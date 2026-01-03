/**
 * Claude API 路由
 * 处理 /v1/messages 端点
 */

import { Router } from 'express';
import { handleClaudeRequest } from '../server/handlers/claude.js';

const router = Router();

/**
 * POST /v1/messages
 * 处理 Claude 消息请求
 */
router.post('/messages', (req, res) => {
  const isStream = req.body.stream === true;
  handleClaudeRequest(req, res, isStream);
});

export default router;