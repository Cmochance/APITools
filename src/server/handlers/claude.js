/**
 * Claude 格式处理器
 * 处理 /v1/messages 请求，支持流式和非流式响应
 */

import { generateAssistantResponse, generateAssistantResponseNoStream } from '../../api/client.js';
import { generateClaudeRequestBody, prepareImageRequest } from '../../utils/utils.js';
import { normalizeClaudeParameters } from '../../utils/parameterNormalizer.js';
import { buildClaudeErrorPayload } from '../../utils/errors.js';
import logger from '../../utils/logger.js';
import config, { saveConfigJson } from '../../config/config.js';
import tokenManager from '../../auth/token_manager.js';
import {
  setStreamHeaders,
  createHeartbeat,
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
 * 创建 Claude 流式事件
 * @param {string} eventType - 事件类型
 * @param {Object} data - 事件数据
 * @returns {string}
 */
export const createClaudeStreamEvent = (eventType, data) => {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
};

/**
 * 创建 Claude 非流式响应
 * @param {string} id - 消息ID
 * @param {string} model - 模型名称
 * @param {string|null} content - 文本内容
 * @param {string|null} reasoning - 思维链内容
 * @param {string|null} reasoningSignature - 思维链签名
 * @param {Array|null} toolCalls - 工具调用
 * @param {string} stopReason - 停止原因
 * @param {Object|null} usage - 使用量统计
 * @returns {Object}
 */
export const createClaudeResponse = (id, model, content, reasoning, reasoningSignature, toolCalls, stopReason, usage) => {
  const contentBlocks = [];
  
  // 思维链内容（如果有）- Claude 格式用 thinking 类型
  if (reasoning) {
    const thinkingBlock = {
      type: "thinking",
      thinking: reasoning
    };
    if (reasoningSignature && config.passSignatureToClient) {
      thinkingBlock.signature = reasoningSignature;
    }
    contentBlocks.push(thinkingBlock);
  }
  
  // 文本内容
  if (content) {
    contentBlocks.push({
      type: "text",
      text: content
    });
  }
  
  // 工具调用
  if (toolCalls && toolCalls.length > 0) {
    for (const tc of toolCalls) {
      try {
        const toolBlock = {
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments)
        };
        if (tc.thoughtSignature && config.passSignatureToClient) {
          toolBlock.signature = tc.thoughtSignature;
        }
        contentBlocks.push(toolBlock);
      } catch (e) {
        // 解析失败时传入空对象
        contentBlocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: {}
        });
      }
    }
  }

  return {
    id: id,
    type: "message",
    role: "assistant",
    content: contentBlocks,
    model: model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: usage ? {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0
    } : { input_tokens: 0, output_tokens: 0 }
  };
};

/**
 * 处理 Claude 格式的聊天请求
 * @param {Request} req - Express请求对象
 * @param {Response} res - Express响应对象
 * @param {boolean} isStream - 是否流式响应
 */
export const handleClaudeRequest = async (req, res, isStream) => {
  const { messages, model, system, tools, ...rawParams } = req.body;
  
  try {
    if (!messages) {
      return res.status(400).json(buildClaudeErrorPayload({ message: 'messages is required' }, 400));
    }

    if (!model || typeof model !== 'string') {
      return res.status(400).json(buildClaudeErrorPayload({ message: 'model is required' }, 400));
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
          return res.status(400).json(buildClaudeErrorPayload({ message: `Invalid alias mapping for model: ${requestedModel}` }, 400));
        }
        actualModel = mapped;
      } else if (allowedActualModels.has(requestedModel)) {
        actualModel = requestedModel;
      } else {
        const allowedForClient = Array.from(new Set([
          ...Array.from(allowedActualModels),
          ...Array.from(allowedAliasNames)
        ])).filter(Boolean).sort();

        return res.status(400).json(buildClaudeErrorPayload({ message: `Model '${requestedModel}' is not allowed for this API key. Allowed models: ${allowedForClient.join(', ')}` }, 400));
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
        return res.status(429).json(buildClaudeErrorPayload({ message: errMsg }, 429));
      }
    }
    
    const token = await tokenManager.getToken();
    if (!token) {
      throw new Error('没有可用的token，请运行 npm run login 获取token');
    }
    
    // 使用统一参数规范化模块处理 Claude 格式参数
    const parameters = normalizeClaudeParameters(rawParams);
    
    const isImageModel = actualModel.includes('-image');
    const requestBody = generateClaudeRequestBody(messages, actualModel, parameters, tools, system, token);
    
    if (isImageModel) {
      prepareImageRequest(requestBody);
    }
    
    const msgId = `msg_${Date.now()}`;
    const maxRetries = Number(config.retryTimes || 0);
    const safeRetries = maxRetries > 0 ? Math.floor(maxRetries) : 0;
    
    if (isStream) {
      setStreamHeaders(res);
      const heartbeatTimer = createHeartbeat(res);
      
      try {
        let contentIndex = 0;
        let usageData = null;
        let hasToolCall = false;
        let currentBlockType = null;
        let reasoningSent = false;
        
        // 发送 message_start
        res.write(createClaudeStreamEvent('message_start', {
          type: "message_start",
          message: {
            id: msgId,
            type: "message",
            role: "assistant",
            content: [],
            model: requestedModel,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 }
          }
        }));
        
        if (isImageModel) {
          // 生图模型：使用非流式获取结果后以流式格式返回
          const { content, usage } = await with429Retry(
            () => generateAssistantResponseNoStream(requestBody, token),
            safeRetries,
            'claude.stream.image '
          );
          
          // 发送文本块
          res.write(createClaudeStreamEvent('content_block_start', {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" }
          }));
          res.write(createClaudeStreamEvent('content_block_delta', {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: content || '' }
          }));
          res.write(createClaudeStreamEvent('content_block_stop', {
            type: "content_block_stop",
            index: 0
          }));
          
          // 发送 message_delta 和 message_stop
          res.write(createClaudeStreamEvent('message_delta', {
            type: "message_delta",
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: usage ? { output_tokens: usage.completion_tokens || 0 } : { output_tokens: 0 }
          }));
          res.write(createClaudeStreamEvent('message_stop', {
            type: "message_stop"
          }));
          
          clearInterval(heartbeatTimer);
          res.end();
          return;
        }
        
        await with429Retry(
          () => generateAssistantResponse(requestBody, token, (data) => {
            if (data.type === 'usage') {
              usageData = data.usage;
            } else if (data.type === 'reasoning') {
              // 思维链内容 - 使用 thinking 类型
              if (!reasoningSent) {
                // 开始思维块
                const contentBlock = { type: "thinking", thinking: "" };
                if (data.thoughtSignature && config.passSignatureToClient) {
                  contentBlock.signature = data.thoughtSignature;
                }
                res.write(createClaudeStreamEvent('content_block_start', {
                  type: "content_block_start",
                  index: contentIndex,
                  content_block: contentBlock
                }));
                currentBlockType = 'thinking';
                reasoningSent = true;
              }
              // 发送思维增量
              const delta = { type: "thinking_delta", thinking: data.reasoning_content || '' };
              if (data.thoughtSignature && config.passSignatureToClient) {
                delta.signature = data.thoughtSignature;
              }
              res.write(createClaudeStreamEvent('content_block_delta', {
                type: "content_block_delta",
                index: contentIndex,
                delta: delta
              }));
            } else if (data.type === 'tool_calls') {
              hasToolCall = true;
              // 结束之前的块（如果有）
              if (currentBlockType) {
                res.write(createClaudeStreamEvent('content_block_stop', {
                  type: "content_block_stop",
                  index: contentIndex
                }));
                contentIndex++;
              }
              // 工具调用
              for (const tc of data.tool_calls) {
                try {
                  const toolBlock = {
                    type: "tool_use",
                    id: tc.id,
                    name: tc.function.name,
                    input: JSON.parse(tc.function.arguments)
                  };
                  if (tc.thoughtSignature && config.passSignatureToClient) {
                    toolBlock.signature = tc.thoughtSignature;
                  }
                  res.write(createClaudeStreamEvent('content_block_start', {
                    type: "content_block_start",
                    index: contentIndex,
                    content_block: toolBlock
                  }));
                  // 发送 input 增量
                  res.write(createClaudeStreamEvent('content_block_delta', {
                    type: "content_block_delta",
                    index: contentIndex,
                    delta: { type: "input_json_delta", partial_json: JSON.stringify(JSON.parse(tc.function.arguments)) }
                  }));
                  res.write(createClaudeStreamEvent('content_block_stop', {
                    type: "content_block_stop",
                    index: contentIndex
                  }));
                  contentIndex++;
                } catch (e) {
                  // 解析失败，跳过
                }
              }
              currentBlockType = null;
            } else {
              // 普通文本内容
              if (currentBlockType === 'thinking') {
                // 结束思维块
                res.write(createClaudeStreamEvent('content_block_stop', {
                  type: "content_block_stop",
                  index: contentIndex
                }));
                contentIndex++;
                currentBlockType = null;
              }
              if (currentBlockType !== 'text') {
                // 开始文本块
                res.write(createClaudeStreamEvent('content_block_start', {
                  type: "content_block_start",
                  index: contentIndex,
                  content_block: { type: "text", text: "" }
                }));
                currentBlockType = 'text';
              }
              // 发送文本增量
              res.write(createClaudeStreamEvent('content_block_delta', {
                type: "content_block_delta",
                index: contentIndex,
                delta: { type: "text_delta", text: data.content || '' }
              }));
            }
          }),
          safeRetries,
          'claude.stream '
        );
        
        // 结束最后一个内容块
        if (currentBlockType) {
          res.write(createClaudeStreamEvent('content_block_stop', {
            type: "content_block_stop",
            index: contentIndex
          }));
        }
        
        // 发送 message_delta
        const stopReason = hasToolCall ? 'tool_use' : 'end_turn';
        res.write(createClaudeStreamEvent('message_delta', {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: usageData ? { output_tokens: usageData.completion_tokens || 0 } : { output_tokens: 0 }
        }));
        
        // 发送 message_stop
        res.write(createClaudeStreamEvent('message_stop', {
          type: "message_stop"
        }));
        
        clearInterval(heartbeatTimer);
        res.end();
      } catch (error) {
        clearInterval(heartbeatTimer);
        if (!res.writableEnded) {
          const statusCode = error.statusCode || error.status || 500;
          res.write(createClaudeStreamEvent('error', buildClaudeErrorPayload(error, statusCode)));
          res.end();
        }
        logger.error('Claude 流式请求失败:', error.message);
        return;
      }
    } else {
      // 非流式请求
      req.setTimeout(0);
      res.setTimeout(0);
      
      const { content, reasoningContent, reasoningSignature, toolCalls, usage } = await with429Retry(
        () => generateAssistantResponseNoStream(requestBody, token),
        safeRetries,
        'claude.no_stream '
      );
      
      const stopReason = toolCalls.length > 0 ? 'tool_use' : 'end_turn';
      const response = createClaudeResponse(
        msgId,
        requestedModel,
        content,
        reasoningContent,
        reasoningSignature,
        toolCalls,
        stopReason,
        usage
      );
      
      res.json(response);
    }
  } catch (error) {
    logger.error('Claude 请求失败:', error.message);
    if (res.headersSent) return;
    const statusCode = error.statusCode || error.status || 500;
    res.status(statusCode).json(buildClaudeErrorPayload(error, statusCode));
  }
};
