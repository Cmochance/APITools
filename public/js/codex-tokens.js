// Codex Token 管理：增删改查、启用禁用
// 与 tokens.js / kiro-tokens.js 保持一致的接口风格

let cachedCodexAccounts = [];
let currentCodexFilter = localStorage.getItem('codexFilter') || 'all';
let skipCodexAnimation = false;

// 初始化 Codex 筛选状态
function initCodexFilterState() {
    const savedFilter = localStorage.getItem('codexFilter') || 'all';
    currentCodexFilter = savedFilter;
    updateCodexFilterButtonState(savedFilter);
}

// 更新 Codex 筛选按钮状态
function updateCodexFilterButtonState(filter) {
    document.querySelectorAll('#codexPage .stat-item').forEach(item => {
        item.classList.remove('active');
    });
    const filterMap = { 'all': 'totalCodexAccounts', 'enabled': 'enabledCodexAccounts', 'disabled': 'disabledCodexAccounts' };
    const activeElement = document.getElementById(filterMap[filter]);
    if (activeElement) {
        activeElement.closest('.stat-item').classList.add('active');
    }
}

// 筛选 Codex 账号
function filterCodexAccounts(filter) {
    currentCodexFilter = filter;
    localStorage.setItem('codexFilter', filter);
    updateCodexFilterButtonState(filter);
    renderCodexAccounts(cachedCodexAccounts);
}

// 加载 Codex 账号列表
async function loadCodexAccounts() {
    try {
        const response = await authFetch('/admin/codex/accounts', {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        const data = await response.json();
        if (data.success) {
            renderCodexAccounts(data.data);
        } else {
            showToast('加载Codex账号失败: ' + (data.message || '未知错误'), 'error');
        }
    } catch (error) {
        showToast('加载Codex账号失败: ' + error.message, 'error');
    }
}

// 正在刷新的 Codex 账号集合
const refreshingCodexAccounts = new Set();

// 渲染 Codex 账号列表
function renderCodexAccounts(accounts) {
    if (accounts !== cachedCodexAccounts) {
        cachedCodexAccounts = accounts;
    }

    // 更新统计
    const totalEl = document.getElementById('totalCodexAccounts');
    const enabledEl = document.getElementById('enabledCodexAccounts');
    const disabledEl = document.getElementById('disabledCodexAccounts');

    if (totalEl) totalEl.textContent = accounts.length;
    if (enabledEl) enabledEl.textContent = accounts.filter(a => a.enable).length;
    if (disabledEl) disabledEl.textContent = accounts.filter(a => !a.enable).length;

    // 根据筛选条件过滤
    let filteredAccounts = accounts;
    if (currentCodexFilter === 'enabled') {
        filteredAccounts = accounts.filter(a => a.enable);
    } else if (currentCodexFilter === 'disabled') {
        filteredAccounts = accounts.filter(a => !a.enable);
    }

    const accountList = document.getElementById('codexAccountList');
    if (!accountList) return;

    if (filteredAccounts.length === 0) {
        const emptyText = currentCodexFilter === 'all' ? '暂无Codex账号' :
                          currentCodexFilter === 'enabled' ? '暂无启用的账号' : '暂无禁用的账号';
        const emptyHint = currentCodexFilter === 'all' ? '点击上方"导入"按钮添加账号' : '点击上方"总数"查看全部';
        accountList.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📦</div>
                <div class="empty-state-text">${emptyText}</div>
                <div class="empty-state-hint">${emptyHint}</div>
            </div>
        `;
        return;
    }

    accountList.innerHTML = filteredAccounts.map((account, index) => {
        const isExpired = account.auth_type === 'oauth' && account.expires_at && new Date(account.expires_at) < new Date();
        const isRefreshing = refreshingCodexAccounts.has(account.id);
        const isApiKey = account.auth_type === 'api_key';
        const expireStr = isApiKey
            ? '永久有效'
            : (account.expires_at
                ? new Date(account.expires_at).toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'})
                : '未知');
        const cardId = account.id.substring(0, 12);

        // 计算在原始列表中的序号
        const originalIndex = cachedCodexAccounts.findIndex(a => a.id === account.id);
        const accountNumber = originalIndex + 1;

        // 转义数据防止 XSS
        const safeId = escapeJs(account.id);
        const safeEmail = escapeHtml(account.email || '未设置');
        const safeName = escapeHtml(account.name || '未命名');
        const safeAccessTokenSuffix = escapeHtml(account.access_token_suffix || 'N/A');
        const safeAuthType = isApiKey ? 'API Key' : 'OAuth';
        const authTypeBadgeClass = isApiKey ? 'api-key' : 'oauth';

        return `
        <div class="token-card ${!account.enable ? 'disabled' : ''} ${isExpired ? 'expired' : ''} ${isRefreshing ? 'refreshing' : ''} ${skipCodexAnimation ? 'no-animation' : ''}" id="codex-card-${escapeHtml(cardId)}">
            <div class="token-header">
                <span class="status ${account.enable ? 'enabled' : 'disabled'}">
                    ${account.enable ? '✅ 启用' : '❌ 禁用'}
                </span>
                <div class="token-header-right">
                    <span class="provider-badge codex">📦 Codex</span>
                    <span class="auth-type-badge ${authTypeBadgeClass}">${safeAuthType}</span>
                    <span class="token-id">#${accountNumber}</span>
                </div>
            </div>
            <div class="token-info">
                <div class="info-row">
                    <span class="info-label">📛</span>
                    <span class="info-value">${safeName}</span>
                </div>
                <div class="info-row sensitive-row">
                    <span class="info-label">🎫</span>
                    <span class="info-value sensitive-info" title="${safeAccessTokenSuffix}">${safeAccessTokenSuffix}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">📧</span>
                    <span class="info-value">${safeEmail}</span>
                </div>
                <div class="info-row ${isExpired ? 'expired-text' : ''}">
                    <span class="info-label">⏰</span>
                    <span class="info-value">${isRefreshing ? '🔄 刷新中...' : escapeHtml(expireStr)}${isExpired && !isRefreshing ? ' (已过期)' : ''}</span>
                    ${!isApiKey ? `<button class="btn-icon btn-refresh" onclick="refreshCodexToken('${safeId}')" title="刷新Token" ${isRefreshing ? 'disabled' : ''}>🔄</button>` : ''}
                </div>
            </div>
            <div class="token-actions">
                <button class="btn btn-info btn-xs" onclick="showCodexDetailModal('${safeId}')" title="查看详情">📊 详情</button>
                <button class="btn ${account.enable ? 'btn-warning' : 'btn-success'} btn-xs" onclick="toggleCodexAccount('${safeId}', ${!account.enable})" title="${account.enable ? '禁用' : '启用'}">
                    ${account.enable ? '⏸️ 禁用' : '▶️ 启用'}
                </button>
                <button class="btn btn-danger btn-xs" onclick="deleteCodexAccount('${safeId}')" title="删除">🗑️ 删除</button>
            </div>
        </div>
    `}).join('');

    updateSensitiveInfoDisplay();
    skipCodexAnimation = false;
}

// 刷新 Codex Token (仅 OAuth 模式)
async function refreshCodexToken(accountId) {
    if (refreshingCodexAccounts.has(accountId)) {
        showToast('该账号正在刷新中', 'warning');
        return;
    }

    refreshingCodexAccounts.add(accountId);

    // 更新 UI 显示刷新中状态
    skipCodexAnimation = true;
    renderCodexAccounts(cachedCodexAccounts);

    try {
        const response = await authFetch(`/admin/codex/accounts/${encodeURIComponent(accountId)}/refresh`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        const data = await response.json();
        if (data.success) {
            showToast('Codex Token 刷新成功', 'success');
            await loadCodexAccounts();
        } else {
            showToast('刷新失败: ' + (data.message || '未知错误'), 'error');
        }
    } catch (error) {
        showToast('刷新失败: ' + error.message, 'error');
    } finally {
        refreshingCodexAccounts.delete(accountId);
        skipCodexAnimation = true;
        renderCodexAccounts(cachedCodexAccounts);
    }
}

// 切换 Codex 账号启用状态
async function toggleCodexAccount(accountId, enable) {
    try {
        const response = await authFetch(`/admin/codex/accounts/${encodeURIComponent(accountId)}`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ enable })
        });

        const data = await response.json();
        if (data.success) {
            showToast(enable ? 'Codex账号已启用' : 'Codex账号已禁用', 'success');
            skipCodexAnimation = true;
            await loadCodexAccounts();
        } else {
            showToast('操作失败: ' + (data.message || '未知错误'), 'error');
        }
    } catch (error) {
        showToast('操作失败: ' + error.message, 'error');
    }
}

// 删除 Codex 账号
async function deleteCodexAccount(accountId) {
    if (!confirm('确定要删除这个Codex账号吗？')) return;

    try {
        const response = await authFetch(`/admin/codex/accounts/${encodeURIComponent(accountId)}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        const data = await response.json();
        if (data.success) {
            showToast('Codex账号已删除', 'success');
            await loadCodexAccounts();
        } else {
            showToast('删除失败: ' + (data.message || '未知错误'), 'error');
        }
    } catch (error) {
        showToast('删除失败: ' + error.message, 'error');
    }
}

// 打开 Codex OAuth 授权页面
function showCodexOAuthPage() {
    window.location.href = 'codex-auth.html';
}

// 重新加载 Codex 账号
async function reloadCodexAccounts() {
    try {
        const response = await authFetch('/admin/codex/accounts/reload', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        const data = await response.json();
        if (data.success) {
            showToast('Codex账号已热重载', 'success');
            await loadCodexAccounts();
        } else {
            showToast('重载失败: ' + (data.message || '未知错误'), 'error');
        }
    } catch (error) {
        showToast('重载失败: ' + error.message, 'error');
    }
}

// 显示 Codex 账号详情模态框
async function showCodexDetailModal(accountId) {
    const account = cachedCodexAccounts.find(a => a.id === accountId);
    if (!account) {
        showToast('账号不存在', 'error');
        return;
    }

    const activeIndex = cachedCodexAccounts.findIndex(a => a.id === accountId);

    // 构建账号标签页（参考 Antigravity quota.js）
    const accountTabs = cachedCodexAccounts.map((a, index) => {
        // 优先使用邮箱，其次名称，最后使用序号
        const displayName = a.email || a.name || `账号 ${index + 1}`;
        const shortName = displayName.length > 20 ? displayName.substring(0, 17) + '...' : displayName;
        const isActive = index === activeIndex;
        const authIcon = a.auth_type === 'api_key' ? '🔑' : '🔐';
        const safeName = escapeHtml(displayName);
        const safeShortName = escapeHtml(shortName);
        return `<button type="button" class="quota-tab${isActive ? ' active' : ''}" data-index="${index}" onclick="switchCodexDetailByIndex(${index})" title="${safeName}">${authIcon} ${safeShortName}</button>`;
    }).join('');

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'codexDetailModal';
    modal.innerHTML = `
        <div class="modal-content modal-xl">
            <div class="quota-modal-header">
                <div class="modal-title">📦 Codex 账号详情</div>
                <div class="quota-update-time" id="codexDetailUpdateTime"></div>
            </div>
            <div class="quota-tabs" id="codexAccountTabs">
                ${accountTabs}
            </div>
            <div id="codexDetailContent" class="quota-container">
                <div class="quota-loading">加载中...</div>
            </div>
            <div class="modal-actions">
                <button class="btn btn-info btn-sm" id="codexDetailRefreshBtn" onclick="refreshCodexDetail()">🔄 刷新</button>
                <button class="btn btn-secondary btn-sm" onclick="this.closest('.modal').remove()">关闭</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

    // 保存当前选中的账号ID
    window.currentCodexDetailAccountId = accountId;

    // 加载详情数据
    await loadCodexDetailData(accountId);

    // 添加横向滚动支持
    const tabsContainer = document.getElementById('codexAccountTabs');
    if (tabsContainer) {
        tabsContainer.addEventListener('wheel', (e) => {
            if (e.deltaY !== 0) {
                e.preventDefault();
                tabsContainer.scrollLeft += e.deltaY;
            }
        }, { passive: false });
    }
}

// 切换 Codex 详情账号
async function switchCodexDetailByIndex(index) {
    if (index < 0 || index >= cachedCodexAccounts.length) return;

    const account = cachedCodexAccounts[index];
    window.currentCodexDetailAccountId = account.id;

    // 更新标签页激活状态
    document.querySelectorAll('#codexAccountTabs .quota-tab').forEach((tab, i) => {
        if (i === index) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    });

    await loadCodexDetailData(account.id);
}

// Codex 额度缓存
const codexQuotaCache = {
    data: {},
    ttl: 5 * 60 * 1000,  // 5分钟缓存

    get(accountId) {
        const cached = this.data[accountId];
        if (!cached) return null;
        if (Date.now() - cached.timestamp > this.ttl) {
            delete this.data[accountId];
            return null;
        }
        return cached.data;
    },

    set(accountId, data) {
        this.data[accountId] = { data, timestamp: Date.now() };
    },

    clear(accountId) {
        if (accountId) {
            delete this.data[accountId];
        } else {
            this.data = {};
        }
    }
};

// 加载 Codex 详情数据
async function loadCodexDetailData(accountId, forceRefresh = false) {
    const detailContent = document.getElementById('codexDetailContent');
    if (!detailContent) return;

    const refreshBtn = document.getElementById('codexDetailRefreshBtn');
    if (refreshBtn) {
        refreshBtn.disabled = true;
        refreshBtn.textContent = '⏳ 加载中...';
    }

    const account = cachedCodexAccounts.find(a => a.id === accountId);
    if (!account) {
        detailContent.innerHTML = '<div class="quota-error">账号不存在</div>';
        return;
    }

    detailContent.innerHTML = '<div class="quota-loading">加载中...</div>';

    try {
        // 获取额度信息（带缓存）
        let quotaData = null;
        if (!forceRefresh) {
            quotaData = codexQuotaCache.get(accountId);
        }

        if (!quotaData) {
            // 从后端获取额度
            const response = await authFetch(`/admin/codex/accounts/${encodeURIComponent(accountId)}/quotas${forceRefresh ? '?refresh=true' : ''}`, {
                headers: { 'Authorization': `Bearer ${authToken}` }
            });
            const data = await response.json();
            if (data.success && data.data) {
                quotaData = data.data;
                codexQuotaCache.set(accountId, quotaData);
            }
        }

        // 渲染详情内容
        renderCodexDetail(detailContent, account, quotaData);

        // 更新时间
        const updateTimeEl = document.getElementById('codexDetailUpdateTime');
        if (updateTimeEl) {
            const timestamp = quotaData?.lastUpdated || Date.now();
            const updateTime = new Date(timestamp).toLocaleString('zh-CN', {
                month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
            });
            updateTimeEl.textContent = `更新于 ${updateTime}`;
        }
    } catch (error) {
        detailContent.innerHTML = `<div class="quota-error">加载失败: ${escapeHtml(error.message)}</div>`;
    } finally {
        if (refreshBtn) {
            refreshBtn.disabled = false;
            refreshBtn.textContent = '🔄 刷新';
        }
    }
}

// 刷新 Codex 详情
async function refreshCodexDetail() {
    if (window.currentCodexDetailAccountId) {
        await loadCodexDetailData(window.currentCodexDetailAccountId, true);
    }
}

// 渲染 Codex 详情内容
function renderCodexDetail(container, account, quotaData) {
    const isApiKey = account.auth_type === 'api_key';
    const authTypeText = isApiKey ? 'API Key' : 'OAuth';
    const authTypeIcon = isApiKey ? '🔑' : '🔐';
    const authTypeBadgeClass = isApiKey ? 'api-key' : 'oauth';

    // 账号信息区
    let html = `
        <div class="codex-detail-section">
            <div class="quota-group-title">📋 账号信息</div>
            <div class="codex-info-grid">
                <div class="codex-info-item">
                    <span class="codex-info-label">认证类型</span>
                    <span class="codex-info-value"><span class="auth-type-badge ${authTypeBadgeClass}">${authTypeIcon} ${authTypeText}</span></span>
                </div>
                <div class="codex-info-item">
                    <span class="codex-info-label">账号名称</span>
                    <span class="codex-info-value">${escapeHtml(account.name || '未设置')}</span>
                </div>
                <div class="codex-info-item">
                    <span class="codex-info-label">邮箱</span>
                    <span class="codex-info-value">${escapeHtml(account.email || (isApiKey ? '不适用 (API Key)' : '自动获取中...'))}</span>
                </div>
                <div class="codex-info-item">
                    <span class="codex-info-label">状态</span>
                    <span class="codex-info-value">${account.enable ? '<span class="status-badge enabled">✅ 启用</span>' : '<span class="status-badge disabled">❌ 禁用</span>'}</span>
                </div>
    `;

    // OAuth 模式显示过期时间
    if (!isApiKey && account.expires_at) {
        const expireDate = new Date(account.expires_at);
        const isExpired = expireDate < new Date();
        const expireStr = expireDate.toLocaleString('zh-CN', {
            month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
        });
        html += `
                <div class="codex-info-item">
                    <span class="codex-info-label">Token过期</span>
                    <span class="codex-info-value ${isExpired ? 'expired-text' : ''}">${escapeHtml(expireStr)}${isExpired ? ' (已过期)' : ''}</span>
                </div>
        `;
    }

    html += `
            </div>
        </div>
    `;

    // 模型额度区（带进度条）
    html += `
        <div class="codex-detail-section">
            <div class="quota-group-title">🤖 模型额度</div>
    `;

    const models = quotaData?.models || {};
    const modelEntries = Object.entries(models);

    if (modelEntries.length > 0) {
        html += '<div class="quota-grid">';
        modelEntries.forEach(([modelId, quota]) => {
            const modelName = escapeHtml(modelId);
            const percentage = (quota.remaining || 0) * 100;
            const percentageText = quota.unlimited ? '∞' : `${percentage.toFixed(0)}%`;
            const barColor = quota.unlimited ? 'linear-gradient(90deg, #10a37f, #06b6d4)' :
                (percentage > 50 ? '#10b981' : percentage > 20 ? '#f59e0b' : '#ef4444');
            const barWidth = quota.unlimited ? 100 : percentage;
            const resetTime = escapeHtml(quota.resetTime || '-');
            const note = escapeHtml(quota.note || '');

            html += `
                <div class="quota-item" title="${note}">
                    <div class="quota-model-name">🤖 ${modelName}</div>
                    <div class="quota-bar-container">
                        <div class="quota-bar" style="width: ${barWidth}%; background: ${barColor};"></div>
                    </div>
                    <div class="quota-info-row">
                        <span class="quota-reset">重置: ${resetTime}</span>
                        <span class="quota-percentage">${percentageText}</span>
                    </div>
                </div>
            `;
        });
        html += '</div>';
    } else {
        html += '<div class="quota-empty">暂无模型额度信息</div>';
    }

    html += '</div>';

    // 额度说明（API Key 和 OAuth 不同）
    html += `
        <div class="codex-detail-section">
            <div class="quota-group-title">💡 额度说明</div>
            <div class="codex-quota-note">
                ${isApiKey
                    ? '<p>🔑 <strong>API Key 模式</strong>：额度取决于您的 OpenAI Platform 账户余额和配额设置。请前往 <a href="https://platform.openai.com/usage" target="_blank">OpenAI Dashboard</a> 查看详细用量。</p>'
                    : '<p>🔐 <strong>OAuth 模式</strong>：使用 ChatGPT Plus/Pro 订阅的额度。订阅用户享有无限额度（∞），具体限制取决于您的订阅等级。</p>'
                }
            </div>
        </div>
    `;

    container.innerHTML = html;
}
