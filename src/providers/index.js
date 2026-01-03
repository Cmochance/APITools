/**
 * Provider 管理器
 * 负责注册、选择和管理所有 AI 提供商
 */

import logger from '../utils/logger.js';
import { getConfigJson } from '../config/config.js';

/**
 * @typedef {import('./base.js').BaseProvider} BaseProvider
 */

class ProviderManager {
  constructor() {
    /** @type {Map<string, BaseProvider>} */
    this.providers = new Map();

    /** @type {Map<string, string[]>} 模型到提供商的映射 */
    this.modelProviderMapping = new Map();

    this.initialized = false;
  }

  /**
   * 注册提供商
   * @param {string} name - 提供商名称
   * @param {BaseProvider} provider - 提供商实例
   */
  register(name, provider) {
    if (this.providers.has(name)) {
      logger.warn(`Provider ${name} already registered, overwriting...`);
    }
    this.providers.set(name, provider);
    logger.info(`Provider registered: ${name}`);
  }

  /**
   * 获取指定提供商
   * @param {string} name - 提供商名称
   * @returns {BaseProvider|null}
   */
  get(name) {
    return this.providers.get(name) || null;
  }

  /**
   * 获取所有已注册的提供商名称
   * @returns {string[]}
   */
  getProviderNames() {
    return Array.from(this.providers.keys());
  }

  /**
   * 获取所有已启用的提供商（按优先级排序）
   * @returns {BaseProvider[]}
   */
  getEnabledProviders() {
    return Array.from(this.providers.values())
      .filter(p => p.enabled && p.initialized)
      .sort((a, b) => a.priority - b.priority);
  }

  /**
   * 初始化所有已注册的提供商
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this.initialized) return;

    logger.info('Initializing all providers...');

    const initPromises = [];
    for (const [name, provider] of this.providers) {
      if (provider.enabled) {
        initPromises.push(
          provider.initialize()
            .then(() => {
              logger.info(`Provider ${name} initialized successfully`);
            })
            .catch(err => {
              logger.error(`Provider ${name} initialization failed:`, err.message);
              provider.enabled = false;
            })
        );
      }
    }

    await Promise.allSettled(initPromises);

    // 构建模型映射
    this.buildModelMapping();

    this.initialized = true;
    logger.info(`Provider initialization complete. Active providers: ${this.getEnabledProviders().map(p => p.name).join(', ')}`);
  }

  /**
   * 构建模型到提供商的映射
   */
  buildModelMapping() {
    this.modelProviderMapping.clear();

    // 从配置读取自定义映射
    const jsonConfig = getConfigJson();
    const customMapping = jsonConfig?.routing?.modelProviderMapping || {};

    // 处理自定义映射
    for (const [pattern, providerNames] of Object.entries(customMapping)) {
      const providers = Array.isArray(providerNames) ? providerNames : [providerNames];
      this.modelProviderMapping.set(pattern, providers);
    }

    // 为每个提供商的模型添加默认映射
    for (const [name, provider] of this.providers) {
      if (!provider.enabled) continue;

      for (const model of provider.supportedModels) {
        if (!this.modelProviderMapping.has(model)) {
          this.modelProviderMapping.set(model, [name]);
        }
      }
    }
  }

  /**
   * 根据模型选择提供商
   * @param {string} model - 模型名称
   * @returns {BaseProvider|null}
   */
  selectProvider(model) {
    if (!model) return null;

    // 1. 先检查精确匹配的自定义映射
    if (this.modelProviderMapping.has(model)) {
      const providerNames = this.modelProviderMapping.get(model);
      for (const name of providerNames) {
        const provider = this.providers.get(name);
        if (provider && provider.enabled && provider.initialized) {
          return provider;
        }
      }
    }

    // 2. 检查通配符映射
    for (const [pattern, providerNames] of this.modelProviderMapping) {
      if (pattern.endsWith('*')) {
        const prefix = pattern.slice(0, -1);
        if (model.startsWith(prefix)) {
          for (const name of providerNames) {
            const provider = this.providers.get(name);
            if (provider && provider.enabled && provider.initialized) {
              return provider;
            }
          }
        }
      }
    }

    // 3. 遍历所有提供商，找到支持该模型的
    const enabledProviders = this.getEnabledProviders();
    for (const provider of enabledProviders) {
      if (provider.supportsModel(model)) {
        return provider;
      }
    }

    // 4. 如果没找到，返回优先级最高的提供商（fallback）
    if (enabledProviders.length > 0) {
      logger.warn(`No provider found for model: ${model}, using fallback: ${enabledProviders[0].name}`);
      return enabledProviders[0];
    }

    return null;
  }

  /**
   * 处理聊天请求
   * @param {Object} request - 请求体
   * @param {boolean} stream - 是否流式
   * @returns {Promise<Object|AsyncGenerator>}
   */
  async handleChat(request, stream = false) {
    const model = request.model;
    const provider = this.selectProvider(model);

    if (!provider) {
      throw new Error(`No available provider for model: ${model}`);
    }

    logger.info(`Routing request for model ${model} to provider: ${provider.name}`);

    try {
      if (stream) {
        return provider.chatStream(request);
      } else {
        const result = await provider.chat(request);
        provider.recordRequest(true, result.usage?.total_tokens || 0);
        return result;
      }
    } catch (error) {
      provider.recordRequest(false);
      throw error;
    }
  }

  /**
   * 获取所有提供商的统计信息
   * @returns {Object[]}
   */
  getAllStats() {
    return Array.from(this.providers.values()).map(p => p.getStats());
  }

  /**
   * 获取所有可用模型列表
   * @returns {Promise<Object[]>}
   */
  async listAllModels() {
    const allModels = [];
    const enabledProviders = this.getEnabledProviders();

    for (const provider of enabledProviders) {
      try {
        const models = await provider.listModels();
        allModels.push(...models);
      } catch (error) {
        logger.error(`Failed to list models from ${provider.name}:`, error.message);
      }
    }

    // 去重
    const seen = new Set();
    return allModels.filter(m => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
  }

  /**
   * 重新加载所有提供商
   * @returns {Promise<void>}
   */
  async reloadAll() {
    logger.info('Reloading all providers...');
    for (const provider of this.providers.values()) {
      if (provider.enabled) {
        try {
          await provider.reload();
          logger.info(`Provider ${provider.name} reloaded`);
        } catch (error) {
          logger.error(`Failed to reload ${provider.name}:`, error.message);
        }
      }
    }
    this.buildModelMapping();
  }
}

// 单例
const providerManager = new ProviderManager();

export default providerManager;

// 导出类供测试使用
export { ProviderManager };
