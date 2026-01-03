/**
 * OpenAI 格式处理器
 * 处理 /v1/chat/completions 请求，支持流式和非流式响应
 */

import { generateAssistantResponse, generateAssistantResponseNoStream } from '../../api/client.js';
import { generateRequestBody, prepareImageRequest } from '../../utils/utils.js';
import { AppError, buildOpenAIErrorPayload } from '../../utils/errors.js';
import logger from '../../utils/logger.js';
import config, { saveConfigJson } from '../../config/config.js';
import tokenManager from '../../auth/token_manager.js';
import codexProvider from '../../providers/codex.js';
import {
  createResponseMeta,
  setStreamHeaders,
  createHeartbeat,
  getChunkObject,
  releaseChunkObject,
  writeStreamData,
  endStream,
  with429Retry
} from '../stream.js';

function getRoutingRouteById(routeId) {
  if (!routeId) return null;
  const routes = Array.isArray(config.routing?.routes) ? config.routing.routes : [];
  return routes.find(r => (r?.id || r?.routeId || '').toString() === routeId) || null;
}

function parseNonNegativeInt(value, fallback = 0) {
  const num = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(num)) return fallback;
  const intVal = Math.floor(num);
  if (intVal < 0) return fallback;
  return intVal;
}

/**
 * 获取当前周期的起始时间戳
 * @param {string} periodType - 周期类型: daily, weekly, monthly
 * @returns {number} 当前周期开始的时间戳
 */
function getPeriodStartTimestamp(periodType) {
  const now = new Date();
  switch (periodType) {
    case 'daily':
      return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    case 'weekly': {
      const day = now.getDay();
      const diff = now.getDate() - day + (day === 0 ? -6 : 1); // 周一为起始
      return new Date(now.getFullYear(), now.getMonth(), diff).getTime();
    }
    case 'monthly':
      return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    default:
      return 0;
  }
}

/**
 * 规范化 usage 对象结构
 * @param {number|object} usage - 原始 usage 数据（可能是旧格式的数字或新格式的对象）
 * @returns {object} 规范化后的 usage 对象
 */
function normalizeUsageEntry(usage) {
  if (typeof usage === 'number') {
    // 旧格式：纯数字表示总用量，向后兼容
    return { totalUsed: usage, periodUsed: 0, lastReset: 0 };
  }
  if (usage && typeof usage === 'object') {
    return {
      totalUsed: parseNonNegativeInt(usage.totalUsed, 0),
      periodUsed: parseNonNegativeInt(usage.periodUsed, 0),
      lastReset: parseNonNegativeInt(usage.lastReset, 0)
    };
  }
  return { totalUsed: 0, periodUsed: 0, lastReset: 0 };
}

/**
 * 规范化 limit 配置结构
 * @param {number|object} limit - 原始 limit 配置（可能是旧格式的数字或新格式的对象）
 * @returns {object|null} 规范化后的 limit 对象，若无配置返回 null
 */
function normalizeLimitEntry(limit) {
  if (limit === undefined || limit === null) {
    return null;
  }
  if (typeof limit === 'number') {
    // 旧格式：纯数字表示总限额
    return { total: limit, period: null, periodLimit: null, expireAt: null };
  }
  if (limit && typeof limit === 'object') {
    const total = limit.total !== undefined && limit.total !== null && limit.total !== ''
      ? parseNonNegativeInt(limit.total, null) : null;
    const period = ['daily', 'weekly', 'monthly'].includes(limit.period) ? limit.period : null;
    const periodLimit = period && limit.periodLimit !== undefined && limit.periodLimit !== null && limit.periodLimit !== ''
      ? parseNonNegativeInt(limit.periodLimit, null) : null;
    const expireAt = limit.expireAt !== undefined && limit.expireAt !== null && limit.expireAt !== ''
      ? parseNonNegativeInt(limit.expireAt, null) : null;
    
    if (total === null && periodLimit === null && expireAt === null) {
      return null; // 无有效限制
    }
    return { total, period, periodLimit, expireAt };
  }
  return null;
}

function consumeRoutingModelQuota(routeId, modelId) {
  const route = getRoutingRouteById(routeId);
  if (!route) return { allowed: true, reason: null };

  const limitsObj = (route.modelLimits && typeof route.modelLimits === 'object' && !Array.isArray(route.modelLimits))
    ? route.modelLimits
    : {};
  const limitConfig = normalizeLimitEntry(limitsObj[modelId]);

  // 如果没有任何限制配置，直接放行
  if (!limitConfig) {
    return { allowed: true, reason: null };
  }

  const usageObj = (route.modelUsage && typeof route.modelUsage === 'object' && !Array.isArray(route.modelUsage))
    ? route.modelUsage
    : {};
  let usageEntry = normalizeUsageEntry(usageObj[modelId]);

  const { total, period, periodLimit, expireAt } = limitConfig;

  // 检查有效期
  if (expireAt !== null && Date.now() > expireAt) {
    return {
      allowed: false,
      reason: 'expired',
      expireAt
    };
  }

  // 检查周期重置
  if (period && periodLimit !== null) {
    const periodStart = getPeriodStartTimestamp(period);
    if (usageEntry.lastReset < periodStart) {
      // 新周期开始，重置周期用量
      usageEntry.periodUsed = 0;
      usageEntry.lastReset = periodStart;
    }
  }

  // 检查总额度
  if (total !== null && usageEntry.totalUsed >= total) {
    return {
      allowed: false,
      reason: 'total_exceeded',
      totalLimit: total,
      totalUsed: usageEntry.totalUsed
    };
  }

  // 检查周期额度
  if (period && periodLimit !== null && usageEntry.periodUsed >= periodLimit) {
    return {
      allowed: false,
      reason: 'period_exceeded',
      period,
      periodLimit,
      periodUsed: usageEntry.periodUsed
    };
  }

  // 消费配额
  usageEntry.totalUsed += 1;
  if (period && periodLimit !== null) {
    usageEntry.periodUsed += 1;
  }

  // 更新 usage 到 route 对象
  const nextUsage = {
    ...usageObj,
    [modelId]: usageEntry
  };
  route.modelUsage = nextUsage;

  try {
    saveConfigJson({ routing: { routes: Array.isArray(config.routing?.routes) ? config.routing.routes : [] } });
  } catch (e) {
    logger.error('保存分流用量失败:', e.message);
  }

  return { allowed: true, reason: null, totalUsed: usageEntry.totalUsed, periodUsed: usageEntry.periodUsed };
}

/**
 * 创建流式数据块
 * 支持 DeepSeek 格式的 reasoning_content
 * @param {string} id - 响应ID
 * @param {number} created - 创建时间戳
 * @param {string} model - 模型名称
 * @param {Object} delta - 增量内容
 * @param {string|null} finish_reason - 结束原因
 * @returns {Object}
 */
export const createStreamChunk = (id, created, model, delta, finish_reason = null) => {
  const chunk = getChunkObject();
  chunk.id = id;
  chunk.object = 'chat.completion.chunk';
  chunk.created = created;
  chunk.model = model;
  chunk.choices[0].delta = delta;
  chunk.choices[0].finish_reason = finish_reason;
  return chunk;
};

const isCodexModel = (modelId) => {
  if (!modelId) return false;
  const normalized = String(modelId).toLowerCase();
  if (normalized.startsWith('gpt-') || normalized.startsWith('gpt_')) return true;
  if (/^o\d/.test(normalized)) return true;
  return normalized.includes('codex');
};

/**
 * 处理 OpenAI 格式的聊天请求
 * @param {Request} req - Express请求对象
 * @param {Response} res - Express响应对象
 */
export const handleOpenAIRequest = async (req, res) => {
  const { messages, model, stream = false, tools, ...params } = req.body;
  
  try {
    if (!messages) {
      return res.status(400).json({ error: 'messages is required' });
    }

    if (!model || typeof model !== 'string') {
      const err = new AppError('model is required', 400, 'invalid_request_error');
      return res.status(400).json(buildOpenAIErrorPayload(err, 400));
    }

    const requestedModel = model;
    let actualModel = requestedModel;

    const route = req.downstreamRoute;
    if (route && !route.isMaster) {
      const allowedActualModels = new Set(Array.isArray(route.models) ? route.models : []);
      const aliasMap = (route.modelAliases && typeof route.modelAliases === 'object') ? route.modelAliases : {};
      const allowedAliasNames = new Set(Object.keys(aliasMap));

      if (allowedAliasNames.has(requestedModel)) {
        const mapped = aliasMap[requestedModel];
        if (!mapped || typeof mapped !== 'string') {
          const err = new AppError(`Invalid alias mapping for model: ${requestedModel}`, 400, 'invalid_request_error');
          return res.status(400).json(buildOpenAIErrorPayload(err, 400));
        }
        actualModel = mapped;
      } else if (allowedActualModels.has(requestedModel)) {
        actualModel = requestedModel;
      } else {
        const allowedForClient = Array.from(new Set([
          ...allowedActualModels,
          ...allowedAliasNames
        ])).filter(Boolean).sort();

        const err = new AppError(
          `Model '${requestedModel}' is not allowed for this API key. Allowed models: ${allowedForClient.join(', ')}`,
          400,
          'invalid_request_error'
        );
        return res.status(400).json(buildOpenAIErrorPayload(err, 400));
      }
    }

    if (route && !route.isMaster) {
      const quota = consumeRoutingModelQuota(route.id, actualModel);
      if (!quota.allowed) {
        let errMsg;
        if (quota.reason === 'total_exceeded') {
          errMsg = `Model '${requestedModel}' total quota exceeded. Limit: ${quota.totalLimit}, used: ${quota.totalUsed}`;
        } else if (quota.reason === 'period_exceeded') {
          const periodNames = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };
          errMsg = `Model '${requestedModel}' ${periodNames[quota.period] || quota.period} quota exceeded. Limit: ${quota.periodLimit}, used: ${quota.periodUsed}`;
        } else if (quota.reason === 'expired') {
          const expireStr = new Date(quota.expireAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
          errMsg = `Model '${requestedModel}' routing key expired at ${expireStr}`;
        } else {
          errMsg = `Model '${requestedModel}' quota exceeded.`;
        }
        // 对于过期或额度耗尽，使用 429 (Too Many Requests) 或 403 (Forbidden)
        // 这里沿用原逻辑使用 429，但对于过期来说 403 可能更语义化，不过为了客户端兼容性可能保持 429 更好
        const err = new AppError(errMsg, 429, 'rate_limit_error');
        return res.status(429).json(buildOpenAIErrorPayload(err, 429));
      }
    }

    if (isCodexModel(actualModel)) {
      if (!codexProvider.initialized) {
        await codexProvider.initialize();
      }

      if (stream) {
        setStreamHeaders(res);

        const heartbeatTimer = createHeartbeat(res);
        const { id, created } = createResponseMeta();

        try {
          const codexRequest = { model: actualModel, messages, stream: true, tools, ...params };
          for await (const delta of codexProvider.chatOpenAIStream(codexRequest)) {
            if (!delta) continue;
            writeStreamData(res, createStreamChunk(id, created, requestedModel, { content: delta }));
          }

          writeStreamData(res, createStreamChunk(id, created, requestedModel, {}, 'stop'));
          clearInterval(heartbeatTimer);
          endStream(res);
        } catch (error) {
          clearInterval(heartbeatTimer);
          throw error;
        }
      } else {
        req.setTimeout(0);
        res.setTimeout(0);

        const codexRequest = { model: actualModel, messages, stream: false, tools, ...params };
        const response = await codexProvider.chatOpenAI(codexRequest);
        if (response && typeof response === 'object') {
          response.model = requestedModel;
        }
        return res.json(response);
      }
      return;
    }
    
    const token = await tokenManager.getToken();
    if (!token) {
      throw new Error('没有可用的token，请运行 npm run login 获取token');
    }
    
    const isImageModel = actualModel.includes('-image');
    const requestBody = generateRequestBody(messages, actualModel, params, tools, token);
    
    if (isImageModel) {
      prepareImageRequest(requestBody);
    }
    //console.log(JSON.stringify(requestBody,null,2));
    const { id, created } = createResponseMeta();
    const maxRetries = Number(config.retryTimes || 0);
    const safeRetries = maxRetries > 0 ? Math.floor(maxRetries) : 0;
    
    if (stream) {
      setStreamHeaders(res);
      
      // 启动心跳，防止 Cloudflare 超时断连
      const heartbeatTimer = createHeartbeat(res);

      try {
        if (isImageModel) {
          const { content, usage } = await with429Retry(
            () => generateAssistantResponseNoStream(requestBody, token),
            safeRetries,
            'chat.stream.image '
          );
          writeStreamData(res, createStreamChunk(id, created, requestedModel, { content }));
          writeStreamData(res, { ...createStreamChunk(id, created, requestedModel, {}, 'stop'), usage });
        } else {
          let hasToolCall = false;
          let usageData = null;

          await with429Retry(
            () => generateAssistantResponse(requestBody, token, (data) => {
              if (data.type === 'usage') {
                usageData = data.usage;
              } else if (data.type === 'reasoning') {
                const delta = { reasoning_content: data.reasoning_content };
                if (data.thoughtSignature && config.passSignatureToClient) {
                  delta.thoughtSignature = data.thoughtSignature;
                }
                writeStreamData(res, createStreamChunk(id, created, requestedModel, delta));
              } else if (data.type === 'tool_calls') {
                hasToolCall = true;
                // 根据配置决定是否透传工具调用中的签名
                const toolCallsWithIndex = data.tool_calls.map((toolCall, index) => {
                  if (config.passSignatureToClient) {
                    return { index, ...toolCall };
                  } else {
                    const { thoughtSignature, ...rest } = toolCall;
                    return { index, ...rest };
                  }
                });
                const delta = { tool_calls: toolCallsWithIndex };
                writeStreamData(res, createStreamChunk(id, created, requestedModel, delta));
              } else {
                const delta = { content: data.content };
                writeStreamData(res, createStreamChunk(id, created, requestedModel, delta));
              }
            }),
            safeRetries,
            'chat.stream '
          );

          writeStreamData(res, { ...createStreamChunk(id, created, requestedModel, {}, hasToolCall ? 'tool_calls' : 'stop'), usage: usageData });
        }

        clearInterval(heartbeatTimer);
        endStream(res);
      } catch (error) {
        clearInterval(heartbeatTimer);
        throw error;
      }
    } else {
      // 非流式请求：设置较长超时，避免大模型响应超时
      req.setTimeout(0); // 禁用请求超时
      res.setTimeout(0); // 禁用响应超时
      
      const { content, reasoningContent, reasoningSignature, toolCalls, usage } = await with429Retry(
        () => generateAssistantResponseNoStream(requestBody, token),
        safeRetries,
        'chat.no_stream '
      );
      
      // DeepSeek 格式：reasoning_content 在 content 之前
      const message = { role: 'assistant' };
      if (reasoningContent) message.reasoning_content = reasoningContent;
      if (reasoningSignature && config.passSignatureToClient) message.thoughtSignature = reasoningSignature;
      message.content = content;
      
      if (toolCalls.length > 0) {
        // 根据配置决定是否透传工具调用中的签名
        if (config.passSignatureToClient) {
          message.tool_calls = toolCalls;
        } else {
          message.tool_calls = toolCalls.map(({ thoughtSignature, ...rest }) => rest);
        }
      }
      
      // 使用预构建的响应对象，减少内存分配
      const response = {
        id,
        object: 'chat.completion',
        created,
        model: requestedModel,
        choices: [{
          index: 0,
          message,
          finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop'
        }],
        usage
      };
      
      res.json(response);
    }
  } catch (error) {
    logger.error('生成响应失败:', error.message);
    if (res.headersSent) return;
    const statusCode = error.statusCode || error.status || 500;
    return res.status(statusCode).json(buildOpenAIErrorPayload(error, statusCode));
  }
};
