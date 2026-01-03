/**
 * Antigravity Provider
 * 基于现有 ACA 代码重构的 Antigravity 提供商
 */

import BaseProvider from './base.js';
import tokenManager from '../auth/token_manager.js';
import { sendRequest } from '../api/client.js';
import config from '../config/config.js';

// Antigravity 支持的模型列表
const ANTIGRAVITY_MODELS = [
  // Gemini 模型
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.0-flash-thinking',
  'gemini-1.5-pro',
  'gemini-1.5-flash',
  // 通配符
  'gemini-*'
];

class AntigravityProvider extends BaseProvider {
  constructor(providerConfig = {}) {
    super('antigravity', providerConfig);

    this.supportedModels = ANTIGRAVITY_MODELS;
    this.tokenManager = tokenManager;
  }

  /**
   * 初始化提供商
   */
  async initialize() {
    if (this.initialized) return;

    this.log('info', 'Initializing Antigravity provider...');

    // Token manager 会在首次 getToken 时自动初始化
    // 这里只标记为已初始化
    this.initialized = true;

    this.log('info', 'Antigravity provider initialized');
  }

  /**
   * 获取可用的 Token
   */
  async getToken() {
    return await this.tokenManager.getToken();
  }

  /**
   * 刷新 Token
   */
  async refreshToken(token) {
    return await this.tokenManager.refreshToken(token);
  }

  /**
   * 处理聊天请求（非流式）
   * 注意：实际的请求处理仍由现有的 handlers 完成
   * 这里主要是为了统一接口
   */
  async chat(request) {
    const token = await this.getToken();
    if (!token) {
      throw new Error('No available Antigravity token');
    }

    // 调用现有的 sendRequest
    const response = await sendRequest(token, request, false);
    return response;
  }

  /**
   * 处理聊天请求（流式）
   */
  async *chatStream(request) {
    const token = await this.getToken();
    if (!token) {
      throw new Error('No available Antigravity token');
    }

    // 流式请求由 handlers 处理
    // 这里返回一个标记，让 handler 知道使用 antigravity
    yield* this._handleStreamInternal(token, request);
  }

  /**
   * 内部流式处理（占位，实际由 handlers 完成）
   */
  async *_handleStreamInternal(token, request) {
    // 这个方法在完整集成时会被重构
    // 目前保持与现有 handlers 的兼容性
    throw new Error('Stream handling should be done by handlers');
  }

  /**
   * 获取账号列表
   */
  async getAccountList() {
    return await this.tokenManager.getTokenList();
  }

  /**
   * 添加账号
   */
  async addAccount(accountData) {
    return await this.tokenManager.addToken(accountData);
  }

  /**
   * 更新账号
   */
  async updateAccount(accountId, updates) {
    return await this.tokenManager.updateToken(accountId, updates);
  }

  /**
   * 删除账号
   */
  async deleteAccount(accountId) {
    return await this.tokenManager.deleteToken(accountId);
  }

  /**
   * 重新加载账号
   */
  async reload() {
    await this.tokenManager.reload();
    this.log('info', 'Antigravity accounts reloaded');
  }

  /**
   * 获取模型列表
   */
  async listModels() {
    // 过滤掉通配符，返回具体模型
    const concreteModels = this.supportedModels.filter(m => !m.includes('*'));
    return concreteModels.map(id => ({
      id,
      object: 'model',
      created: Date.now(),
      owned_by: 'antigravity'
    }));
  }

  /**
   * 标记 Token 额度耗尽
   */
  markQuotaExhausted(token) {
    this.tokenManager.markQuotaExhausted(token);
  }

  /**
   * 恢复 Token 额度
   */
  restoreQuota(token) {
    this.tokenManager.restoreQuota(token);
  }

  /**
   * 获取轮���配置
   */
  getRotationConfig() {
    return this.tokenManager.getRotationConfig();
  }

  /**
   * 更新轮询配置
   */
  updateRotationConfig(strategy, requestCount) {
    this.tokenManager.updateRotationConfig(strategy, requestCount);
  }
}

// 创建单例
const antigravityProvider = new AntigravityProvider({
  enabled: true,
  priority: 1
});

export default antigravityProvider;
export { AntigravityProvider, ANTIGRAVITY_MODELS };
