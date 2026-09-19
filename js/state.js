/**
 * ============================================================================
 * state.js — 全局运行时状态
 * ============================================================================
 *
 * 【本次重构说明 — 页面生命周期修订】
 *
 *   一、resetTransientState 修订
 *     · 保留 searchMatches 与 currentMatchIndex —— 页面隐藏再可见时，
 *       用户希望看到之前搜索的结果与当前位置保持不变。
 *     · 仅重置"警告抑制时间戳"与"大文本 lower-case 缓存"：
 *         - 警告时间戳：让下次搜索达上限时允许再次提示
 *         - 大文本缓存：释放内存
 *
 *   二、其余字段保持不变
 *     · 所有持久化字段、临时字段的定义与初始值不变
 *     · 所有配置相关字段（jsTrustedRuleIds / persistenceRequestDeferred 等）不变
 * ============================================================================
 */

export const AppState = {
    // ==================== 持久化字段 ====================

    sourceText: '',
    resultText: '',

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

    persistentStorageGranted: 'unknown',
    persistentStorageNotified: false,
    // ★ 新增：持久化权限申请是否已延后（等待用户手势）
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
    // ★ 新增：搜索上限警告的上次触发时间
    searchLimitWarningLastAt: 0,

    isSyncingScroll: false,

    batchRunInProgress: false,

    importModeDialogOpen: false,
    // ★ 新增：本次导入对话框是否已按默认模式预选
    importModeDefaultApplied: false,

    statisticsModalOpen: false,

    isApplyingImportedState: false,

    existenceIndexCache: {
        isDirty: true,
        contentHashMap: new Map()
    },
    // ★ 新增：增量存在性索引的副索引
    //   ruleId -> Set<presetId>（含 CONFIG.MAIN_TABLE_VIRTUAL_ID）
    existenceIndexRulePositions: new Map(),
    //   presetId -> Map<hash, Set<ruleId>>
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

    // ★ 新增：按规则 JS 信任集合
    //   当 CONFIG.JS_TRUST_RULE_BASED === true 时生效。
    //   值为规则 id 的字符串集合；被信任的规则启用 JS 模式时不再询问。
    jsTrustedRuleIds: new Set(),

    // ★ 新增：Toast 当前存活数量
    toastLiveCount: 0,

    // ★ 新增：是否已挂载 beforeunload 拦截
    pendingBeforeUnloadArmed: false,

    // ★ 新增：预设过滤缓存（避免每次渲染都全量遍历）
    lastPresetFilterQuery: null,
    lastPresetFilterScope: null,
    lastPresetFilterDataSource: null,
    lastPresetFilterPresetsSnapshot: null,
    lastPresetFilterResult: null
};

/**
 * 重置所有临时字段为初始值。
 *
 * ★ 修订：不再清空 searchMatches / currentMatchIndex。
 *   原因：本函数在 visibilitychange(hidden) 时被调用。若页面隐藏再可见，
 *   用户期望结果区的高亮位置与搜索结果保持不变。
 *   清空这些字段会导致"切到别的标签页再切回来，搜索高亮全没了"。
 *
 *   仍清空的搜索相关字段：
 *     · searchLimitWarningLastAt —— 让下次搜索达上限时允许再次提示
 *     · searchLargeTextLowercaseCache / Source / Dirty —— 释放内存
 */
export function resetTransientState() {
    AppState.internalUpdateInProgress = false;

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

    // ★ 修订：保留 searchMatches 与 currentMatchIndex（见文件头注释）

    AppState.searchLimitWarningLastAt = 0;

    AppState.searchLargeTextLowercaseCache = null;
    AppState.searchLargeTextLowercaseSource = null;
    AppState.searchLargeTextLowercaseDirty = false;

    AppState.isSyncingScroll = false;
    AppState.isSyncingBetweenPresetAndMain = false;
    AppState.isSyncingDefaultRulesAndCustomRules = false;
    AppState.batchRunInProgress = false;
    AppState.importModeDialogOpen = false;
    AppState.importModeDefaultApplied = false;
    AppState.statisticsModalOpen = false;
    AppState.isApplyingImportedState = false;

    AppState.existenceIndexCache.isDirty = true;
    AppState.existenceIndexCache.contentHashMap = new Map();
    AppState.existenceIndexRulePositions = new Map();
    AppState.existenceIndexPresetHashes = new Map();

    AppState.appendTargetModalOpen = false;
    AppState.presetManagerModalOpen = false;
    AppState.currentAppendRule = null;
    AppState.currentAppendSourcePresetId = null;
    AppState.modalStack = [];
    AppState.presetSearchScope = 'all';
    AppState.searchDataSource = 'all';
    AppState.presetHelpTooltipOpen = false;
    AppState.lastAppendAttempt = null;
    AppState.lastAutoSaveTimestamp = 0;
    AppState.presetListScrollTop = 0;

    AppState.lastAppliedColumnWidthsSignature = '';

    AppState.lastRenderedRuleOrderKey = '';
    AppState.duplicateDetectionCacheKey = '';
    AppState.duplicateDetectionCacheResult = null;

    AppState.autoSaveInProgress = false;
    AppState.autoSavePendingRetry = false;

    AppState.mainTableDirtyForActivePreset = false;

    AppState.toastLiveCount = 0;
    AppState.pendingBeforeUnloadArmed = false;

    AppState.lastPresetFilterQuery = null;
    AppState.lastPresetFilterScope = null;
    AppState.lastPresetFilterDataSource = null;
    AppState.lastPresetFilterPresetsSnapshot = null;
    AppState.lastPresetFilterResult = null;

    // 注意：persistentStorageGranted / persistentStorageNotified /
    //       persistenceRequestDeferred / jsTrustedRuleIds
    //       属于"会话级"状态，不在此处重置。
}