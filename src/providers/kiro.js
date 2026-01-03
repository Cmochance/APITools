/**
 * Kiro Provider
 * 基于 ACB 的 claude-kiro.js 移植的 Kiro 提供商
 * 通过 AWS CodeWhisperer 访问 Claude 模型
 */

import BaseProvider from './base.js';
import { KIRO_CONSTANTS, KIRO_MODEL_MAPPING } from '../constants/kiro.js';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

// Kiro 支持的模型列表
const KIRO_MODELS = [
  'claude-opus-4-5',
  'claude-opus-4-5-20251101',
  'claude-haiku-4-5',
  'claude-sonnet-4-5',
  'claude-sonnet-4-5-20250929',
  'claude-sonnet-4-20250514',
  'claude-3-7-sonnet-20250219',
  // 通配符
  'claude-*'
];

class KiroProvider extends BaseProvider {
  constructor(providerConfig = {}) {
    super('kiro', providerConfig);

    this.supportedModels = KIRO_MODELS;

    // Kiro 特定配置
    this.region = providerConfig.region || 'us-east-1';
    this.accountsFile = providerConfig.accountsFile || 'data/kiro-accounts.json';

    // Token 管理器（将在后续实现）
    this.tokenManager = null;

    // 活跃的服务实例缓存
    this.serviceInstances = new Map();
  }

  /**
   * 初始化提供商
   */
  async initialize() {
    if (this.initialized) return;

    this.log('info', 'Initializing Kiro provider...');

    try {
      // 动态导入 token manager（避免循环依赖）
      const { default: KiroTokenManager } = await import('../auth/kiro_token_manager.js');
      this.tokenManager = new KiroTokenManager(this.accountsFile);
      await this.tokenManager.load();

      this.initialized = true;
      const accountCount = await this.tokenManager.getAccountCount();
      this.log('info', `Kiro provider initialized with ${accountCount} accounts`);
    } catch (error) {
      this.log('error', 'Failed to initialize Kiro provider:', error.message);
      throw error;
    }
  }

  /**
   * 获取可用的 Token
   */
  async getToken() {
    if (!this.tokenManager) {
      throw new Error('Kiro provider not initialized');
    }
    return await this.tokenManager.getToken();
  }

  /**
   * 刷新 Token
   */
  async refreshToken(token) {
    if (!this.tokenManager) {
      throw new Error('Kiro provider not initialized');
    }
    return await this.tokenManager.refreshToken(token);
  }

  /**
   * 将模型名称映射到 Kiro/CodeWhisperer 格式
   */
  mapModel(model) {
    return KIRO_MODEL_MAPPING[model] || KIRO_MODEL_MAPPING['claude-opus-4-5'];
  }

  /**
   * 处理聊天请求（非流式）
   */
  async chat(request) {
    const token = await this.getToken();
    if (!token) {
      throw new Error('No available Kiro token');
    }

    const mappedModel = this.mapModel(request.model);
    this.log('info', `Processing chat request with model: ${request.model} -> ${mappedModel}`);

    // 构建 CodeWhisperer 请求
    const cwRequest = this._buildCodeWhispererRequest(request, mappedModel, token);

    // 发送请求
    const response = await this._sendRequest(cwRequest, token, false);

    // 解析响应
    return this._parseResponse(response, request.model);
  }

  /**
   * 处理聊天请求（流式）
   */
  async *chatStream(request) {
    const token = await this.getToken();
    if (!token) {
      throw new Error('No available Kiro token');
    }

    const mappedModel = this.mapModel(request.model);
    this.log('info', `Processing stream request with model: ${request.model} -> ${mappedModel}`);

    // 构建 CodeWhisperer 请求
    const cwRequest = this._buildCodeWhispererRequest(request, mappedModel, token);

    // 流式发送请求
    yield* this._sendStreamRequest(cwRequest, token, request.model);
  }

  /**
   * 构建 CodeWhisperer 请求体
   * @private
   */
  _buildCodeWhispererRequest(request, mappedModel, token) {
    const conversationId = uuidv4();

    // 处理消息
    const history = [];
    const messages = request.messages || [];

    // 系统提示词处理
    let systemPrompt = '';
    if (request.system) {
      systemPrompt = typeof request.system === 'string'
        ? request.system
        : request.system.map(s => s.text || '').join('\n');
    }

    // 处理历史消息
    for (let i = 0; i < messages.length - 1; i++) {
      const msg = messages[i];
      if (msg.role === 'user') {
        history.push({
          userInputMessage: {
            content: this._getContentText(msg),
            modelId: mappedModel,
            origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
          }
        });
      } else if (msg.role === 'assistant') {
        history.push({
          assistantResponseMessage: {
            content: this._getContentText(msg)
          }
        });
      }
    }

    // 当前消息
    const currentMessage = messages[messages.length - 1];
    let currentContent = this._getContentText(currentMessage);

    // 如果有系统提示词且是第一条用户消息
    if (systemPrompt && history.length === 0) {
      currentContent = `${systemPrompt}\n\n${currentContent}`;
    }

    const cwRequest = {
      conversationState: {
        chatTriggerType: KIRO_CONSTANTS.CHAT_TRIGGER_TYPE_MANUAL,
        conversationId: conversationId,
        currentMessage: {
          userInputMessage: {
            content: currentContent,
            modelId: mappedModel,
            origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
          }
        }
      }
    };

    if (history.length > 0) {
      cwRequest.conversationState.history = history;
    }

    // 处理工具定义
    if (request.tools && request.tools.length > 0) {
      cwRequest.conversationState.currentMessage.userInputMessage.userInputMessageContext = {
        tools: request.tools.map(tool => ({
          toolSpecification: {
            name: tool.name || tool.function?.name,
            description: tool.description || tool.function?.description || '',
            inputSchema: { json: tool.input_schema || tool.function?.parameters || {} }
          }
        }))
      };
    }

    // 添加 profileArn
    if (token.profileArn) {
      cwRequest.profileArn = token.profileArn;
    }

    return cwRequest;
  }

  /**
   * 获取消息文本内容
   * @private
   */
  _getContentText(message) {
    if (!message) return '';

    if (typeof message.content === 'string') {
      return message.content;
    }

    if (Array.isArray(message.content)) {
      return message.content
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .join('');
    }

    return String(message.content || '');
  }

  /**
   * 发送请求到 CodeWhisperer
   * @private
   */
  async _sendRequest(cwRequest, token, isStream) {
    const baseUrl = KIRO_CONSTANTS.BASE_URL.replace('{{region}}', this.region);

    const response = await axios.post(baseUrl, cwRequest, {
      headers: {
        'Authorization': `Bearer ${token.accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'amz-sdk-invocation-id': uuidv4(),
        'amz-sdk-request': 'attempt=1; max=1',
        'x-amzn-kiro-agent-mode': 'vibe',
        'User-Agent': `KiroIDE/${KIRO_CONSTANTS.KIRO_VERSION}`
      },
      timeout: KIRO_CONSTANTS.AXIOS_TIMEOUT,
      responseType: isStream ? 'stream' : 'text'
    });

    return response;
  }

  /**
   * 流式发送请求
   * @private
   */
  async *_sendStreamRequest(cwRequest, token, originalModel) {
    const baseUrl = KIRO_CONSTANTS.BASE_URL.replace('{{region}}', this.region);

    const response = await axios.post(baseUrl, cwRequest, {
      headers: {
        'Authorization': `Bearer ${token.accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'amz-sdk-invocation-id': uuidv4(),
        'amz-sdk-request': 'attempt=1; max=1',
        'x-amzn-kiro-agent-mode': 'vibe',
        'User-Agent': `KiroIDE/${KIRO_CONSTANTS.KIRO_VERSION}`
      },
      timeout: KIRO_CONSTANTS.AXIOS_TIMEOUT,
      responseType: 'stream'
    });

    const messageId = uuidv4();

    // message_start
    yield {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: originalModel,
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

    // 解析流式响应
    for await (const chunk of response.data) {
      const text = chunk.toString();
      const events = this._parseEventStream(text);

      for (const event of events) {
        if (event.content) {
          totalContent += event.content;
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: event.content }
          };
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
   * 解析事件流
   * @private
   */
  _parseEventStream(rawText) {
    const events = [];
    const contentRegex = /\{"content":"([^"]*?)"\}/g;

    let match;
    while ((match = contentRegex.exec(rawText)) !== null) {
      try {
        const content = match[1]
          .replace(/\\n/g, '\n')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
        events.push({ content });
      } catch (e) {
        // 忽略解析错误
      }
    }

    return events;
  }

  /**
   * 解析响应
   * @private
   */
  _parseResponse(response, originalModel) {
    // 解析响应文本
    const rawText = typeof response.data === 'string' ? response.data : response.data.toString();
    const events = this._parseEventStream(rawText);
    const content = events.map(e => e.content).join('');

    return {
      id: uuidv4(),
      type: 'message',
      role: 'assistant',
      model: originalModel,
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 0,
        output_tokens: Math.ceil(content.length / 4)
      },
      content: [{ type: 'text', text: content }]
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
      return { success: false, message: 'Kiro provider not initialized' };
    }
    return await this.tokenManager.addAccount(accountData);
  }

  /**
   * 更新账号
   */
  async updateAccount(accountId, updates) {
    if (!this.tokenManager) {
      return { success: false, message: 'Kiro provider not initialized' };
    }
    return await this.tokenManager.updateAccount(accountId, updates);
  }

  /**
   * 删除账号
   */
  async deleteAccount(accountId) {
    if (!this.tokenManager) {
      return { success: false, message: 'Kiro provider not initialized' };
    }
    return await this.tokenManager.deleteAccount(accountId);
  }

  /**
   * 重新加载账号
   */
  async reload() {
    if (this.tokenManager) {
      await this.tokenManager.reload();
      this.log('info', 'Kiro accounts reloaded');
    }
  }

  /**
   * 获取模型列表
   */
  async listModels() {
    const concreteModels = this.supportedModels.filter(m => !m.includes('*'));
    return concreteModels.map(id => ({
      id,
      object: 'model',
      created: Date.now(),
      owned_by: 'kiro'
    }));
  }
}

// 创建单例（默认禁用，需要配置启用）
const kiroProvider = new KiroProvider({
  enabled: false,
  priority: 2
});

export default kiroProvider;
export { KiroProvider, KIRO_MODELS };
