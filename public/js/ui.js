// UI组件：Toast、Modal、Loading

function showToast(message, type = 'info', title = '') {
    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    const titles = { success: '成功', error: '错误', warning: '警告', info: '提示' };
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    // 转义用户输入防止 XSS
    const safeTitle = escapeHtml(title || titles[type]);
    const safeMessage = escapeHtml(message);
    toast.innerHTML = `
        <div class="toast-icon">${icons[type]}</div>
        <div class="toast-content">
            <div class="toast-title">${safeTitle}</div>
            <div class="toast-message">${safeMessage}</div>
        </div>
    `;
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function showConfirm(message, title = '确认操作') {
    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.className = 'modal';
        // 转义用户输入防止 XSS
        const safeTitle = escapeHtml(title);
        const safeMessage = escapeHtml(message);
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-title">${safeTitle}</div>
                <div class="modal-message">${safeMessage}</div>
                <div class="modal-actions">
                    <button class="btn btn-secondary" onclick="this.closest('.modal').remove(); window.modalResolve(false)">取消</button>
                    <button class="btn btn-danger" onclick="this.closest('.modal').remove(); window.modalResolve(true)">确定</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        modal.onclick = (e) => { if (e.target === modal) { modal.remove(); resolve(false); } };
        window.modalResolve = resolve;
    });
}

function showLoading(text = '处理中...') {
    const overlay = document.createElement('div');
    overlay.className = 'loading-overlay';
    overlay.id = 'loadingOverlay';
    // 转义用户输入防止 XSS
    const safeText = escapeHtml(text);
    overlay.innerHTML = `<div class="spinner"></div><div class="loading-text">${safeText}</div>`;
    document.body.appendChild(overlay);
}

function hideLoading() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.remove();
}

function switchTab(tab, saveState = true) {
    // 更新html元素的class以防止闪烁
    document.documentElement.classList.remove('tab-settings', 'tab-kiro', 'tab-codex');
    if (tab === 'settings') {
        document.documentElement.classList.add('tab-settings');
    } else if (tab === 'kiro') {
        document.documentElement.classList.add('tab-kiro');
    } else if (tab === 'codex') {
        document.documentElement.classList.add('tab-codex');
    }

    // 移除所有tab的active状态
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));

    // 找到对应的tab按钮并激活
    const targetTab = document.querySelector(`.tab[data-tab="${tab}"]`);
    if (targetTab) {
        targetTab.classList.add('active');
    }

    const tokensPage = document.getElementById('tokensPage');
    const kiroPage = document.getElementById('kiroPage');
    const codexPage = document.getElementById('codexPage');
    const settingsPage = document.getElementById('settingsPage');

    // 隐藏所有页面并移除动画类
    tokensPage.classList.add('hidden');
    tokensPage.classList.remove('page-enter');
    if (kiroPage) {
        kiroPage.classList.add('hidden');
        kiroPage.classList.remove('page-enter');
    }
    if (codexPage) {
        codexPage.classList.add('hidden');
        codexPage.classList.remove('page-enter');
    }
    settingsPage.classList.add('hidden');
    settingsPage.classList.remove('page-enter');

    // 显示对应页面并添加入场动画
    if (tab === 'tokens') {
        tokensPage.classList.remove('hidden');
        // 触发重排以重新播放动画
        void tokensPage.offsetWidth;
        tokensPage.classList.add('page-enter');
    } else if (tab === 'kiro') {
        if (kiroPage) {
            kiroPage.classList.remove('hidden');
            void kiroPage.offsetWidth;
            kiroPage.classList.add('page-enter');
            // 首次切换到 Kiro 时加载账号列表
            if (typeof loadKiroAccounts === 'function') {
                loadKiroAccounts();
            }
        }
    } else if (tab === 'codex') {
        if (codexPage) {
            codexPage.classList.remove('hidden');
            void codexPage.offsetWidth;
            codexPage.classList.add('page-enter');
            // 首次切换到 Codex 时加载账号列表
            if (typeof loadCodexAccounts === 'function') {
                loadCodexAccounts();
            }
        }
    } else if (tab === 'settings') {
        settingsPage.classList.remove('hidden');
        // 触发重排以重新播放动画
        void settingsPage.offsetWidth;
        settingsPage.classList.add('page-enter');
        loadConfig();
    }

    // 保存当前Tab状态到localStorage
    if (saveState) {
        localStorage.setItem('currentTab', tab);
    }
}

// 恢复Tab状态
function restoreTabState() {
    const savedTab = localStorage.getItem('currentTab');
    if (savedTab && (savedTab === 'tokens' || savedTab === 'kiro' || savedTab === 'codex' || savedTab === 'settings')) {
        switchTab(savedTab, false);
    }
}

// 创建固定底部浮动按钮栏
function createConfigFloatingBar() {
    // 如果已存在则不重复创建
    if (document.getElementById('configFloatingBar')) return;

    const bar = document.createElement('div');
    bar.id = 'configFloatingBar';
    bar.className = 'config-floating-bar';
    bar.innerHTML = `
        <button type="button" id="floatingSaveBtn" class="btn btn-success">💾 保存配置</button>
        <button type="button" id="floatingReloadBtn" class="btn btn-secondary">🔄 重新加载</button>
    `;

    // 插入到 body 最后
    document.body.appendChild(bar);

    // 绑定保存按钮事件 - 触发表单提交
    document.getElementById('floatingSaveBtn').addEventListener('click', function() {
        const form = document.getElementById('configForm');
        if (form) {
            // 创建并触发submit事件
            const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
            form.dispatchEvent(submitEvent);
        }
    });

    // 绑定重新加载按钮事件
    document.getElementById('floatingReloadBtn').addEventListener('click', function() {
        if (typeof loadConfig === 'function') {
            loadConfig();
        }
    });

    // 用JS动态固定位置，解决backdrop-filter破坏position:fixed的问题
    function updateBarPosition() {
        const viewportHeight = window.innerHeight;
        bar.style.top = (viewportHeight - bar.offsetHeight - 24) + 'px';

        const mainContent = document.getElementById('mainContent');
        if (mainContent) {
            const rect = mainContent.getBoundingClientRect();
            const padding = 24;
            const rightAligned = rect.right - bar.offsetWidth - padding;
            const leftBound = rect.left + padding;
            bar.style.left = Math.max(leftBound, rightAligned) + 'px';
        }
    }

    // 监听滚动容器
    const configGrid = document.querySelector('.config-grid');
    if (configGrid) {
        configGrid.addEventListener('scroll', updateBarPosition, { passive: true });
    }

    // 监听窗口大小变化
    window.addEventListener('resize', updateBarPosition, { passive: true });

    // 初始定位
    setTimeout(updateBarPosition, 100);

    // 使用 MutationObserver 监听显示状态变化
    const observer = new MutationObserver(function() {
        if (bar.offsetParent !== null) {
            updateBarPosition();
        }
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
}
