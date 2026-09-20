// filename: js/main.js
/**
 * ============================================================================
 * main.js — 引导入口
 * ============================================================================
 *
 * 【本次修订说明 — 修复第一行非法字符】
 *
 *   一、【P0 修复】第一行 `# filename:` 改为 `// filename:`
 *     · 原先第一行是 `# filename: js/main.js`，是非法的 JavaScript，
 *       会导致整个 ES Module 图构建失败。
 *
 *   二、其余能力保持不变
 *     · 控制台版本信息
 *     · 错误边界降级 UI
 *     · visibilitychange + pagehide 双绑定
 *     · 持久化权限申请状态可读描述
 * ============================================================================
 */

import { CONFIG } from './config.js';
import {
    AppState,
    resetTransientStateForHidden,
    resetTransientStateForUnload
} from './state.js';
import { showToast } from './toast.js';
import {
    loadStateOnStartup,
    scheduleAutoSave,
    syncDarkModeToggleButtonText,
    forceSaveBeforeUnload
} from './persistence.js';
import { closeDatabase } from './storage.js';
import {
    renderRuleTable,
    initializeRuleTableColumns,
    updateBatchRunButtonLabel,
    updateActivePresetIndicator
} from './rules.js';
import {
    initializeResultSearch
} from './search.js';
import {
    bindAllUiEvents,
    updateStorageUnavailableBanner,
    updatePersistentStorageBanner,
    updateJsTrustIndicator
} from './ui.js';
import {
    printChangelog,
    getChangelogSummary,
    getChangelogStats
} from './changelog.js';

// ============================================================================
// 主流程
// ============================================================================

async function initializeApplication() {
    // ---- 1. 加载持久化状态（仅规则、预设、界面偏好）----
    let loadResult = { loaded: false, reason: 'default' };
    try {
        loadResult = await loadStateOnStartup();
    } catch (loadError) {
        console.warn('状态加载异常，使用默认配置:', loadError);
        loadResult = { loaded: false, reason: 'default' };
    }

    // ---- 2. 渲染规则表 ----
    renderRuleTable();

    // ---- 3. 列宽拖拽 ----
    initializeRuleTableColumns();

    // ---- 4. 搜索结果栏 ----
    initializeResultSearch();

    // ---- 5. 绑定 UI 事件 ----
    bindAllUiEvents();

    // ---- 6. 调度一次自动保存（仅在允许保存时生效）----
    scheduleAutoSave();

    // ---- 7. 顶部指示器同步 ----
    syncDarkModeToggleButtonText();
    updateStorageUnavailableBanner();
    updatePersistentStorageBanner();
    updateJsTrustIndicator();
    updateBatchRunButtonLabel();
    updateActivePresetIndicator();

    // ---- 8. 启动完成提示 ----
    displayStartupToast(loadResult);

    // ---- 9. 控制台版本信息 ----
    printStartupVersionInfo();

    // ---- 10. 页面生命周期处理 ----
    bindPageLifecycleEvents();
}

// ============================================================================
// 页面生命周期
// ============================================================================

/**
 * 页面隐藏 / 卸载时的保存与重置逻辑。
 *
 * 使用 visibilitychange(hidden) 作为主要触发点（比 pagehide 更早）。
 * pagehide 作为兜底。
 */
function bindPageLifecycleEvents() {
    if (typeof window === 'undefined') return;

    let hasSavedOnHide = false;

    function saveOnHide(reason) {
        if (hasSavedOnHide) return;
        hasSavedOnHide = true;

        forceSaveBeforeUnload()
            .then(function onSaved() {
                closeDatabase();
            })
            .catch(function onSaveError(saveError) {
                console.warn(
                    '页面隐藏时强制保存失败 (' + reason + '):',
                    saveError
                );
            });

        try {
            if (reason === 'visibilitychange') {
                resetTransientStateForHidden();
            } else {
                resetTransientStateForUnload();
            }
        } catch (resetError) {
            console.warn('清理临时状态失败 (' + reason + '):', resetError);
        }
    }

    document.addEventListener('visibilitychange', function onVisibilityChange() {
        if (document.visibilityState === 'hidden') {
            saveOnHide('visibilitychange');
        } else if (document.visibilityState === 'visible') {
            hasSavedOnHide = false;
        }
    });

    window.addEventListener('pagehide', function onPageHide(pagehideEvent) {
        if (pagehideEvent && pagehideEvent.persisted === true) {
            return;
        }
        saveOnHide('pagehide');
    });
}

// ============================================================================
// 启动 toast
// ============================================================================

function displayStartupToast(loadResult) {
    const result = loadResult || {};
    const loaded = result.loaded === true;
    const reason = result.reason || 'default';

    if (loaded) {
        showToast('已恢复规则与设置（文本始终从空白开始）');
        return;
    }

    if (reason === 'skipped') {
        showToast(
            '本次会话未加载磁盘数据，也不会保存到磁盘。\n' +
            '如需恢复请勾选"启动时恢复规则与设置"后刷新页面。'
        );
        return;
    }

    if (reason === 'storage_unavailable') {
        return;
    }

    // 默认 / 首次访问
    showToast('已加载默认配置');
}

// ============================================================================
// 控制台版本信息
// ============================================================================

function describePersistentStorageStatus() {
    const granted = AppState.persistentStorageGranted;

    if (granted === 'unknown') {
        return CONFIG.STORAGE_PERSIST_DEFERRED
            ? '申请中（待首次交互）'
            : '申请中';
    }
    return granted;
}

function printStartupVersionInfo() {
    if (typeof console === 'undefined' || !console.log) return;

    console.log(
        '%c TextPro 文本净化工具 v' + CONFIG.APP_VERSION + ' 已就绪',
        'color:#0f6b8c;font-weight:bold;font-size:14px;'
    );

    const summary = getChangelogSummary();
    if (summary) {
        console.log(
            '%c 本次更新：' + summary,
            'color:#16a34a;font-weight:bold;'
        );
    }

    const stats = getChangelogStats();
    console.log(
        '%c 变更统计：新增 ' + stats['新增'] +
        ' · 优化 ' + stats['优化'] +
        ' · 修复 ' + stats['修复'],
        'color:#6b7280;'
    );

    console.log(
        '%c 持久化存储权限：' + describePersistentStorageStatus() +
        '（策略：' + (CONFIG.STORAGE_PERSIST_DEFERRED
            ? '延后到首次交互'
            : '立即申请') + '）',
        'color:#6b7280;'
    );

    console.log(
        '%c JS 信任模型：' + (CONFIG.JS_TRUST_RULE_BASED
            ? '按规则信任'
            : '按会话信任'),
        'color:#6b7280;'
    );

    console.log(
        '%c 持久化策略：配置持久化（规则/预设/界面偏好）· 内容不持久化（文本/搜索词）',
        'color:#6b7280;'
    );

    console.log(
        '%c 页面隐藏策略：切标签页保留大文本缓存 · 关闭页面时释放',
        'color:#6b7280;'
    );

    console.log(
        '%c 在控制台执行 printChangelog() 可查看完整版本历史',
        'color:#6b7280;font-style:italic;'
    );

    if (typeof window !== 'undefined') {
        window.printChangelog = printChangelog;
    }
}

// ============================================================================
// 错误边界降级 UI
// ============================================================================

function renderFatalErrorFallback(fatalError) {
    if (typeof document === 'undefined') return;

    try {
        const existingFallback = document.getElementById(
            'textpro-fatal-error-fallback'
        );
        if (existingFallback) return;

        const fallbackOverlay = document.createElement('div');
        fallbackOverlay.id = 'textpro-fatal-error-fallback';
        fallbackOverlay.style.cssText =
            'position: fixed;' +
            'top: 0; left: 0; right: 0; bottom: 0;' +
            'background: rgba(15, 23, 42, 0.75);' +
            'backdrop-filter: blur(2px);' +
            'z-index: 9999;' +
            'display: flex;' +
            'align-items: center;' +
            'justify-content: center;' +
            'padding: 20px;';

        const fallbackCard = document.createElement('div');
        fallbackCard.style.cssText =
            'background: #ffffff;' +
            'color: #1e293b;' +
            'border-radius: 20px;' +
            'box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);' +
            'padding: 28px 32px;' +
            'max-width: 560px;' +
            'width: 100%;' +
            'font-family: system-ui, sans-serif;' +
            'line-height: 1.6;';

        const title = document.createElement('div');
        title.textContent = '⚠️ 应用启动失败';
        title.style.cssText =
            'font-size: 1.25rem;' +
            'font-weight: 700;' +
            'color: #b13b2a;' +
            'margin-bottom: 12px;';
        fallbackCard.appendChild(title);

        const description = document.createElement('div');
        description.textContent =
            'TextPro 遇到意外错误，无法完成初始化。' +
            '请刷新页面重试。如果问题持续出现，' +
            '可以尝试清除本站的浏览器存储，或使用其他浏览器访问。';
        description.style.cssText =
            'font-size: 0.9rem;' +
            'color: #475569;' +
            'margin-bottom: 20px;';
        fallbackCard.appendChild(description);

        const errorDetailsWrapper = document.createElement('details');
        errorDetailsWrapper.style.cssText =
            'background: #f1f5f9;' +
            'border-radius: 10px;' +
            'padding: 8px 14px;' +
            'font-size: 0.8rem;' +
            'margin-bottom: 20px;';

        const errorDetailsSummary = document.createElement('summary');
        errorDetailsSummary.textContent = '查看错误详情';
        errorDetailsSummary.style.cssText =
            'cursor: pointer;' +
            'font-weight: 600;' +
            'color: #1f5e7e;' +
            'user-select: none;';
        errorDetailsWrapper.appendChild(errorDetailsSummary);

        const errorDetailsBody = document.createElement('pre');
        errorDetailsBody.textContent = fatalError && fatalError.stack
            ? String(fatalError.stack)
            : (fatalError && fatalError.message
                ? String(fatalError.message)
                : '未知错误');
        errorDetailsBody.style.cssText =
            'margin-top: 8px;' +
            'white-space: pre-wrap;' +
            'word-break: break-word;' +
            'font-family: monospace;' +
            'font-size: 0.75rem;' +
            'color: #334155;' +
            'max-height: 200px;' +
            'overflow: auto;';
        errorDetailsWrapper.appendChild(errorDetailsBody);

        fallbackCard.appendChild(errorDetailsWrapper);

        const actionsRow = document.createElement('div');
        actionsRow.style.cssText =
            'display: flex;' +
            'justify-content: flex-end;' +
            'gap: 10px;';

        const reloadButton = document.createElement('button');
        reloadButton.type = 'button';
        reloadButton.textContent = '🔄 重新加载';
        reloadButton.style.cssText =
            'background: #0f6b8c;' +
            'color: white;' +
            'border: none;' +
            'border-radius: 40px;' +
            'padding: 10px 24px;' +
            'font-size: 0.9rem;' +
            'font-weight: 600;' +
            'cursor: pointer;';
        reloadButton.addEventListener('click', function onReload() {
            window.location.reload();
        });
        actionsRow.appendChild(reloadButton);

        fallbackCard.appendChild(actionsRow);
        fallbackOverlay.appendChild(fallbackCard);
        document.body.appendChild(fallbackOverlay);
    } catch (renderError) {
        if (typeof console !== 'undefined' && console.error) {
            console.error('渲染降级 UI 失败:', renderError);
        }
    }
}

// ============================================================================
// 启动入口
// ============================================================================

initializeApplication().catch(function onFatalError(fatalError) {
    console.error('应用启动失败:', fatalError);

    try {
        showToast('应用启动失败，请刷新页面重试', true);
    } catch (toastError) {
        console.warn('显示 toast 失败:', toastError);
    }

    renderFatalErrorFallback(fatalError);
});