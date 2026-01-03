let cachedRoutingModels = null;
let cachedRoutingRoutes = [];
let routingInitialized = false;

let routingQuotaDraftLimits = {};
let routingQuotaUsageBaseline = {};

function validateRoutingRouteId(routeId) {
    if (!routeId || typeof routeId !== 'string') return false;
    const trimmed = routeId.trim();
    if (!trimmed) return false;
    if (trimmed.length > 64) return false;
    if (trimmed === 'master') return false;
    return /^[a-zA-Z0-9_-]+$/.test(trimmed);
}

function getShortModelName(modelId) {
    if (modelId === null || modelId === undefined) return '';
    const normalized = String(modelId).replace('models/', '').replace('publishers/google/', '');
    const parts = normalized.split('/').filter(Boolean);
    return parts[parts.length - 1] || normalized;
}

/**
 * 根据模型名称获取对应的厂商图标
 * @param {string} modelName - 模型名称或ID
 * @returns {string} - 图标字符（emoji 或 SVG）
 */
function getModelIcon(modelName) {
    if (!modelName) return '📦';
    const name = String(modelName).toLowerCase();
    
    // Claude/Anthropic 模型
    if (name.includes('claude')) {
        return '🤖';
    }
    // Gemini/Google 模型
    if (name.includes('gemini')) {
        return '💎';
    }
    // OpenAI 模型 (GPT, O1 等)
    if (name.includes('gpt') || name.startsWith('o1') || name.includes('openai')) {
        return '🧠';
    }
    // Llama 模型
    if (name.includes('llama')) {
        return '🦙';
    }
    // Mistral 模型
    if (name.includes('mistral') || name.includes('mixtral')) {
        return '🌀';
    }
    // 图像生成模型
    if (name.includes('imagen') || name.includes('dall') || name.includes('stable')) {
        return '🎨';
    }
    // 默认图标
    return '📦';
}

function getCachedRoutingRouteById(routeId) {
    const rid = (routeId || '').toString();
    return cachedRoutingRoutes.find(r => (r?.id || '').toString() === rid) || null;
}

function getRoutingRouteEditorModalEl() {
    return document.getElementById('routingRouteEditorModal');
}

function parseNonNegativeInt(value, fallback = 0) {
    const num = typeof value === 'string' ? Number(value) : value;
    if (!Number.isFinite(num)) return fallback;
    const intVal = Math.floor(num);
    if (intVal < 0) return fallback;
    return intVal;
}

function initRoutingModelQuotaEditor(initialLimits = {}, initialUsage = {}) {
    // 清空旧版草稿
    routingQuotaDraftLimits = {};
    // 初始化新版草稿
    routingQuotaDraftLimitsV2 = {};
    
    const limits = (initialLimits && typeof initialLimits === 'object' && !Array.isArray(initialLimits)) ? initialLimits : {};
    for (const [k, v] of Object.entries(limits)) {
        // 将初始限额配置转换为规范化格式并存入草稿
        const normalized = normalizeLimitEntryForDisplay(v);
        // 只要有任何限制（包括有效期），就存入草稿
        if (normalized.total || normalized.period || normalized.periodLimit || normalized.expireAt) {
            routingQuotaDraftLimitsV2[k] = normalized;
        }
    }

    routingQuotaUsageBaseline = (initialUsage && typeof initialUsage === 'object' && !Array.isArray(initialUsage)) ? initialUsage : {};
    renderRoutingModelQuotaList();
}

function getRoutingModelsForQuotaEditor() {
    let models = collectRoutingModelsFromModal();
    const aliases = collectRoutingAliasesFromModal();
    const aliasTargets = Object.values(aliases).filter(Boolean);
    models = Array.from(new Set([...models, ...aliasTargets]));
    return models;
}

// 限额配置草稿：{ modelId: { total, period, periodLimit, expireAt } }
let routingQuotaDraftLimitsV2 = {};

/**
 * 根据时长值和单位计算 expireAt（绝对时间戳）
 */
function updateExpireAtFromDuration(modelId, durationValue, unit) {
    if (!modelId) return;
    const duration = parseInt(durationValue, 10);
    if (!Number.isFinite(duration) || duration <= 0) return;
    
    // 确保草稿存在
    if (!routingQuotaDraftLimitsV2[modelId]) {
        routingQuotaDraftLimitsV2[modelId] = { total: '', period: '', periodLimit: '', expireAt: null };
    }
    
    // 计算毫秒数
    let ms = 0;
    switch (unit) {
        case 'hour':
            ms = duration * 3600 * 1000;
            break;
        case 'day':
            ms = duration * 24 * 3600 * 1000;
            break;
        case 'week':
            ms = duration * 7 * 24 * 3600 * 1000;
            break;
        case 'month':
            ms = duration * 30 * 24 * 3600 * 1000;
            break;
        default:
            ms = duration * 24 * 3600 * 1000; // 默认天
    }
    
    const expireAt = Date.now() + ms;
    routingQuotaDraftLimitsV2[modelId].expireAt = expireAt;
    
    // 更新 UI 显示
    updateExpireAtDisplay(modelId, expireAt);
}

/**
 * 清除某个模型的有效期限制
 */
function clearModelExpireAt(modelId) {
    if (!modelId) return;
    
    if (routingQuotaDraftLimitsV2[modelId]) {
        routingQuotaDraftLimitsV2[modelId].expireAt = null;
    }
    
    // 更新 UI 显示
    updateExpireAtDisplay(modelId, null);
    
    // 清空时长输入框
    const row = document.querySelector(`.routing-quota-row-v2[data-model-id="${modelId}"]`);
    if (row) {
        const durationInput = row.querySelector('.routing-model-duration-input');
        if (durationInput) {
            durationInput.value = '';
        }
    }
}

/**
 * 更新有效期显示
 */
function updateExpireAtDisplay(modelId, expireAt) {
    const row = document.querySelector(`.routing-quota-row-v2[data-model-id="${modelId}"]`);
    if (!row) return;
    
    const expireInfo = row.querySelector('.routing-quota-expire-info');
    if (!expireInfo) return;
    
    if (!expireAt) {
        expireInfo.innerHTML = `<span class="routing-quota-expire-text">永久有效</span>`;
    } else {
        const isExpired = Date.now() > expireAt;
        const dateStr = new Date(expireAt).toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'});
        const expireStatus = isExpired 
            ? '<span class="routing-quota-tag expired">❌ 已过期</span>' 
            : '<span class="routing-quota-tag active">✅ 使用中</span>';
        expireInfo.innerHTML = `${expireStatus}<span class="routing-quota-expire-text">过期时间: ${dateStr}</span>`;
    }
}

/**
 * 规范化使用量条目，支持旧格式（数字）和新格式（对象）
 */
function normalizeUsageEntryForDisplay(usage) {
    if (typeof usage === 'number') {
        return { totalUsed: usage, periodUsed: 0, lastReset: 0 };
    }
    if (usage && typeof usage === 'object') {
        return {
            totalUsed: parseNonNegativeInt(usage.totalUsed, 0),
            periodUsed: parseNonNegativeInt(usage.periodUsed, 0),
            lastReset: parseNonNegativeInt(usage.lastReset, 0)
        };
    }
    return { totalUsed: 0, periodUsed: 0, lastReset: 0 };
}

/**
 * 规范化限额配置项，支持旧格式（数字）和新格式（对象）
 */
function normalizeLimitEntryForDisplay(limit) {
    if (limit === undefined || limit === null) {
        return { total: '', period: '', periodLimit: '', expireAt: null };
    }
    if (typeof limit === 'number') {
        return { total: String(limit), period: '', periodLimit: '', expireAt: null };
    }
    if (limit && typeof limit === 'object') {
        return {
            total: limit.total !== null && limit.total !== undefined ? String(limit.total) : '',
            period: limit.period || '',
            periodLimit: limit.periodLimit !== null && limit.periodLimit !== undefined ? String(limit.periodLimit) : '',
            expireAt: limit.expireAt || null
        };
    }
    return { total: '', period: '', periodLimit: '', expireAt: null };
}

function renderRoutingModelQuotaList() {
    const modal = getRoutingRouteEditorModalEl();
    if (!modal) return;
    const listEl = modal.querySelector('#routingModelQuotaList');
    if (!listEl) return;

    const models = getRoutingModelsForQuotaEditor();
    if (!Array.isArray(models) || models.length === 0) {
        listEl.innerHTML = `<div class="empty-state" style="padding: 0.75rem;">
            <div class="empty-state-text">请先选择模型</div>
        </div>`;
        return;
    }

    listEl.innerHTML = models.map(modelId => {
        const id = escapeHtml(modelId);
        const shortName = escapeHtml(getShortModelName(modelId));
        const icon = getModelIcon(modelId);
        
        // 获取使用量信息
        const usageEntry = normalizeUsageEntryForDisplay(routingQuotaUsageBaseline?.[modelId]);
        
        // 获取限额配置（优先使用草稿，否则用基线）
        const draftLimit = routingQuotaDraftLimitsV2?.[modelId];
        const limitEntry = draftLimit || normalizeLimitEntryForDisplay(routingQuotaDraftLimits?.[modelId]);
        
        const totalVal = limitEntry.total ?? '';
        const periodVal = limitEntry.period ?? '';
        const periodLimitVal = limitEntry.periodLimit ?? '';
        const expireAtVal = limitEntry.expireAt;
        
        // 显示周期已用信息
        const showPeriodUsed = periodVal && periodLimitVal;
        const periodNames = { daily: '今日', weekly: '本周', monthly: '本月' };
        const periodUsedText = showPeriodUsed ? `${periodNames[periodVal] || '周期'}已用: ${usageEntry.periodUsed}` : '';

        // 有效期显示
        let expireStatus = '';
        let expireText = '永久有效';
        if (expireAtVal) {
            const isExpired = Date.now() > expireAtVal;
            const dateStr = new Date(expireAtVal).toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'});
            expireStatus = isExpired ? '<span class="routing-quota-tag expired">❌ 已过期</span>' : '<span class="routing-quota-tag active">✅ 使用中</span>';
            expireText = `过期时间: ${dateStr}`;
        }

        return `
            <div class="routing-quota-row-v2" data-model-id="${id}">
                <div class="routing-quota-header">
                    <span class="routing-quota-icon">${icon}</span>
                    <span class="routing-quota-name" title="${id}">${shortName}</span>
                </div>
                <div class="routing-quota-controls">
                    <div class="routing-quota-control-group">
                        <label class="routing-quota-label">📦 总额度</label>
                        <input type="number" min="0" step="1" 
                               class="routing-model-total-input" 
                               data-model-id="${id}" 
                               value="${escapeHtml(String(totalVal))}" 
                               placeholder="不限">
                        <span class="routing-quota-usage-hint">累计已用: ${usageEntry.totalUsed}</span>
                    </div>
                    <div class="routing-quota-control-group">
                        <label class="routing-quota-label">🔄 周期重置</label>
                        <div class="routing-quota-period-row">
                            <select class="routing-model-period-select" data-model-id="${id}">
                                <option value="" ${!periodVal ? 'selected' : ''}>不启用</option>
                                <option value="daily" ${periodVal === 'daily' ? 'selected' : ''}>每日</option>
                                <option value="weekly" ${periodVal === 'weekly' ? 'selected' : ''}>每周</option>
                                <option value="monthly" ${periodVal === 'monthly' ? 'selected' : ''}>每月</option>
                            </select>
                            <input type="number" min="0" step="1" 
                                   class="routing-model-period-limit-input" 
                                   data-model-id="${id}" 
                                   value="${escapeHtml(String(periodLimitVal))}" 
                                   placeholder="周期额度"
                                   ${!periodVal ? 'disabled' : ''}>
                        </div>
                        <span class="routing-quota-usage-hint routing-quota-period-used ${showPeriodUsed ? '' : 'hidden'}">${periodUsedText}</span>
                    </div>
                    <div class="routing-quota-control-group">
                        <label class="routing-quota-label">⏳ 有效期 (时长卡)</label>
                        <div class="routing-quota-period-row">
                            <input type="number" min="1" step="1" 
                                   class="routing-model-duration-input" 
                                   data-model-id="${id}" 
                                   placeholder="时长">
                            <select class="routing-model-duration-unit" data-model-id="${id}">
                                <option value="hour">小时</option>
                                <option value="day" selected>天</option>
                                <option value="week">周</option>
                                <option value="month">月</option>
                            </select>
                        </div>
                        <div class="routing-quota-expire-actions">
                            <div class="routing-quota-expire-info">
                                ${expireStatus}
                                <span class="routing-quota-expire-text">${expireText}</span>
                            </div>
                            <button type="button" class="btn btn-xs btn-text routing-model-expire-clear" data-model-id="${id}" title="清除有效期限制">设为永久</button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function attachRoutingQuotaEditorListeners(modal) {
    if (!modal) return;

    modal.addEventListener('change', (e) => {
        const target = e.target;
        if (!target || !target.classList) return;
        
        // 模型选择或别名变化时重新渲染限额列表
        if (target.classList.contains('routing-model-checkbox') || target.classList.contains('routing-alias-target')) {
            renderRoutingModelQuotaList();
            return;
        }
        
        // 周期选择变化时更新草稿并处理周期额度输入框状态
        if (target.classList.contains('routing-model-period-select')) {
            const modelId = target.dataset.modelId;
            if (!modelId) return;
            const periodVal = target.value || '';
            
            // 确保草稿存在
            if (!routingQuotaDraftLimitsV2[modelId]) {
                routingQuotaDraftLimitsV2[modelId] = { total: '', period: '', periodLimit: '', expireAt: null };
            }
            routingQuotaDraftLimitsV2[modelId].period = periodVal;
            
            // 如果取消了周期，清空周期额度
            if (!periodVal) {
                routingQuotaDraftLimitsV2[modelId].periodLimit = '';
            }
            
            // 找到对应的周期额度输入框并更新其状态
            const row = target.closest('.routing-quota-row-v2');
            if (row) {
                const periodLimitInput = row.querySelector('.routing-model-period-limit-input');
                if (periodLimitInput) {
                    periodLimitInput.disabled = !periodVal;
                    if (!periodVal) {
                        periodLimitInput.value = '';
                    }
                }
                // 更新周期已用显示
                const periodUsedSpan = row.querySelector('.routing-quota-period-used');
                if (periodUsedSpan) {
                    if (periodVal && routingQuotaDraftLimitsV2[modelId].periodLimit) {
                        const usageEntry = normalizeUsageEntryForDisplay(routingQuotaUsageBaseline?.[modelId]);
                        const periodNames = { daily: '今日', weekly: '本周', monthly: '本月' };
                        periodUsedSpan.textContent = `${periodNames[periodVal] || '周期'}已用: ${usageEntry.periodUsed}`;
                        periodUsedSpan.classList.remove('hidden');
                    } else {
                        periodUsedSpan.classList.add('hidden');
                    }
                }
            }
        }
        
        // 有效期时长单位变化时更新 expireAt
        if (target.classList.contains('routing-model-duration-unit')) {
            const modelId = target.dataset.modelId;
            if (!modelId) return;
            const row = target.closest('.routing-quota-row-v2');
            if (row) {
                const durationInput = row.querySelector('.routing-model-duration-input');
                if (durationInput && durationInput.value) {
                    updateExpireAtFromDuration(modelId, durationInput.value, target.value);
                }
            }
        }
    });

    modal.addEventListener('input', (e) => {
        const target = e.target;
        if (!target || !target.classList) return;
        const modelId = target.dataset.modelId;
        if (!modelId) return;
        
        // 确保草稿存在
        if (!routingQuotaDraftLimitsV2[modelId]) {
            routingQuotaDraftLimitsV2[modelId] = { total: '', period: '', periodLimit: '', expireAt: null };
        }
        
        // 总额度输入
        if (target.classList.contains('routing-model-total-input')) {
            routingQuotaDraftLimitsV2[modelId].total = (target.value || '').trim();
            return;
        }
        
        // 周期额度输入
        if (target.classList.contains('routing-model-period-limit-input')) {
            routingQuotaDraftLimitsV2[modelId].periodLimit = (target.value || '').trim();
            
            // 更新周期已用显示
            const row = target.closest('.routing-quota-row-v2');
            if (row) {
                const periodUsedSpan = row.querySelector('.routing-quota-period-used');
                const periodVal = routingQuotaDraftLimitsV2[modelId].period;
                const periodLimitVal = routingQuotaDraftLimitsV2[modelId].periodLimit;
                if (periodUsedSpan) {
                    if (periodVal && periodLimitVal) {
                        const usageEntry = normalizeUsageEntryForDisplay(routingQuotaUsageBaseline?.[modelId]);
                        const periodNames = { daily: '今日', weekly: '本周', monthly: '本月' };
                        periodUsedSpan.textContent = `${periodNames[periodVal] || '周期'}已用: ${usageEntry.periodUsed}`;
                        periodUsedSpan.classList.remove('hidden');
                    } else {
                        periodUsedSpan.classList.add('hidden');
                    }
                }
            }
            return;
        }
        
        // 有效期时长输入
        if (target.classList.contains('routing-model-duration-input')) {
            const row = target.closest('.routing-quota-row-v2');
            if (row) {
                const unitSelect = row.querySelector('.routing-model-duration-unit');
                const unit = unitSelect?.value || 'day';
                if (target.value) {
                    updateExpireAtFromDuration(modelId, target.value, unit);
                }
            }
            return;
        }
    });
    
    // 点击事件：处理"设为永久"按钮
    modal.addEventListener('click', (e) => {
        const target = e.target;
        if (!target || !target.classList) return;
        
        if (target.classList.contains('routing-model-expire-clear')) {
            const modelId = target.dataset.modelId;
            if (modelId) {
                clearModelExpireAt(modelId);
            }
        }
    });
}

/**
 * 收集模型限额配置（新版 V2 格式）
 * 返回后端期望的格式：{ modelId: { total, period, periodLimit, expireAt } }
 */
function collectRoutingModelLimitsForModels(models) {
    const list = Array.isArray(models) ? models : [];
    const out = {};
    
    for (const m of list) {
        const draft = routingQuotaDraftLimitsV2?.[m];
        if (!draft) continue;
        
        const totalStr = (draft.total || '').trim();
        const periodStr = (draft.period || '').trim();
        const periodLimitStr = (draft.periodLimit || '').trim();
        const expireAt = draft.expireAt || null;
        
        // 如果都为空，跳过
        if (!totalStr && !periodStr && !periodLimitStr && !expireAt) continue;
        
        // 验证总额度
        let total = null;
        if (totalStr) {
            const num = Number(totalStr);
            if (!Number.isFinite(num) || num < 0) {
                showToast(`模型 ${getShortModelName(m)} 的总额度无效`, 'warning');
                return null;
            }
            total = Math.floor(num);
        }
        
        // 验证周期额度
        let period = null;
        let periodLimit = null;
        if (periodStr && ['daily', 'weekly', 'monthly'].includes(periodStr)) {
            period = periodStr;
            if (periodLimitStr) {
                const num = Number(periodLimitStr);
                if (!Number.isFinite(num) || num < 0) {
                    showToast(`模型 ${getShortModelName(m)} 的周期额度无效`, 'warning');
                    return null;
                }
                periodLimit = Math.floor(num);
            }
        }
        
        // 至少需要一个有效值（总额度、周期额度或有效期）
        if (total === null && periodLimit === null && !expireAt) continue;
        
        out[m] = { total, period, periodLimit, expireAt };
    }
    
    return out;
}

function extractRoutingModelIds(payload) {
    if (!payload) return [];
    const candidates = [];
    if (Array.isArray(payload?.data?.data)) candidates.push(...payload.data.data);
    if (Array.isArray(payload?.data)) candidates.push(...payload.data);
    if (Array.isArray(payload)) candidates.push(...payload);
    return candidates.map(item => {
        if (!item) return null;
        if (typeof item === 'string') return item;
        if (typeof item.id === 'string') return item.id;
        return null;
    }).filter(Boolean);
}

async function fetchRoutingModelSource(url) {
    const response = await authFetch(url, {
        headers: { 'Authorization': `Bearer ${authToken}` }
    });

    const data = await response.json();
    if (!data?.success) {
        throw new Error(data?.message || '获取模型列表失败');
    }

    return extractRoutingModelIds(data);
}

async function fetchAdminModelsForRouting() {
    const sources = [
        '/admin/models',
        '/admin/kiro/models',
        '/admin/codex/models'
    ];

    const results = await Promise.allSettled(sources.map(source => fetchRoutingModelSource(source)));
    const modelIds = new Set();
    const errors = [];

    results.forEach(result => {
        if (result.status === 'fulfilled') {
            result.value.forEach(id => modelIds.add(id));
        } else {
            errors.push(result.reason?.message);
        }
    });

    if (!modelIds.size) {
        throw new Error(errors.find(Boolean) || '模型列表为空');
    }

    return Array.from(modelIds).sort();
}

async function ensureRoutingModelsLoaded(force = false) {
    if (cachedRoutingModels && !force) return cachedRoutingModels;
    cachedRoutingModels = await fetchAdminModelsForRouting();
    return cachedRoutingModels;
}

async function refreshRoutingModels() {
    if (!authToken) return;
    showLoading('正在刷新模型列表...');
    try {
        await ensureRoutingModelsLoaded(true);
        hideLoading();
        showToast('模型列表已刷新', 'success');
    } catch (error) {
        hideLoading();
        showToast('刷新模型失败: ' + error.message, 'error');
    }
}

async function fetchRoutingRoutes() {
    const response = await authFetch('/admin/routing/routes', {
        headers: { 'Authorization': `Bearer ${authToken}` }
    });

    const data = await response.json();
    if (!data?.success) {
        throw new Error(data?.message || '获取路由列表失败');
    }

    if (!Array.isArray(data.data)) {
        throw new Error('路由列表格式错误');
    }

    return data.data;
}

function renderRoutingRoutes(routes) {
    cachedRoutingRoutes = Array.isArray(routes) ? routes : [];

    const countEl = document.getElementById('routingRouteCount');
    if (countEl) countEl.textContent = String(cachedRoutingRoutes.length);

    const listEl = document.getElementById('routingRouteList');
    if (!listEl) return;

    if (cachedRoutingRoutes.length === 0) {
        listEl.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">🧭</div>
                <div class="empty-state-text">暂无路由</div>
                <div class="empty-state-hint">点击上方"新建路由"创建分支Key分流规则</div>
            </div>
        `;
        return;
    }

    listEl.innerHTML = cachedRoutingRoutes.map(route => {
        const id = escapeHtml(route?.id || '');
        const name = escapeHtml(route?.name || '');
        const safeIdJs = escapeJs(route?.id || '');

        const models = Array.isArray(route?.models) ? route.models : [];
        const aliases = (route?.aliases && typeof route.aliases === 'object' && !Array.isArray(route.aliases)) ? route.aliases : {};
        const apiKeyHashes = Array.isArray(route?.apiKeyHashes) ? route.apiKeyHashes : [];
        const modelLimits = (route?.modelLimits && typeof route.modelLimits === 'object' && !Array.isArray(route.modelLimits)) ? route.modelLimits : {};
        const modelUsage = (route?.modelUsage && typeof route.modelUsage === 'object' && !Array.isArray(route.modelUsage)) ? route.modelUsage : {};

        const aliasNames = Object.keys(aliases);
        const aliasPreview = aliasNames.slice(0, 4).map(a => escapeHtml(a)).join(', ');

        // 构建模型列表HTML
        const modelListHtml = models.length === 0
            ? '<div class="route-model-empty">暂无模型</div>'
            : models.map(modelId => {
                const shortName = escapeHtml(getShortModelName(modelId));
                const fullName = escapeHtml(modelId);
                const icon = getModelIcon(modelId);
                
                // 获取使用量（支持新旧格式）
                const usageEntry = normalizeUsageEntryForDisplay(modelUsage?.[modelId]);
                const totalUsed = usageEntry.totalUsed;
                
                // 获取限额配置（支持新旧格式）
                const limitEntry = normalizeLimitEntryForDisplay(modelLimits?.[modelId]);
                const totalLimit = limitEntry.total ? parseInt(limitEntry.total, 10) : null;
                const periodLimit = limitEntry.periodLimit ? parseInt(limitEntry.periodLimit, 10) : null;
                const period = limitEntry.period || '';
                const expireAt = limitEntry.expireAt;
                
                // 确定显示哪个限额（优先显示总限额，其次是周期限额）
                const hasLimit = totalLimit !== null || periodLimit !== null || expireAt !== null;
                const displayLimit = totalLimit !== null ? totalLimit : periodLimit;
                const displayUsed = totalLimit !== null ? totalUsed : usageEntry.periodUsed;

                let barClass = 'bar-unlimited';
                let barWidth = '100%';

                if (displayLimit !== null && displayLimit > 0) {
                    const remaining = Math.max(0, displayLimit - displayUsed);
                    const pct = Math.round((remaining / displayLimit) * 100);
                    barWidth = `${pct}%`;
                    if (pct > 50) barClass = 'bar-green';
                    else if (pct > 20) barClass = 'bar-yellow';
                    else barClass = 'bar-red';
                } else if (displayLimit === 0) {
                    barClass = 'bar-red';
                    barWidth = '0%';
                }

                // 构建详细信息面板
                const periodNames = { daily: '日', weekly: '周', monthly: '月' };
                let detailsHtml = '';
                
                // 总额度
                const totalText = totalLimit !== null ? `${totalUsed}/${totalLimit}` : '不限';
                detailsHtml += `<span class="route-model-detail-item" title="总额度">📦 ${totalText}</span>`;
                
                // 周期额度
                if (period && periodLimit !== null) {
                    detailsHtml += `<span class="route-model-detail-item" title="${periodNames[period] || '周期'}额度">🔄 ${periodNames[period] || ''}${usageEntry.periodUsed}/${periodLimit}</span>`;
                }
                
                // 有效期与剩余时间
                if (expireAt) {
                    const now = Date.now();
                    const isExpired = now > expireAt;
                    let remainingText = '';
                    if (isExpired) {
                        remainingText = '❌ 已过期';
                    } else {
                        const diffMs = expireAt - now;
                        const diffDays = Math.floor(diffMs / (24 * 3600 * 1000));
                        const diffHours = Math.floor((diffMs % (24 * 3600 * 1000)) / (3600 * 1000));
                        if (diffDays > 0) {
                            remainingText = `⏳ 剩${diffDays}天${diffHours}时`;
                        } else if (diffHours > 0) {
                            remainingText = `⏳ 剩${diffHours}小时`;
                        } else {
                            const diffMins = Math.floor((diffMs % (3600 * 1000)) / (60 * 1000));
                            remainingText = `⏳ 剩${diffMins}分钟`;
                        }
                    }
                    detailsHtml += `<span class="route-model-detail-item ${isExpired ? 'expired' : ''}" title="有效期">${remainingText}</span>`;
                }

                const unlimitedClass = !hasLimit ? ' unlimited' : '';

                return `
                    <div class="route-model-item ${expireAt && Date.now() > expireAt ? 'expired' : ''}" title="${fullName}">
                        <span class="route-model-icon">${icon}</span>
                        <span class="route-model-name">${shortName}</span>
                        <div class="route-model-bar">
                            <span class="${barClass}" style="width: ${barWidth};"></span>
                        </div>
                        <div class="route-model-details">${detailsHtml}</div>
                    </div>
                `;
            }).join('');

        return `
            <div class="token-card" id="route-card-${id}">
                <div class="token-header">
                    <span class="status enabled">🔀 ${name || id}</span>
                    <div class="token-header-right">
                        <span class="token-id">${id}</span>
                    </div>
                </div>
                <div class="token-info">
                    <div class="info-row">
                        <span class="info-label">📦</span>
                        <span class="info-value">${escapeHtml(String(models.length))} 个模型</span>
                    </div>
                </div>
                <div class="route-model-list">
                    ${modelListHtml}
                </div>
                <div class="token-info">
                    <div class="info-row">
                        <span class="info-label">🏷️</span>
                        <span class="info-value" title="${escapeHtml(aliasNames.join(', '))}">${escapeHtml(String(aliasNames.length))} 个别名${aliasPreview ? `：${aliasPreview}${aliasNames.length > 4 ? '…' : ''}` : ''}</span>
                    </div>
                    <div class="info-row">
                        <span class="info-label">🔑</span>
                        <span class="info-value">${escapeHtml(String(apiKeyHashes.length))} 个Key</span>
                    </div>
                </div>
                <div class="token-actions">
                    <button type="button" class="btn btn-info btn-xs" onclick="showEditRoutingRouteModal('${safeIdJs}')">✏️ 编辑</button>
                    <button type="button" class="btn btn-success btn-xs" onclick="showRoutingKeysModal('${safeIdJs}')">🔑 Keys</button>
                    <button type="button" class="btn btn-danger btn-xs" onclick="deleteRoutingRoute('${safeIdJs}')">🗑️ 删除</button>
                </div>
            </div>
        `;
    }).join('');
}

async function loadRoutingRoutes(force = false) {
    if (!authToken) return;
    if (!document.getElementById('routingRouteList')) return;

    try {
        const routes = await fetchRoutingRoutes();
        renderRoutingRoutes(routes);
    } catch (error) {
        showToast('加载路由失败: ' + error.message, 'error');
    }
}

function closeRoutingModal(modal) {
    if (modal) modal.remove();
}

function normalizeRoutingCustomApiKey(value) {
    if (value === null || value === undefined) return null;
    const trimmed = String(value).trim();
    if (!trimmed) return null;
    if (trimmed.length < 8 || trimmed.length > 256) return null;
    if (/\s/.test(trimmed)) return null;
    return trimmed;
}

async function copyTextToClipboard(text) {
    const value = (text || '').toString();
    if (!value) return false;

    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(value);
            return true;
        }
    } catch (e) {
    }

    try {
        const textarea = document.createElement('textarea');
        textarea.value = value;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.top = '-1000px';
        textarea.style.left = '-1000px';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        textarea.setSelectionRange(0, textarea.value.length);
        const ok = document.execCommand('copy');
        textarea.remove();
        return Boolean(ok);
    } catch (e) {
        return false;
    }
}

function buildRoutingModelCheckboxesHtml(models, selectedSet) {
    const cards = models.map(modelId => {
        const id = escapeHtml(modelId);
        const shortName = escapeHtml(getShortModelName(modelId));
        const icon = getModelIcon(modelId);
        const isSelected = selectedSet.has(modelId);
        const checked = isSelected ? 'checked' : '';
        const selectedClass = isSelected ? ' selected' : '';
        return `
            <div class="routing-model-card${selectedClass}" data-model-id="${id}" onclick="toggleRoutingModelCard(this)">
                <input type="checkbox" class="routing-model-checkbox" value="${id}" ${checked} onclick="event.stopPropagation()">
                <span class="routing-model-icon">${icon}</span>
                <span class="routing-model-card-name" title="${id}">${shortName}</span>
            </div>
        `;
    }).join('');

    return `<div class="routing-model-grid">${cards}</div>`;
}

function toggleRoutingModelCard(cardEl) {
    if (!cardEl) return;
    const checkbox = cardEl.querySelector('.routing-model-checkbox');
    if (!checkbox) return;

    checkbox.checked = !checkbox.checked;
    cardEl.classList.toggle('selected', checkbox.checked);

    // 触发 change 事件以更新配额列表
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
}

function buildRoutingAliasRowHtml(index, models, aliasName = '', targetModel = '') {
    const safeAlias = escapeHtml(aliasName);
    const safeTarget = escapeHtml(targetModel);
    const options = models.map(m => {
        const mid = escapeHtml(m);
        const selected = m === targetModel ? 'selected' : '';
        return `<option value="${mid}" ${selected}>${escapeHtml(getShortModelName(m))}</option>`;
    }).join('');

    return `
        <div class="routing-alias-row" data-index="${escapeHtml(String(index))}">
            <input type="text" class="routing-alias-name" placeholder="别名（对外）" value="${safeAlias}">
            <select class="routing-alias-target">
                <option value="" ${safeTarget ? '' : 'selected'}>选择映射模型</option>
                ${options}
            </select>
            <button type="button" class="btn btn-danger btn-sm routing-alias-remove" onclick="removeRoutingAliasRow(this)">✖</button>
        </div>
    `;
}

function removeRoutingAliasRow(btn) {
    const row = btn?.closest('.routing-alias-row');
    if (row) row.remove();

    renderRoutingModelQuotaList();
}

function addRoutingAliasRow() {
    const list = document.getElementById('routingAliasList');
    if (!list) return;

    const models = Array.isArray(cachedRoutingModels) ? cachedRoutingModels : [];
    const idx = list.querySelectorAll('.routing-alias-row').length;
    list.insertAdjacentHTML('beforeend', buildRoutingAliasRowHtml(idx, models));

    renderRoutingModelQuotaList();
}

function collectRoutingAliasesFromModal() {
    const aliases = {};
    const rows = document.querySelectorAll('.routing-alias-row');
    rows.forEach(row => {
        const nameInput = row.querySelector('.routing-alias-name');
        const targetSelect = row.querySelector('.routing-alias-target');
        const name = (nameInput?.value || '').trim();
        const target = (targetSelect?.value || '').trim();
        if (!name || !target) return;
        aliases[name] = target;
    });
    return aliases;
}

function collectRoutingModelsFromModal() {
    const checkboxes = document.querySelectorAll('.routing-model-checkbox');
    const models = [];
    checkboxes.forEach(cb => {
        if (cb.checked && cb.value) models.push(cb.value);
    });
    return Array.from(new Set(models));
}

async function showCreateRoutingRouteModal() {
    if (!authToken) return;

    showLoading('正在加载模型列表...');
    let models;
    try {
        models = await ensureRoutingModelsLoaded();
        hideLoading();
    } catch (error) {
        hideLoading();
        showToast('获取模型列表失败: ' + error.message, 'error');
        return;
    }

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'routingRouteEditorModal';

    const modelCheckboxes = buildRoutingModelCheckboxesHtml(models, new Set());

    modal.innerHTML = `
        <div class="modal-content modal-lg">
            <div class="modal-title">➕ 新建路由</div>
            <div class="form-row">
                <div class="form-group">
                    <label>路由ID</label>
                    <input type="text" id="routingRouteIdInput" placeholder="例如: team_a">
                </div>
                <div class="form-group">
                    <label>路由名称</label>
                    <input type="text" id="routingRouteNameInput" placeholder="例如: Team A">
                </div>
                <div class="form-group">
                    <label>允许模型</label>
                    ${modelCheckboxes}
                </div>
                <div class="form-group">
                    <label>模型限额 / 已用次数</label>
                    <div id="routingModelQuotaList" style="max-height: 220px; overflow: auto; border: 1.5px solid var(--border); border-radius: 0.5rem; padding: 0.5rem;"></div>
                </div>
                <div class="form-group">
                    <label>别名映射（可选）</label>
                    <div id="routingAliasList"></div>
                    <button type="button" class="btn btn-secondary btn-sm" onclick="addRoutingAliasRow()">➕ 添加别名</button>
                </div>
            </div>
            <div class="modal-actions">
                <button class="btn btn-secondary" onclick="this.closest('.modal').remove()">取消</button>
                <button class="btn btn-success" onclick="submitCreateRoutingRoute()">创建</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    modal.onclick = (e) => { if (e.target === modal) closeRoutingModal(modal); };

    initRoutingModelQuotaEditor({}, {});
    attachRoutingQuotaEditorListeners(modal);
}

async function submitCreateRoutingRoute() {
    const id = (document.getElementById('routingRouteIdInput')?.value || '').trim();
    const name = (document.getElementById('routingRouteNameInput')?.value || '').trim();

    if (!validateRoutingRouteId(id)) {
        showToast('无效的路由ID，仅允许字母/数字/_/-，长度<=64，且不能为 master', 'warning');
        return;
    }
    if (!name) {
        showToast('请输入路由名称', 'warning');
        return;
    }

    let models = collectRoutingModelsFromModal();
    const aliases = collectRoutingAliasesFromModal();
    const aliasTargets = Object.values(aliases).filter(Boolean);
    models = Array.from(new Set([...models, ...aliasTargets]));

    const modelLimits = collectRoutingModelLimitsForModels(models);
    if (modelLimits === null) {
        return;
    }

    showLoading('正在创建路由...');
    try {
        const response = await authFetch('/admin/routing/routes', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({ id, name, models, aliases, modelLimits })
        });

        const data = await response.json();
        hideLoading();
        if (!data?.success) {
            showToast(data?.message || '创建失败', 'error');
            return;
        }

        showToast('路由已创建', 'success');
        document.querySelectorAll('.modal').forEach(m => m.remove());
        await loadRoutingRoutes(true);
    } catch (error) {
        hideLoading();
        showToast('创建失败: ' + error.message, 'error');
    }
}

async function showEditRoutingRouteModal(routeId) {
    if (!authToken) return;

    const route = getCachedRoutingRouteById(routeId);
    if (!route) {
        await loadRoutingRoutes(true);
    }

    const current = getCachedRoutingRouteById(routeId);
    if (!current) {
        showToast('路由不存在', 'error');
        return;
    }

    showLoading('正在加载模型列表...');
    let models;
    try {
        models = await ensureRoutingModelsLoaded();
        hideLoading();
    } catch (error) {
        hideLoading();
        showToast('获取模型列表失败: ' + error.message, 'error');
        return;
    }

    const selected = new Set(Array.isArray(current.models) ? current.models : []);
    const modelCheckboxes = buildRoutingModelCheckboxesHtml(models, selected);

    const aliases = (current.aliases && typeof current.aliases === 'object' && !Array.isArray(current.aliases)) ? current.aliases : {};
    const aliasEntries = Object.entries(aliases);

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'routingRouteEditorModal';

    modal.innerHTML = `
        <div class="modal-content modal-lg">
            <div class="modal-title">✏️ 编辑路由</div>
            <div class="form-row">
                <div class="form-group">
                    <label>路由ID</label>
                    <input type="text" id="routingRouteIdInput" value="${escapeHtml(current.id || '')}" disabled>
                </div>
                <div class="form-group">
                    <label>路由名称</label>
                    <input type="text" id="routingRouteNameInput" value="${escapeHtml(current.name || '')}">
                </div>
                <div class="form-group">
                    <label>允许模型</label>
                    ${modelCheckboxes}
                </div>
                <div class="form-group">
                    <label>模型限额 / 已用次数</label>
                    <div id="routingModelQuotaList" style="max-height: 220px; overflow: auto; border: 1.5px solid var(--border); border-radius: 0.5rem; padding: 0.5rem;"></div>
                </div>
                <div class="form-group">
                    <label>别名映射（可选）</label>
                    <div id="routingAliasList"></div>
                    <button type="button" class="btn btn-secondary btn-sm" onclick="addRoutingAliasRow()">➕ 添加别名</button>
                </div>
            </div>
            <div class="modal-actions">
                <button class="btn btn-secondary" onclick="this.closest('.modal').remove()">取消</button>
                <button class="btn btn-success" onclick="submitUpdateRoutingRoute('${escapeJs(current.id || '')}')">保存</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    modal.onclick = (e) => { if (e.target === modal) closeRoutingModal(modal); };

    attachRoutingQuotaEditorListeners(modal);

    const aliasList = document.getElementById('routingAliasList');
    if (aliasList) {
        if (aliasEntries.length === 0) {
            aliasList.innerHTML = '';
        } else {
            aliasList.innerHTML = aliasEntries.map(([a, m], idx) => buildRoutingAliasRowHtml(idx, models, a, m)).join('');
        }
    }

    initRoutingModelQuotaEditor(current?.modelLimits || {}, current?.modelUsage || {});

    renderRoutingModelQuotaList();
}

async function submitUpdateRoutingRoute(routeId) {
    const name = (document.getElementById('routingRouteNameInput')?.value || '').trim();
    if (!name) {
        showToast('请输入路由名称', 'warning');
        return;
    }

    let models = collectRoutingModelsFromModal();
    const aliases = collectRoutingAliasesFromModal();
    const aliasTargets = Object.values(aliases).filter(Boolean);
    models = Array.from(new Set([...models, ...aliasTargets]));

    const modelLimits = collectRoutingModelLimitsForModels(models);
    if (modelLimits === null) {
        return;
    }

    showLoading('正在保存路由...');
    try {
        const response = await authFetch(`/admin/routing/routes/${encodeURIComponent(routeId)}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({ name, models, aliases, modelLimits })
        });

        const data = await response.json();
        hideLoading();
        if (!data?.success) {
            showToast(data?.message || '保存失败', 'error');
            return;
        }

        showToast('路由已更新', 'success');
        document.querySelectorAll('.modal').forEach(m => m.remove());
        await loadRoutingRoutes(true);
    } catch (error) {
        hideLoading();
        showToast('保存失败: ' + error.message, 'error');
    }
}

async function deleteRoutingRoute(routeId) {
    const route = getCachedRoutingRouteById(routeId);
    const title = route?.name ? `删除路由：${route.name}` : '删除路由';
    const confirmed = await showConfirm('确定要删除该路由吗？该路由的所有分支Key将失效。', title);
    if (!confirmed) return;

    showLoading('正在删除路由...');
    try {
        const response = await authFetch(`/admin/routing/routes/${encodeURIComponent(routeId)}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        const data = await response.json();
        hideLoading();

        if (!data?.success) {
            showToast(data?.message || '删除失败', 'error');
            return;
        }

        showToast('路由已删除', 'success');
        await loadRoutingRoutes(true);
    } catch (error) {
        hideLoading();
        showToast('删除失败: ' + error.message, 'error');
    }
}

function getRoutingKeysModalEl() {
    return document.getElementById('routingKeysModal');
}

function updateRoutingKeysModalTitle(route) {
    const titleEl = document.getElementById('routingKeysModalTitle');
    if (!titleEl) return;
    const name = route?.name ? `${route.name} (${route.id})` : (route?.id || '');
    titleEl.textContent = `🔑 Keys - ${name}`;
}

function renderRoutingKeysList(route) {
    const listEl = document.getElementById('routingKeyHashList');
    if (!listEl) return;

    const hashes = Array.isArray(route?.apiKeyHashes) ? route.apiKeyHashes : [];
    const safeRouteJs = escapeJs(route?.id || '');

    if (hashes.length === 0) {
        listEl.innerHTML = `<div class="empty-state" style="padding: 0.75rem;">
            <div class="empty-state-icon">🔑</div>
            <div class="empty-state-text">暂无Key</div>
        </div>`;
        return;
    }

    // 按创建顺序倒序显示，最新的在最前面
    const ordered = hashes.slice().reverse();
    const total = ordered.length;
    listEl.innerHTML = ordered.map((h, idx) => {
        const rawHash = (h || '').toString();
        const safeHashJs = escapeJs(rawHash);
        // 简化显示：Key #序号（最新的是 #1）
        const keyNumber = idx + 1;
        return `
            <div class="routing-keyhash-row">
                <span class="routing-keyhash-label">🔑 Key #${keyNumber}</span>
                <div class="routing-keyhash-actions">
                    <button type="button" class="btn btn-danger btn-xs" onclick="revokeRoutingApiKey('${safeRouteJs}', '${safeHashJs}')">吊销</button>
                </div>
            </div>
        `;
    }).join('');
}

async function copyRoutingKeyHash(keyHash) {
    const value = (keyHash || '').toString();
    if (!value) return;
    const ok = await copyTextToClipboard(value);
    if (ok) {
        showToast('Hash已复制', 'success');
    } else {
        showToast('复制失败，请手动复制', 'warning');
    }
}

function setRoutingGeneratedKey(apiKey) {
    const wrapper = document.getElementById('routingGeneratedKeyWrapper');
    const input = document.getElementById('routingGeneratedKeyInput');
    if (!wrapper || !input) return;

    input.value = apiKey || '';
    input.type = 'password';
    wrapper.style.display = apiKey ? '' : 'none';
}

function toggleRoutingGeneratedKeyVisibility() {
    const input = document.getElementById('routingGeneratedKeyInput');
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
}

async function copyRoutingGeneratedKey() {
    const input = document.getElementById('routingGeneratedKeyInput');
    if (!input || !input.value) return;
    const ok = await copyTextToClipboard(input.value);
    if (ok) {
        showToast('Key已复制', 'success');
    } else {
        input.type = 'text';
        input.focus();
        input.select();
        showToast('复制失败，请手动复制', 'warning');
    }
}

async function showRoutingKeysModal(routeId) {
    if (!authToken) return;

    const route = getCachedRoutingRouteById(routeId);
    if (!route) {
        await loadRoutingRoutes(true);
    }

    const current = getCachedRoutingRouteById(routeId);
    if (!current) {
        showToast('路由不存在', 'error');
        return;
    }

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'routingKeysModal';

    modal.innerHTML = `
        <div class="modal-content modal-lg">
            <div class="modal-title" id="routingKeysModalTitle"></div>
            <div class="modal-message">Key 仅会在创建后显示一次；系统只保存 Key Hash 用于吊销/审计，请及时复制并妥善保管。</div>
            <div class="routing-keys-grid">
                <div>
                    <div class="form-group highlight">
                        <label>创建新Key（可选自定义，留空则随机生成）</label>
                        <div class="routing-keys-create-row">
                            <input type="text" id="routingCustomKeyInput" value="" placeholder="输入自定义Key，或留空随机生成" style="font-family: var(--font-mono, ui-monospace);">
                            <div class="routing-keys-actions">
                                <button type="button" class="btn btn-success btn-sm" onclick="generateRoutingApiKey('${escapeJs(current.id || '')}')">生成/保存</button>
                            </div>
                        </div>
                        <div class="routing-keys-hint">自定义Key要求：长度 8~256，不能包含空白字符</div>
                    </div>
                    <div class="form-group" id="routingGeneratedKeyWrapper" style="display:none;">
                        <label>新生成Key（仅显示一次，请立即复制）</label>
                        <div class="routing-keys-generated-row">
                            <input type="password" id="routingGeneratedKeyInput" value="" readonly style="font-family: var(--font-mono, ui-monospace);">
                            <div class="routing-keys-actions">
                                <button type="button" class="btn btn-info btn-xs" onclick="toggleRoutingGeneratedKeyVisibility()">👁️</button>
                                <button type="button" class="btn btn-success btn-xs" onclick="copyRoutingGeneratedKey()">📋</button>
                            </div>
                        </div>
                    </div>
                </div>
                <div>
                    <div class="form-group">
                        <label>Key Hash 列表</label>
                        <div id="routingKeyHashList" class="routing-keyhash-list"></div>
                    </div>
                </div>
            </div>
            <div class="modal-actions">
                <button class="btn btn-secondary" onclick="this.closest('.modal').remove()">关闭</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    modal.onclick = (e) => { if (e.target === modal) closeRoutingModal(modal); };

    updateRoutingKeysModalTitle(current);
    renderRoutingKeysList(current);
    setRoutingGeneratedKey('');
    const customKeyInput = document.getElementById('routingCustomKeyInput');
    if (customKeyInput) {
        customKeyInput.value = '';
        customKeyInput.focus();
        customKeyInput.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            generateRoutingApiKey(current.id || '');
        });
    }
}

async function generateRoutingApiKey(routeId) {
    const rawCustomKey = document.getElementById('routingCustomKeyInput')?.value;
    const trimmed = (rawCustomKey || '').trim();
    const normalizedCustomKey = trimmed ? normalizeRoutingCustomApiKey(trimmed) : '';
    if (trimmed && !normalizedCustomKey) {
        showToast('自定义Key格式无效（长度8~256，不能包含空白字符）', 'warning');
        const input = document.getElementById('routingCustomKeyInput');
        if (input) {
            input.focus();
            input.select();
        }
        return;
    }

    showLoading('正在生成Key...');
    try {
        const customKey = normalizedCustomKey;
        const response = await authFetch(`/admin/routing/routes/${encodeURIComponent(routeId)}/keys`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify(customKey ? { apiKey: customKey } : {})
        });
        const data = await response.json();
        hideLoading();

        if (!data?.success) {
            showToast(data?.message || '生成失败', 'error');
            return;
        }

        const apiKey = data?.data?.apiKey;
        const keyHash = data?.data?.keyHash;

        showToast('Key已生成（仅显示一次）', 'success');

        const modal = getRoutingKeysModalEl();
        if (modal) {
            setRoutingGeneratedKey(apiKey || '');
            const customKeyInput = document.getElementById('routingCustomKeyInput');
            if (customKeyInput) customKeyInput.value = '';
        } else {
            if (apiKey) {
                const ok = await copyTextToClipboard(apiKey);
                if (ok) {
                    showToast('Key已复制', 'success');
                } else {
                    showToast('Key复制失败，请手动复制', 'warning');
                }
            }
        }

        await loadRoutingRoutes(true);
        const updated = getCachedRoutingRouteById(routeId);
        if (modal && updated) {
            renderRoutingKeysList(updated);
        }

        if (!apiKey || !keyHash) {
            return;
        }
    } catch (error) {
        hideLoading();
        showToast('生成失败: ' + error.message, 'error');
    }
}

async function revokeRoutingApiKey(routeId, keyHash) {
    const confirmed = await showConfirm('确定要吊销该Key吗？吊销后该Key将无法再访问。', '吊销Key');
    if (!confirmed) return;

    showLoading('正在吊销Key...');
    try {
        const response = await authFetch(`/admin/routing/routes/${encodeURIComponent(routeId)}/keys/${encodeURIComponent(keyHash)}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        const data = await response.json();
        hideLoading();

        if (!data?.success) {
            showToast(data?.message || '吊销失败', 'error');
            return;
        }

        showToast('Key已吊销', 'success');
        await loadRoutingRoutes(true);

        const modal = getRoutingKeysModalEl();
        if (modal) {
            const updated = getCachedRoutingRouteById(routeId);
            if (updated) renderRoutingKeysList(updated);
        }
    } catch (error) {
        hideLoading();
        showToast('吊销失败: ' + error.message, 'error');
    }
}

function initRoutingManagement() {
    if (!document.getElementById('routingRouteList')) return;

    if (!routingInitialized) {
        routingInitialized = true;
    }

    if (authToken) {
        loadRoutingRoutes();
    }
}
