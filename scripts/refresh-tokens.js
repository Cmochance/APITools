import { fileURLToPath } from 'url';
import path from 'path';
import log from '../src/utils/logger.js';
import tokenManager from '../src/auth/token_manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ACCOUNTS_FILE = path.join(__dirname, '..', 'data', 'accounts.json');

async function refreshAllTokens() {
  const tokens = tokenManager.getTokenList();
  if (!tokens || tokens.length === 0) {
    log.warn('未找到可刷新账号');
    return;
  }

  log.info(`找到 ${tokens.length} 个账号`);

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token.enable === false) {
      log.warn(`账号 ${i + 1}: 已禁用，跳过`);
      continue;
    }

    try {
      log.info(`刷新账号 ${i + 1}...`);
      await tokenManager.refreshToken(token);
      successCount++;
      log.info(`账号 ${i + 1}: 刷新成功`);
    } catch (error) {
      failCount++;
      const statusCode = error.statusCode;
      log.error(`账号 ${i + 1}: 刷新失败 - ${error.message}`);

      // 对于 400/403 之类错误，统一禁用该账号，行为与运行时一致
      if (statusCode === 400 || statusCode === 403) {
        tokenManager.disableToken(token);
        log.warn(`账号 ${i + 1}: Token 已失效或错误，已自动禁用该账号`);
      }
    }
  }

  log.info(`刷新完成: 成功 ${successCount} 个, 失败 ${failCount} 个`);
  log.info(`账号文件路径: ${ACCOUNTS_FILE}`);
}

refreshAllTokens().catch(err => {
  log.error('刷新失败:', err.message);
  process.exit(1);
});
