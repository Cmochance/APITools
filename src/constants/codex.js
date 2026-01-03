/**
 * OpenAI Codex/ChatGPT OAuth 相关常量
 * 从 ACC (opencode-openai-codex-auth) 项目移植
 * 支持 OAuth + API Key 双模式
 */

export const CODEX_CONSTANTS = {
  // OAuth URLs
  CLIENT_ID: 'app_EMoamEEZ73f0CkXaXp7hrann',
  AUTHORIZE_URL: 'https://auth.openai.com/oauth/authorize',
  TOKEN_URL: 'https://auth.openai.com/oauth/token',
  REDIRECT_URI: 'http://localhost:1455/auth/callback',
  SCOPE: 'openid profile email offline_access',

  // API URLs
  BASE_URL: 'https://chatgpt.com/backend-api',
  CODEX_RESPONSES_URL: 'https://chatgpt.com/backend-api/codex/responses',
  PLATFORM_API_URL: 'https://api.openai.com/v1',

  // 默认配置
  DEFAULT_MODEL: 'gpt-4o',
  AXIOS_TIMEOUT: 300000, // 5 分钟超时

  // HTTP Headers
  OPENAI_BETA: 'responses=experimental',
  ORIGINATOR: 'codex_cli_rs',

  // JWT Claim Path
  JWT_CLAIM_PATH: 'https://api.openai.com/auth',

  // Token 过期提前量（10分钟，毫秒）
  TOKEN_REFRESH_BUFFER: 10 * 60 * 1000,

  // 认证类型
  AUTH_TYPE_OAUTH: 'oauth',
  AUTH_TYPE_API_KEY: 'api_key'
};

/**
 * Codex 支持的模型列表 (2025)
 * GPT-5 系列: gpt-5.2, gpt-5.2-codex, gpt-5.1-codex-max, gpt-5.1-codex-mini
 * 以及向后兼容的模型
 */
export const CODEX_MODELS = [
  // GPT-5 Codex 系列 (最新)
  'gpt-5.2',
  'gpt-5.2-codex',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex-mini',
  // GPT-4o 系列 (兼容)
  'gpt-4o',
  'gpt-4o-mini',
  // o 系列推理模型
  'o3-mini',
  'o4-mini'
];

/**
 * Codex 账号结构定义
 * @typedef {Object} CodexAccount
 * @property {string} id - 账号唯一标识
 * @property {string} [access_token] - 访问令牌 (OAuth 模式)
 * @property {string} [refresh_token] - 刷新令牌 (OAuth 模式)
 * @property {string} [api_key] - API Key (API Key 模式)
 * @property {string} auth_type - 认证类型 ('oauth' | 'api_key')
 * @property {string} [chatgpt_account_id] - ChatGPT 账号 ID (OAuth 模式)
 * @property {string} [email] - 账号邮箱
 * @property {string} [name] - 账号名称
 * @property {number} [expires_at] - 过期时间戳 (毫秒)
 * @property {boolean} [enable] - 是否启用
 * @property {number} [timestamp] - 添加时间戳
 */

export default {
  CODEX_CONSTANTS,
  CODEX_MODELS
};
