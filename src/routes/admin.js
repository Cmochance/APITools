import express from 'express';
import crypto from 'crypto';
import { generateToken, authMiddleware } from '../auth/jwt.js';
import tokenManager from '../auth/token_manager.js';
import quotaManager from '../auth/quota_manager.js';
import oauthManager from '../auth/oauth_manager.js';
import config, { getConfigJson, saveConfigJson } from '../config/config.js';
// Kiro provider import
import kiroProvider from '../providers/kiro.js';
import logger from '../utils/logger.js';
import { parseEnvFile, updateEnvFile } from '../utils/envParser.js';
import { reloadConfig } from '../utils/configReloader.js';
import { deepMerge } from '../utils/deepMerge.js';
import { getModelsWithQuotas, getAvailableModels } from '../api/client.js';
import { getEnvPath } from '../utils/paths.js';
import dotenv from 'dotenv';

const envPath = getEnvPath();

const router = express.Router();

// 登录速率限制 - 防止暴力破解
const loginAttempts = new Map(); // IP -> { count, lastAttempt, blockedUntil }
const MAX_LOGIN_ATTEMPTS = 5;
const BLOCK_DURATION = 5 * 60 * 1000; // 5分钟
const ATTEMPT_WINDOW = 15 * 60 * 1000; // 15分钟窗口

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
         req.headers['x-real-ip'] ||
         req.connection?.remoteAddress ||
         req.ip ||
         'unknown';
}

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const attempt = loginAttempts.get(ip);
  
  if (!attempt) return { allowed: true };
  
  // 检查是否被封禁
  if (attempt.blockedUntil && now < attempt.blockedUntil) {
    const remainingSeconds = Math.ceil((attempt.blockedUntil - now) / 1000);
    return {
      allowed: false,
      message: `登录尝试过多，请 ${remainingSeconds} 秒后重试`,
      remainingSeconds
    };
  }
  
  // 清理过期的尝试记录
  if (now - attempt.lastAttempt > ATTEMPT_WINDOW) {
    loginAttempts.delete(ip);
    return { allowed: true };
  }
  
  return { allowed: true };
}

function recordLoginAttempt(ip, success) {
  const now = Date.now();
  
  if (success) {
    // 登录成功，清除记录
    loginAttempts.delete(ip);
    return;
  }
  
  // 登录失败，记录尝试
  const attempt = loginAttempts.get(ip) || { count: 0, lastAttempt: now };
  attempt.count++;
  attempt.lastAttempt = now;
  
  // 超过最大尝试次数，封禁
  if (attempt.count >= MAX_LOGIN_ATTEMPTS) {
    attempt.blockedUntil = now + BLOCK_DURATION;
    logger.warn(`IP ${ip} 因登录失败次数过多被暂时封禁`);
  }
  
  loginAttempts.set(ip, attempt);
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function generateApiKey() {
  return crypto.randomBytes(32).toString('base64').replace(/[+/=]/g, '');
}

function normalizeCustomApiKey(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length < 8 || trimmed.length > 256) return null;
  if (/\s/.test(trimmed)) return null;
  return trimmed;
}

function validateRouteId(routeId) {
  if (!routeId || typeof routeId !== 'string') return false;
  const trimmed = routeId.trim();
  if (!trimmed) return false;
  if (trimmed.length > 64) return false;
  if (trimmed === 'master') return false;
  return /^[a-zA-Z0-9_-]+$/.test(trimmed);
}

function getRoutingRoutesFromConfig(jsonData) {
  return Array.isArray(jsonData?.routing?.routes) ? jsonData.routing.routes : [];
}

function normalizeModels(models) {
  if (!Array.isArray(models)) return [];
  return Array.from(new Set(models
    .filter(m => typeof m === 'string')
    .map(m => m.trim())
    .filter(Boolean)));
}

function normalizeAliases(aliases) {
  if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) return {};
  const out = {};
  for (const [k, v] of Object.entries(aliases)) {
    const key = typeof k === 'string' ? k.trim() : '';
    const val = typeof v === 'string' ? v.trim() : '';
    if (key && val) out[key] = val;
  }
  return out;
}

/**
 * 解析非负整数，支持字符串或数字输入
 */
function parseNonNegativeInt(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const num = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(num)) return fallback;
  const intVal = Math.floor(num);
  if (intVal < 0) return fallback;
  return intVal;
}

/**
 * 规范化单个限额配置项
 * 支持旧格式（纯数字）和新格式（对象: { total, period, periodLimit }）
 */
function normalizeSingleLimit(value) {
  if (value === undefined || value === null) return null;
  
  // 旧格式：纯数字，表示总限额
  if (typeof value === 'number') {
    const intVal = Math.floor(value);
    if (intVal < 0) return null;
    return { total: intVal, period: null, periodLimit: null, expireAt: null };
  }
  
  // 旧格式：字符串数字
  if (typeof value === 'string') {
    const num = Number(value);
    if (Number.isFinite(num) && num >= 0) {
      return { total: Math.floor(num), period: null, periodLimit: null, expireAt: null };
    }
    return null;
  }
  
  // 新格式：对象
  if (typeof value === 'object' && !Array.isArray(value)) {
    const total = parseNonNegativeInt(value.total, null);
    const validPeriods = ['daily', 'weekly', 'monthly'];
    const period = validPeriods.includes(value.period) ? value.period : null;
    const periodLimit = period ? parseNonNegativeInt(value.periodLimit, null) : null;
    const expireAt = parseNonNegativeInt(value.expireAt, null);
    
    // 至少需要一个有效限制
    if (total === null && periodLimit === null && expireAt === null) return null;
    
    return { total, period, periodLimit, expireAt };
  }
  
  return null;
}

function normalizeModelLimits(modelLimits, models) {
  if (!modelLimits || typeof modelLimits !== 'object' || Array.isArray(modelLimits)) return {};
  const modelSet = new Set(Array.isArray(models) ? models : []);
  const out = {};
  for (const [k, v] of Object.entries(modelLimits)) {
    const key = typeof k === 'string' ? k.trim() : '';
    if (!key || !modelSet.has(key)) continue;
    const normalized = normalizeSingleLimit(v);
    if (normalized) {
      out[key] = normalized;
    }
  }
  return out;
}

/**
 * 规范化单个使用量条目
 * 支持旧格式（纯数字）和新格式（对象: { totalUsed, periodUsed, lastReset }）
 */
function normalizeSingleUsage(value) {
  if (value === undefined || value === null) {
    return { totalUsed: 0, periodUsed: 0, lastReset: 0 };
  }
  
  // 旧格式：纯数字，表示总使用量
  if (typeof value === 'number') {
    return { totalUsed: Math.max(0, Math.floor(value)), periodUsed: 0, lastReset: 0 };
  }
  
  // 旧格式：字符串数字
  if (typeof value === 'string') {
    const num = Number(value);
    if (Number.isFinite(num)) {
      return { totalUsed: Math.max(0, Math.floor(num)), periodUsed: 0, lastReset: 0 };
    }
    return { totalUsed: 0, periodUsed: 0, lastReset: 0 };
  }
  
  // 新格式：对象
  if (typeof value === 'object' && !Array.isArray(value)) {
    return {
      totalUsed: parseNonNegativeInt(value.totalUsed, 0),
      periodUsed: parseNonNegativeInt(value.periodUsed, 0),
      lastReset: parseNonNegativeInt(value.lastReset, 0)
    };
  }
  
  return { totalUsed: 0, periodUsed: 0, lastReset: 0 };
}

function mergeModelUsage(existingUsage, models) {
  const usage = (existingUsage && typeof existingUsage === 'object' && !Array.isArray(existingUsage)) ? existingUsage : {};
  const out = {};
  const list = Array.isArray(models) ? models : [];
  for (const m of list) {
    out[m] = normalizeSingleUsage(usage[m]);
  }
  return out;
}

// 登录接口
router.post('/login', (req, res) => {
  const clientIP = getClientIP(req);
  
  // 检查速率限制
  const rateCheck = checkLoginRateLimit(clientIP);
  if (!rateCheck.allowed) {
    return res.status(429).json({
      success: false,
      message: rateCheck.message,
      retryAfter: rateCheck.remainingSeconds
    });
  }
  
  const { username, password } = req.body;
  
  // 验证输入
  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ success: false, message: '用户名和密码必填' });
  }
  
  // 限制输入长度防止 DoS
  if (username.length > 100 || password.length > 100) {
    return res.status(400).json({ success: false, message: '输入过长' });
  }
  
  if (username === config.admin.username && password === config.admin.password) {
    recordLoginAttempt(clientIP, true);
    const token = generateToken({ username, role: 'admin' });
    res.json({ success: true, token });
  } else {
    recordLoginAttempt(clientIP, false);
    res.status(401).json({ success: false, message: '用户名或密码错误' });
  }
});

// Token管理API - 需要JWT认证
router.get('/tokens', authMiddleware, async (req, res) => {
  try {
    const tokens = await tokenManager.getTokenList();
    res.json({ success: true, data: tokens });
  } catch (error) {
    logger.error('获取Token列表失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/tokens', authMiddleware, async (req, res) => {
  const { access_token, refresh_token, expires_in, timestamp, enable, projectId, email } = req.body;
  if (!access_token || !refresh_token) {
    return res.status(400).json({ success: false, message: 'access_token和refresh_token必填' });
  }
  const tokenData = { access_token, refresh_token, expires_in };
  if (timestamp) tokenData.timestamp = timestamp;
  if (enable !== undefined) tokenData.enable = enable;
  if (projectId) tokenData.projectId = projectId;
  if (email) tokenData.email = email;
  
  try {
    const result = await tokenManager.addToken(tokenData);
    res.json(result);
  } catch (error) {
    logger.error('添加Token失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/tokens/:refreshToken', authMiddleware, async (req, res) => {
  const { refreshToken } = req.params;
  const updates = req.body;
  try {
    const result = await tokenManager.updateToken(refreshToken, updates);
    res.json(result);
  } catch (error) {
    logger.error('更新Token失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.delete('/tokens/:refreshToken', authMiddleware, async (req, res) => {
  const { refreshToken } = req.params;
  try {
    const result = await tokenManager.deleteToken(refreshToken);
    res.json(result);
  } catch (error) {
    logger.error('删除Token失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/tokens/reload', authMiddleware, async (req, res) => {
  try {
    await tokenManager.reload();
    res.json({ success: true, message: 'Token已热重载' });
  } catch (error) {
    logger.error('热重载失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 刷新指定Token的access_token
router.post('/tokens/:refreshToken/refresh', authMiddleware, async (req, res) => {
  const { refreshToken } = req.params;
  try {
    logger.info('正在刷新token...');
    const tokens = await tokenManager.getTokenList();
    const tokenData = tokens.find(t => t.refresh_token === refreshToken);
    
    if (!tokenData) {
      return res.status(404).json({ success: false, message: 'Token不存在' });
    }
    
    // 调用 tokenManager 的刷新方法
    const refreshedToken = await tokenManager.refreshToken(tokenData);
    res.json({ success: true, message: 'Token刷新成功', data: { expires_in: refreshedToken.expires_in, timestamp: refreshedToken.timestamp } });
  } catch (error) {
    logger.error('刷新Token失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/oauth/exchange', authMiddleware, async (req, res) => {
  const { code, port } = req.body;
  if (!code || !port) {
    return res.status(400).json({ success: false, message: 'code和port必填' });
  }
  
  try {
    const account = await oauthManager.authenticate(code, port);
    const message = account.hasQuota 
      ? 'Token添加成功' 
      : 'Token添加成功（该账号无资格，已自动使用随机ProjectId）';
    res.json({ success: true, data: account, message, fallbackMode: !account.hasQuota });
  } catch (error) {
    logger.error('认证失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 获取配置
router.get('/config', authMiddleware, (req, res) => {
  try {
    const envData = parseEnvFile(envPath);
    const jsonData = getConfigJson();
    res.json({ success: true, data: { env: envData, json: jsonData } });
  } catch (error) {
    logger.error('读取配置失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 更新配置
router.put('/config', authMiddleware, async (req, res) => {
  try {
    const { env: envUpdates, json: jsonUpdates } = req.body;
    
    if (envUpdates) updateEnvFile(envPath, envUpdates);
    if (jsonUpdates) saveConfigJson(deepMerge(getConfigJson(), jsonUpdates));
    
    dotenv.config({ path: envPath, override: true });
    reloadConfig();
    
    logger.info('配置已更新并热重载');
    res.json({ success: true, message: '配置已保存并生效（端口/HOST修改需重启）' });
  } catch (error) {
    logger.error('更新配置失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/models', authMiddleware, async (req, res) => {
  try {
    const models = await getAvailableModels();
    res.json({ success: true, data: models });
  } catch (error) {
    logger.error('获取模型列表失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/routing/routes', authMiddleware, (req, res) => {
  try {
    const jsonData = getConfigJson();
    const routes = getRoutingRoutesFromConfig(jsonData).map(route => ({
      id: route?.id,
      name: route?.name,
      models: Array.isArray(route?.models) ? route.models : [],
      aliases: (route?.aliases && typeof route.aliases === 'object' && !Array.isArray(route.aliases)) ? route.aliases : {},
      apiKeyHashes: Array.isArray(route?.apiKeyHashes) ? route.apiKeyHashes : [],
      modelLimits: (route?.modelLimits && typeof route.modelLimits === 'object' && !Array.isArray(route.modelLimits)) ? route.modelLimits : {},
      modelUsage: (route?.modelUsage && typeof route.modelUsage === 'object' && !Array.isArray(route.modelUsage)) ? route.modelUsage : {}
    }));
    res.json({ success: true, data: routes });
  } catch (error) {
    logger.error('读取路由失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/routing/routes', authMiddleware, (req, res) => {
  try {
    const { id, name, models, aliases, modelLimits } = req.body || {};

    if (!validateRouteId(id)) {
      return res.status(400).json({ success: false, message: '无效的路由ID，仅允许字母/数字/_/-，长度<=64，且不能为 master' });
    }
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ success: false, message: 'name必填' });
    }

    const jsonData = getConfigJson();
    const routes = getRoutingRoutesFromConfig(jsonData);
    if (routes.some(r => (r?.id || '').toString() === id.trim())) {
      return res.status(400).json({ success: false, message: '路由ID已存在' });
    }

    const normalizedModels = normalizeModels(models);
    const normalizedLimits = normalizeModelLimits(modelLimits, normalizedModels);
    const route = {
      id: id.trim(),
      name: name.trim(),
      models: normalizedModels,
      aliases: normalizeAliases(aliases),
      apiKeyHashes: [],
      modelLimits: normalizedLimits,
      modelUsage: mergeModelUsage({}, normalizedModels)
    };

    saveConfigJson({ routing: { routes: [...routes, route] } });
    reloadConfig();
    res.json({ success: true, data: route });
  } catch (error) {
    logger.error('创建路由失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/routing/routes/:routeId', authMiddleware, (req, res) => {
  try {
    const { routeId } = req.params;
    if (!validateRouteId(routeId)) {
      return res.status(400).json({ success: false, message: '无效的路由ID' });
    }

    const { name, models, aliases, modelLimits } = req.body || {};
    const jsonData = getConfigJson();
    const routes = getRoutingRoutesFromConfig(jsonData);
    const idx = routes.findIndex(r => (r?.id || '').toString() === routeId);
    if (idx === -1) {
      return res.status(404).json({ success: false, message: '路由不存在' });
    }

    const existing = routes[idx] || {};
    const normalizedModels = models !== undefined ? normalizeModels(models) : (Array.isArray(existing.models) ? existing.models : []);
    const nextLimits = modelLimits !== undefined
      ? normalizeModelLimits(modelLimits, normalizedModels)
      : normalizeModelLimits(existing.modelLimits, normalizedModels);
    const nextUsage = mergeModelUsage(existing.modelUsage, normalizedModels);
    const updated = {
      ...existing,
      name: name !== undefined ? (typeof name === 'string' ? name.trim() : '') : existing.name,
      models: normalizedModels,
      aliases: aliases !== undefined ? normalizeAliases(aliases) : ((existing.aliases && typeof existing.aliases === 'object' && !Array.isArray(existing.aliases)) ? existing.aliases : {}),
      modelLimits: nextLimits,
      modelUsage: nextUsage
    };

    if (!updated.name || typeof updated.name !== 'string' || !updated.name.trim()) {
      return res.status(400).json({ success: false, message: 'name必填' });
    }
    updated.name = updated.name.trim();

    routes[idx] = updated;
    saveConfigJson({ routing: { routes } });
    reloadConfig();
    res.json({ success: true, data: updated });
  } catch (error) {
    logger.error('更新路由失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.delete('/routing/routes/:routeId', authMiddleware, (req, res) => {
  try {
    const { routeId } = req.params;
    if (!validateRouteId(routeId)) {
      return res.status(400).json({ success: false, message: '无效的路由ID' });
    }

    const jsonData = getConfigJson();
    const routes = getRoutingRoutesFromConfig(jsonData);
    const nextRoutes = routes.filter(r => (r?.id || '').toString() !== routeId);
    if (nextRoutes.length === routes.length) {
      return res.status(404).json({ success: false, message: '路由不存在' });
    }

    saveConfigJson({ routing: { routes: nextRoutes } });
    reloadConfig();
    res.json({ success: true });
  } catch (error) {
    logger.error('删除路由失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/routing/routes/:routeId/keys', authMiddleware, (req, res) => {
  try {
    const { routeId } = req.params;
    if (!validateRouteId(routeId)) {
      return res.status(400).json({ success: false, message: '无效的路由ID' });
    }

    const jsonData = getConfigJson();
    const routes = getRoutingRoutesFromConfig(jsonData);
    const idx = routes.findIndex(r => (r?.id || '').toString() === routeId);
    if (idx === -1) {
      return res.status(404).json({ success: false, message: '路由不存在' });
    }

    const rawApiKey = req.body?.apiKey;
    let customApiKey = null;
    if (rawApiKey !== undefined && rawApiKey !== null) {
      if (typeof rawApiKey !== 'string') {
        return res.status(400).json({ success: false, message: '自定义Key必须是字符串' });
      }
      const trimmed = rawApiKey.trim();
      if (trimmed) {
        customApiKey = normalizeCustomApiKey(trimmed);
        if (!customApiKey) {
          return res.status(400).json({ success: false, message: '自定义Key格式无效（长度8~256，不能包含空白字符）' });
        }
      }
    }
    const apiKey = customApiKey || generateApiKey();

    const masterKey = config.security?.apiKey;
    if (masterKey && apiKey === masterKey) {
      return res.status(400).json({ success: false, message: '该Key与主API Key冲突，请更换' });
    }

    const keyHash = sha256Hex(apiKey);
    for (const r of routes) {
      const apiKeys = Array.isArray(r.apiKeys)
        ? r.apiKeys
        : (Array.isArray(r.keys) ? r.keys : []);
      const apiKeyHashes = Array.isArray(r.apiKeyHashes) ? r.apiKeyHashes : [];
      if (apiKeys.includes(apiKey) || apiKeyHashes.includes(keyHash)) {
        return res.status(400).json({ success: false, message: 'Key已存在，请更换' });
      }
    }

    const existing = routes[idx] || {};
    const apiKeyHashes = Array.isArray(existing.apiKeyHashes) ? existing.apiKeyHashes : [];
    routes[idx] = {
      ...existing,
      apiKeyHashes: Array.from(new Set([...apiKeyHashes, keyHash]))
    };

    saveConfigJson({ routing: { routes } });
    reloadConfig();
    res.json({ success: true, data: { apiKey, keyHash } });
  } catch (error) {
    logger.error('生成Key失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.delete('/routing/routes/:routeId/keys/:keyHash', authMiddleware, (req, res) => {
  try {
    const { routeId, keyHash } = req.params;
    if (!validateRouteId(routeId)) {
      return res.status(400).json({ success: false, message: '无效的路由ID' });
    }
    if (!keyHash || typeof keyHash !== 'string' || keyHash.length !== 64) {
      return res.status(400).json({ success: false, message: '无效的keyHash' });
    }

    const jsonData = getConfigJson();
    const routes = getRoutingRoutesFromConfig(jsonData);
    const idx = routes.findIndex(r => (r?.id || '').toString() === routeId);
    if (idx === -1) {
      return res.status(404).json({ success: false, message: '路由不存在' });
    }

    const existing = routes[idx] || {};
    const apiKeyHashes = Array.isArray(existing.apiKeyHashes) ? existing.apiKeyHashes : [];
    const nextHashes = apiKeyHashes.filter(h => h !== keyHash.toLowerCase());
    if (nextHashes.length === apiKeyHashes.length) {
      return res.status(404).json({ success: false, message: 'keyHash不存在' });
    }

    routes[idx] = {
      ...existing,
      apiKeyHashes: nextHashes
    };

    saveConfigJson({ routing: { routes } });
    reloadConfig();
    res.json({ success: true });
  } catch (error) {
    logger.error('吊销Key失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 获取轮询策略配置
router.get('/rotation', authMiddleware, (req, res) => {
  try {
    const rotationConfig = tokenManager.getRotationConfig();
    res.json({ success: true, data: rotationConfig });
  } catch (error) {
    logger.error('获取轮询配置失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 更新轮询策略配置
router.put('/rotation', authMiddleware, (req, res) => {
  try {
    const { strategy, requestCount } = req.body;
    
    // 验证策略值
    const validStrategies = ['round_robin', 'quota_exhausted', 'request_count'];
    if (strategy && !validStrategies.includes(strategy)) {
      return res.status(400).json({
        success: false,
        message: `无效的策略，可选值: ${validStrategies.join(', ')}`
      });
    }
    
    // 更新内存中的配置
    tokenManager.updateRotationConfig(strategy, requestCount);
    
    // 保存到config.json
    const currentConfig = getConfigJson();
    if (!currentConfig.rotation) currentConfig.rotation = {};
    if (strategy) currentConfig.rotation.strategy = strategy;
    if (requestCount) currentConfig.rotation.requestCount = requestCount;
    saveConfigJson(currentConfig);
    
    // 重载配置到内存
    reloadConfig();
    
    logger.info(`轮询策略已更新: ${strategy || '未变'}, 请求次数: ${requestCount || '未变'}`);
    res.json({ success: true, message: '轮询策略已更新', data: tokenManager.getRotationConfig() });
  } catch (error) {
    logger.error('更新轮询配置失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 获取指定Token的模型额度
router.get('/tokens/:refreshToken/quotas', authMiddleware, async (req, res) => {
  try {
    const { refreshToken } = req.params;
    const forceRefresh = req.query.refresh === 'true';
    const tokens = await tokenManager.getTokenList();
    let tokenData = tokens.find(t => t.refresh_token === refreshToken);
    
    if (!tokenData) {
      return res.status(404).json({ success: false, message: 'Token不存在' });
    }
    
    // 检查token是否过期，如果过期则刷新
    if (tokenManager.isExpired(tokenData)) {
      try {
        tokenData = await tokenManager.refreshToken(tokenData);
      } catch (error) {
        logger.error('刷新token失败:', error.message);
        // 使用 400 而不是 401，避免前端误认为 JWT 登录过期
        return res.status(400).json({ success: false, message: 'Google Token已过期且刷新失败，请重新登录Google账号' });
      }
    }
    
    // 先从缓存获取（除非强制刷新）
    let quotaData = forceRefresh ? null : quotaManager.getQuota(refreshToken);
    
    if (!quotaData) {
      // 缓存未命中或强制刷新，从API获取
      const token = { access_token: tokenData.access_token, refresh_token: refreshToken };
      const quotas = await getModelsWithQuotas(token);
      quotaManager.updateQuota(refreshToken, quotas);
      quotaData = { lastUpdated: Date.now(), models: quotas };
    }
    
    // 转换时间为北京时间
    const modelsWithBeijingTime = {};
    Object.entries(quotaData.models).forEach(([modelId, quota]) => {
      modelsWithBeijingTime[modelId] = {
        remaining: quota.r,
        resetTime: quotaManager.convertToBeijingTime(quota.t),
        resetTimeRaw: quota.t
      };
    });
    
    res.json({ 
      success: true, 
      data: { 
        lastUpdated: quotaData.lastUpdated,
        models: modelsWithBeijingTime 
      } 
    });
  } catch (error) {
    logger.error('获取额度失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== Kiro 管理 API ====================

// 获取 Kiro 账号列表
router.get('/kiro/accounts', authMiddleware, async (req, res) => {
  try {
    // 确保 Kiro provider 已初始化
    if (!kiroProvider.initialized) {
      await kiroProvider.initialize();
    }
    const accounts = await kiroProvider.getAccountList();
    res.json({ success: true, data: accounts });
  } catch (error) {
    logger.error('获取Kiro账号列表失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 添加 Kiro 账号
router.post('/kiro/accounts', authMiddleware, async (req, res) => {
  try {
    // 确保 Kiro provider 已初始化
    if (!kiroProvider.initialized) {
      await kiroProvider.initialize();
    }

    const { accessToken, refreshToken, email, profileArn, clientId, clientSecret, authMethod, region, enable } = req.body;

    if (!accessToken || !refreshToken) {
      return res.status(400).json({ success: false, message: 'accessToken和refreshToken必填' });
    }

    const accountData = {
      accessToken,
      refreshToken,
      email: email || null,
      profileArn: profileArn || null,
      clientId: clientId || null,
      clientSecret: clientSecret || null,
      authMethod: authMethod || 'social',
      region: region || 'us-east-1',
      enable: enable !== false
    };

    const result = await kiroProvider.addAccount(accountData);
    res.json(result);
  } catch (error) {
    logger.error('添加Kiro账号失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 更新 Kiro 账号
router.put('/kiro/accounts/:accountId', authMiddleware, async (req, res) => {
  try {
    if (!kiroProvider.initialized) {
      await kiroProvider.initialize();
    }

    const { accountId } = req.params;
    const updates = req.body;

    const result = await kiroProvider.updateAccount(accountId, updates);
    res.json(result);
  } catch (error) {
    logger.error('更新Kiro账号失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 删除 Kiro 账号
router.delete('/kiro/accounts/:accountId', authMiddleware, async (req, res) => {
  try {
    if (!kiroProvider.initialized) {
      await kiroProvider.initialize();
    }

    const { accountId } = req.params;
    const result = await kiroProvider.deleteAccount(accountId);
    res.json(result);
  } catch (error) {
    logger.error('删除Kiro账号失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 刷新 Kiro 账号 Token
router.post('/kiro/accounts/:accountId/refresh', authMiddleware, async (req, res) => {
  try {
    if (!kiroProvider.initialized) {
      await kiroProvider.initialize();
    }

    const { accountId } = req.params;

    // 获取账号列表找到对应账号
    const accounts = await kiroProvider.getAccountList();
    const accountInfo = accounts.find(a => a.id === accountId);

    if (!accountInfo) {
      return res.status(404).json({ success: false, message: 'Kiro账号不存在' });
    }

    // 获取完整账号数据进行刷新
    const fullAccounts = kiroProvider.tokenManager.accounts;
    const account = fullAccounts.find(a => a.id === accountId);

    if (!account) {
      return res.status(404).json({ success: false, message: 'Kiro账号不存在' });
    }

    await kiroProvider.refreshToken(account);
    res.json({ success: true, message: 'Kiro Token刷新成功' });
  } catch (error) {
    logger.error('刷新Kiro Token失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Kiro OAuth 凭据交换（支持 Base64 编码的凭据）
router.post('/kiro/oauth/exchange', authMiddleware, async (req, res) => {
  try {
    if (!kiroProvider.initialized) {
      await kiroProvider.initialize();
    }

    const { base64Credentials, credentials } = req.body;

    let parsedCredentials;

    if (base64Credentials) {
      // 解析 Base64 编码的凭据
      try {
        const decoded = Buffer.from(base64Credentials, 'base64').toString('utf8');
        parsedCredentials = JSON.parse(decoded);
      } catch (e) {
        return res.status(400).json({ success: false, message: 'Base64凭据解析失败' });
      }
    } else if (credentials) {
      parsedCredentials = credentials;
    } else {
      return res.status(400).json({ success: false, message: '请提供base64Credentials或credentials' });
    }

    // 验证必要字段
    if (!parsedCredentials.accessToken || !parsedCredentials.refreshToken) {
      return res.status(400).json({ success: false, message: '凭据缺少accessToken或refreshToken' });
    }

    // 添加账号
    const accountData = {
      accessToken: parsedCredentials.accessToken,
      refreshToken: parsedCredentials.refreshToken,
      email: parsedCredentials.email || null,
      profileArn: parsedCredentials.profileArn || null,
      clientId: parsedCredentials.clientId || null,
      clientSecret: parsedCredentials.clientSecret || null,
      authMethod: parsedCredentials.authMethod || 'social',
      region: parsedCredentials.region || 'us-east-1',
      expiresAt: parsedCredentials.expiresAt || null,
      enable: true
    };

    const result = await kiroProvider.addAccount(accountData);
    res.json({
      success: true,
      message: result.message || 'Kiro账号导入成功',
      data: { email: accountData.email, region: accountData.region }
    });
  } catch (error) {
    logger.error('Kiro OAuth交换失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 重新加载 Kiro 账号
router.post('/kiro/accounts/reload', authMiddleware, async (req, res) => {
  try {
    if (!kiroProvider.initialized) {
      await kiroProvider.initialize();
    }

    await kiroProvider.reload();
    res.json({ success: true, message: 'Kiro账号已热重载' });
  } catch (error) {
    logger.error('Kiro热重载失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 获取 Kiro 支持的模型列表
router.get('/kiro/models', authMiddleware, async (req, res) => {
  try {
    if (!kiroProvider.initialized) {
      await kiroProvider.initialize();
    }

    const models = await kiroProvider.listModels();
    res.json({ success: true, data: models });
  } catch (error) {
    logger.error('获取Kiro模型列表失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== Codex 管理 API ====================

// 导入 Codex provider
import codexProvider from '../providers/codex.js';

// 获取 Codex 账号列表
router.get('/codex/accounts', authMiddleware, async (req, res) => {
  try {
    if (!codexProvider.initialized) {
      await codexProvider.initialize();
    }
    const accounts = await codexProvider.getAccountList();
    res.json({ success: true, data: accounts });
  } catch (error) {
    logger.error('获取Codex账号列表失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 添加 Codex 账号
router.post('/codex/accounts', authMiddleware, async (req, res) => {
  try {
    if (!codexProvider.initialized) {
      await codexProvider.initialize();
    }

    const { access_token, refresh_token, api_key, email, name, auth_type, expires_at, enable } = req.body;

    // 验证必填字段
    if (!access_token && !api_key) {
      return res.status(400).json({ success: false, message: 'access_token 或 api_key 必填其一' });
    }

    const accountData = {
      access_token: access_token || null,
      refresh_token: refresh_token || null,
      api_key: api_key || null,
      email: email || null,
      name: name || null,
      auth_type: auth_type || (refresh_token ? 'oauth' : 'api_key'),
      expires_at: expires_at || null,
      enable: enable !== false
    };

    const result = await codexProvider.addAccount(accountData);
    res.json(result);
  } catch (error) {
    logger.error('添加Codex账号失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 更新 Codex 账号
router.put('/codex/accounts/:accountId', authMiddleware, async (req, res) => {
  try {
    if (!codexProvider.initialized) {
      await codexProvider.initialize();
    }

    const { accountId } = req.params;
    const updates = req.body;

    const result = await codexProvider.updateAccount(accountId, updates);
    res.json(result);
  } catch (error) {
    logger.error('更新Codex账号失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 删除 Codex 账号
router.delete('/codex/accounts/:accountId', authMiddleware, async (req, res) => {
  try {
    if (!codexProvider.initialized) {
      await codexProvider.initialize();
    }

    const { accountId } = req.params;
    const result = await codexProvider.deleteAccount(accountId);
    res.json(result);
  } catch (error) {
    logger.error('删除Codex账号失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 刷新 Codex 账号 Token（仅 OAuth 模式）
router.post('/codex/accounts/:accountId/refresh', authMiddleware, async (req, res) => {
  try {
    if (!codexProvider.initialized) {
      await codexProvider.initialize();
    }

    const { accountId } = req.params;

    // 获取完整账号数据
    const accounts = codexProvider.tokenManager.accounts;
    const account = accounts.find(a => a.id === accountId);

    if (!account) {
      return res.status(404).json({ success: false, message: 'Codex账号不存在' });
    }

    if (account.auth_type !== 'oauth') {
      return res.status(400).json({ success: false, message: 'API Key 模式不支持刷新' });
    }

    await codexProvider.refreshToken(account);
    res.json({ success: true, message: 'Codex Token刷新成功' });
  } catch (error) {
    logger.error('刷新Codex Token失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 重新加载 Codex 账号
router.post('/codex/accounts/reload', authMiddleware, async (req, res) => {
  try {
    if (!codexProvider.initialized) {
      await codexProvider.initialize();
    }

    await codexProvider.reload();
    res.json({ success: true, message: 'Codex账号已热重载' });
  } catch (error) {
    logger.error('Codex热重载失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 获取 Codex 支持的模型列表
router.get('/codex/models', authMiddleware, async (req, res) => {
  try {
    if (!codexProvider.initialized) {
      await codexProvider.initialize();
    }

    const models = await codexProvider.listModels();
    res.json({ success: true, data: models });
  } catch (error) {
    logger.error('获取Codex模型列表失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 获取 Codex 账号的模型额度
router.get('/codex/accounts/:accountId/quotas', authMiddleware, async (req, res) => {
  try {
    if (!codexProvider.initialized) {
      await codexProvider.initialize();
    }

    const { accountId } = req.params;
    const forceRefresh = req.query.refresh === 'true';

    const quotaData = await codexProvider.getAccountQuotas(accountId, forceRefresh);

    // 转换为前端期望的格式
    const models = {};
    Object.entries(quotaData.models || {}).forEach(([modelId, quota]) => {
      models[modelId] = {
        remaining: quota.remaining,
        resetTime: quota.resetTime || '-',
        unlimited: quota.unlimited || false,
        note: quota.note || '',
        balance: quota.balance,
        limit: quota.limit
      };
    });

    res.json({
      success: true,
      data: {
        lastUpdated: quotaData.lastUpdated,
        subscriptionType: quotaData.subscriptionType,
        models
      }
    });
  } catch (error) {
    logger.error('获取Codex账号额度失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// OAuth 授权码交换
router.post('/codex/oauth/exchange', authMiddleware, async (req, res) => {
  try {
    if (!codexProvider.initialized) {
      await codexProvider.initialize();
    }

    const { code, verifier, redirect_uri } = req.body;

    if (!code || !verifier) {
      return res.status(400).json({ success: false, message: 'code 和 verifier 必填' });
    }

    // 交换 Token
    const tokenData = await codexProvider.exchangeAuthorizationCode(code, verifier, redirect_uri);

    // 添加账号
    const result = await codexProvider.addAccount(tokenData);

    res.json({
      success: true,
      message: result.message || 'Codex账号授权成功',
      data: { email: tokenData.email, id: result.id }
    });
  } catch (error) {
    logger.error('Codex OAuth交换失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
