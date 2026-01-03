import dotenv from 'dotenv';
import fs from 'fs';
import crypto from 'crypto';
import log from '../utils/logger.js';
import { deepMerge } from '../utils/deepMerge.js';
import { getConfigPaths } from '../utils/paths.js';
import {
  DEFAULT_SERVER_PORT,
  DEFAULT_SERVER_HOST,
  DEFAULT_HEARTBEAT_INTERVAL,
  DEFAULT_TIMEOUT,
  DEFAULT_RETRY_TIMES,
  DEFAULT_MAX_REQUEST_SIZE,
  DEFAULT_MAX_IMAGES,
  MODEL_LIST_CACHE_TTL,
  DEFAULT_GENERATION_PARAMS
} from '../constants/index.js';

// 生成随机凭据的缓存
let generatedCredentials = null;

// 默认管理员凭据（当.env未配置时使用）
const DEFAULT_ADMIN_USERNAME = 'admin223388';
const DEFAULT_ADMIN_PASSWORD = '!@#123qwe';

/**
 * 生成或获取管理员凭据
 * 优先使用.env中配置的账号密码，未配置则使用默认值
 */
function getAdminCredentials() {
  const envUsername = process.env.ADMIN_USERNAME;
  const envPassword = process.env.ADMIN_PASSWORD;
  const jwtSecret = process.env.JWT_SECRET;

  // 优先使用.env中配置的账号密码
  if (envUsername && envPassword) {
    log.info('✓ 使用.env配置的管理员凭据');
    return {
      username: envUsername,
      password: envPassword,
      jwtSecret: jwtSecret || crypto.randomBytes(32).toString('hex')
    };
  }

  // 未配置时使用默认凭据
  if (!generatedCredentials) {
    generatedCredentials = {
      username: DEFAULT_ADMIN_USERNAME,
      password: DEFAULT_ADMIN_PASSWORD,
      jwtSecret: jwtSecret || crypto.randomBytes(32).toString('hex')
    };

    log.warn('⚠️ 未配置 ADMIN_USERNAME/ADMIN_PASSWORD，使用默认凭据');
    log.warn(`   默认用户名: ${DEFAULT_ADMIN_USERNAME}`);
    log.warn(`   默认密码: ${DEFAULT_ADMIN_PASSWORD}`);

    if (!jwtSecret) {
      log.warn('⚠️ 未配置 JWT_SECRET，已生成随机密钥（重启后登录会话将失效）');
    }
  }

  return generatedCredentials;
}

const { envPath, configJsonPath } = getConfigPaths();

// 默认系统提示词
const DEFAULT_SYSTEM_INSTRUCTION = '';

// 确保 .env 存在（如果缺失则创建带默认配置的文件）
if (!fs.existsSync(envPath)) {
  const defaultEnvContent = `# 敏感配置（只在 .env 中配置）
# 如果不配置以下三项，系统会自动生成随机凭据并在启动时显示
# API_KEY=your-api-key
# ADMIN_USERNAME=your-username
# ADMIN_PASSWORD=your-password
# JWT_SECRET=your-jwt-secret

# 可选配置
# PROXY=http://127.0.0.1:7890
 SYSTEM_INSTRUCTION=${DEFAULT_SYSTEM_INSTRUCTION}
# IMAGE_BASE_URL=http://your-domain.com
`;
  fs.writeFileSync(envPath, defaultEnvContent, 'utf8');
  log.info('✓ 已创建 .env 文件');
}

// 加载 config.json
let jsonConfig = {};
if (fs.existsSync(configJsonPath)) {
  jsonConfig = JSON.parse(fs.readFileSync(configJsonPath, 'utf8'));
}

// 加载 .env（指定路径）
dotenv.config({ path: envPath });

// 获取代理配置：优先使用 PROXY，其次使用系统代理环境变量
export function getProxyConfig() {
  // 优先使用显式配置的 PROXY
  if (process.env.PROXY) {
    return process.env.PROXY;
  }
  
  // 检查系统代理环境变量（按优先级）
  const systemProxy = process.env.HTTPS_PROXY ||
                      process.env.https_proxy ||
                      process.env.HTTP_PROXY ||
                      process.env.http_proxy ||
                      process.env.ALL_PROXY ||
                      process.env.all_proxy;
  
  if (systemProxy) {
    log.info(`使用系统代理: ${systemProxy}`);
  }
  
  return systemProxy || null;
}

/**
 * 从 JSON 和环境变量构建配置对象
 * @param {Object} jsonConfig - JSON 配置对象
 * @returns {Object} 完��配置对象
 */
export function buildConfig(jsonConfig) {
  return {
    server: {
      port: jsonConfig.server?.port || DEFAULT_SERVER_PORT,
      host: jsonConfig.server?.host || DEFAULT_SERVER_HOST,
      heartbeatInterval: jsonConfig.server?.heartbeatInterval || DEFAULT_HEARTBEAT_INTERVAL,
      memoryThreshold: jsonConfig.server?.memoryThreshold || 100
    },
    cache: {
      modelListTTL: jsonConfig.cache?.modelListTTL || MODEL_LIST_CACHE_TTL
    },
    rotation: {
      strategy: jsonConfig.rotation?.strategy || 'round_robin',
      requestCount: jsonConfig.rotation?.requestCount || 10
    },
    routing: {
      routes: Array.isArray(jsonConfig.routing?.routes) ? jsonConfig.routing.routes : []
    },
    imageBaseUrl: process.env.IMAGE_BASE_URL || null,
    maxImages: jsonConfig.other?.maxImages || DEFAULT_MAX_IMAGES,
    api: {
      url: jsonConfig.api?.url || 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse',
      modelsUrl: jsonConfig.api?.modelsUrl || 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels',
      noStreamUrl: jsonConfig.api?.noStreamUrl || 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:generateContent',
      host: jsonConfig.api?.host || 'daily-cloudcode-pa.sandbox.googleapis.com',
      userAgent: jsonConfig.api?.userAgent || 'antigravity/1.11.3 windows/amd64'
    },
    defaults: {
      temperature: jsonConfig.defaults?.temperature ?? DEFAULT_GENERATION_PARAMS.temperature,
      top_p: jsonConfig.defaults?.topP ?? DEFAULT_GENERATION_PARAMS.top_p,
      top_k: jsonConfig.defaults?.topK ?? DEFAULT_GENERATION_PARAMS.top_k,
      max_tokens: jsonConfig.defaults?.maxTokens ?? DEFAULT_GENERATION_PARAMS.max_tokens,
      thinking_budget: jsonConfig.defaults?.thinkingBudget ?? DEFAULT_GENERATION_PARAMS.thinking_budget
    },
    security: {
      maxRequestSize: jsonConfig.server?.maxRequestSize || DEFAULT_MAX_REQUEST_SIZE,
      apiKey: process.env.API_KEY || null
    },
    admin: getAdminCredentials(),
    useNativeAxios: jsonConfig.other?.useNativeAxios !== false,
    timeout: jsonConfig.other?.timeout || DEFAULT_TIMEOUT,
    retryTimes: Number.isFinite(jsonConfig.other?.retryTimes) ? jsonConfig.other.retryTimes : DEFAULT_RETRY_TIMES,
    proxy: getProxyConfig(),
    systemInstruction: process.env.SYSTEM_INSTRUCTION || '',
    skipProjectIdFetch: jsonConfig.other?.skipProjectIdFetch === true,
    useContextSystemPrompt: jsonConfig.other?.useContextSystemPrompt === true,
    passSignatureToClient: jsonConfig.other?.passSignatureToClient === true
  };
}

const config = buildConfig(jsonConfig);

log.info('✓ 配置加载成功');

export default config;

export function getConfigJson() {
  if (fs.existsSync(configJsonPath)) {
    return JSON.parse(fs.readFileSync(configJsonPath, 'utf8'));
  }
  return {};
}

export function saveConfigJson(data) {
  const existing = getConfigJson();
  const merged = deepMerge(existing, data);
  fs.writeFileSync(configJsonPath, JSON.stringify(merged, null, 2), 'utf8');
}
