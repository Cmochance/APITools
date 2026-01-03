/**
 * Codex Provider
 * 基于 ACC (opencode-openai-codex-auth) 移植的 Codex 提供商
 * 支持 OAuth + API Key 双模式：
 * - OAuth: 通过 ChatGPT Plus/Pro 订阅访问 (chatgpt.com/backend-api)
 * - API Key: 通过 OpenAI Platform API 访问 (api.openai.com)
 */

import BaseProvider from './base.js';
import { CODEX_CONSTANTS, CODEX_MODELS } from '../constants/codex.js';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

/**
 * 解析时间字符串为毫秒
 * 支持格式: "30s", "2m", "1h30m", "500ms", "2m30s"
 */
function parseDurationMs(durationStr) {
  if (!durationStr || typeof durationStr !== 'string') return null;

  const regex = /([\d.]+)\s*(ms|s|m|h)/gi;
  let totalMs = 0;
  let matched = false;
  let match;

  while ((match = regex.exec(durationStr)) !== null) {
    matched = true;
    const value = parseFloat(match[1]);
    const unit = match[2].toLowerCase();

    switch (unit) {
      case 'ms': totalMs += value; break;
      case 's': totalMs += value * 1000; break;
      case 'm': totalMs += value * 60 * 1000; break;
      case 'h': totalMs += value * 60 * 60 * 1000; break;
    }
  }

  return matched ? Math.round(totalMs) : null;
}

/**
 * 从 429 错误响应中解析重试延迟
 * 支持 OpenAI/ChatGPT 的错误格式
 */
function parseRetryDelay(errorData) {
  try {
    // 如果是字符串，尝试解析为 JSON
    const data = typeof errorData === 'string' ? JSON.parse(errorData) : errorData;

    // 格式1: OpenAI 标准格式 - error.details[].retryDelay
    const details = data?.error?.details;
    if (Array.isArray(details)) {
      for (const detail of details) {
        // RetryInfo 类型
        if (detail['@type']?.includes('RetryInfo') && detail.retryDelay) {
          const delay = parseDurationMs(detail.retryDelay);
          if (delay) return delay;
        }
        // metadata.quotaResetDelay
        if (detail.metadata?.quotaResetDelay) {
          const delay = parseDurationMs(detail.metadata.quotaResetDelay);
          if (delay) return delay;
        }
      }
    }

    // 格式2: ChatGPT 格式 - 从 message 中提取时间
    const message = data?.error?.message || data?.message || '';
    // 匹配 "Please try again in 2m30s" 或 "Rate limit exceeded. Retry after 1h"
    const timeMatch = message.match(/(?:in|after)\s+([\d.]+\s*(?:ms|s|m|h)[\d.smh\s]*)/i);
    if (timeMatch) {
      const delay = parseDurationMs(timeMatch[1]);
      if (delay) return delay;
    }

    // 格式3: Retry-After header 值（秒数）
    if (data?.retryAfter) {
      return parseInt(data.retryAfter, 10) * 1000;
    }

  } catch (e) {
    // 解析失败，返回默认值
  }

  // 默认返回 null，表示无法解析
  return null;
}

class CodexProvider extends BaseProvider {
  constructor(providerConfig = {}) {
    super('codex', providerConfig);

    this.supportedModels = [
      ...CODEX_MODELS,
      // 通配符
      'gpt-5*',
      'gpt-4*',
      'o3-*',
      'o4-*'
    ];

    // Codex 特定配置
    this.accountsFile = providerConfig.accountsFile || 'data/codex-accounts.json';

    // Token 管理器
    this.tokenManager = null;

    // 账号限流状态追踪
    // Map<accountId, { rateLimited: boolean, resetTime: number, lastError: string }>
    this.rateLimitStatus = new Map();
  }

  /**
   * 记录账号被限流
   * @param {string} accountId - 账号ID
   * @param {number} delayMs - 延迟毫秒数
   * @param {string} errorMessage - 错误信息
   */
  _setRateLimited(accountId, delayMs, errorMessage = '') {
    const resetTime = Date.now() + delayMs;
    this.rateLimitStatus.set(accountId, {
      rateLimited: true,
      resetTime,
      lastError: errorMessage,
      setAt: Date.now()
    });
    this.log('warn', `Account ${accountId.substring(0, 8)}... rate limited, reset at ${new Date(resetTime).toLocaleTimeString()}`);
  }

  /**
   * 清除账号限流状态
   * @param {string} accountId - 账号ID
   */
  _clearRateLimited(accountId) {
    if (this.rateLimitStatus.has(accountId)) {
      this.rateLimitStatus.delete(accountId);
      this.log('info', `Account ${accountId.substring(0, 8)}... rate limit cleared`);
    }
  }

  /**
   * 检查账号是否被限流
   * @param {string} accountId - 账号ID
   * @returns {Object|null} 限流状态或 null
   */
  _getRateLimitStatus(accountId) {
    const status = this.rateLimitStatus.get(accountId);
    if (!status) return null;

    // 检查是否已过期
    if (Date.now() >= status.resetTime) {
      this._clearRateLimited(accountId);
      return null;
    }

    return status;
  }

  /**
   * 处理 API 错误，检测限流
   * @param {Error} error - Axios 错误
   * @param {string} accountId - 账号ID
   */
  _handleApiError(error, accountId) {
    const status = error.response?.status;
    const data = error.response?.data;

    if (status === 429) {
      // 尝试解析重试延迟
      let delayMs = parseRetryDelay(data);

      // 如果无法解析，使用默认值（3小时，ChatGPT 的典型限制周期）
      if (!delayMs) {
        delayMs = 3 * 60 * 60 * 1000; // 3小时
      }

      const errorMessage = data?.error?.message || data?.message || 'Rate limit exceeded';
      this._setRateLimited(accountId, delayMs, errorMessage);
    }

    throw error;
  }

  /**
   * 初始化提供商
   */
  async initialize() {
    if (this.initialized) return;

    this.log('info', 'Initializing Codex provider...');

    try {
      // 动态导入 token manager
      const { default: CodexTokenManager } = await import('../auth/codex_token_manager.js');
      this.tokenManager = new CodexTokenManager(this.accountsFile);
      await this.tokenManager.load();

      this.initialized = true;
      const accountCount = await this.tokenManager.getAccountCount();
      this.log('info', `Codex provider initialized with ${accountCount} accounts`);
    } catch (error) {
      this.log('error', 'Failed to initialize Codex provider:', error.message);
      throw error;
    }
  }

  /**
   * 获取可用的 Token
   */
  async getToken() {
    if (!this.tokenManager) {
      throw new Error('Codex provider not initialized');
    }
    return await this.tokenManager.getToken();
  }

  /**
   * 刷新 Token
   */
  async refreshToken(token) {
    if (!this.tokenManager) {
      throw new Error('Codex provider not initialized');
    }
    return await this.tokenManager.refreshToken(token);
  }

  /**
   * 获取请求 URL 和 Headers（根据认证类型）
   * @param {Object} account - 账号对象
   * @returns {Object} - { baseUrl, headers }
   */
  _getRequestConfig(account) {
    if (account.auth_type === CODEX_CONSTANTS.AUTH_TYPE_OAUTH) {
      // OAuth 模式：使用 ChatGPT Backend API
      const headers = {
        'Authorization': `Bearer ${account.access_token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'OpenAI-Beta': CODEX_CONSTANTS.OPENAI_BETA,
        'originator': CODEX_CONSTANTS.ORIGINATOR,
        'session_id': uuidv4()
      };

      // 如果有 chatgpt_account_id，添加到 headers
      if (account.chatgpt_account_id) {
        headers['chatgpt-account-id'] = account.chatgpt_account_id;
      }

      return {
        baseUrl: CODEX_CONSTANTS.BASE_URL,
        headers,
        isOAuth: true
      };
    } else {
      // API Key 模式：使用 OpenAI Platform API
      const apiKey = account.api_key || account.access_token;
      return {
        baseUrl: CODEX_CONSTANTS.PLATFORM_API_URL,
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        isOAuth: false
      };
    }
  }

  /**
   * 构建 Codex 请求体（OAuth 模式专用）
   * @param {Object} request - 原始请求
   * @returns {Object} - Codex 格式的请求体
   */
  _buildCodexRequestBody(request) {
    // 处理 input 格式（Codex/Responses API 格式）
    const input = [];

    // 添加系统消息
    if (request.system) {
      const systemText = typeof request.system === 'string'
        ? request.system
        : request.system.map(s => s.text || '').join('\n');
      input.push({
        type: 'message',
        role: 'system',
        content: systemText
      });
    }

    // 转换 messages
    for (const msg of (request.messages || [])) {
      const content = typeof msg.content === 'string'
        ? msg.content
        : (Array.isArray(msg.content)
            ? msg.content.filter(p => p.type === 'text').map(p => p.text).join('')
            : String(msg.content || ''));

      input.push({
        type: 'message',
        role: msg.role,
        content
      });
    }

    const body = {
      model: request.model || CODEX_CONSTANTS.DEFAULT_MODEL,
      input,
      stream: request.stream !== false
    };

    // 可选参数
    if (request.max_tokens) {
      body.max_output_tokens = request.max_tokens;
    }
    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    // 工具定义
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools;
    }

    return body;
  }

  /**
   * 构建 OpenAI Chat 请求体（API Key 模式）
   * @param {Object} request - 原始请求
   * @returns {Object} - OpenAI Chat 格式的请求体
   */
  _buildChatRequestBody(request) {
    const body = {
      model: request.model || CODEX_CONSTANTS.DEFAULT_MODEL,
      messages: request.messages || [],
      stream: request.stream !== false
    };

    if (request.max_tokens) {
      body.max_tokens = request.max_tokens;
    }
    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools;
    }

    return body;
  }

  /**
   * 处理聊天请求（非流式）
   */
  async chat(request) {
    const account = await this.getToken();
    if (!account) {
      throw new Error('No available Codex account');
    }

    this.log('info', `Processing chat request with model: ${request.model} (auth_type: ${account.auth_type})`);

    const config = this._getRequestConfig(account);

    try {
      let response;
      if (config.isOAuth) {
        // OAuth 模式：使用 Codex Responses API
        const body = this._buildCodexRequestBody({ ...request, stream: false });
        response = await axios.post(
          `${config.baseUrl}/codex/responses`,
          body,
          {
            headers: config.headers,
            timeout: CODEX_CONSTANTS.AXIOS_TIMEOUT
          }
        );
        // 成功请求，清除可能的限流状态
        this._clearRateLimited(account.id);
        return this._parseCodexResponse(response.data, request.model);
      } else {
        // API Key 模式：使用 Chat Completions API
        const body = this._buildChatRequestBody({ ...request, stream: false });
        response = await axios.post(
          `${config.baseUrl}/chat/completions`,
          body,
          {
            headers: config.headers,
            timeout: CODEX_CONSTANTS.AXIOS_TIMEOUT
          }
        );
        // 成功请求，清除可能的限流状态
        this._clearRateLimited(account.id);
        return this._convertToClaudeFormat(response.data, request.model);
      }
    } catch (error) {
      // 处理错误，检测限流
      this._handleApiError(error, account.id);
    }
  }

  /**
   * 处理聊天请求（流式）
   */
  async *chatStream(request) {
    const account = await this.getToken();
    if (!account) {
      throw new Error('No available Codex account');
    }

    this.log('info', `Processing stream request with model: ${request.model} (auth_type: ${account.auth_type})`);

    const config = this._getRequestConfig(account);
    const messageId = uuidv4();

    // message_start
    yield {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: request.model,
        usage: { input_tokens: 0, output_tokens: 0 },
        content: []
      }
    };

    // content_block_start
    yield {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' }
    };

    let totalContent = '';

    if (config.isOAuth) {
      // OAuth 模式：使用 Codex Responses API
      const body = this._buildCodexRequestBody({ ...request, stream: true });
      const response = await axios.post(
        `${config.baseUrl}/codex/responses`,
        body,
        {
          headers: config.headers,
          timeout: CODEX_CONSTANTS.AXIOS_TIMEOUT,
          responseType: 'stream'
        }
      );

      let buffer = '';
      for await (const chunk of response.data) {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);
              // Codex SSE 事件解析
              if (parsed.type === 'response.output_text.delta' && parsed.delta) {
                totalContent += parsed.delta;
                yield {
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'text_delta', text: parsed.delta }
                };
              } else if (parsed.type === 'response.content_part.delta' && parsed.delta?.text) {
                totalContent += parsed.delta.text;
                yield {
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'text_delta', text: parsed.delta.text }
                };
              }
            } catch {
              // 忽略解析错误
            }
          }
        }
      }
    } else {
      // API Key 模式：使用 Chat Completions API
      const body = this._buildChatRequestBody({ ...request, stream: true });
      const response = await axios.post(
        `${config.baseUrl}/chat/completions`,
        body,
        {
          headers: config.headers,
          timeout: CODEX_CONSTANTS.AXIOS_TIMEOUT,
          responseType: 'stream'
        }
      );

      let buffer = '';
      for await (const chunk of response.data) {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                totalContent += delta;
                yield {
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'text_delta', text: delta }
                };
              }
            } catch {
              // 忽略解析错误
            }
          }
        }
      }
    }

    // content_block_stop
    yield { type: 'content_block_stop', index: 0 };

    // message_delta
    yield {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: Math.ceil(totalContent.length / 4) }
    };

    // message_stop
    yield { type: 'message_stop' };
  }

  /**
   * 解析 Codex Responses API 响应
   * @private
   */
  _parseCodexResponse(responseData, model) {
    // Codex 响应格式解析
    let content = '';

    if (responseData.output) {
      // 提取 output 中的文本
      for (const item of responseData.output) {
        if (item.type === 'message' && item.content) {
          for (const part of item.content) {
            if (part.type === 'output_text' || part.type === 'text') {
              content += part.text || '';
            }
          }
        }
      }
    }

    return {
      id: responseData.id || uuidv4(),
      type: 'message',
      role: 'assistant',
      model: model,
      stop_reason: 'end_turn',
      usage: {
        input_tokens: responseData.usage?.input_tokens || 0,
        output_tokens: responseData.usage?.output_tokens || 0
      },
      content: [{ type: 'text', text: content }]
    };
  }

  /**
   * 将 OpenAI Chat 响应转换为 Claude 格式
   * @private
   */
  _convertToClaudeFormat(openaiResponse, model) {
    const choice = openaiResponse.choices?.[0];
    const message = choice?.message;

    return {
      id: openaiResponse.id || uuidv4(),
      type: 'message',
      role: 'assistant',
      model: model,
      stop_reason: choice?.finish_reason === 'stop' ? 'end_turn' : choice?.finish_reason,
      usage: {
        input_tokens: openaiResponse.usage?.prompt_tokens || 0,
        output_tokens: openaiResponse.usage?.completion_tokens || 0
      },
      content: [{
        type: 'text',
        text: message?.content || ''
      }]
    };
  }

  /**
   * 获取账号列表
   */
  async getAccountList() {
    if (!this.tokenManager) return [];
    return await this.tokenManager.getAccountList();
  }

  /**
   * 添加账号
   */
  async addAccount(accountData) {
    if (!this.tokenManager) {
      return { success: false, message: 'Codex provider not initialized' };
    }
    return await this.tokenManager.addAccount(accountData);
  }

  /**
   * 更新账号
   */
  async updateAccount(accountId, updates) {
    if (!this.tokenManager) {
      return { success: false, message: 'Codex provider not initialized' };
    }
    return await this.tokenManager.updateAccount(accountId, updates);
  }

  /**
   * 删除账号
   */
  async deleteAccount(accountId) {
    if (!this.tokenManager) {
      return { success: false, message: 'Codex provider not initialized' };
    }
    return await this.tokenManager.deleteAccount(accountId);
  }

  /**
   * 重新加载账号
   */
  async reload() {
    if (this.tokenManager) {
      await this.tokenManager.reload();
      this.log('info', 'Codex accounts reloaded');
    }
  }

  /**
   * 获取模型列表
   */
  async listModels() {
    return CODEX_MODELS.map(id => ({
      id,
      object: 'model',
      created: Date.now(),
      owned_by: 'codex'
    }));
  }

  /**
   * 获取账号的模型额度信息
   * @param {string} accountId - 账号 ID
   * @returns {Object} 额度信息 { models: { [modelId]: { remaining, resetTime } } }
   */
  async getAccountQuotas(accountId) {
    if (!this.tokenManager) {
      throw new Error('Codex provider not initialized');
    }

    const accounts = await this.tokenManager.getAccountList();
    const account = accounts.find(a => a.id === accountId);

    if (!account) {
      throw new Error('Account not found');
    }

    // 检查是否被限流
    const rateLimitStatus = this._getRateLimitStatus(accountId);
    if (rateLimitStatus) {
      // 账号被限流，返回限流状态
      const resetTimeStr = new Date(rateLimitStatus.resetTime).toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
      });
      const remainingMs = rateLimitStatus.resetTime - Date.now();
      const remainingMinutes = Math.ceil(remainingMs / 60000);

      return {
        lastUpdated: Date.now(),
        subscriptionType: account.auth_type === 'api_key' ? 'api_key' : 'plus',
        rateLimited: true,
        resetTime: rateLimitStatus.resetTime,
        resetTimeFormatted: resetTimeStr,
        remainingMinutes,
        lastError: rateLimitStatus.lastError,
        models: CODEX_MODELS.reduce((acc, modelId) => {
          acc[modelId] = {
            remaining: 0,
            resetTime: resetTimeStr,
            unlimited: false,
            rateLimited: true,
            note: `已达限制，${remainingMinutes} 分钟后重置`
          };
          return acc;
        }, {})
      };
    }

    const config = this._getRequestConfig(account);

    try {
      if (config.isOAuth) {
        // OAuth 模式：尝试从 ChatGPT backend-api 获取用量
        // 注意：ChatGPT 的额度是订阅级别的，无法精确获取每个模型的剩余额度
        // 返回一个模拟的额度信息（基于订阅类型）
        return {
          lastUpdated: Date.now(),
          subscriptionType: 'plus', // plus, pro, etc
          rateLimited: false,
          models: CODEX_MODELS.reduce((acc, modelId) => {
            acc[modelId] = {
              remaining: 1.0, // OAuth 模式无法精确获取，显示为满
              resetTime: this._getNextResetTime(),
              unlimited: true, // 标记为订阅无限制
              rateLimited: false,
              note: 'ChatGPT Plus/Pro 订阅'
            };
            return acc;
          }, {})
        };
      } else {
        // API Key 模式：调用 OpenAI usage API
        const usageData = await this._fetchOpenAIUsage(account);
        return {
          lastUpdated: Date.now(),
          subscriptionType: 'api_key',
          rateLimited: false,
          models: CODEX_MODELS.reduce((acc, modelId) => {
            // API Key 模式根据账户余额计算
            const balance = usageData?.balance || 0;
            const limit = usageData?.limit || 100;
            const remaining = limit > 0 ? Math.min(1, balance / limit) : 1;
            acc[modelId] = {
              remaining: remaining,
              resetTime: '月度重置',
              balance: usageData?.balance,
              limit: usageData?.limit,
              rateLimited: false,
              note: 'OpenAI Platform API'
            };
            return acc;
          }, {})
        };
      }
    } catch (error) {
      this.log('warn', `Failed to fetch quotas for account ${accountId}:`, error.message);
      // 返回默认额度信息
      return {
        lastUpdated: Date.now(),
        error: error.message,
        models: CODEX_MODELS.reduce((acc, modelId) => {
          acc[modelId] = {
            remaining: 1.0,
            resetTime: '-',
            note: '无法获取额度信息'
          };
          return acc;
        }, {})
      };
    }
  }

  /**
   * 获取下一个重置时间（每月1号）
   * @private
   */
  _getNextResetTime() {
    const now = new Date();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return nextMonth.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
  }

  /**
   * 获取 OpenAI Platform 用量信息
   * @private
   */
  async _fetchOpenAIUsage(account) {
    try {
      const apiKey = account.api_key || account.access_token;

      // 尝试获取组织信息和用量
      // 注意：OpenAI 的 usage API 需要特定权限
      const response = await axios.get(
        'https://api.openai.com/v1/dashboard/billing/credit_grants',
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );

      if (response.data) {
        return {
          balance: response.data.total_available || 0,
          limit: response.data.total_granted || 100,
          used: response.data.total_used || 0
        };
      }
    } catch (error) {
      // billing API 可能需要特殊权限，静默失败
      this.log('debug', 'OpenAI billing API not accessible:', error.message);
    }

    // 返回默认值
    return { balance: null, limit: null, used: null };
  }

  /**
   * 通过授权码交换 Token
   */
  async exchangeAuthorizationCode(code, verifier, redirectUri) {
    if (!this.tokenManager) {
      throw new Error('Codex provider not initialized');
    }
    return await this.tokenManager.exchangeAuthorizationCode(code, verifier, redirectUri);
  }
}

// 创建单例（默认禁用）
const codexProvider = new CodexProvider({
  enabled: false,
  priority: 3
});

export default codexProvider;
export { CodexProvider, CODEX_MODELS, CODEX_CONSTANTS };
