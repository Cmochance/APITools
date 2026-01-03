// Kiro Token 管理：增删改查、启用禁用
// 与 tokens.js 保持一致的接口风格

let cachedKiroAccounts = [];
let currentKiroFilter = localStorage.getItem('kiroFilter') || 'all';
let skipKiroAnimation = false;

// 初始化 Kiro 筛选状态
function initKiroFilterState() {
    const savedFilter = localStorage.getItem('kiroFilter') || 'all';
    currentKiroFilter = savedFilter;
    updateKiroFilterButtonState(savedFilter);
}

// 更新 Kiro 筛选按钮状态
function updateKiroFilterButtonState(filter) {
    document.querySelectorAll('#kiroPage .stat-item').forEach(item => {
        item.classList.remove('active');
    });
    const filterMap = { 'all': 'totalKiroAccounts', 'enabled': 'enabledKiroAccounts', 'disabled': 'disabledKiroAccounts' };
    const activeElement = document.getElementById(filterMap[filter]);
    if (activeElement) {
        activeElement.closest('.stat-item').classList.add('active');
    }
}

// 筛选 Kiro 账号
function filterKiroAccounts(filter) {
    currentKiroFilter = filter;
    localStorage.setItem('kiroFilter', filter);
    updateKiroFilterButtonState(filter);
    renderKiroAccounts(cachedKiroAccounts);
}

// 加载 Kiro 账号列表
async function loadKiroAccounts() {
    try {
        const response = await authFetch('/admin/kiro/accounts', {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        const data = await response.json();
        if (data.success) {
            renderKiroAccounts(data.data);
        } else {
            showToast('加载Kiro账号失败: ' + (data.message || '未知错误'), 'error');
        }
    } catch (error) {
        showToast('加载Kiro账号失败: ' + error.message, 'error');
    }
}

// 正在刷新的 Kiro 账号集合
const refreshingKiroAccounts = new Set();

// 渲染 Kiro 账号列表
function renderKiroAccounts(accounts) {
    if (accounts !== cachedKiroAccounts) {
        cachedKiroAccounts = accounts;
    }

    // 更新统计
    const totalEl = document.getElementById('totalKiroAccounts');
    const enabledEl = document.getElementById('enabledKiroAccounts');
    const disabledEl = document.getElementById('disabledKiroAccounts');

    if (totalEl) totalEl.textContent = accounts.length;
    if (enabledEl) enabledEl.textContent = accounts.filter(a => a.enable).length;
    if (disabledEl) disabledEl.textContent = accounts.filter(a => !a.enable).length;

    // 根据筛选条件过滤
    let filteredAccounts = accounts;
    if (currentKiroFilter === 'enabled') {
        filteredAccounts = accounts.filter(a => a.enable);
    } else if (currentKiroFilter === 'disabled') {
        filteredAccounts = accounts.filter(a => !a.enable);
    }

    const accountList = document.getElementById('kiroAccountList');
    if (!accountList) return;

    if (filteredAccounts.length === 0) {
        const emptyText = currentKiroFilter === 'all' ? '暂无Kiro账号' :
                          currentKiroFilter === 'enabled' ? '暂无启用的账号' : '暂无禁用的账号';
        const emptyHint = currentKiroFilter === 'all' ? '点击上方"导入"按钮添加账号' : '点击上方"总数"查看全部';
        accountList.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">🦊</div>
                <div class="empty-state-text">${emptyText}</div>
                <div class="empty-state-hint">${emptyHint}</div>
            </div>
        `;
        return;
    }

    accountList.innerHTML = filteredAccounts.map((account, index) => {
        const isExpired = account.expiresAt && new Date(account.expiresAt) < new Date();
        const isRefreshing = refreshingKiroAccounts.has(account.id);
        const expireStr = account.expiresAt
            ? new Date(account.expiresAt).toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'})
            : '未知';
        const cardId = account.id.substring(0, 12);

        // 计算在原始列表中的序号
        const originalIndex = cachedKiroAccounts.findIndex(a => a.id === account.id);
        const accountNumber = originalIndex + 1;

        // 转义数据防止 XSS
        const safeId = escapeJs(account.id);
        const safeEmail = escapeHtml(account.email || '未设置');
        const safeRegion = escapeHtml(account.region || 'us-east-1');
        const safeAccessTokenSuffix = escapeHtml(account.accessToken_suffix || 'N/A');
        const safeAuthMethod = escapeHtml(account.authMethod || 'social');

        return `
        <div class="token-card ${!account.enable ? 'disabled' : ''} ${isExpired ? 'expired' : ''} ${isRefreshing ? 'refreshing' : ''} ${skipKiroAnimation ? 'no-animation' : ''}" id="kiro-card-${escapeHtml(cardId)}">
            <div class="token-header">
                <span class="status ${account.enable ? 'enabled' : 'disabled'}">
                    ${account.enable ? '✅ 启用' : '❌ 禁用'}
                </span>
                <div class="token-header-right">
                    <span class="provider-badge kiro">🦊 Kiro</span>
                    <span class="token-id">#${accountNumber}</span>
                </div>
            </div>
            <div class="token-info">
                <div class="info-row sensitive-row">
                    <span class="info-label">🎫</span>
                    <span class="info-value sensitive-info" title="${safeAccessTokenSuffix}">${safeAccessTokenSuffix}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">📧</span>
                    <span class="info-value">${safeEmail}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">🌍</span>
                    <span class="info-value">${safeRegion}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">🔐</span>
                    <span class="info-value">${safeAuthMethod}</span>
                </div>
                <div class="info-row ${isExpired ? 'expired-text' : ''}">
                    <span class="info-label">⏰</span>
                    <span class="info-value">${isRefreshing ? '🔄 刷新中...' : escapeHtml(expireStr)}${isExpired && !isRefreshing ? ' (已过期)' : ''}</span>
                    <button class="btn-icon btn-refresh" onclick="refreshKiroToken('${safeId}')" title="刷新Token" ${isRefreshing ? 'disabled' : ''}>🔄</button>
                </div>
            </div>
            <div class="token-actions">
                <button class="btn ${account.enable ? 'btn-warning' : 'btn-success'} btn-xs" onclick="toggleKiroAccount('${safeId}', ${!account.enable})" title="${account.enable ? '禁用' : '启用'}">
                    ${account.enable ? '⏸️ 禁用' : '▶️ 启用'}
                </button>
                <button class="btn btn-danger btn-xs" onclick="deleteKiroAccount('${safeId}')" title="删除">🗑️ 删除</button>
            </div>
        </div>
    `}).join('');

    updateSensitiveInfoDisplay();
    skipKiroAnimation = false;
}

// 刷新 Kiro Token
async function refreshKiroToken(accountId) {
    if (refreshingKiroAccounts.has(accountId)) {
        showToast('该账号正在刷新中', 'warning');
        return;
    }

    refreshingKiroAccounts.add(accountId);

    // 更新 UI 显示刷新中状态
    skipKiroAnimation = true;
    renderKiroAccounts(cachedKiroAccounts);

    try {
        const response = await authFetch(`/admin/kiro/accounts/${encodeURIComponent(accountId)}/refresh`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        const data = await response.json();
        if (data.success) {
            showToast('Kiro Token 刷新成功', 'success');
            await loadKiroAccounts();
        } else {
            showToast('刷新失败: ' + (data.message || '未知错误'), 'error');
        }
    } catch (error) {
        showToast('刷新失败: ' + error.message, 'error');
    } finally {
        refreshingKiroAccounts.delete(accountId);
        skipKiroAnimation = true;
        renderKiroAccounts(cachedKiroAccounts);
    }
}

// 切换 Kiro 账号启用状态
async function toggleKiroAccount(accountId, enable) {
    try {
        const response = await authFetch(`/admin/kiro/accounts/${encodeURIComponent(accountId)}`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ enable })
        });

        const data = await response.json();
        if (data.success) {
            showToast(enable ? 'Kiro账号已启用' : 'Kiro账号已禁用', 'success');
            skipKiroAnimation = true;
            await loadKiroAccounts();
        } else {
            showToast('操作失败: ' + (data.message || '未知错误'), 'error');
        }
    } catch (error) {
        showToast('操作失败: ' + error.message, 'error');
    }
}

// 删除 Kiro 账号
async function deleteKiroAccount(accountId) {
    if (!confirm('确定要删除这个Kiro账号吗？')) return;

    try {
        const response = await authFetch(`/admin/kiro/accounts/${encodeURIComponent(accountId)}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        const data = await response.json();
        if (data.success) {
            showToast('Kiro账号已删除', 'success');
            await loadKiroAccounts();
        } else {
            showToast('删除失败: ' + (data.message || '未知错误'), 'error');
        }
    } catch (error) {
        showToast('删除失败: ' + error.message, 'error');
    }
}

// 打开 Kiro OAuth 授权页面
function showKiroOAuthPage() {
    window.location.href = 'kiro-auth.html';
}

// 重新加载 Kiro 账号
async function reloadKiroAccounts() {
    try {
        const response = await authFetch('/admin/kiro/accounts/reload', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        const data = await response.json();
        if (data.success) {
            showToast('Kiro账号已热重载', 'success');
            await loadKiroAccounts();
        } else {
            showToast('重载失败: ' + (data.message || '未知错误'), 'error');
        }
    } catch (error) {
        showToast('重载失败: ' + error.message, 'error');
    }
}
