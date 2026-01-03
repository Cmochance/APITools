import axios from 'axios';
import dns from 'dns';
import http from 'http';
import https from 'https';
import createHttpsProxyAgent from 'https-proxy-agent';
import config from '../config/config.js';
import log from './logger.js';

// ==================== DNS & 代理统一配置 ====================

// 自定义 DNS 解析：优先 IPv4，失败则回退 IPv6
function customLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, family: 4 }, (err4, address4, family4) => {
    if (!err4 && address4) {
      return callback(null, address4, family4);
    }
    dns.lookup(hostname, { ...options, family: 6 }, (err6, address6, family6) => {
      if (!err6 && address6) {
        return callback(null, address6, family6);
      }
      callback(err4 || err6);
    });
  });
}

function normalizeProxyUrl(proxy) {
  if (!proxy) return null;
  const trimmed = String(proxy).trim();
  if (!trimmed) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

function sanitizeProxyUrlForLog(proxy) {
  const normalizedProxyUrl = normalizeProxyUrl(proxy);
  if (!normalizedProxyUrl) return '';

  try {
    const proxyUrl = new URL(normalizedProxyUrl);
    if (proxyUrl.username || proxyUrl.password) {
      proxyUrl.password = proxyUrl.password ? '***' : '';
    }
    return proxyUrl.toString();
  } catch {
    return String(proxy).trim();
  }
}

let cachedHttpsProxyUrl = null;
let cachedHttpsProxyAgent = null;
let lastLoggedProxyValue = null;

function getOrCreateHttpsProxyAgent() {
  const normalizedProxyUrl = normalizeProxyUrl(config.proxy);
  if (!normalizedProxyUrl) return null;

  if (normalizedProxyUrl === cachedHttpsProxyUrl && cachedHttpsProxyAgent) {
    return cachedHttpsProxyAgent;
  }

  cachedHttpsProxyUrl = normalizedProxyUrl;
  try {
    cachedHttpsProxyAgent = createHttpsProxyAgent(normalizedProxyUrl);
  } catch (error) {
    cachedHttpsProxyUrl = null;
    cachedHttpsProxyAgent = null;
    log.warn(`创建代理 Agent 失败: ${error.message}`);
    return null;
  }
  return cachedHttpsProxyAgent;
}

function logProxyUsageOnce() {
  if (!config.proxy) return;
  if (config.proxy === lastLoggedProxyValue) return;
  lastLoggedProxyValue = config.proxy;
  const safeProxyUrl = sanitizeProxyUrlForLog(config.proxy);
  log.info(`外部请求使用代理: ${safeProxyUrl}`);
}

// 使用自定义 DNS 解析的 Agent（优先 IPv4，失败则 IPv6）
const httpAgent = new http.Agent({
  lookup: customLookup,
  keepAlive: true
});

const httpsAgent = new https.Agent({
  lookup: customLookup,
  keepAlive: true
});

// 统一构建代理配置
function buildProxyConfig() {
  const normalizedProxyUrl = normalizeProxyUrl(config.proxy);
  if (!normalizedProxyUrl) return false;
  try {
    const proxyUrl = new URL(normalizedProxyUrl);
    const port = proxyUrl.port
      ? parseInt(proxyUrl.port, 10)
      : proxyUrl.protocol === 'https:'
        ? 443
        : 80;

    const proxyConfig = {
      protocol: proxyUrl.protocol.replace(':', ''),
      host: proxyUrl.hostname,
      port
    };

    if (proxyUrl.username || proxyUrl.password) {
      proxyConfig.auth = {
        username: decodeURIComponent(proxyUrl.username),
        password: decodeURIComponent(proxyUrl.password)
      };
    }

    return proxyConfig;
  } catch {
    return false;
  }
}

// 为 axios 构建统一请求配置
export function buildAxiosRequestConfig({ method = 'POST', url, headers, data = null, timeout = config.timeout }) {
  const axiosConfig = {
    method,
    url,
    headers,
    timeout,
    httpAgent,
    httpsAgent,
    proxy: buildProxyConfig()
  };

  const normalizedProxyUrl = normalizeProxyUrl(config.proxy);
  if (normalizedProxyUrl) {
    let protocol = null;
    try {
      protocol = new URL(url).protocol;
    } catch {
      protocol = null;
    }

    if (protocol === 'https:') {
      const proxyAgent = getOrCreateHttpsProxyAgent();
      if (proxyAgent) {
        axiosConfig.proxy = false;
        axiosConfig.httpsAgent = proxyAgent;
        logProxyUsageOnce();
      }
    }
  }

  if (data !== null) axiosConfig.data = data;
  return axiosConfig;
}

// 简单封装 axios 调用，方便后续统一扩展（重试、打点等）
export async function httpRequest(configOverrides) {
  const axiosConfig = buildAxiosRequestConfig(configOverrides);
  return axios(axiosConfig);
}

// 流式请求封装
export async function httpStreamRequest(configOverrides) {
  const axiosConfig = buildAxiosRequestConfig(configOverrides);
  axiosConfig.responseType = 'stream';
  return axios(axiosConfig);
}
