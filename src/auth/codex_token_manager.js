/**
 * Codex Token Manager
 * 管理 OpenAI Codex 账号的 Token 存储、轮询、OAuth 刷新
 * 支持 OAuth + API Key 双模式
 * 从 ACC (opencode-openai-codex-auth) 项目移植 OAuth 逻辑
 */

import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
import logger from '../utils/logger.js';
import { getDataDir } from '../utils/paths.js';
import { CODEX_CONSTANTS } from '../constants/codex.js';

const log = {
  info: (...args) => logger.info('[Codex]', ...args),
  warn: (...args) => logger.warn('[Codex]', ...args),
  error: (...args) => logger.error('[Codex]', ...args)
};

class CodexTokenManager {
  /**
   * @param {string} filePath - 账号文件路径
   */
  constructor(filePath = 'data/codex-accounts.json') {
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
      log.info(`Loaded ${this.accounts.length} Codex accounts`);
    } catch (error) {
      if (error.code === 'ENOENT') {
        // 文件不存在，创建空文件
        await this.save();
        this.accounts = [];
        this.loaded = true;
        log.info('Created empty Codex accounts file');
      } else {
        log.error('Failed to load Codex accounts:', error.message);
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
      log.error('Failed to save Codex accounts:', error.message);
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
   * 检查 Token 是否过期（OAuth 模式）
   * @param {Object} account - 账号对象
   * @returns {boolean}
   */
  isExpired(account) {
    // API Key 模式永不过期
    if (account.auth_type === CODEX_CONSTANTS.AUTH_TYPE_API_KEY) {
      return false;
    }

    // OAuth 模式检查过期时间
    if (!account.expires_at) return false;

    const now = Date.now();
    // 提前 10 分钟刷新
    return now >= account.expires_at - CODEX_CONSTANTS.TOKEN_REFRESH_BUFFER;
  }

  /**
   * 解析 JWT Token 获取 payload
   * @param {string} token - JWT Token
   * @returns {Object|null}
   */
  decodeJWT(token) {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const payload = parts[1];
      // 处理 Base64URL 编码（替换特殊字符并补齐）
      const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
      const decoded = Buffer.from(padded, 'base64').toString('utf-8');
      return JSON.parse(decoded);
    } catch {
      return null;
    }
  }

  /**
   * 从 JWT 中提取邮箱
   * @param {string} accessToken - 访问令牌
   * @returns {string|null}
   */
  extractEmail(accessToken) {
    const decoded = this.decodeJWT(accessToken);
    if (!decoded) return null;
    // OpenAI JWT 可能包含 email 或在其他字段中
    return decoded.email ||
           decoded['https://api.openai.com/profile']?.email ||
           decoded.preferred_username ||
           null;
  }

  /**
   * 从 JWT 中提取 ChatGPT Account ID
   * @param {string} accessToken - 访问令牌
   * @returns {string|null}
   */
  extractAccountId(accessToken) {
    const decoded = this.decodeJWT(accessToken);
    if (!decoded) return null;
    return decoded[CODEX_CONSTANTS.JWT_CLAIM_PATH]?.chatgpt_account_id || null;
  }

  /**
   * 获取可用的 Token
   * 自动处理过期刷新
   */
  async getToken() {
    const enabledAccounts = this.accounts.filter(a => a.enable !== false);
    if (enabledAccounts.length === 0) {
      return null;
    }

    // Round-robin 选择
    const index = this.currentIndex % enabledAccounts.length;
    this.currentIndex++;

    let account = enabledAccounts[index];

    // 检查是否过期（OAuth 模式）
    if (account.auth_type === CODEX_CONSTANTS.AUTH_TYPE_OAUTH && this.isExpired(account)) {
      try {
        account = await this.refreshToken(account);
      } catch (error) {
        log.error(`Failed to refresh token for ${account.email || account.id}:`, error.message);
        // 如果刷新失败且有多个账号，尝试下一个
        if (enabledAccounts.length > 1) {
          return this.getToken();
        }
        throw error;
      }
    }

    return account;
  }

  /**
   * 刷新 OAuth Token
   * @param {Object} account - 账号对象
   * @returns {Promise<Object>} - 更新后的账号
   */
  async refreshToken(account) {
    // API Key 模式不支持刷新
    if (account.auth_type === CODEX_CONSTANTS.AUTH_TYPE_API_KEY) {
      log.warn('API Key accounts do not support refresh');
      return account;
    }

    if (!account.refresh_token) {
      throw new Error('No refresh token available');
    }

    log.info(`Refreshing OAuth token for ${account.email || account.id}...`);

    try {
      const response = await axios.post(
        CODEX_CONSTANTS.TOKEN_URL,
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: account.refresh_token,
          client_id: CODEX_CONSTANTS.CLIENT_ID
        }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          timeout: 30000
        }
      );

      const { access_token, refresh_token, expires_in } = response.data;

      if (!access_token || !refresh_token || typeof expires_in !== 'number') {
        throw new Error('Invalid refresh response: missing required fields');
      }

      // 更新账号信息
      account.access_token = access_token;
      account.refresh_token = refresh_token;
      account.expires_at = Date.now() + expires_in * 1000;

      // 提取并更新 ChatGPT Account ID
      const chatgptAccountId = this.extractAccountId(access_token);
      if (chatgptAccountId) {
        account.chatgpt_account_id = chatgptAccountId;
      }

      // 尝试从新 Token 中提取邮箱（如果之前没有）
      if (!account.email) {
        const email = this.extractEmail(access_token);
        if (email) {
          account.email = email;
        }
      }

      await this.save();
      log.info(`Token refreshed for ${account.email || account.id}`);

      return account;
    } catch (error) {
      const statusCode = error.response?.status;
      const message = error.response?.data?.error_description || error.message;
      log.error(`Token refresh failed (${statusCode}):`, message);
      throw error;
    }
  }

  /**
   * 通过授权码交换 Token (OAuth 流程)
   * @param {string} code - 授权码
   * @param {string} verifier - PKCE verifier
   * @param {string} redirectUri - 重定向 URI
   * @returns {Promise<Object>} - Token 信息
   */
  async exchangeAuthorizationCode(code, verifier, redirectUri = CODEX_CONSTANTS.REDIRECT_URI) {
    log.info('Exchanging authorization code for tokens...');

    try {
      const response = await axios.post(
        CODEX_CONSTANTS.TOKEN_URL,
        new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: CODEX_CONSTANTS.CLIENT_ID,
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri
        }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          timeout: 30000
        }
      );

      const { access_token, refresh_token, expires_in } = response.data;

      if (!access_token || !refresh_token || typeof expires_in !== 'number') {
        throw new Error('Invalid token response: missing required fields');
      }

      // 提取 ChatGPT Account ID
      const chatgptAccountId = this.extractAccountId(access_token);

      // 从 JWT 中提取邮箱
      const email = this.extractEmail(access_token);

      const tokenData = {
        access_token,
        refresh_token,
        expires_at: Date.now() + expires_in * 1000,
        chatgpt_account_id: chatgptAccountId,
        email,
        auth_type: CODEX_CONSTANTS.AUTH_TYPE_OAUTH
      };

      log.info('Authorization code exchanged successfully');
      return tokenData;
    } catch (error) {
      const statusCode = error.response?.status;
      const message = error.response?.data?.error_description || error.message;
      log.error(`Code exchange failed (${statusCode}):`, message);
      throw error;
    }
  }

  /**
   * 获取账号列表（用于管理界面）
   */
  async getAccountList() {
    // 遍历账号并尝试补全邮箱信息
    let needSave = false;

    const result = this.accounts.map(account => {
      // 如果没有邮箱但有 access_token (OAuth 模式)，尝试从 JWT 提取
      let email = account.email;
      if (!email && account.access_token && account.auth_type === CODEX_CONSTANTS.AUTH_TYPE_OAUTH) {
        email = this.extractEmail(account.access_token);
        if (email) {
          // 更新原始账号数据
          account.email = email;
          needSave = true;
        }
      }

      return {
        id: account.id,
        name: account.name || null,
        email: email || null,
        auth_type: account.auth_type || CODEX_CONSTANTS.AUTH_TYPE_API_KEY,
        access_token_suffix: account.access_token
          ? `...${account.access_token.slice(-8)}`
          : (account.api_key ? `...${account.api_key.slice(-8)}` : 'N/A'),
        chatgpt_account_id: account.chatgpt_account_id || null,
        expires_at: account.expires_at || null,
        enable: account.enable !== false,
        timestamp: account.timestamp || null
      };
    });

    // 如果有新提取的邮箱，保存到文件
    if (needSave) {
      this.save().catch(err => log.warn('Failed to save extracted emails:', err.message));
    }

    return result;
  }

  /**
   * 添加账号
   * @param {Object} accountData - 账号数据
   */
  async addAccount(accountData) {
    const id = accountData.id || `codex_${Date.now()}`;
    const authType = accountData.auth_type ||
      (accountData.refresh_token ? CODEX_CONSTANTS.AUTH_TYPE_OAUTH : CODEX_CONSTANTS.AUTH_TYPE_API_KEY);

    // 检查是否已存在
    const existing = this.accounts.find(a =>
      a.id === id ||
      (accountData.access_token && a.access_token === accountData.access_token) ||
      (accountData.api_key && a.api_key === accountData.api_key) ||
      (accountData.chatgpt_account_id && a.chatgpt_account_id === accountData.chatgpt_account_id)
    );

    if (existing) {
      // 更新现有账号
      Object.assign(existing, accountData, {
        id: existing.id,
        auth_type: authType
      });
      await this.save();
      return { success: true, message: 'Account updated', id: existing.id };
    }

    const newAccount = {
      id,
      auth_type: authType,
      access_token: accountData.access_token || null,
      refresh_token: accountData.refresh_token || null,
      api_key: accountData.api_key || null,
      chatgpt_account_id: accountData.chatgpt_account_id || null,
      name: accountData.name || null,
      email: accountData.email || null,
      expires_at: accountData.expires_at || null,
      enable: accountData.enable !== false,
      timestamp: Date.now()
    };

    this.accounts.push(newAccount);
    await this.save();

    return { success: true, message: 'Account added', id };
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

export default CodexTokenManager;
