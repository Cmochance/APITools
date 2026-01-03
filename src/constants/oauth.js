/**
 * Google OAuth 配置
 * 统一管理，避免在多个文件中重复定义和硬编码
 */
export const OAUTH_CONFIG = {
  CLIENT_ID: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
  CLIENT_SECRET: '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',
  TOKEN_URL: 'https://oauth2.googleapis.com/token',
  AUTH_URL: 'https://accounts.google.com/o/oauth2/v2/auth'
};

// 服务器端使用的默认 OAuth Scope 列表
export const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs'
];
