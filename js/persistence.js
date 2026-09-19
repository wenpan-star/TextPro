/**
 * ============================================================================
 * persistence.js — 自动保存调度 + 用户配置持久化
 * ============================================================================
 *
 * 【本次重构说明 — 配置持久化 / 内容不持久化】
 *
 *   一、设计原则
 *     · 参考 Notepad++ / VS Code / regex101 等同类产品的成熟做法：
 *         用户配置（规则、预设、界面偏好）→ 跨会话保留
 *         工作内容（源文本、结果文本、搜索输入）→ 不持久化
 *
 *   二、collectFullUiState 调整
 *     · 移除 sourceText / resultText —— 文本不再进入加密状态
 *     · 移除 searchInput / searchCase —— 搜索词与文本强绑定，不持久化
 *     · 保留全部其余字段
 *
 *   三、applyFullUiState 调整
 *     · 移除文本恢复逻辑（包括对旧快照中 sourceText / resultText 的兼容处理）
 *     · 移除 searchInput / searchCase 恢复逻辑
 *     · 保留全部其余字段
 *
 *   四、其他能力保留
 *     · 保存并发保护（autoSaveInProgress / autoSavePendingRetry）
 *     · DECRYPT_FAILED / JSON_PARSE_FAILED 错误分类
 *     · applyFullUiState 微任务渲染
 *     · 启动恢复一致性校验
 * ============================================================================
 */

import {
    CONFIG,
    STORAGE_KEYS,
    DARK_MODE_TOGGLE_TEXT,
    defaultCustomRules,
    SEARCH_DATA_SOURCE
} from './config.js';
import { AppState } from './state.js';
import { DOM } from './dom.js';
import { showToast } from './toast.js';
import {
    saveEncryptedState,
    loadEncryptedState,
    getOrCreateCryptoKey,
    saveLocalBackup,
    loadLocalBackup,
    requestPersistentStorage,
    attachPersistentStorageDeferredTrigger
} from './storage.js';

let cachedCryptoKey = null;

// ============================================================================
// 渲染调度：applyFullUiState 之后自动刷新 UI
// ============================================================================

let pendingRenderAfterApplyFlag = false;

function scheduleRenderAfterApplyState() {
    if (pendingRenderAfterApplyFlag) return;
    pendingRenderAfterApplyFlag = true;

    // 使用微任务 + 动态 import，确保 rules.js 已加载
    Promise.resolve()
        .then(function loadRulesModule() {
            return import('./rules.js');
        })
        .then(function applyRender(rulesModule) {
            pendingRenderAfterApplyFlag = false;

            if (!rulesModule) return;

            if (typeof rulesModule.renderRuleTable === 'function') {
                rulesModule.renderRuleTable();
            }
            if (typeof rulesModule.updateActivePresetIndicator === 'function') {
                rulesModule.updateActivePresetIndicator();
            }
            if (typeof rulesModule.updateBatchRunButtonLabel === 'function') {
                rulesModule.updateBatchRunButtonLabel();
            }
        })
        .catch(function onRenderError(renderError) {
            pendingRenderAfterApplyFlag = false;
            console.warn('应用状态后自动渲染失败:', renderError);
        });
}

// ============================================================================
// 安全拷贝工具
// ============================================================================

function safeCopyPlainObject(source) {
    const result = {};

    if (!source || typeof source !== 'object' || Array.isArray(source)) {
        return result;
    }

    const sourceKeys = Object.keys(source);
    for (let keyIndex = 0; keyIndex < sourceKeys.length; keyIndex++) {
        const key = sourceKeys[keyIndex];
        if (
            key === '__proto__' ||
            key === 'constructor' ||
            key === 'prototype'
        ) {
            continue;
        }
        result[key] = source[key];
    }

    return result;
}

// ============================================================================
// 启动恢复一致性校验辅助
// ============================================================================

function areRuleListsOrderedEquivalent(rulesA, rulesB) {
    if (!Array.isArray(rulesA) || !Array.isArray(rulesB)) return false;
    if (rulesA.length !== rulesB.length) return false;

    for (let index = 0; index < rulesA.length; index++) {
        const ruleA = rulesA[index];
        const ruleB = rulesB[index];
        if (!ruleA || !ruleB) return false;

        if (String(ruleA.name || '') !== String(ruleB.name || '')) return false;
        if (String(ruleA.pattern || '') !== String(ruleB.pattern || '')) return false;
        if (String(ruleA.replacement || '') !== String(ruleB.replacement || '')) return false;

        const isRegexA = ruleA.isRegex !== false;
        const isRegexB = ruleB.isRegex !== false;
        if (isRegexA !== isRegexB) return false;

        const isJSA = ruleA.isJS === true;
        const isJSB = ruleB.isJS === true;
        if (isJSA !== isJSB) return false;
    }
    return true;
}

function derivePresetRuleIdFromMainId(mainRuleId) {
    if (mainRuleId === undefined || mainRuleId === null) {
        return 'preset_rule_' + Date.now() + '_' +
            Math.floor(Math.random() * CONFIG.ID_COLLISION_RANDOM_RANGE);
    }
    const mainIdString = String(mainRuleId);
    if (mainIdString.indexOf('preset_rule_') === 0) {
        return mainIdString;
    }
    return 'preset_rule_' + mainIdString;
}

function ensureStartupStateConsistent() {
    if (
        !AppState.activePresetId ||
        AppState.activePresetId === CONFIG.MAIN_TABLE_VIRTUAL_ID
    ) {
        return;
    }

    const activePreset = AppState.presets.find(function findPreset(preset) {
        return preset.id === AppState.activePresetId;
    });
    if (!activePreset || !Array.isArray(activePreset.rules)) {
        return;
    }

    const isConsistent = areRuleListsOrderedEquivalent(
        AppState.customRules,
        activePreset.rules
    );

    if (isConsistent) return;

    console.warn(
        '[TextPro] 启动恢复时检测到主表与预设内容不一致，' +
        '已按主表优先策略同步预设内容'
    );

    activePreset.rules = AppState.customRules.map(function mapRule(
        mainRule,
        index
    ) {
        return {
            id: derivePresetRuleIdFromMainId(mainRule.id),
            name: mainRule.name || '未命名规则',
            pattern: typeof mainRule.pattern === 'string' ? mainRule.pattern : '',
            replacement: typeof mainRule.replacement === 'string'
                ? mainRule.replacement
                : '',
            enabled: mainRule.enabled !== false,
            order: index + 1,
            runChecked: mainRule.runChecked !== false,
            isRegex: mainRule.isRegex !== false,
            isJS: mainRule.isJS === true
        };
    });
    activePreset.updatedAt = Date.now();

    AppState.existenceIndexCache.isDirty = true;
}

// ============================================================================
// 规则前缀一次性处理
// ============================================================================

function applyRulePrefixConversion(rule) {
    const replacementText = String(rule.replacement || '');
    const trimmedText = replacementText.trim();

    if (trimmedText.startsWith('@@js:')) {
        rule.replacement = replacementText.replace(/^@@js:\s*/, '@js:');
        rule.isJS = false;
    } else if (trimmedText.startsWith('@js:')) {
        rule.isJS = true;
        rule.replacement = replacementText.replace(/^@js:\s*/, '').trim();
    }
}

function normalizeRuleList(rawRules) {
    if (!Array.isArray(rawRules)) return [];

    return rawRules.map(function mapRule(rawRule) {
        const rule = safeCopyPlainObject(rawRule);
        rule.isRegex = rule.isRegex !== false;
        rule.isJS = rule.isJS === true;
        rule.enabled = rule.enabled !== false;
        rule.runChecked = rule.runChecked !== false;

        if (!rule.id) {
            rule.id = Date.now() +
                Math.floor(Math.random() * CONFIG.ID_COLLISION_RANDOM_RANGE);
        }
        if (typeof rule.name !== 'string') rule.name = '未命名规则';
        if (typeof rule.pattern !== 'string') rule.pattern = '';
        if (typeof rule.replacement !== 'string') rule.replacement = '';

        applyRulePrefixConversion(rule);

        return rule;
    });
}

function normalizePreset(rawPreset) {
    const preset = {
        id: (rawPreset && typeof rawPreset.id === 'string' && rawPreset.id)
            ? rawPreset.id
            : ('preset_' + Date.now() + '_' +
                Math.floor(Math.random() * CONFIG.ID_COLLISION_RANDOM_RANGE)),
        name: (rawPreset && typeof rawPreset.name === 'string' && rawPreset.name)
            ? rawPreset.name
            : '未命名预设',
        rules: [],
        createdAt: (rawPreset && typeof rawPreset.createdAt === 'number')
            ? rawPreset.createdAt
            : Date.now(),
        updatedAt: (rawPreset && typeof rawPreset.updatedAt === 'number')
            ? rawPreset.updatedAt
            : Date.now()
    };

    if (rawPreset && Array.isArray(rawPreset.rules)) {
        preset.rules = rawPreset.rules.map(function mapRule(rawRule) {
            const rule = safeCopyPlainObject(rawRule);
            rule.isRegex = rule.isRegex !== false;
            rule.isJS = rule.isJS === true;
            rule.enabled = rule.enabled !== false;
            rule.runChecked = rule.runChecked !== false;

            if (
                typeof rule.id === 'string' &&
                rule.id.indexOf('preset_rule_') === 0
            ) {
                // 保留合法前缀
            } else {
                rule.id = 'preset_rule_' + Date.now() + '_' +
                    Math.floor(Math.random() * CONFIG.ID_COLLISION_RANDOM_RANGE);
            }

            if (typeof rule.name !== 'string') rule.name = '未命名规则';
            if (typeof rule.pattern !== 'string') rule.pattern = '';
            if (typeof rule.replacement !== 'string') rule.replacement = '';

            applyRulePrefixConversion(rule);

            return rule;
        });
    }

    return preset;
}

function deepCloneRules(rules) {
    if (!Array.isArray(rules)) return [];
    try {
        return JSON.parse(JSON.stringify(rules));
    } catch (cloneError) {
        console.warn('规则列表深拷贝失败，降级为逐条浅拷贝:', cloneError);
    }

    const fallbackResult = [];
    for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex++) {
        const rule = rules[ruleIndex];
        if (rule && typeof rule === 'object') {
            fallbackResult.push(Object.assign({}, rule));
        }
    }
    return fallbackResult;
}

export function syncDarkModeToggleButtonText() {
    if (!DOM.darkModeToggleButton) return;
    const isDarkNow = document.body.classList.contains('dark');
    DOM.darkModeToggleButton.textContent = isDarkNow
        ? DARK_MODE_TOGGLE_TEXT.dark
        : DARK_MODE_TOGGLE_TEXT.light;
}

// ============================================================================
// 状态采集
// ============================================================================

/**
 * 采集需要持久化的应用状态。
 *
 * ★ 关键设计：只采集"用户配置"与"界面偏好"两类字段，绝不采集"工作内容"。
 *
 *   持久化（跨会话保留）：
 *     · 规则表（customRules / defaultRules / defaultRulesName）
 *     · 预设库（presets / activePresetId）
 *     · 界面偏好（各种勾选、主题、列宽、同步模式等）
 *
 *   不持久化（每次打开从零开始）：
 *     · 源文本（sourceText）
 *     · 结果文本（resultText）
 *     · 结果区搜索词（searchInput）
 *     · 结果区搜索大小写敏感开关（searchCase）
 *
 *   兼容性说明：
 *     旧版本快照可能包含 sourceText / resultText / searchInput / searchCase，
 *     这里主动不采集，applyFullUiState 也会主动忽略这些字段。
 */
export function collectFullUiState() {
    return {
        // ★ 修订：不再采集文本内容
        //   sourceText:  （已移除）
        //   resultText:  （已移除）

        flagG: DOM.globalFlagG ? DOM.globalFlagG.checked : AppState.flagG,
        flagI: DOM.globalFlagI ? DOM.globalFlagI.checked : AppState.flagI,
        flagM: DOM.globalFlagM ? DOM.globalFlagM.checked : AppState.flagM,
        loopUntilStable: DOM.loopUntilStableCheckbox
            ? DOM.loopUntilStableCheckbox.checked
            : AppState.loopUntilStable,
        autoLoadSnapshot: DOM.autoLoadSnapshotCheckbox
            ? DOM.autoLoadSnapshotCheckbox.checked
            : AppState.autoLoadSnapshot,

        quickPattern: DOM.quickPatternInput
            ? DOM.quickPatternInput.value
            : AppState.quickPattern,
        quickReplacement: DOM.quickReplacementInput
            ? DOM.quickReplacementInput.value
            : AppState.quickReplacement,
        quickG: DOM.quickCheckboxG
            ? DOM.quickCheckboxG.checked
            : AppState.quickG,
        quickI: DOM.quickCheckboxI
            ? DOM.quickCheckboxI.checked
            : AppState.quickI,
        quickM: DOM.quickCheckboxM
            ? DOM.quickCheckboxM.checked
            : AppState.quickM,
        quickJsMode: DOM.quickCheckboxJsMode
            ? DOM.quickCheckboxJsMode.checked
            : AppState.quickJsMode,

        syncScrollMode: DOM.syncScrollSelect
            ? DOM.syncScrollSelect.value
            : AppState.syncScrollMode,
        darkMode: document.body.classList.contains('dark'),
        helpPanelOpen: DOM.helpContent
            ? DOM.helpContent.classList.contains('show')
            : AppState.helpPanelOpen,
        columnWidths: AppState.columnWidths.slice(),

        // ★ 修订：不再采集结果区搜索词与大小写敏感开关
        //   searchInput: （已移除）
        //   searchCase:  （已移除）

        searchDataSource: AppState.searchDataSource,
        presetSearchScope: AppState.presetSearchScope,

        defaultRules: AppState.defaultRules.map(function mapRule(rule) {
            return {
                id: rule.id,
                name: rule.name,
                pattern: rule.pattern,
                replacement: rule.replacement,
                enabled: rule.enabled,
                order: rule.order,
                runChecked: rule.runChecked,
                isRegex: rule.isRegex,
                isJS: rule.isJS
            };
        }),
        defaultRulesName: AppState.defaultRulesName,

        customRules: AppState.customRules.map(function mapRule(rule) {
            return {
                id: rule.id,
                name: rule.name,
                pattern: rule.pattern,
                replacement: rule.replacement,
                enabled: rule.enabled,
                order: rule.order,
                runChecked: rule.runChecked,
                isRegex: rule.isRegex,
                isJS: rule.isJS
            };
        }),

        presets: AppState.presets.map(function mapPreset(preset) {
            return {
                id: preset.id,
                name: preset.name,
                rules: (preset.rules || []).map(function mapRule(rule) {
                    return {
                        id: rule.id,
                        name: rule.name,
                        pattern: rule.pattern,
                        replacement: rule.replacement,
                        enabled: rule.enabled,
                        order: rule.order,
                        runChecked: rule.runChecked,
                        isRegex: rule.isRegex,
                        isJS: rule.isJS
                    };
                }),
                createdAt: preset.createdAt,
                updatedAt: preset.updatedAt
            };
        }),

        activePresetId: AppState.activePresetId,

        lastImportedFileName: AppState.lastImportedFileName
    };
}

// ============================================================================
// 状态应用
// ============================================================================

/**
 * 把持久化状态应用到运行时。
 *
 * ★ 关键设计：只恢复"用户配置"与"界面偏好"，绝不恢复"工作内容"。
 *
 *   兼容性：
 *     旧版本快照可能包含 sourceText / resultText / searchInput / searchCase，
 *     本函数主动忽略这些字段 —— 保证旧用户升级后行为一致。
 *
 *   注意：
 *     本函数不会主动清空 DOM 中的 textarea。
 *     原因：settings-io 的导入也会走本函数，主动清空会让用户正在编辑的
 *     文本消失。启动时 DOM 本来就是空的，所以无需额外处理。
 */
export function applyFullUiState(state) {
    if (!state || typeof state !== 'object') return;

    AppState.isApplyingImportedState = true;

    try {
        // ★ 修订：不再恢复文本内容
        //   即使 state.sourceText / state.resultText 存在，也主动忽略。
        //   AppState.sourceText / resultText 保持 '' 与当前 DOM 值不动。

        if (typeof state.flagG === 'boolean') {
            AppState.flagG = state.flagG;
            if (DOM.globalFlagG) DOM.globalFlagG.checked = state.flagG;
        }
        if (typeof state.flagI === 'boolean') {
            AppState.flagI = state.flagI;
            if (DOM.globalFlagI) DOM.globalFlagI.checked = state.flagI;
        }
        if (typeof state.flagM === 'boolean') {
            AppState.flagM = state.flagM;
            if (DOM.globalFlagM) DOM.globalFlagM.checked = state.flagM;
        }
        if (typeof state.loopUntilStable === 'boolean') {
            AppState.loopUntilStable = state.loopUntilStable;
            if (DOM.loopUntilStableCheckbox) {
                DOM.loopUntilStableCheckbox.checked = state.loopUntilStable;
            }
        }
        if (typeof state.autoLoadSnapshot === 'boolean') {
            AppState.autoLoadSnapshot = state.autoLoadSnapshot;
            if (DOM.autoLoadSnapshotCheckbox) {
                DOM.autoLoadSnapshotCheckbox.checked = state.autoLoadSnapshot;
            }
            saveLocalBackup(
                STORAGE_KEYS.UI_AUTO_LOAD_SNAPSHOT,
                state.autoLoadSnapshot
            );
        }

        if (typeof state.quickPattern === 'string') {
            AppState.quickPattern = state.quickPattern;
            if (DOM.quickPatternInput) {
                DOM.quickPatternInput.value = state.quickPattern;
            }
        }
        if (typeof state.quickReplacement === 'string') {
            AppState.quickReplacement = state.quickReplacement;
            if (DOM.quickReplacementInput) {
                DOM.quickReplacementInput.value = state.quickReplacement;
            }
        }
        if (typeof state.quickG === 'boolean') {
            AppState.quickG = state.quickG;
            if (DOM.quickCheckboxG) DOM.quickCheckboxG.checked = state.quickG;
        }
        if (typeof state.quickI === 'boolean') {
            AppState.quickI = state.quickI;
            if (DOM.quickCheckboxI) DOM.quickCheckboxI.checked = state.quickI;
        }
        if (typeof state.quickM === 'boolean') {
            AppState.quickM = state.quickM;
            if (DOM.quickCheckboxM) DOM.quickCheckboxM.checked = state.quickM;
        }
        if (typeof state.quickJsMode === 'boolean') {
            AppState.quickJsMode = state.quickJsMode;
            if (DOM.quickCheckboxJsMode) {
                DOM.quickCheckboxJsMode.checked = state.quickJsMode;
            }
        }

        if (typeof state.syncScrollMode === 'string') {
            AppState.syncScrollMode = state.syncScrollMode;
            if (DOM.syncScrollSelect) {
                DOM.syncScrollSelect.value = state.syncScrollMode;
            }
            saveLocalBackup(
                STORAGE_KEYS.UI_SYNC_SCROLL_MODE,
                state.syncScrollMode
            );
        }
        if (typeof state.darkMode === 'boolean') {
            AppState.darkMode = state.darkMode;
            if (state.darkMode) {
                document.body.classList.add('dark');
            } else {
                document.body.classList.remove('dark');
            }
            saveLocalBackup(
                STORAGE_KEYS.UI_THEME,
                state.darkMode ? 'dark' : 'light'
            );
            syncDarkModeToggleButtonText();
        }
        if (typeof state.helpPanelOpen === 'boolean') {
            AppState.helpPanelOpen = state.helpPanelOpen;
            if (DOM.helpContent) {
                if (state.helpPanelOpen) {
                    DOM.helpContent.classList.add('show');
                } else {
                    DOM.helpContent.classList.remove('show');
                }
            }
        }
        if (Array.isArray(state.columnWidths)) {
            AppState.columnWidths = state.columnWidths.slice();
            AppState.lastAppliedColumnWidthsSignature = '';
        }

        // ★ 修订：不再恢复结果区搜索词与大小写敏感开关
        //   旧快照若含 searchInput / searchCase，本函数主动忽略。

        if (
            state.searchDataSource === SEARCH_DATA_SOURCE.ALL ||
            state.searchDataSource === SEARCH_DATA_SOURCE.CURRENT
        ) {
            AppState.searchDataSource = state.searchDataSource;
        }

        if (
            state.presetSearchScope === 'all' ||
            state.presetSearchScope === 'nameOnly'
        ) {
            AppState.presetSearchScope = state.presetSearchScope;
        }

        if (Array.isArray(state.customRules)) {
            AppState.customRules = normalizeRuleList(state.customRules);
        }

        if (Array.isArray(state.defaultRules)) {
            AppState.defaultRules = normalizeRuleList(state.defaultRules);
        } else if (Array.isArray(state.customRules)) {
            AppState.defaultRules = normalizeRuleList(state.customRules);
        } else {
            AppState.defaultRules = [];
        }

        if (
            typeof state.defaultRulesName === 'string' &&
            state.defaultRulesName
        ) {
            AppState.defaultRulesName = state.defaultRulesName;
        } else {
            AppState.defaultRulesName = '默认规则';
        }

        if (Array.isArray(state.presets)) {
            AppState.presets = state.presets.map(normalizePreset);
        }

        if (
            state.activePresetId === null ||
            state.activePresetId === undefined
        ) {
            AppState.activePresetId = CONFIG.MAIN_TABLE_VIRTUAL_ID;
        } else if (state.activePresetId === CONFIG.MAIN_TABLE_VIRTUAL_ID) {
            AppState.activePresetId = CONFIG.MAIN_TABLE_VIRTUAL_ID;
        } else if (typeof state.activePresetId === 'string') {
            const presetExists = AppState.presets.some(function findPreset(
                preset
            ) {
                return preset.id === state.activePresetId;
            });
            AppState.activePresetId = presetExists
                ? state.activePresetId
                : CONFIG.MAIN_TABLE_VIRTUAL_ID;
        } else {
            AppState.activePresetId = CONFIG.MAIN_TABLE_VIRTUAL_ID;
        }

        if (AppState.activePresetId === CONFIG.MAIN_TABLE_VIRTUAL_ID) {
            AppState.customRules = AppState.defaultRules.map(function mapRule(
                rule
            ) {
                return {
                    id: rule.id,
                    name: rule.name || '未命名规则',
                    pattern: typeof rule.pattern === 'string' ? rule.pattern : '',
                    replacement: typeof rule.replacement === 'string'
                        ? rule.replacement
                        : '',
                    enabled: rule.enabled !== false,
                    order: rule.order,
                    runChecked: rule.runChecked !== false,
                    isRegex: rule.isRegex !== false,
                    isJS: rule.isJS === true
                };
            });
        }

        ensureStartupStateConsistent();

        if (state.lastImportedFileName !== undefined) {
            AppState.lastImportedFileName = state.lastImportedFileName;
            saveLocalBackup(
                STORAGE_KEYS.UI_LAST_IMPORTED_FILENAME,
                state.lastImportedFileName
            );
        }

        AppState.existenceIndexCache.isDirty = true;

        AppState.lastRenderedRuleOrderKey = '';
        AppState.duplicateDetectionCacheKey = '';
        AppState.duplicateDetectionCacheResult = null;
    } finally {
        AppState.isApplyingImportedState = false;
    }

    scheduleRenderAfterApplyState();
}

// ============================================================================
// 自动保存
// ============================================================================

function estimateCurrentTextByteLengthUpperBound() {
    const sourceLength = AppState.sourceText ? AppState.sourceText.length : 0;
    const resultLength = AppState.resultText ? AppState.resultText.length : 0;
    const maxLength = Math.max(sourceLength, resultLength);
    return maxLength * 3;
}

function clearAutoSaveTimers() {
    if (AppState.autoSaveTimer) {
        clearTimeout(AppState.autoSaveTimer);
        AppState.autoSaveTimer = null;
    }
    if (AppState.autoSaveMaxWaitTimer) {
        clearTimeout(AppState.autoSaveMaxWaitTimer);
        AppState.autoSaveMaxWaitTimer = null;
    }
    AppState.autoSaveFirstPendingTimestamp = 0;
}

export function scheduleAutoSave() {
    if (!AppState.databaseReady || !cachedCryptoKey) {
        return;
    }

    if (AppState.autoSaveTimer) {
        clearTimeout(AppState.autoSaveTimer);
        AppState.autoSaveTimer = null;
    }

    const estimatedByteLength = estimateCurrentTextByteLengthUpperBound();
    const isLargeText =
        estimatedByteLength >= CONFIG.LARGE_TEXT_AUTOSAVE_THRESHOLD_BYTES;

    const debounceMs = isLargeText
        ? CONFIG.LARGE_TEXT_AUTOSAVE_THROTTLE_MS
        : CONFIG.AUTO_SAVE_DEBOUNCE_MS;

    AppState.autoSaveTimer = setTimeout(function onDebounce() {
        AppState.autoSaveTimer = null;
        performAutoSave();
    }, debounceMs);

    if (AppState.autoSaveFirstPendingTimestamp === 0) {
        AppState.autoSaveFirstPendingTimestamp = Date.now();

        if (AppState.autoSaveMaxWaitTimer) {
            clearTimeout(AppState.autoSaveMaxWaitTimer);
        }
        AppState.autoSaveMaxWaitTimer = setTimeout(function onMaxWait() {
            AppState.autoSaveMaxWaitTimer = null;
            AppState.autoSaveFirstPendingTimestamp = 0;

            if (AppState.autoSaveTimer) {
                clearTimeout(AppState.autoSaveTimer);
                AppState.autoSaveTimer = null;
            }
            performAutoSave();
        }, CONFIG.MAX_AUTO_SAVE_WAIT_MS);
    }
}

async function performAutoSave() {
    if (AppState.autoSaveInProgress) {
        AppState.autoSavePendingRetry = true;
        return;
    }

    AppState.autoSaveInProgress = true;
    AppState.autoSavePendingRetry = false;

    try {
        const fullState = collectFullUiState();
        const stateJson = JSON.stringify(fullState);
        await saveEncryptedState(stateJson, cachedCryptoKey);

        AppState.lastAutoSaveTimestamp = Date.now();
        AppState.autoSaveFirstPendingTimestamp = 0;

        if (AppState.autoSaveMaxWaitTimer) {
            clearTimeout(AppState.autoSaveMaxWaitTimer);
            AppState.autoSaveMaxWaitTimer = null;
        }
    } catch (saveError) {
        console.warn('自动保存失败:', saveError);
    } finally {
        AppState.autoSaveInProgress = false;

        if (AppState.autoSavePendingRetry) {
            AppState.autoSavePendingRetry = false;
            Promise.resolve().then(function retrySave() {
                performAutoSave();
            });
        }
    }
}

export async function forceSaveBeforeUnload() {
    if (!AppState.databaseReady || !cachedCryptoKey) {
        return;
    }

    if (AppState.autoSaveTimer) {
        clearTimeout(AppState.autoSaveTimer);
        AppState.autoSaveTimer = null;
    }
    if (AppState.autoSaveMaxWaitTimer) {
        clearTimeout(AppState.autoSaveMaxWaitTimer);
        AppState.autoSaveMaxWaitTimer = null;
    }
    AppState.autoSaveFirstPendingTimestamp = 0;

    try {
        const rulesModule = await import('./rules.js');
        if (
            rulesModule &&
            typeof rulesModule.flushPendingPresetSync === 'function'
        ) {
            rulesModule.flushPendingPresetSync();
        }
    } catch (syncError) {
        console.warn('卸载前同步预设失败:', syncError);
    }

    await performAutoSave();
}

export async function saveStateImmediately() {
    const result = { saved: false };

    if (!AppState.databaseReady || !cachedCryptoKey) {
        return result;
    }

    clearAutoSaveTimers();

    try {
        const rulesModule = await import('./rules.js');
        if (
            rulesModule &&
            typeof rulesModule.flushPendingPresetSync === 'function'
        ) {
            rulesModule.flushPendingPresetSync();
        }
    } catch (syncError) {
        console.warn('保存前同步预设失败:', syncError);
    }

    if (AppState.autoSaveInProgress) {
        AppState.autoSavePendingRetry = true;
        let waitCount = 0;
        while (AppState.autoSaveInProgress && waitCount < 100) {
            await new Promise(function wait(resolve) {
                setTimeout(resolve, 50);
            });
            waitCount++;
        }
    }

    AppState.autoSaveInProgress = true;
    try {
        const fullState = collectFullUiState();
        const stateJson = JSON.stringify(fullState);
        await saveEncryptedState(stateJson, cachedCryptoKey);
        AppState.lastAutoSaveTimestamp = Date.now();
        result.saved = true;
    } catch (saveError) {
        console.warn('立即保存失败:', saveError);
    } finally {
        AppState.autoSaveInProgress = false;
    }

    return result;
}

// ============================================================================
// 启动恢复
// ============================================================================

/**
 * 调度持久化存储权限申请。
 *
 * · 若 CONFIG.STORAGE_PERSIST_DEFERRED === false → 立即申请
 * · 否则挂载一次性触发器，等待首次交互后申请
 *
 * 无论哪种方式，结果都会写入 AppState.persistentStorageGranted
 * 并镜像到 localStorage。
 */
function schedulePersistentStorageRequest() {
    function applyResult(result) {
        AppState.persistentStorageGranted = result;
        saveLocalBackup(STORAGE_KEYS.UI_PERSISTENT_STORAGE, result);
        console.log(
            '[TextPro] 持久化存储权限：' + result +
            (result === 'denied'
                ? '（浏览器可能在存储压力下自动清除数据）'
                : '')
        );

        // 通知 UI 更新提示条（若 ui.js 已加载）
        try {
            document.dispatchEvent(
                new CustomEvent('textpro:persistent-storage-updated', {
                    detail: { result: result }
                })
            );
        } catch (dispatchError) {
            // 忽略
        }
    }

    try {
        attachPersistentStorageDeferredTrigger(applyResult);
    } catch (triggerError) {
        console.warn('[TextPro] 挂载持久化权限触发器失败:', triggerError);
        // 兜底：直接申请一次
        requestPersistentStorage().then(applyResult).catch(function onErr() {
            applyResult('denied');
        });
    }
}

/**
 * 启动时加载状态。
 *
 * ★ 说明：
 *   本函数返回的 loaded / reason 仅描述"配置恢复"是否成功。
 *   文本内容始终由 DOM 决定（启动时即空），不参与本流程。
 */
export async function loadStateOnStartup() {
    // 持久化权限：延后 / 立即由 schedulePersistentStorageRequest 决定
    schedulePersistentStorageRequest();

    const mirroredAutoLoadSnapshot = loadLocalBackup(
        STORAGE_KEYS.UI_AUTO_LOAD_SNAPSHOT,
        true
    );

    // ---- 分支 1：用户主动关闭"启动时恢复规则与设置" ----
    if (mirroredAutoLoadSnapshot === false) {
        initializeDefaultState();

        AppState.autoLoadSnapshot = false;
        if (DOM.autoLoadSnapshotCheckbox) {
            DOM.autoLoadSnapshotCheckbox.checked = false;
        }

        try {
            cachedCryptoKey = await getOrCreateCryptoKey();
            AppState.cryptoKeyReady = true;
            AppState.databaseReady = true;
        } catch (keyError) {
            console.warn('密钥初始化失败:', keyError);
            AppState.cryptoKeyReady = false;
            AppState.databaseReady = false;
            AppState.storageUnavailableBannerShown = true;
            return {
                loaded: false,
                reason: 'storage_unavailable'
            };
        }

        return {
            loaded: false,
            reason: 'skipped'
        };
    }

    // ---- 分支 2：密钥初始化 ----
    try {
        cachedCryptoKey = await getOrCreateCryptoKey();
        AppState.cryptoKeyReady = true;
    } catch (keyError) {
        console.warn('密钥初始化失败:', keyError);
        initializeDefaultState({ showIndexedDBUnavailableToast: true });
        AppState.databaseReady = false;
        AppState.cryptoKeyReady = false;
        AppState.storageUnavailableBannerShown = true;
        return {
            loaded: false,
            reason: 'storage_unavailable'
        };
    }

    // ---- 分支 3：加载加密状态 ----
    let savedState = null;
    try {
        savedState = await loadEncryptedState(cachedCryptoKey);
    } catch (loadError) {
        const errorCode = loadError && loadError.code;

        if (errorCode === 'JSON_PARSE_FAILED') {
            console.warn('[TextPro] 本地数据格式损坏:', loadError);
            initializeDefaultState({ showIndexedDBUnavailableToast: true });
            AppState.databaseReady = true;
            AppState.cryptoKeyReady = true;
            showToast('⚠️ 本地数据格式损坏，已使用默认配置', true);
            return {
                loaded: false,
                reason: 'storage_unavailable'
            };
        }

        console.warn('解密失败:', loadError);
        const userWantsToContinue = confirm(
            '⚠️ 检测到本地加密数据损坏或与当前密钥不匹配。\n\n' +
            '这可能是因为浏览器存储被部分清除导致的。\n' +
            '· 点击"确定"：继续使用默认配置（本次不启用自动保存，保护现有密文）\n' +
            '· 点击"取消"：使用默认配置并允许自动保存覆盖（现有数据将永久丢失）'
        );
        initializeDefaultState({ showIndexedDBUnavailableToast: true });
        if (userWantsToContinue) {
            AppState.databaseReady = false;
            AppState.cryptoKeyReady = false;
        } else {
            AppState.databaseReady = true;
            AppState.cryptoKeyReady = true;
        }
        return {
            loaded: false,
            reason: 'storage_unavailable'
        };
    }

    // ---- 分支 4：应用已保存的状态 ----
    if (savedState && typeof savedState === 'object') {
        applyFullUiState(savedState);
        AppState.databaseReady = true;
        return {
            loaded: true,
            reason: 'restored'
        };
    }

    // ---- 分支 5：首次访问 / 无保存状态 ----
    initializeDefaultState();
    AppState.databaseReady = true;
    return {
        loaded: false,
        reason: 'default'
    };
}

function initializeDefaultState(options) {
    const opts = options || {};
    const showIndexedDBUnavailableToast =
        opts.showIndexedDBUnavailableToast === true;

    AppState.defaultRules = JSON.parse(JSON.stringify(defaultCustomRules));
    AppState.defaultRulesName = '默认规则';
    AppState.presets = [];
    AppState.activePresetId = CONFIG.MAIN_TABLE_VIRTUAL_ID;
    AppState.customRules = deepCloneRules(AppState.defaultRules);

    AppState.flagG = true;
    AppState.flagI = false;
    AppState.flagM = false;
    AppState.loopUntilStable = false;

    AppState.quickPattern = '';
    AppState.quickReplacement = '';
    AppState.quickG = true;
    AppState.quickI = false;
    AppState.quickM = false;
    AppState.quickJsMode = false;

    const savedSyncScrollMode = loadLocalBackup(
        STORAGE_KEYS.UI_SYNC_SCROLL_MODE,
        'proportion'
    );
    AppState.syncScrollMode = (typeof savedSyncScrollMode === 'string')
        ? savedSyncScrollMode
        : 'proportion';

    const savedTheme = loadLocalBackup(STORAGE_KEYS.UI_THEME, 'light');
    AppState.darkMode = (savedTheme === 'dark');

    AppState.helpPanelOpen = false;
    AppState.columnWidths = [];
    AppState.lastAppliedColumnWidthsSignature = '';

    // ★ 说明：sourceText / resultText / searchInput / searchCase 不再初始化，
    //   因为它们本来就是 AppState 的初始值（'' / false）。

    AppState.searchDataSource = SEARCH_DATA_SOURCE.ALL;
    AppState.presetSearchScope = 'all';

    const savedLastFileName = loadLocalBackup(
        STORAGE_KEYS.UI_LAST_IMPORTED_FILENAME,
        null
    );
    AppState.lastImportedFileName = (
        savedLastFileName === null ||
        typeof savedLastFileName === 'string'
    )
        ? savedLastFileName
        : null;

    const mirroredAutoLoadSnapshot = loadLocalBackup(
        STORAGE_KEYS.UI_AUTO_LOAD_SNAPSHOT,
        true
    );
    AppState.autoLoadSnapshot = mirroredAutoLoadSnapshot !== false;

    if (AppState.darkMode) {
        document.body.classList.add('dark');
    } else {
        document.body.classList.remove('dark');
    }
    syncDarkModeToggleButtonText();

    if (DOM.syncScrollSelect) {
        DOM.syncScrollSelect.value = AppState.syncScrollMode;
    }
    if (DOM.globalFlagG) DOM.globalFlagG.checked = AppState.flagG;
    if (DOM.globalFlagI) DOM.globalFlagI.checked = AppState.flagI;
    if (DOM.globalFlagM) DOM.globalFlagM.checked = AppState.flagM;
    if (DOM.loopUntilStableCheckbox) {
        DOM.loopUntilStableCheckbox.checked = AppState.loopUntilStable;
    }
    if (DOM.autoLoadSnapshotCheckbox) {
        DOM.autoLoadSnapshotCheckbox.checked = AppState.autoLoadSnapshot;
    }

    if (DOM.quickCheckboxG) DOM.quickCheckboxG.checked = AppState.quickG;
    if (DOM.quickCheckboxI) DOM.quickCheckboxI.checked = AppState.quickI;
    if (DOM.quickCheckboxM) DOM.quickCheckboxM.checked = AppState.quickM;
    if (DOM.quickCheckboxJsMode) {
        DOM.quickCheckboxJsMode.checked = AppState.quickJsMode;
    }

    if (DOM.quickPatternInput) {
        DOM.quickPatternInput.value = AppState.quickPattern;
    }
    if (DOM.quickReplacementInput) {
        DOM.quickReplacementInput.value = AppState.quickReplacement;
    }

    AppState.existenceIndexCache.isDirty = true;
    AppState.existenceIndexRulePositions = new Map();
    AppState.existenceIndexPresetHashes = new Map();

    AppState.lastRenderedRuleOrderKey = '';
    AppState.duplicateDetectionCacheKey = '';
    AppState.duplicateDetectionCacheResult = null;

    if (showIndexedDBUnavailableToast) {
        showToast('IndexedDB 不可用，仅恢复基础设置', true);
    }
}