/**
 * ============================================================================
 * dom.js — DOM 元素引用集中收集
 * ============================================================================
 *
 * 【本次修订】
 *
 *   一、新增 storagePersistenceBanner 引用
 *     · 对应 index.html 中新增的 #storagePersistenceBanner 提示条。
 *     · 用于在持久化存储权限未获得时提示用户。
 *
 *   二、保留 presetSidebarHint 删除
 *     · 该 DOM 节点已在 index.html 中删除，相应引用不再保留。
 *
 *   三、其余引用保持不变
 * ============================================================================
 */

function getElementById(id) {
    return document.getElementById(id);
}

export const DOM = {
    // ==================== 顶部工具栏按钮 ====================
    importButton: getElementById('importBtn'),
    exportButton: getElementById('exportBtn'),
    clearAllButton: getElementById('clearAllBtn'),
    statsButton: getElementById('statsBtn'),
    darkModeToggleButton: getElementById('darkModeToggle'),

    // ==================== 顶部状态指示器 ====================
    storageUnavailableBanner: getElementById('storageUnavailableBanner'),
    storagePersistenceBanner: getElementById('storagePersistenceBanner'),
    jsTrustIndicator: getElementById('jsTrustIndicator'),

    // ==================== 源文本 / 结果文本 ====================
    sourceTextarea: getElementById('sourceText'),
    resultTextarea: getElementById('resultText'),
    copySourceButton: getElementById('copySourceBtn'),
    copyResultButton: getElementById('copyResultBtn'),

    convertResultToSourceButton: getElementById('convertResultToSourceBtn'),
    swapSourceResultButton: getElementById('swapSourceResultBtn'),
    resetResultButton: getElementById('resetResultBtn'),

    syncScrollSelect: getElementById('syncScrollSelect'),

    // ==================== 结果区搜索栏 ====================
    resultSearchBar: getElementById('resultSearchBar'),
    resultSearchInput: getElementById('resultSearchInput'),
    resultSearchCase: getElementById('resultSearchCase'),
    resultSearchPrev: getElementById('resultSearchPrev'),
    resultSearchNext: getElementById('resultSearchNext'),
    resultSearchCount: getElementById('resultSearchCount'),
    resultSearchClear: getElementById('resultSearchClear'),
    resultSearchUseForReplace: getElementById('resultSearchUseForReplace'),

    // ==================== 快速替换面板 ====================
    quickPatternInput: getElementById('quickPattern'),
    quickReplacementInput: getElementById('quickReplacement'),
    quickCheckboxG: getElementById('quickG'),
    quickCheckboxI: getElementById('quickI'),
    quickCheckboxM: getElementById('quickM'),
    quickCheckboxJsMode: getElementById('quickJsMode'),
    quickApplyButton: getElementById('quickApplyBtn'),
    quickSaveAsRuleButton: getElementById('quickSaveAsRuleBtn'),

    // ==================== 全局选项 ====================
    globalFlagG: getElementById('flagG'),
    globalFlagI: getElementById('flagI'),
    globalFlagM: getElementById('flagM'),
    loopUntilStableCheckbox: getElementById('loopUntilStable'),
    autoLoadSnapshotCheckbox: getElementById('autoLoadSnapshotCheck'),

    // ==================== 规则表操作按钮 ====================
    addRuleButton: getElementById('addRuleBtn'),
    resetDefaultRulesButton: getElementById('resetDefaultRulesBtn'),
    saveSnapshotButton: getElementById('saveSnapshotBtn'),
    exportFullConfigButton: getElementById('exportFullConfigBtn'),
    importFullConfigButton: getElementById('importFullConfigBtn'),
    templateButton: getElementById('templateBtn'),
    batchRunCheckedButton: getElementById('batchRunCheckedBtn'),
    selectAllRulesButton: getElementById('selectAllRulesBtn'),
    deselectAllRulesButton: getElementById('deselectAllRulesBtn'),

    // ==================== 主表关联预设指示器 ====================
    activePresetIndicator: getElementById('activePresetIndicator'),
    syncToActivePresetButton: getElementById('syncToActivePresetBtn'),
    clearActivePresetButton: getElementById('clearActivePresetBtn'),

    // ==================== 主表规则表 ====================
    customRuleTable: getElementById('customRuleTable'),
    customRuleTbody: getElementById('customRuleTbody'),

    // ==================== 批量运行错误汇总条 ====================
    batchRunErrorBar: getElementById('batchRunErrorBar'),
    batchRunErrorToggle: getElementById('batchRunErrorToggle'),
    batchRunErrorCopy: getElementById('batchRunErrorCopy'),
    batchRunErrorList: getElementById('batchRunErrorList'),

    // ==================== 批量运行进度条 ====================
    batchRunProgressBar: getElementById('batchRunProgressBar'),
    batchRunProgressText: getElementById('batchRunProgressText'),
    batchRunProgressPercent: getElementById('batchRunProgressPercent'),
    batchRunProgressFill: getElementById('batchRunProgressFill'),
    batchRunCancelButton: getElementById('batchRunCancelBtn'),

    // ==================== 帮助面板 ====================
    helpToggle: getElementById('helpToggle'),
    helpContent: getElementById('helpContent'),

    // ==================== 模板浮动面板 ====================
    templatePanel: getElementById('templatePanel'),

    // ==================== 命名预设管理 ====================
    presetManagerButton: getElementById('presetManagerBtn'),
    presetManagerModalOverlay: getElementById('presetManagerModalOverlay'),
    presetManagerModal: getElementById('presetManagerModal'),

    presetModalFullscreenButton: getElementById('presetModalFullscreenBtn'),
    presetModalCloseButton: getElementById('presetModalCloseBtn'),
    presetSearchInput: getElementById('presetSearchInput'),
    presetSearchScopeButton: getElementById('presetSearchScopeBtn'),
    presetSearchDataSourceButton: getElementById('presetSearchDataSourceBtn'),

    presetHelpButton: getElementById('presetHelpBtn'),
    presetHelpTooltip: getElementById('presetHelpTooltip'),

    presetListContainer: getElementById('presetListContainer'),
    presetCreateFromCurrentButton: getElementById('presetCreateFromCurrentBtn'),
    presetCreateBlankButton: getElementById('presetCreateBlankBtn'),

    presetDetailEmptyHint: getElementById('presetDetailEmptyHint'),
    presetDetailContent: getElementById('presetDetailContent'),
    presetMobileBackButton: getElementById('presetMobileBackBtn'),
    presetNameDisplay: getElementById('presetNameDisplay'),
    presetNameEditButton: getElementById('presetNameEditBtn'),
    presetDetailMeta: getElementById('presetDetailMeta'),

    presetRulesListContainer: getElementById('presetRulesListContainer'),
    presetAddRuleButton: getElementById('presetAddRuleBtn'),

    presetEmptyCreateFromCurrentButton: getElementById('presetEmptyCreateFromCurrentBtn'),
    presetEmptyCreateBlankButton: getElementById('presetEmptyCreateBlankBtn'),

    presetSaveAsButton: getElementById('presetSaveAsBtn'),
    presetDeleteButton: getElementById('presetDeleteBtn'),
    presetCancelButton: getElementById('presetCancelBtn'),
    presetApplyButton: getElementById('presetApplyBtn'),

    // ==================== 导入模式对话框 ====================
    importModeOverlay: getElementById('importModeOverlay'),
    importModeDialog: getElementById('importModeDialog'),
    importModeOverwriteRadio: getElementById('importModeOverwrite'),
    importModeAppendRadio: getElementById('importModeAppend'),
    importModeMergeRadio: getElementById('importModeMerge'),
    importModeSummary: getElementById('importModeSummary'),
    importModeConfirmButton: getElementById('importModeConfirmBtn'),
    importModeCancelButton: getElementById('importModeCancelBtn'),

    // ==================== 追加目标选择模态框 ====================
    appendTargetModalOverlay: getElementById('appendTargetModalOverlay'),
    appendTargetCloseButton: getElementById('appendTargetCloseBtn'),
    appendTargetCancelButton: getElementById('appendTargetCancelBtn'),
    appendTargetSearchInput: getElementById('appendTargetSearchInput'),
    appendTargetListContainer: getElementById('appendTargetListContainer'),
    appendTargetRulePreview: getElementById('appendTargetRulePreview')
};