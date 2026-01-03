import http from 'http';
import { URL } from 'url';
import path from 'path';
import { fileURLToPath } from 'url';
import log from '../src/utils/logger.js';
import tokenManager from '../src/auth/token_manager.js';
import oauthManager from '../src/auth/oauth_manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ACCOUNTS_FILE = path.join(__dirname, '..', 'data', 'accounts.json');

const server = http.createServer((req, res) => {
  const port = server.address().port;
  const url = new URL(req.url, `http://localhost:${port}`);
  
  if (url.pathname === '/oauth-callback') {
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    
    if (code) {
      log.info('收到授权码，正在交换 Token...');
      oauthManager.authenticate(code, port).then(account => {
        const result = tokenManager.addToken(account);
        if (result.success) {
          log.info(`Token 已保存到 ${ACCOUNTS_FILE}`);
          if (!account.hasQuota) {
            log.warn('该账号无资格，已自动使用随机ProjectId');
          }
        } else {
          log.error('保存 Token 失败:', result.message);
        }
        
        const statusMsg = account.hasQuota ? '' : '<p style="color: orange;">⚠️ 该账号无资格，已自动使用随机ProjectId</p>';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h1>授权成功！</h1><p>Token 已保存，可以关闭此页面。</p>${statusMsg}`);
        setTimeout(() => server.close(), 1000);
      }).catch(err => {
        log.error('认证失败:', err.message);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>认证失败</h1><p>查看控制台错误信息</p>');
        setTimeout(() => server.close(), 1000);
      });
    } else {
      log.error('授权失败:', error || '未收到授权码');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>授权失败</h1>');
      setTimeout(() => server.close(), 1000);
    }
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(0, () => {
  const port = server.address().port;
  const authUrl = oauthManager.generateAuthUrl(port);
  log.info(`服务器运行在 http://localhost:${port}`);
  log.info('请在浏览器中打开以下链接进行登录：');
  console.log(`\n${authUrl}\n`);
  log.info('等待授权回调...');
});
