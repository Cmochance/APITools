// 简单内存缓存：按 sessionId + model 维度缓存思维链签名和工具签名
// 同时集成内存管理器，在压力较高时自动收缩/清空缓存

import memoryManager, { MemoryPressure } from './memoryManager.js';

const reasoningSignatureCache = new Map();
const toolSignatureCache = new Map();

// 正常情况下允许的最大条目数（低压力时）
const MAX_REASONING_ENTRIES = 256;
const MAX_TOOL_ENTRIES = 256;

// 过期时间与定时清理间隔（毫秒）
const ENTRY_TTL_MS = 30 * 60 * 1000;      // 30 分钟
const CLEAN_INTERVAL_MS = 10 * 60 * 1000; // 每 10 分钟扫一遍

function makeKey(sessionId, model) {
  return `${sessionId || ''}::${model || ''}`;
}

function pruneMap(map, targetSize) {
  if (map.size <= targetSize) return;
  const removeCount = map.size - targetSize;
  let removed = 0;
  for (const key of map.keys()) {
    map.delete(key);
    removed++;
    if (removed >= removeCount) break;
  }
}

function pruneExpired(map, now) {
  for (const [key, entry] of map.entries()) {
    if (!entry || typeof entry.ts !== 'number') continue;
    if (now - entry.ts > ENTRY_TTL_MS) {
      map.delete(key);
    }
  }
}

// 注册到内存管理器，在不同压力级别下自动清理缓存
memoryManager.registerCleanup((pressure) => {
  if (pressure === MemoryPressure.MEDIUM) {
    // 中等压力：收缩到一半容量
    pruneMap(reasoningSignatureCache, Math.floor(MAX_REASONING_ENTRIES / 2));
    pruneMap(toolSignatureCache, Math.floor(MAX_TOOL_ENTRIES / 2));
  } else if (pressure === MemoryPressure.HIGH) {
    // 高压力：大幅收缩
    pruneMap(reasoningSignatureCache, Math.floor(MAX_REASONING_ENTRIES / 4));
    pruneMap(toolSignatureCache, Math.floor(MAX_TOOL_ENTRIES / 4));
  } else if (pressure === MemoryPressure.CRITICAL) {
    // 紧急压力：直接清空，优先保活
    reasoningSignatureCache.clear();
    toolSignatureCache.clear();
  }
});

// 定时清理：不依赖压力等级，按 TTL 移除过期签名
setInterval(() => {
  const now = Date.now();
  pruneExpired(reasoningSignatureCache, now);
  pruneExpired(toolSignatureCache, now);
}, CLEAN_INTERVAL_MS).unref?.();

export function setReasoningSignature(sessionId, model, signature) {
  if (!signature) return;
  const key = makeKey(sessionId, model);
  reasoningSignatureCache.set(key, { signature, ts: Date.now() });
  // 防止在低压力下无限增长
  pruneMap(reasoningSignatureCache, MAX_REASONING_ENTRIES);
}

export function getReasoningSignature(sessionId, model) {
  const key = makeKey(sessionId, model);
  const entry = reasoningSignatureCache.get(key);
  if (!entry) return null;
  const now = Date.now();
  if (typeof entry.ts === 'number' && now - entry.ts > ENTRY_TTL_MS) {
    reasoningSignatureCache.delete(key);
    return null;
  }
  return entry.signature || null;
}

export function setToolSignature(sessionId, model, signature) {
  if (!signature) return;
  const key = makeKey(sessionId, model);
  toolSignatureCache.set(key, { signature, ts: Date.now() });
  pruneMap(toolSignatureCache, MAX_TOOL_ENTRIES);
}

export function getToolSignature(sessionId, model) {
  const key = makeKey(sessionId, model);
  const entry = toolSignatureCache.get(key);
  if (!entry) return null;
  const now = Date.now();
  if (typeof entry.ts === 'number' && now - entry.ts > ENTRY_TTL_MS) {
    toolSignatureCache.delete(key);
    return null;
  }
  return entry.signature || null;
}

// 预留：手动清理接口（目前未在外部使用，但方便将来扩展）
export function clearThoughtSignatureCaches() {
  reasoningSignatureCache.clear();
  toolSignatureCache.clear();
}
