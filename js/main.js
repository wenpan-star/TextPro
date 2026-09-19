/**
 * ============================================================================
 * main.js — 引导入口
 * ============================================================================
 *
 * 【本次重构说明 — 配置持久化 / 内容不持久化】
 *
 *   一、移除文本区初始值应用
 *     · 文本不再持久化 → 启动时无需从 AppState 回填 textarea
 *     · DOM 中 textarea 默认就是空，天然满足"每次打开从空文本开始"
 *
 *   二、移除启动时的搜索刷新
 *     · 搜索词不再持久化 → 启动时搜索框必为空，无需触发搜索
 *
 *   三、启动 toast 文案调整
 *     · "已恢复上次编辑状态" → "已恢复规则与设置（文本始终从空白开始）"
 *     · skipped 分支的文案同步调整，避免对用户产生误导
 *
 *   四、保留全部既有能力
 *     · 控制台版本信息
 *     · 错误边界降级 UI
 *     · visibilitychange + pagehide 双绑定
 *     · 持久化权限申请状态可读描述
 * ============================================================================
 */

import { CONFIG } from './config.js';
import { AppState, resetTransientState } from './state.js';
import { DOM } from './dom.js';
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
    initializeResultSearch,
    updateSearchMatches
} from './search.js';
import {
    bindAllUiEvents,
    updateStorageUnavailableBanner,
    updatePersistentStorageBanner,
    updateJsTrustIndicator
} from './ui.js';
import { getSourceText, getResultText } from './editor-api.js';
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

    // ★ 修订：原先的"应用文本区初始值"整段移除
    //   文本不再持久化 → 启动时 textarea 天然为空，无需回填。
    //   若未来重新启用文本持久化，请在此处恢复：
    //     if (DOM.sourceTextarea && AppState.sourceText) {
    //         DOM.sourceTextarea.value = AppState.sourceText;
    //     }
    //     if (DOM.resultTextarea && AppState.resultText) {
    //         DOM.resultTextarea.value = AppState.resultText;
    //     }

    // ★ 修订：原先的"刷新搜索结果"整段移除
    //   搜索词不再持久化 → 启动时搜索框必为空，无需触发搜索。
    //   若未来重新启用搜索词持久化，请在此处恢复：
    //     if (DOM.resultSearchInput && DOM.resultSearchInput.value.trim() !== '') {
    //         updateSearchMatches();
    //     }

    // ---- 6. 调度一次自动保存（写入配置，不包含文本）----
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
 * 页面隐藏 / 卸载时的保存逻辑。
 *
 * 使用 visibilitychange(hidden) 作为主要触发点（比 pagehide 更早）。
 * pagehide 作为兜底。
 *
 * 加锁策略：
 *   · hasSavedOnHide = true 时表示本次隐藏已经触发保存
 *   · 页面重新可见时（visibilityState === 'visible'）重置该标志
 *   · 避免短时间内多次触发重复保存
 */
function bindPageLifecycleEvents() {
    if (typeof window === 'undefined') return;

    let hasSavedOnHide = false;

    function saveOnHide(reason) {
        if (hasSavedOnHide) return;
        hasSavedOnHide = true;

        forceSaveBeforeUnload()
            .then(function onSaved() {
                // 保存完成后主动关闭数据库连接
                closeDatabase();
            })
            .catch(function onSaveError(saveError) {
                console.warn('页面隐藏时强制保存失败 (' + reason + '):', saveError);
            });

        try {
            resetTransientState();
        } catch (resetError) {
            console.warn('卸载时清理临时状态失败:', resetError);
        }
    }

    document.addEventListener('visibilitychange', function onVisibilityChange() {
        if (document.visibilityState === 'hidden') {
            saveOnHide('visibilitychange');
        } else if (document.visibilityState === 'visible') {
            // 页面重新可见 → 允许下次再次触发保存
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

/**
 * 显示启动提示。
 *
 * ★ 修订：文案与"配置持久化 / 内容不持久化"的新设计保持一致。
 *
 *   新语义：
 *     · loaded=true        → 恢复了规则与设置（文本始终从空白开始）
 *     · reason='skipped'   → 用户主动关闭恢复 → 使用默认配置
 *     · reason='storage_unavailable' → 存储不可用（顶部横幅已提示）
 *     · reason='default'   → 首次访问
 */
function displayStartupToast(loadResult) {
    const result = loadResult || {};
    const loaded = result.loaded === true;
    const reason = result.reason || 'default';

    if (loaded) {
        showToast('已恢复规则与设置（文本始终从空白开始）');
        return;
    }

    if (reason === 'skipped') {
        let message = '已按设置使用默认配置（文本始终从空白开始）';
        // 只在权限已授予时，才承诺"旧配置仍在本地"
        if (AppState.persistentStorageGranted === 'granted') {
            message +=
                '（旧配置仍在本地，重新勾选"启动时恢复规则与设置"并刷新即可恢复）';
        } else {
            message +=
                '（旧配置可能已被浏览器清理，建议重新勾选后刷新查看）';
        }
        showToast(message);
        return;
    }

    if (reason === 'storage_unavailable') {
        // 存储不可用已在 persistence 中弹过错误 toast
        // 顶部的常驻警告横幅也已显示，这里不再重复提示
        return;
    }

    // 默认 / 首次访问
    showToast('已加载默认配置');
}

// ============================================================================
// 控制台版本信息
// ============================================================================

/**
 * 生成持久化权限的可读描述。
 *
 * · unknown + STORAGE_PERSIST_DEFERRED → "申请中（待首次交互）"
 * · unknown + !STORAGE_PERSIST_DEFERRED → "申请中"
 * · 其它 → 原样返回（'granted' / 'denied' / 'unsupported'）
 */
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

/**
 * 在应用启动失败时渲染一个降级提示卡。
 *
 * 特点：
 *   · 显示明确的错误标题
 *   · 提供"重新加载"按钮
 *   · 提供"查看错误详情"折叠区
 *   · 不影响页面原有布局（追加到 body 末尾）
 */
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
        // 渲染降级 UI 本身出错时，静默失败（避免无限递归）
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

    // 尝试显示 toast（若 DOM 已就绪）
    try {
        showToast('应用启动失败，请刷新页面重试', true);
    } catch (toastError) {
        // showToast 本身失败时忽略
        console.warn('显示 toast 失败:', toastError);
    }

    // 渲染降级 UI
    renderFatalErrorFallback(fatalError);
});