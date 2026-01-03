/**
 * Kiro/CodeWhisperer 相关常量
 * 从 ACB 的 claude-kiro.js 提取
 */

export const KIRO_CONSTANTS = {
  // API URLs ({{region}} 会被替换为实际区域)
  REFRESH_URL: 'https://prod.{{region}}.auth.desktop.kiro.dev/refreshToken',
  REFRESH_IDC_URL: 'https://oidc.{{region}}.amazonaws.com/token',
  BASE_URL: 'https://codewhisperer.{{region}}.amazonaws.com/generateAssistantResponse',
  AMAZON_Q_URL: 'https://codewhisperer.{{region}}.amazonaws.com/SendMessageStreaming',
  USAGE_LIMITS_URL: 'https://q.{{region}}.amazonaws.com/getUsageLimits',

  // 默认配置
  DEFAULT_MODEL_NAME: 'claude-opus-4-5',
  DEFAULT_REGION: 'us-east-1',
  AXIOS_TIMEOUT: 300000, // 5 分钟超时

  // HTTP 头部
  USER_AGENT: 'KiroIDE',
  KIRO_VERSION: '0.7.5',
  CONTENT_TYPE_JSON: 'application/json',
  ACCEPT_JSON: 'application/json',

  // 认证相关
  AUTH_METHOD_SOCIAL: 'social',

  // 请求类型
  CHAT_TRIGGER_TYPE_MANUAL: 'MANUAL',
  ORIGIN_AI_EDITOR: 'AI_EDITOR',

  // 配额类型
  QUOTA_RESOURCE_TYPE: 'AGENTIC_REQUEST'
};

/**
 * 模型映射表
 * 将 OpenAI/Claude 风格的模型名称映射到 Kiro/CodeWhisperer 格式
 */
export const KIRO_MODEL_MAPPING = {
  'claude-opus-4-5': 'claude-opus-4.5',
  'claude-opus-4-5-20251101': 'claude-opus-4.5',
  'claude-haiku-4-5': 'claude-haiku-4.5',
  'claude-sonnet-4-5': 'CLAUDE_SONNET_4_5_20250929_V1_0',
  'claude-sonnet-4-5-20250929': 'CLAUDE_SONNET_4_5_20250929_V1_0',
  'claude-sonnet-4-20250514': 'CLAUDE_SONNET_4_20250514_V1_0',
  'claude-3-7-sonnet-20250219': 'CLAUDE_3_7_SONNET_20250219_V1_0'
};

/**
 * 支持的 Kiro 模型列表
 */
export const KIRO_MODELS = [
  'claude-opus-4-5',
  'claude-opus-4-5-20251101',
  'claude-haiku-4-5',
  'claude-sonnet-4-5',
  'claude-sonnet-4-5-20250929',
  'claude-sonnet-4-20250514',
  'claude-3-7-sonnet-20250219'
];

/**
 * Kiro 账号结构定义
 * @typedef {Object} KiroAccount
 * @property {string} id - 账号唯一标识
 * @property {string} accessToken - 访问令牌
 * @property {string} refreshToken - 刷新令牌
 * @property {string} [email] - 账号邮箱
 * @property {string} [profileArn] - AWS Profile ARN
 * @property {string} [clientId] - 客户端 ID
 * @property {string} [clientSecret] - 客户端密钥
 * @property {string} [authMethod] - 认证方法 (social/idc)
 * @property {string} [region] - AWS 区域
 * @property {string} [expiresAt] - 过期时间 (ISO 字符串)
 * @property {boolean} [enable] - 是否启用
 * @property {number} [timestamp] - 添加时间戳
 */

export default {
  KIRO_CONSTANTS,
  KIRO_MODEL_MAPPING,
  KIRO_MODELS
};
