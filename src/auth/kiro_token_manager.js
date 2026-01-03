/**
 * Kiro Token Manager
 * 管理 Kiro 账号的 Token 存储、轮询、刷新
 * 与 ACA 的 token_manager.js 保持一致的接口
 */

import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
import { KIRO_CONSTANTS } from '../constants/kiro.js';
import logger from '../utils/logger.js';
import { getDataDir } from '../utils/paths.js';

const log = {
  info: (...args) => logger.info('[Kiro]', ...args),
  warn: (...args) => logger.warn('[Kiro]', ...args),
  error: (...args) => logger.error('[Kiro]', ...args)
};

class KiroTokenManager {
  /**
   * @param {string} filePath - 账号文件路径
   */
  constructor(filePath = 'data/kiro-accounts.json') {
    this.filePath = filePath.startsWith('/')
      ? filePath
      : path.join(getDataDir(), path.basename(filePath));

    /** @type {Array<Object>} */
    this.accounts = [];

    /** @type {number} */
    this.currentIndex = 0;

    /** @type {boolean} */
    this.loaded = false;
  }

  /**
   * 加载账号数据
   */
  async load() {
    try {
      const content = await fs.readFile(this.filePath, 'utf8');
      const data = JSON.parse(content);
      this.accounts = Array.isArray(data) ? data : [];
      this.loaded = true;
      log.info(`Loaded ${this.accounts.length} Kiro accounts`);
    } catch (error) {
      if (error.code === 'ENOENT') {
        // 文件不存在，创建空文件
        await this.save();
        this.accounts = [];
        this.loaded = true;
        log.info('Created empty Kiro accounts file');
      } else {
        log.error('Failed to load Kiro accounts:', error.message);
        throw error;
      }
    }
  }

  /**
   * 保存账号数据
   */
  async save() {
    try {
      const dir = path.dirname(this.filePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(this.accounts, null, 2));
    } catch (error) {
      log.error('Failed to save Kiro accounts:', error.message);
      throw error;
    }
  }

  /**
   * 获取账号数量
   */
  async getAccountCount() {
    return this.accounts.filter(a => a.enable !== false).length;
  }

  /**
   * 获取可用的 Token
   */
  async getToken() {
    const enabledAccounts = this.accounts.filter(a => a.enable !== false);
    if (enabledAccounts.length === 0) {
      return null;
    }

    // Round-robin 选择
    const index = this.currentIndex % enabledAccounts.length;
    this.currentIndex++;

    const account = enabledAccounts[index];

    // 检查是否过期
    if (this.isExpired(account)) {
      try {
        await this.refreshToken(account);
      } catch (error) {
        log.error(`Failed to refresh token for ${account.email || account.id}:`, error.message);
        // 如果刷新失败，尝试下一个账号
        if (enabledAccounts.length > 1) {
          return this.getToken();
        }
        throw error;
      }
    }

    return account;
  }

  /**
   * 检查 Token 是否过期
   */
  isExpired(account) {
    if (!account.expiresAt) return false;

    const expiresAt = new Date(account.expiresAt).getTime();
    const now = Date.now();
    // 提前 10 分钟刷新
    return now >= expiresAt - 10 * 60 * 1000;
  }

  /**
   * 刷新 Token
   */
  async refreshToken(account) {
    if (!account.refreshToken) {
      throw new Error('No refresh token available');
    }

    const region = account.region || KIRO_CONSTANTS.DEFAULT_REGION;
    const authMethod = account.authMethod || KIRO_CONSTANTS.AUTH_METHOD_SOCIAL;

    let refreshUrl;
    const requestBody = { refreshToken: account.refreshToken };

    if (authMethod === KIRO_CONSTANTS.AUTH_METHOD_SOCIAL) {
      refreshUrl = KIRO_CONSTANTS.REFRESH_URL.replace('{{region}}', region);
    } else {
      refreshUrl = KIRO_CONSTANTS.REFRESH_IDC_URL.replace('{{region}}', region);
      requestBody.clientId = account.clientId;
      requestBody.clientSecret = account.clientSecret;
      requestBody.grantType = 'refresh_token';
    }

    log.info(`Refreshing token for ${account.email || account.id}...`);

    try {
      const response = await axios.post(refreshUrl, requestBody, {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: 30000
      });

      if (response.data.accessToken) {
        account.accessToken = response.data.accessToken;
        account.refreshToken = response.data.refreshToken || account.refreshToken;
        account.profileArn = response.data.profileArn || account.profileArn;

        const expiresIn = response.data.expiresIn || 3600;
        account.expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

        await this.save();
        log.info(`Token refreshed for ${account.email || account.id}`);
        return account;
      } else {
        throw new Error('Invalid refresh response: missing accessToken');
      }
    } catch (error) {
      const statusCode = error.response?.status;
      const message = error.response?.data?.message || error.message;
      log.error(`Token refresh failed (${statusCode}):`, message);
      throw error;
    }
  }

  /**
   * 获取账号列表（用于管理界面）
   */
  async getAccountList() {
    return this.accounts.map(account => ({
      id: account.id,
      email: account.email || null,
      accessToken_suffix: account.accessToken ? `...${account.accessToken.slice(-8)}` : 'N/A',
      profileArn: account.profileArn || null,
      region: account.region || KIRO_CONSTANTS.DEFAULT_REGION,
      expiresAt: account.expiresAt || null,
      enable: account.enable !== false,
      authMethod: account.authMethod || KIRO_CONSTANTS.AUTH_METHOD_SOCIAL
    }));
  }

  /**
   * 添加账号
   */
  async addAccount(accountData) {
    const id = accountData.id || `kiro_${Date.now()}`;

    // 检查是否已存在
    const existing = this.accounts.find(a =>
      a.id === id ||
      (accountData.email && a.email === accountData.email)
    );

    if (existing) {
      // 更新现有账号
      Object.assign(existing, accountData, { id: existing.id });
      await this.save();
      return { success: true, message: 'Account updated' };
    }

    const newAccount = {
      id,
      accessToken: accountData.accessToken,
      refreshToken: accountData.refreshToken,
      email: accountData.email || null,
      profileArn: accountData.profileArn || null,
      clientId: accountData.clientId || null,
      clientSecret: accountData.clientSecret || null,
      authMethod: accountData.authMethod || KIRO_CONSTANTS.AUTH_METHOD_SOCIAL,
      region: accountData.region || KIRO_CONSTANTS.DEFAULT_REGION,
      expiresAt: accountData.expiresAt || null,
      enable: accountData.enable !== false,
      timestamp: Date.now()
    };

    this.accounts.push(newAccount);
    await this.save();

    return { success: true, message: 'Account added' };
  }

  /**
   * 更新账号
   */
  async updateAccount(accountId, updates) {
    const account = this.accounts.find(a => a.id === accountId);
    if (!account) {
      return { success: false, message: 'Account not found' };
    }

    Object.assign(account, updates);
    await this.save();

    return { success: true, message: 'Account updated' };
  }

  /**
   * 删除账号
   */
  async deleteAccount(accountId) {
    const index = this.accounts.findIndex(a => a.id === accountId);
    if (index === -1) {
      return { success: false, message: 'Account not found' };
    }

    this.accounts.splice(index, 1);
    await this.save();

    return { success: true, message: 'Account deleted' };
  }

  /**
   * 重新加载账号
   */
  async reload() {
    await this.load();
  }
}

export default KiroTokenManager;
