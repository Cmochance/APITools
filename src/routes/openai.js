/**
 * OpenAI API 路由
 * 处理 /v1/chat/completions 和 /v1/models 端点
 */

import { Router } from 'express';
import { getAvailableModels } from '../api/client.js';
import { handleOpenAIRequest } from '../server/handlers/openai.js';
import logger from '../utils/logger.js';
import { CODEX_MODELS } from '../constants/codex.js';

const router = Router();

const mergeCodexModels = (models) => {
  const baseData = Array.isArray(models?.data) ? models.data : [];
  const created = baseData[0]?.created || Math.floor(Date.now() / 1000);
  const merged = [...baseData];
  const seenIds = new Set(merged.map(m => m.id));

  for (const modelId of CODEX_MODELS) {
    if (typeof modelId !== 'string' || !modelId) continue;
    if (!seenIds.has(modelId)) {
      merged.push({ id: modelId, object: 'model', created, owned_by: 'openai' });
      seenIds.add(modelId);
    }
  }

  return { object: 'list', data: merged };
};

/**
 * GET /v1/models
 * 获取可用模型列表
 */
router.get('/models', async (req, res) => {
  try {
    const models = await getAvailableModels();
    const enrichedModels = mergeCodexModels(models);

    const route = req.downstreamRoute;
    if (!route || route.isMaster) {
      return res.json(enrichedModels);
    }

    const allowedActualModels = new Set(Array.isArray(route.models) ? route.models : []);
    const aliasMap = (route.modelAliases && typeof route.modelAliases === 'object') ? route.modelAliases : {};
    const allowedAliasNames = Object.keys(aliasMap);

    const baseData = Array.isArray(enrichedModels?.data) ? enrichedModels.data : [];
    const created = baseData[0]?.created || Math.floor(Date.now() / 1000);

    const filteredModels = [];
    const seenIds = new Set();

    for (const m of baseData) {
      if (m && typeof m.id === 'string' && allowedActualModels.has(m.id) && !seenIds.has(m.id)) {
        filteredModels.push(m);
        seenIds.add(m.id);
      }
    }

    for (const modelId of allowedActualModels) {
      if (typeof modelId === 'string' && modelId.length > 0 && !seenIds.has(modelId)) {
        filteredModels.push({ id: modelId, object: 'model', created, owned_by: 'google' });
        seenIds.add(modelId);
      }
    }

    for (const aliasName of allowedAliasNames) {
      if (typeof aliasName === 'string' && aliasName.length > 0 && !seenIds.has(aliasName)) {
        filteredModels.push({ id: aliasName, object: 'model', created, owned_by: 'google' });
        seenIds.add(aliasName);
      }
    }

    return res.json({ object: 'list', data: filteredModels });
  } catch (error) {
    logger.error('获取模型列表失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /v1/chat/completions
 * 处理聊天补全请求
 */
router.post('/chat/completions', handleOpenAIRequest);

export default router;
