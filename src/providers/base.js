/**
 * Provider 基类
 * 所有 AI 提供商（Antigravity、Kiro、Codex）的抽象基类
 */

import logger from '../utils/logger.js';

/**
 * @typedef {Object} ProviderToken
 * @property {string} access_token - 访问令牌
 * @property {string} refresh_token - 刷新令牌
 * @property {number} expires_in - 过期时间（秒）
 * @property {number} timestamp - 获取时间戳
 * @property {boolean} enable - 是否启用
 * @property {string} [email] - 账号邮箱
 * @property {string} [projectId] - 项目ID
 */

/**
 * @typedef {Object} ProviderConfig
 * @property {boolean} enabled - 是否启用该提供商
 * @property {number} priority - 优先级（数字越小越优先）
 * @property {string} accountsFile - 账号文件路径
 * @property {Object} [extra] - 提供商特定配置
 */

/**
 * @typedef {Object} ChatMessage
 * @property {string} role - 消息角色 (user/assistant/system)
 * @property {string|Array} content - 消息内容
 */

/**
 * @typedef {Object} ChatRequest
 * @property {string} model - 模型名称
 * @property {ChatMessage[]} messages - 消息列表
 * @property {boolean} [stream] - 是否流式响应
 * @property {number} [temperature] - 温度参数
 * @property {number} [max_tokens] - 最大 token 数
 * @property {Object[]} [tools] - 工具定义
 */

export class BaseProvider {
  /**
   * @param {string} name - 提供商名称
   * @param {ProviderConfig} config - 配置
   */
  constructor(name, config = {}) {
    this.name = name;
    this.config = config;
    this.enabled = config.enabled !== false;
    this.priority = config.priority || 100;
    this.initialized = false;

    // 子类需要实现的模型列表
    this.supportedModels = [];

    // 统计信息
    this.stats = {
      totalRequests: 0,
      successRequests: 0,
      failedRequests: 0,
      totalTokensUsed: 0,
      lastRequestTime: null
    };
  }

  /**
   * 初始化提供商（加载账号等）
   * @abstract
   * @returns {Promise<void>}
   */
  async initialize() {
    throw new Error(`${this.name}: initialize() must be implemented`);
  }

  /**
   * 检查是否支持指定模型
   * @param {string} model - 模型名称
   * @returns {boolean}
   */
  supportsModel(model) {
    if (!model) return false;

    // 精确匹配
    if (this.supportedModels.includes(model)) return true;

    // 通配符匹配 (如 claude-* 匹配 claude-3-opus)
    for (const pattern of this.supportedModels) {
      if (pattern.endsWith('*')) {
        const prefix = pattern.slice(0, -1);
        if (model.startsWith(prefix)) return true;
      }
    }

    return false;
  }

  /**
   * 获取可用的 Token
   * @abstract
   * @returns {Promise<ProviderToken|null>}
   */
  async getToken() {
    throw new Error(`${this.name}: getToken() must be implemented`);
  }

  /**
   * 刷新 Token
   * @abstract
   * @param {ProviderToken} token - 要刷新的 token
   * @returns {Promise<ProviderToken>}
   */
  async refreshToken(token) {
    throw new Error(`${this.name}: refreshToken() must be implemented`);
  }

  /**
   * 处理聊天请求（非流式）
   * @abstract
   * @param {ChatRequest} request - 请求体
   * @returns {Promise<Object>} - OpenAI 兼容格式的响应
   */
  async chat(request) {
    throw new Error(`${this.name}: chat() must be implemented`);
  }

  /**
   * 处理聊天请求（流式）
   * @abstract
   * @param {ChatRequest} request - 请求体
   * @returns {AsyncGenerator<Object>} - SSE 事件流
   */
  async *chatStream(request) {
    throw new Error(`${this.name}: chatStream() must be implemented`);
  }

  /**
   * 获取可用模型列表
   * @returns {Promise<Array<{id: string, name: string}>>}
   */
  async listModels() {
    return this.supportedModels.map(id => ({
      id,
      object: 'model',
      created: Date.now(),
      owned_by: this.name
    }));
  }

  /**
   * 获取账号列表（用于管理界面）
   * @abstract
   * @returns {Promise<Array<Object>>}
   */
  async getAccountList() {
    throw new Error(`${this.name}: getAccountList() must be implemented`);
  }

  /**
   * 添加账号
   * @abstract
   * @param {Object} accountData - 账号数据
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async addAccount(accountData) {
    throw new Error(`${this.name}: addAccount() must be implemented`);
  }

  /**
   * 更新账号
   * @abstract
   * @param {string} accountId - 账号标识
   * @param {Object} updates - 更新数据
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async updateAccount(accountId, updates) {
    throw new Error(`${this.name}: updateAccount() must be implemented`);
  }

  /**
   * 删除账号
   * @abstract
   * @param {string} accountId - 账号标识
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async deleteAccount(accountId) {
    throw new Error(`${this.name}: deleteAccount() must be implemented`);
  }

  /**
   * 重新加载账号
   * @abstract
   * @returns {Promise<void>}
   */
  async reload() {
    throw new Error(`${this.name}: reload() must be implemented`);
  }

  /**
   * 记录请求统计
   * @param {boolean} success - 是否成功
   * @param {number} [tokensUsed=0] - 使用的 token 数
   */
  recordRequest(success, tokensUsed = 0) {
    this.stats.totalRequests++;
    if (success) {
      this.stats.successRequests++;
    } else {
      this.stats.failedRequests++;
    }
    this.stats.totalTokensUsed += tokensUsed;
    this.stats.lastRequestTime = Date.now();
  }

  /**
   * 获取统计信息
   * @returns {Object}
   */
  getStats() {
    return {
      name: this.name,
      enabled: this.enabled,
      priority: this.priority,
      initialized: this.initialized,
      supportedModels: this.supportedModels,
      ...this.stats
    };
  }

  /**
   * 日志辅助方法
   */
  log(level, message, ...args) {
    const prefix = `[${this.name}]`;
    switch (level) {
      case 'info':
        logger.info(`${prefix} ${message}`, ...args);
        break;
      case 'warn':
        logger.warn(`${prefix} ${message}`, ...args);
        break;
      case 'error':
        logger.error(`${prefix} ${message}`, ...args);
        break;
      case 'debug':
        logger.debug?.(`${prefix} ${message}`, ...args) ||
          console.debug(`${prefix} ${message}`, ...args);
        break;
    }
  }
}

export default BaseProvider;
