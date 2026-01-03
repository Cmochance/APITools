// 认证相关：登录、登出、OAuth

let authToken = localStorage.getItem('authToken');
let oauthPort = null;

const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const SCOPES = [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/cclog',
    'https://www.googleapis.com/auth/experimentsandconfigs'
].join(' ');

// 封装fetch，自动处理401
const authFetch = async (url, options = {}) => {
    const response = await fetch(url, options);
    if (response.status === 401) {
        silentLogout();
        showToast('登录已过期，请重新登录', 'warning');
        throw new Error('Unauthorized');
    }
    return response;
};

function showMainContent() {
    document.documentElement.classList.add('logged-in');
    document.getElementById('loginForm').classList.add('hidden');
    document.getElementById('mainContent').classList.remove('hidden');
}

function silentLogout() {
    localStorage.removeItem('authToken');
    authToken = null;
    document.documentElement.classList.remove('logged-in');
    document.getElementById('loginForm').classList.remove('hidden');
    document.getElementById('mainContent').classList.add('hidden');
}

async function logout() {
    const confirmed = await showConfirm('确定要退出登录吗？', '退出确认');
    if (!confirmed) return;
    
    silentLogout();
    showToast('已退出登录', 'info');
}

function getOAuthUrl() {
    if (!oauthPort) oauthPort = Math.floor(Math.random() * 10000) + 50000;
    const redirectUri = `http://localhost:${oauthPort}/oauth-callback`;
    return `https://accounts.google.com/o/oauth2/v2/auth?` +
        `access_type=offline&client_id=${CLIENT_ID}&prompt=consent&` +
        `redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&` +
        `scope=${encodeURIComponent(SCOPES)}&state=${Date.now()}`;
}

function openOAuthWindow() {
    window.open(getOAuthUrl(), '_blank');
}

function copyOAuthUrl() {
    const url = getOAuthUrl();
    navigator.clipboard.writeText(url).then(() => {
        showToast('授权链接已复制', 'success');
    }).catch(() => {
        showToast('复制失败', 'error');
    });
}

function showOAuthModal() {
    showToast('点击后请在新窗口完成授权', 'info');
    const modal = document.createElement('div');
    modal.className = 'modal form-modal';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-title">🔐 OAuth授权登录</div>
            <div class="oauth-steps">
                <p><strong>📝 授权流程：</strong></p>
                <p>1️⃣ 点击下方按钮打开Google授权页面</p>
                <p>2️⃣ 完成授权后，复制浏览器地址栏的完整URL</p>
                <p>3️⃣ 粘贴URL到下方输入框并提交</p>
            </div>
            <div style="display: flex; gap: 8px; margin-bottom: 12px;">
                <button type="button" onclick="openOAuthWindow()" class="btn btn-success" style="flex: 1;">🔐 打开授权页面</button>
                <button type="button" onclick="copyOAuthUrl()" class="btn btn-info" style="flex: 1;">📋 复制授权链接</button>
            </div>
            <input type="text" id="modalCallbackUrl" placeholder="粘贴完整的回调URL (http://localhost:xxxxx/oauth-callback?code=...)">
            <div class="modal-actions">
                <button class="btn btn-secondary" onclick="this.closest('.modal').remove()">取消</button>
                <button class="btn btn-success" onclick="processOAuthCallbackModal()">✅ 提交</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
}

async function processOAuthCallbackModal() {
    const modal = document.querySelector('.form-modal');
    const callbackUrl = document.getElementById('modalCallbackUrl').value.trim();
    if (!callbackUrl) {
        showToast('请输入回调URL', 'warning');
        return;
    }
    
    showLoading('正在处理授权...');
    
    try {
        const url = new URL(callbackUrl);
        const code = url.searchParams.get('code');
        const port = new URL(url.origin).port || (url.protocol === 'https:' ? 443 : 80);
        
        if (!code) {
            hideLoading();
            showToast('URL中未找到授权码', 'error');
            return;
        }
        
        const response = await authFetch('/admin/oauth/exchange', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({ code, port })
        });
        
        const result = await response.json();
        if (result.success) {
            const account = result.data;
            const addResponse = await authFetch('/admin/tokens', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${authToken}`
                },
                body: JSON.stringify(account)
            });
            
            const addResult = await addResponse.json();
            hideLoading();
            if (addResult.success) {
                modal.remove();
                const message = result.fallbackMode 
                    ? 'Token添加成功（该账号无资格，已自动使用随机ProjectId）' 
                    : 'Token添加成功';
                showToast(message, result.fallbackMode ? 'warning' : 'success');
                loadTokens();
            } else {
                showToast('添加失败: ' + addResult.message, 'error');
            }
        } else {
            hideLoading();
            showToast('交换失败: ' + result.message, 'error');
        }
    } catch (error) {
        hideLoading();
        showToast('处理失败: ' + error.message, 'error');
    }
}
