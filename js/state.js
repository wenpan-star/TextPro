// filename: js/state.js
/**
 * ============================================================================
 * state.js — 全局运行时状态
 * ============================================================================
 *
 * 【本次修订说明 — 修复刷新丢数据的 P0 缺陷】
 *
 *   一、【P0 修复】第一行 `# filename:` 改为 `// filename:`
 *     · 原先第一行是 `# filename: js/state.js`。
 *       `#` 不是合法的 JavaScript 注释符（只在类私有字段和 shebang 里合法），
 *       浏览器解析时抛出 "Invalid or unexpected token"，导致整个 ES 模块
 *       图构建失败 —— main.js 一行都不会执行，数据从未被加载。
 *     · 现改为 `// filename: js/state.js`，是合法的行注释。
 *
 *   二、【P0 修复】新增 userSkippedAutoLoad 标志
 *     · 配合 persistence.js 分支 1 的修复：用户主动关闭"启动时恢复规则与设置"
 *       时，本次会话不加载磁盘数据、也不保存到磁盘。
 *     · 避免"重置为默认值后 500ms 覆盖原数据"的严重缺陷。
 *
 *   三、其余字段保持不变
 * ============================================================================
 */

export const AppState = {
    // ==================== 持久化字段 ====================

    sourceText: '',
    resultText: '',

    // ★ 文本同步标记
    //   · true  → AppState.sourceText / resultText 可能与 DOM 不一致
    //   · false → AppState 中的值与 DOM 一致
    sourceTextStale: false,
    resultTextStale: false,

    flagG: true,
    flagI: false,
    flagM: false,
    loopUntilStable: false,
    autoLoadSnapshot: true,

    quickPattern: '',
    quickReplacement: '',
    quickG: true,
    quickI: false,
    quickM: false,
    quickJsMode: false,

    syncScrollMode: 'proportion',
    darkMode: false,
    helpPanelOpen: false,
    columnWidths: [],

    searchInput: '',
    searchCase: false,

    defaultRules: [],
    defaultRulesName: '默认规则',
    customRules: [],
    presets: [],
    activePresetId: '__main_table__',

    lastImportedFileName: null,

    // ==================== 临时字段（运行时，不持久化） ====================

    internalUpdateInProgress: false,

    databaseReady: false,
    cryptoKeyReady: false,
    storageUnavailableBannerShown: false,

    // ★ 用户在本会话主动关闭了"启动时恢复规则与设置"
    //   · true  → 本次会话不加载磁盘数据，也不保存到磁盘
    //   · false → 正常会话
    userSkippedAutoLoad: false,

    persistentStorageGranted: 'unknown',
    persistentStorageNotified: false,
    persistenceRequestDeferred: false,

    autoSaveTimer: null,
    searchDebounceTimer: null,
    toastTimer: null,
    presetSyncTimer: null,
    autoSaveMaxWaitTimer: null,
    autoSaveFirstPendingTimestamp: 0,

    autoSaveInProgress: false,
    autoSavePendingRetry: false,

    isSyncingBetweenPresetAndMain: false,
    isSyncingDefaultRulesAndCustomRules: false,

    searchMatches: [],
    currentMatchIndex: -1,
    searchLimitWarningLastAt: 0,

    isSyncingScroll: false,

    batchRunInProgress: false,

    importModeDialogOpen: false,
    importModeDefaultApplied: false,

    statisticsModalOpen: false,

    isApplyingImportedState: false,

    existenceIndexCache: {
        isDirty: true,
        contentHashMap: new Map()
    },
    existenceIndexRulePositions: new Map(),
    existenceIndexPresetHashes: new Map(),

    appendTargetModalOpen: false,
    presetManagerModalOpen: false,
    currentAppendRule: null,
    currentAppendSourcePresetId: null,
    modalStack: [],
    presetSearchScope: 'all',
    searchDataSource: 'all',
    presetHelpTooltipOpen: false,
    lastAppendAttempt: null,
    lastAutoSaveTimestamp: 0,
    presetListScrollTop: 0,

    searchLargeTextLowercaseCache: null,
    searchLargeTextLowercaseSource: null,
    searchLargeTextLowercaseDirty: false,

    lastAppliedColumnWidthsSignature: '',

    lastRenderedRuleOrderKey: '',

    duplicateDetectionCacheKey: '',
    duplicateDetectionCacheResult: null,

    resultInputSearchDebounceTimer: null,

    mainTableDirtyForActivePreset: false,

    jsTrustedRuleIds: new Set(),

    toastLiveCount: 0,

    pendingBeforeUnloadArmed: false,

    lastPresetFilterQuery: null,
    lastPresetFilterScope: null,
    lastPresetFilterDataSource: null,
    lastPresetFilterPresetsSnapshot: null,
    lastPresetFilterResult: null
};

// ============================================================================
// 通用清理辅助
// ============================================================================

/**
 * 清理所有"定时器"字段。
 */
function clearAllPendingTimers() {
    if (AppState.autoSaveTimer) {
        clearTimeout(AppState.autoSaveTimer);
        AppState.autoSaveTimer = null;
    }
    if (AppState.autoSaveMaxWaitTimer) {
        clearTimeout(AppState.autoSaveMaxWaitTimer);
        AppState.autoSaveMaxWaitTimer = null;
    }
    AppState.autoSaveFirstPendingTimestamp = 0;

    if (AppState.searchDebounceTimer) {
        clearTimeout(AppState.searchDebounceTimer);
        AppState.searchDebounceTimer = null;
    }
    if (AppState.toastTimer) {
        clearTimeout(AppState.toastTimer);
        AppState.toastTimer = null;
    }
    if (AppState.presetSyncTimer) {
        clearTimeout(AppState.presetSyncTimer);
        AppState.presetSyncTimer = null;
    }
    if (AppState.resultInputSearchDebounceTimer) {
        clearTimeout(AppState.resultInputSearchDebounceTimer);
        AppState.resultInputSearchDebounceTimer = null;
    }
}

/**
 * 清理所有"进行中"的标志位。
 */
function clearAllInProgressFlags() {
    AppState.internalUpdateInProgress = false;

    AppState.isSyncingScroll = false;
    AppState.isSyncingBetweenPresetAndMain = false;
    AppState.isSyncingDefaultRulesAndCustomRules = false;

    AppState.batchRunInProgress = false;

    AppState.autoSaveInProgress = false;
    AppState.autoSavePendingRetry = false;

    AppState.isApplyingImportedState = false;
}

// ============================================================================
// 页面隐藏（visibilitychange → hidden）时的轻量级重置
// ============================================================================

/**
 * 页面隐藏时的轻量级重置。
 */
export function resetTransientStateForHidden() {
    clearAllPendingTimers();
    clearAllInProgressFlags();
}

// ============================================================================
// 页面卸载（pagehide 且非 bfcache）时的完整重置
// ============================================================================

/**
 * 页面卸载时的完整重置。
 */
export function resetTransientStateForUnload() {
    // ---- 1. 通用清理 ----
    clearAllPendingTimers();
    clearAllInProgressFlags();

    // ---- 2. 搜索相关（释放内存）----
    AppState.searchLimitWarningLastAt = 0;

    AppState.searchLargeTextLowercaseCache = null;
    AppState.searchLargeTextLowercaseSource = null;
    AppState.searchLargeTextLowercaseDirty = false;

    // ---- 3. UI 模态框 / 浮层状态 ----
    AppState.importModeDialogOpen = false;
    AppState.importModeDefaultApplied = false;
    AppState.statisticsModalOpen = false;

    AppState.appendTargetModalOpen = false;
    AppState.presetManagerModalOpen = false;
    AppState.currentAppendRule = null;
    AppState.currentAppendSourcePresetId = null;
    AppState.modalStack = [];
    AppState.presetHelpTooltipOpen = false;
    AppState.lastAppendAttempt = null;
    AppState.presetListScrollTop = 0;

    // ---- 4. 存在性索引（释放内存）----
    AppState.existenceIndexCache.isDirty = true;
    AppState.existenceIndexCache.contentHashMap = new Map();
    AppState.existenceIndexRulePositions = new Map();
    AppState.existenceIndexPresetHashes = new Map();

    // ---- 5. 渲染缓存（释放内存）----
    AppState.lastAppliedColumnWidthsSignature = '';
    AppState.lastRenderedRuleOrderKey = '';
    AppState.duplicateDetectionCacheKey = '';
    AppState.duplicateDetectionCacheResult = null;

    AppState.lastPresetFilterQuery = null;
    AppState.lastPresetFilterScope = null;
    AppState.lastPresetFilterDataSource = null;
    AppState.lastPresetFilterPresetsSnapshot = null;
    AppState.lastPresetFilterResult = null;

    // ---- 6. 其他运行态 ----
    AppState.mainTableDirtyForActivePreset = false;
    AppState.lastAutoSaveTimestamp = 0;

    AppState.toastLiveCount = 0;
    AppState.pendingBeforeUnloadArmed = false;

    // ---- 7. 不重置的字段（有意保留）----
    //
    // AppState.searchDataSource / AppState.presetSearchScope
    //   —— 用户界面偏好，应保持。原实现重置为 'all' 会导致
    //      "被重置的偏好写盘"的 bug。
    // AppState.searchMatches / AppState.currentMatchIndex
    //   —— 搜索结果与当前位置，属于会话内上下文。
    // AppState.persistentStorageGranted / AppState.persistenceRequestDeferred
    //   —— 会话级状态，与页面生命周期无关。
    // AppState.jsTrustedRuleIds
    //   —— JS 信任集合，跨会话保留。
    // AppState.sourceTextStale / AppState.resultTextStale
    //   —— 文本同步标记，保持与实际 DOM 的一致。
    // AppState.userSkippedAutoLoad
    //   —— 本会话的"跳过自动加载"标志，不重置。
}

// ============================================================================
// 向后兼容别名
// ============================================================================

/**
 * @deprecated 请使用 resetTransientStateForHidden() 或
 *             resetTransientStateForUnload()，语义更精确。
 */
export function resetTransientState() {
    resetTransientStateForUnload();
}