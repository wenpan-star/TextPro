/**
 * ============================================================================
 * settings-io.js — 设置导出 / 导入
 * ============================================================================
 *
 * 【本次重构说明】
 *
 *   一、导入对话框默认模式改为"合并"
 *     · 原实现默认选中"完全覆盖"，用户直接回车会覆盖现有配置。
 *     · 新实现从 CONFIG.IMPORT_MODE_DEFAULT 读取（默认 'merge'）。
 *     · merge 语义：同名项以文件为准，新项追加，不会丢失现有配置。
 *
 *   二、时间戳钳制
 *     · normalizeImportedPreset 的 createdAt / updatedAt 会被钳制到
 *       [0, Date.now() + TIMESTAMP_FUTURE_TOLERANCE_MS]，
 *       防止未来时间扰乱排序。
 *
 *   三、保留全部既有能力
 *     · 旧格式兼容
 *     · 原型污染防御
 *     · 三种合并策略
 *     · 字符串 id 生成
 * ============================================================================
 */

import {
    CONFIG,
    SETTINGS_EXPORTABLE_KEYS,
    SETTINGS_FILE_TYPE,
    SETTINGS_FILE_VERSION,
    SEARCH_FIELD_SCOPE,
    SEARCH_DATA_SOURCE
} from './config.js';
import { AppState } from './state.js';
import { DOM } from './dom.js';
import { showToast } from './toast.js';
import {
    applyFullUiState,
    scheduleAutoSave
} from './persistence.js';
import { renderRuleTable, areRuleListsEquivalent } from './rules.js';
import { updateSearchMatches } from './search.js';

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
// 时间戳钳制
// ============================================================================

/**
 * ★ 新增：把时间戳钳制到合理范围。
 *
 * @param {*} rawValue 原始值
 * @param {number} fallback 无法解析时的回退值
 * @returns {number}
 */
function clampTimestamp(rawValue, fallback) {
    if (typeof rawValue !== 'number' || !isFinite(rawValue) || rawValue < 0) {
        return fallback;
    }
    const upperBound = Date.now() + CONFIG.TIMESTAMP_FUTURE_TOLERANCE_MS;
    if (rawValue > upperBound) {
        return upperBound;
    }
    return rawValue;
}

// ============================================================================
// ID 生成辅助
// ============================================================================

let globalIdMonotonicCounter = 0;

function nextMonotonicCounter() {
    globalIdMonotonicCounter++;
    return globalIdMonotonicCounter;
}

function generateRuleId(seedIndex) {
    const safeSeed = (seedIndex === undefined || seedIndex === null)
        ? 0
        : seedIndex;
    const monotonic = nextMonotonicCounter();
    return 'imported_rule_' +
        Date.now() + '_' +
        monotonic + '_' +
        safeSeed + '_' +
        Math.floor(Math.random() * CONFIG.ID_COLLISION_RANDOM_RANGE);
}

function generatePresetId() {
    const monotonic = nextMonotonicCounter();
    return 'preset_' + Date.now() + '_' + monotonic + '_' +
        Math.floor(Math.random() * CONFIG.ID_COLLISION_RANDOM_RANGE);
}

function generatePresetRuleId() {
    const monotonic = nextMonotonicCounter();
    return 'preset_rule_' + Date.now() + '_' + monotonic + '_' +
        Math.floor(Math.random() * CONFIG.ID_COLLISION_RANDOM_RANGE);
}

// ============================================================================
// 旧版格式兼容
// ============================================================================

function isLegacyRulesTableFormat(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return false;
    }
    if (Object.prototype.hasOwnProperty.call(payload, '_meta')) {
        return false;
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'data')) {
        return false;
    }
    if (!Array.isArray(payload.customRules)) {
        return false;
    }
    return true;
}

function convertLegacyPayloadToNewFormat(legacyPayload) {
    const convertedData = {};

    if (Array.isArray(legacyPayload.customRules)) {
        convertedData.customRules = legacyPayload.customRules;
        convertedData.defaultRules = legacyPayload.customRules;
        convertedData.defaultRulesName = '默认规则';
    }

    if (Array.isArray(legacyPayload.columnWidths)) {
        convertedData.columnWidths = legacyPayload.columnWidths;
    }

    const globalFlags = legacyPayload.globalFlags;
    if (
        globalFlags &&
        typeof globalFlags === 'object' &&
        !Array.isArray(globalFlags)
    ) {
        if (typeof globalFlags.flagG === 'boolean') {
            convertedData.flagG = globalFlags.flagG;
        }
        if (typeof globalFlags.flagI === 'boolean') {
            convertedData.flagI = globalFlags.flagI;
        }
        if (typeof globalFlags.flagM === 'boolean') {
            convertedData.flagM = globalFlags.flagM;
        }
        if (typeof globalFlags.loopUntilStable === 'boolean') {
            convertedData.loopUntilStable = globalFlags.loopUntilStable;
        }
    }

    return {
        _meta: {
            type: SETTINGS_FILE_TYPE,
            version: 1,
            appVersion: CONFIG.APP_VERSION + '+legacy-import',
            exportedAt: new Date().toISOString(),
            containsWorkData: true
        },
        data: convertedData
    };
}

// ============================================================================
// 字段校验器
// ============================================================================

const FIELD_VALIDATORS = {
    flagG: function(value) { return typeof value === 'boolean'; },
    flagI: function(value) { return typeof value === 'boolean'; },
    flagM: function(value) { return typeof value === 'boolean'; },
    loopUntilStable: function(value) { return typeof value === 'boolean'; },
    autoLoadSnapshot: function(value) { return typeof value === 'boolean'; },
    quickPattern: function(value) { return typeof value === 'string'; },
    quickReplacement: function(value) { return typeof value === 'string'; },
    quickG: function(value) { return typeof value === 'boolean'; },
    quickI: function(value) { return typeof value === 'boolean'; },
    quickM: function(value) { return typeof value === 'boolean'; },
    quickJsMode: function(value) { return typeof value === 'boolean'; },

    syncScrollMode: function(value) {
        return typeof value === 'string' &&
            ['proportion', 'pixel', 'off'].indexOf(value) !== -1;
    },
    darkMode: function(value) { return typeof value === 'boolean'; },
    helpPanelOpen: function(value) { return typeof value === 'boolean'; },

    columnWidths: function(value) {
        if (!Array.isArray(value)) return false;
        for (
            let columnIndex = 0;
            columnIndex < value.length;
            columnIndex++
        ) {
            const columnWidth = value[columnIndex];
            if (typeof columnWidth !== 'number' || !isFinite(columnWidth)) {
                return false;
            }
            if (columnWidth < CONFIG.TABLE_COLUMN_MIN_WIDTH_PX) return false;
            if (columnWidth > 5000) return false;
        }
        return true;
    },

    searchInput: function(value) { return typeof value === 'string'; },
    searchCase: function(value) { return typeof value === 'boolean'; },

    searchDataSource: function(value) {
        return value === SEARCH_DATA_SOURCE.ALL ||
            value === SEARCH_DATA_SOURCE.CURRENT;
    },
    presetSearchScope: function(value) {
        return value === SEARCH_FIELD_SCOPE.ALL ||
            value === SEARCH_FIELD_SCOPE.NAME_ONLY;
    },

    defaultRulesName: function(value) {
        return typeof value === 'string' && value.length > 0;
    },
    defaultRules: function(value) {
        if (!Array.isArray(value)) return false;
        for (let ruleIndex = 0; ruleIndex < value.length; ruleIndex++) {
            const rule = value[ruleIndex];
            if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
                return false;
            }
            if (typeof rule.name !== 'string') return false;
            if (typeof rule.pattern !== 'string') return false;
            if (typeof rule.replacement !== 'string') return false;
        }
        return true;
    },
    customRules: function(value) {
        if (!Array.isArray(value)) return false;
        for (let ruleIndex = 0; ruleIndex < value.length; ruleIndex++) {
            const rule = value[ruleIndex];
            if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
                return false;
            }
            if (typeof rule.name !== 'string') return false;
            if (typeof rule.pattern !== 'string') return false;
            if (typeof rule.replacement !== 'string') return false;
        }
        return true;
    },
    presets: function(value) {
        if (!Array.isArray(value)) return false;
        for (
            let presetIndex = 0;
            presetIndex < value.length;
            presetIndex++
        ) {
            const preset = value[presetIndex];
            if (
                !preset ||
                typeof preset !== 'object' ||
                Array.isArray(preset)
            ) {
                return false;
            }
            if (typeof preset.name !== 'string') return false;
            if (!Array.isArray(preset.rules)) return false;

            for (
                let ruleIndex = 0;
                ruleIndex < preset.rules.length;
                ruleIndex++
            ) {
                const rule = preset.rules[ruleIndex];
                if (
                    !rule ||
                    typeof rule !== 'object' ||
                    Array.isArray(rule)
                ) {
                    return false;
                }
                if (typeof rule.name !== 'string') return false;
                if (typeof rule.pattern !== 'string') return false;
                if (typeof rule.replacement !== 'string') return false;
            }
        }
        return true;
    },
    activePresetId: function(value) {
        if (value === null) return true;
        if (typeof value !== 'string') return false;
        if (value === CONFIG.MAIN_TABLE_VIRTUAL_ID) return true;
        if (value.indexOf('preset_') === 0) return true;
        return false;
    },
    lastImportedFileName: function(value) {
        return value === null || typeof value === 'string';
    }
};

function isFieldValueValid(fieldKey, fieldValue) {
    const validator = FIELD_VALIDATORS[fieldKey];
    if (typeof validator !== 'function') {
        return true;
    }
    try {
        return validator(fieldValue) === true;
    } catch (validationError) {
        return false;
    }
}

// ============================================================================
// 状态采集（导出用）
// ============================================================================

function collectExportableState() {
    const exportableState = {};

    for (
        let keyIndex = 0;
        keyIndex < SETTINGS_EXPORTABLE_KEYS.length;
        keyIndex++
    ) {
        const fieldKey = SETTINGS_EXPORTABLE_KEYS[keyIndex];

        if (fieldKey === 'searchInput') {
            exportableState.searchInput = DOM.resultSearchInput
                ? DOM.resultSearchInput.value
                : '';
        } else if (fieldKey === 'searchCase') {
            exportableState.searchCase = DOM.resultSearchCase
                ? DOM.resultSearchCase.checked
                : false;
        } else {
            if (Object.prototype.hasOwnProperty.call(AppState, fieldKey)) {
                exportableState[fieldKey] = AppState[fieldKey];
            }
        }
    }

    return exportableState;
}

// ============================================================================
// 规则表合并（导入用）
// ============================================================================

function normalizeImportedRule(rawRule, seedIndex) {
    const normalized = safeCopyPlainObject(rawRule);

    normalized.isRegex = normalized.isRegex !== false;
    normalized.isJS = normalized.isJS === true;
    normalized.enabled = normalized.enabled !== false;
    normalized.runChecked = normalized.runChecked !== false;

    if (!normalized.id) {
        normalized.id = generateRuleId(seedIndex);
    }
    if (typeof normalized.name !== 'string') {
        normalized.name = '未命名规则';
    }
    if (typeof normalized.pattern !== 'string') {
        normalized.pattern = '';
    }
    if (typeof normalized.replacement !== 'string') {
        normalized.replacement = '';
    }
    return normalized;
}

function mergeRulesAccordingToMode(existingRules, importedRules, mode) {
    const normalizedImportedRules = importedRules.map(function mapRule(
        rawRule,
        ruleIndex
    ) {
        return normalizeImportedRule(rawRule, ruleIndex);
    });

    if (mode === 'overwrite') {
        return normalizedImportedRules.map(function mapRule(rule, ruleIndex) {
            rule.order = ruleIndex + 1;
            return rule;
        });
    }

    if (mode === 'append') {
        const existingNames = new Set(
            existingRules.map(function mapRule(rule) {
                return (rule.name || '').trim().toLowerCase();
            })
        );

        const mergedResult = existingRules.slice();
        normalizedImportedRules.forEach(function forEachRule(
            rule,
            indexInImported
        ) {
            const normalizedName = (rule.name || '').trim().toLowerCase();
            if (existingNames.has(normalizedName)) {
                return;
            }
            rule.id = generateRuleId(indexInImported);
            rule.order = mergedResult.length + 1;
            mergedResult.push(rule);
            existingNames.add(normalizedName);
        });
        return mergedResult;
    }

    // merge 模式：同名项以文件为准
    const existingByName = new Map();
    const mergedResult = existingRules.map(function mapRule(existingRule) {
        const copy = safeCopyPlainObject(existingRule);
        existingByName.set(
            (copy.name || '').trim().toLowerCase(),
            copy
        );
        return copy;
    });

    normalizedImportedRules.forEach(function forEachRule(
        importedRule,
        indexInImported
    ) {
        const normalizedName = (importedRule.name || '').trim().toLowerCase();
        if (existingByName.has(normalizedName)) {
            const existingRule = existingByName.get(normalizedName);
            const preservedId = existingRule.id;
            const preservedOrder = existingRule.order;
            Object.assign(existingRule, importedRule, {
                id: preservedId,
                order: preservedOrder
            });
        } else {
            importedRule.id = generateRuleId(indexInImported);
            importedRule.order = mergedResult.length + 1;
            mergedResult.push(importedRule);
            existingByName.set(normalizedName, importedRule);
        }
    });

    return mergedResult;
}

// ============================================================================
// 预设合并（导入用）
// ============================================================================

function normalizeImportedPreset(rawPreset) {
    // ★ 时间戳钳制
    const now = Date.now();
    const clampedCreatedAt = clampTimestamp(rawPreset.createdAt, now);
    const clampedUpdatedAt = clampTimestamp(rawPreset.updatedAt, now);

    const preset = {
        id: (typeof rawPreset.id === 'string' && rawPreset.id)
            ? rawPreset.id
            : generatePresetId(),
        name: (typeof rawPreset.name === 'string' && rawPreset.name)
            ? rawPreset.name
            : '未命名预设',
        rules: [],
        createdAt: clampedCreatedAt,
        updatedAt: clampedUpdatedAt
    };

    if (Array.isArray(rawPreset.rules)) {
        preset.rules = rawPreset.rules.map(function mapRule(rawRule, ruleIndex) {
            const rule = normalizeImportedRule(rawRule, ruleIndex);

            if (
                typeof rawRule.id === 'string' &&
                rawRule.id.startsWith('preset_rule_')
            ) {
                rule.id = rawRule.id;
            } else {
                rule.id = generatePresetRuleId();
            }
            return rule;
        });
        preset.rules.forEach(function reindex(rule, index) {
            rule.order = index + 1;
        });
    }

    return preset;
}

function mergePresetsAccordingToMode(importedPresets, mode) {
    const normalizedImportedPresets = importedPresets.map(
        normalizeImportedPreset
    );

    if (mode === 'overwrite') {
        return normalizedImportedPresets;
    }

    if (mode === 'append') {
        const existingNames = new Set(
            AppState.presets.map(function mapPreset(preset) {
                return (preset.name || '').trim().toLowerCase();
            })
        );

        const mergedResult = AppState.presets.slice();
        normalizedImportedPresets.forEach(function forEachPreset(preset) {
            const normalizedName = (preset.name || '').trim().toLowerCase();
            if (existingNames.has(normalizedName)) {
                return;
            }
            preset.id = generatePresetId();
            mergedResult.push(preset);
            existingNames.add(normalizedName);
        });
        return mergedResult;
    }

    // merge 模式
    const existingByName = new Map();
    const mergedResult = AppState.presets.map(function mapPreset(
        existingPreset
    ) {
        const copy = safeCopyPlainObject(existingPreset);
        existingByName.set(
            (copy.name || '').trim().toLowerCase(),
            copy
        );
        return copy;
    });

    normalizedImportedPresets.forEach(function forEachPreset(importedPreset) {
        const normalizedName = (importedPreset.name || '')
            .trim()
            .toLowerCase();
        if (existingByName.has(normalizedName)) {
            const existingPreset = existingByName.get(normalizedName);
            const preservedId = existingPreset.id;
            const preservedCreatedAt = existingPreset.createdAt;
            Object.assign(existingPreset, importedPreset, {
                id: preservedId,
                createdAt: preservedCreatedAt,
                updatedAt: Date.now()
            });
        } else {
            importedPreset.id = generatePresetId();
            mergedResult.push(importedPreset);
            existingByName.set(normalizedName, importedPreset);
        }
    });

    return mergedResult;
}

// ============================================================================
// 状态应用
// ============================================================================

function applyImportedState(importedState, applyOptions) {
    const options = applyOptions || { mode: 'overwrite' };
    let appliedCount = 0;
    let skippedCount = 0;

    const validatedState = {};

    for (
        let keyIndex = 0;
        keyIndex < SETTINGS_EXPORTABLE_KEYS.length;
        keyIndex++
    ) {
        const fieldKey = SETTINGS_EXPORTABLE_KEYS[keyIndex];

        if (!Object.prototype.hasOwnProperty.call(importedState, fieldKey)) {
            continue;
        }

        const fieldValue = importedState[fieldKey];

        if (!isFieldValueValid(fieldKey, fieldValue)) {
            skippedCount++;
            continue;
        }

        validatedState[fieldKey] = fieldValue;
        appliedCount++;
    }

    if (
        Object.prototype.hasOwnProperty.call(validatedState, 'defaultRules') &&
        Array.isArray(validatedState.defaultRules)
    ) {
        validatedState.defaultRules = mergeRulesAccordingToMode(
            AppState.defaultRules,
            validatedState.defaultRules,
            options.mode
        );
    }

    if (
        Object.prototype.hasOwnProperty.call(validatedState, 'customRules') &&
        Array.isArray(validatedState.customRules)
    ) {
        validatedState.customRules = mergeRulesAccordingToMode(
            AppState.customRules,
            validatedState.customRules,
            options.mode
        );
    }

    if (
        Object.prototype.hasOwnProperty.call(validatedState, 'presets') &&
        Array.isArray(validatedState.presets)
    ) {
        validatedState.presets = mergePresetsAccordingToMode(
            validatedState.presets,
            options.mode
        );
    }

    applyFullUiState(validatedState);

    // ---- 一致性校验 ----
    if (AppState.activePresetId) {
        if (AppState.activePresetId !== CONFIG.MAIN_TABLE_VIRTUAL_ID) {
            const activePreset = AppState.presets.find(function findPreset(
                preset
            ) {
                return preset.id === AppState.activePresetId;
            });

            if (!activePreset) {
                AppState.activePresetId = CONFIG.MAIN_TABLE_VIRTUAL_ID;
            } else {
                const mainRules = AppState.customRules || [];
                const presetRules = activePreset.rules || [];
                const isConsistent = areRuleListsEquivalent(
                    mainRules,
                    presetRules
                );

                if (!isConsistent) {
                    AppState.activePresetId = CONFIG.MAIN_TABLE_VIRTUAL_ID;
                    AppState.customRules = AppState.defaultRules.map(
                        function mapRule(rule) {
                            return {
                                id: rule.id,
                                name: rule.name || '未命名规则',
                                pattern: typeof rule.pattern === 'string'
                                    ? rule.pattern
                                    : '',
                                replacement:
                                    typeof rule.replacement === 'string'
                                        ? rule.replacement
                                        : '',
                                enabled: rule.enabled !== false,
                                order: rule.order,
                                runChecked: rule.runChecked !== false,
                                isRegex: rule.isRegex !== false,
                                isJS: rule.isJS === true
                            };
                        }
                    );
                }
            }
        }
    }

    return {
        appliedCount: appliedCount,
        skippedCount: skippedCount
    };
}

// ============================================================================
// 导出
// ============================================================================

function countRulesForExportHint() {
    let presetRuleCount = 0;
    AppState.presets.forEach(function forEachPreset(preset) {
        if (Array.isArray(preset.rules)) {
            presetRuleCount += preset.rules.length;
        }
    });
    return {
        defaultRulesCount: AppState.defaultRules.length,
        customRulesCount: AppState.customRules.length,
        presetCount: AppState.presets.length,
        presetRuleCount: presetRuleCount
    };
}

function formatByteSizeHumanReadable(byteLength) {
    if (byteLength < 1024) {
        return byteLength + ' B';
    }
    if (byteLength < 1024 * 1024) {
        return (byteLength / 1024).toFixed(1) + ' KB';
    }
    return (byteLength / (1024 * 1024)).toFixed(2) + ' MB';
}

export function exportFullConfig() {
    const exportableState = collectExportableState();
    const stats = countRulesForExportHint();

    const payload = {
        _meta: {
            type: SETTINGS_FILE_TYPE,
            version: SETTINGS_FILE_VERSION,
            appVersion: CONFIG.APP_VERSION,
            exportedAt: new Date().toISOString(),
            containsWorkData: false
        },
        data: exportableState
    };

    let serializedJson;
    try {
        serializedJson = JSON.stringify(payload, null, 2);
    } catch (serializeError) {
        showToast('❌ 配置序列化失败', true);
        return;
    }

    const serializedByteLength = new Blob([serializedJson]).size;
    const readableSize = formatByteSizeHumanReadable(serializedByteLength);

    const configBlob = new Blob(
        [serializedJson],
        { type: 'application/json;charset=utf-8' }
    );
    const downloadUrl = URL.createObjectURL(configBlob);
    const downloadLink = document.createElement('a');
    const timestamp = buildTimestampForFilename(new Date());
    downloadLink.href = downloadUrl;
    downloadLink.download = 'textpro-settings-' + timestamp + '.json';
    document.body.appendChild(downloadLink);
    downloadLink.click();
    document.body.removeChild(downloadLink);
    URL.revokeObjectURL(downloadUrl);

    const totalRuleCount = stats.defaultRulesCount + stats.presetRuleCount;
    showToast(
        '📤 已导出配置 · 预设 ' + stats.presetCount +
        ' 个 · 规则 ' + totalRuleCount + ' 条 · 约 ' + readableSize +
        '（不含工作文本）'
    );
}

function buildTimestampForFilename(dateObject) {
    const year = dateObject.getFullYear();
    const month = String(dateObject.getMonth() + 1).padStart(2, '0');
    const day = String(dateObject.getDate()).padStart(2, '0');
    const hour = String(dateObject.getHours()).padStart(2, '0');
    const minute = String(dateObject.getMinutes()).padStart(2, '0');
    const second = String(dateObject.getSeconds()).padStart(2, '0');
    return year + month + day + '-' + hour + minute + second;
}

// ============================================================================
// 导入
// ============================================================================

function hasDuplicateRuleNames(importedRules) {
    if (!importedRules || !importedRules.length) return false;
    const existingNames = new Set(
        AppState.customRules.map(function mapRule(rule) {
            return (rule.name || '').trim().toLowerCase();
        })
    );
    for (
        let ruleIndex = 0;
        ruleIndex < importedRules.length;
        ruleIndex++
    ) {
        const ruleName = (importedRules[ruleIndex].name || '')
            .trim()
            .toLowerCase();
        if (existingNames.has(ruleName)) {
            return true;
        }
    }
    return false;
}

function hasDuplicateDefaultRuleNames(importedDefaultRules) {
    if (!importedDefaultRules || !importedDefaultRules.length) return false;
    const existingNames = new Set(
        AppState.defaultRules.map(function mapRule(rule) {
            return (rule.name || '').trim().toLowerCase();
        })
    );
    for (
        let ruleIndex = 0;
        ruleIndex < importedDefaultRules.length;
        ruleIndex++
    ) {
        const ruleName = (importedDefaultRules[ruleIndex].name || '')
            .trim()
            .toLowerCase();
        if (existingNames.has(ruleName)) {
            return true;
        }
    }
    return false;
}

function hasDuplicatePresetNames(importedPresets) {
    if (!importedPresets || !importedPresets.length) return false;
    const existingNames = new Set(
        AppState.presets.map(function mapPreset(preset) {
            return (preset.name || '').trim().toLowerCase();
        })
    );
    for (
        let presetIndex = 0;
        presetIndex < importedPresets.length;
        presetIndex++
    ) {
        const presetName = (importedPresets[presetIndex].name || '')
            .trim()
            .toLowerCase();
        if (existingNames.has(presetName)) {
            return true;
        }
    }
    return false;
}

function detectLegacyWorkDataFields(importedData) {
    const detectedFields = [];
    if (Object.prototype.hasOwnProperty.call(importedData, 'sourceText')) {
        detectedFields.push('源文本');
    }
    if (Object.prototype.hasOwnProperty.call(importedData, 'resultText')) {
        detectedFields.push('结果文本');
    }
    if (Object.prototype.hasOwnProperty.call(importedData, 'undoStack')) {
        detectedFields.push('撤销历史');
    }
    if (Object.prototype.hasOwnProperty.call(importedData, 'snapshotText')) {
        detectedFields.push('快照文本');
    }
    if (Object.prototype.hasOwnProperty.call(importedData, 'historyText')) {
        detectedFields.push('历史文本');
    }
    return detectedFields;
}

function showImportModeDialog(summary) {
    return new Promise(function executor(resolve) {
        if (!DOM.importModeOverlay || !DOM.importModeDialog) {
            resolve(CONFIG.IMPORT_MODE_DEFAULT || 'merge');
            return;
        }

        if (DOM.importModeSummary && summary) {
            DOM.importModeSummary.textContent = summary;
        }

        // ★ 根据配置选择默认模式
        const defaultMode = CONFIG.IMPORT_MODE_DEFAULT || 'merge';

        if (DOM.importModeOverwriteRadio) {
            DOM.importModeOverwriteRadio.checked = (defaultMode === 'overwrite');
        }
        if (DOM.importModeAppendRadio) {
            DOM.importModeAppendRadio.checked = (defaultMode === 'append');
        }
        if (DOM.importModeMergeRadio) {
            DOM.importModeMergeRadio.checked = (defaultMode === 'merge');
        }

        DOM.importModeOverlay.style.display = 'flex';
        AppState.importModeDialogOpen = true;
        AppState.importModeDefaultApplied = true;

        setTimeout(function deferFocus() {
            if (
                DOM.importModeConfirmButton &&
                typeof DOM.importModeConfirmButton.focus === 'function'
            ) {
                DOM.importModeConfirmButton.focus();
            }
        }, 0);

        function cleanup() {
            DOM.importModeOverlay.style.display = 'none';
            AppState.importModeDialogOpen = false;
            if (DOM.importModeConfirmButton) {
                DOM.importModeConfirmButton.removeEventListener(
                    'click',
                    onConfirm
                );
            }
            if (DOM.importModeCancelButton) {
                DOM.importModeCancelButton.removeEventListener(
                    'click',
                    onCancel
                );
            }
            document.removeEventListener('keydown', onKeyDown);
        }

        function onConfirm() {
            let mode = defaultMode;
            if (
                DOM.importModeAppendRadio &&
                DOM.importModeAppendRadio.checked
            ) {
                mode = 'append';
            } else if (
                DOM.importModeMergeRadio &&
                DOM.importModeMergeRadio.checked
            ) {
                mode = 'merge';
            } else if (
                DOM.importModeOverwriteRadio &&
                DOM.importModeOverwriteRadio.checked
            ) {
                mode = 'overwrite';
            }
            cleanup();
            resolve(mode);
        }

        function onCancel() {
            cleanup();
            resolve(null);
        }

        function onKeyDown(event) {
            if (event.key === 'Escape') {
                event.preventDefault();
                onCancel();
            }
        }

        if (DOM.importModeConfirmButton) {
            DOM.importModeConfirmButton.addEventListener('click', onConfirm);
        }
        if (DOM.importModeCancelButton) {
            DOM.importModeCancelButton.addEventListener('click', onCancel);
        }
        document.addEventListener('keydown', onKeyDown);
    });
}

export function importFullConfigFromFile(settingsFile) {
    if (!settingsFile) return;

    if (settingsFile.size > CONFIG.SETTINGS_FILE_MAX_SIZE_BYTES) {
        const maxMegabytes = (
            CONFIG.SETTINGS_FILE_MAX_SIZE_BYTES / (1024 * 1024)
        ).toFixed(0);
        showToast('❌ 配置文件过大（最大 ' + maxMegabytes + 'MB）', true);
        return;
    }

    const fileReader = new FileReader();

    fileReader.onload = async function onLoad(loadEvent) {
        try {
            let rawText = String(loadEvent.target.result || '');

            if (rawText.charCodeAt(0) === 0xFEFF) {
                rawText = rawText.slice(1);
            }

            let parsedPayload;
            try {
                parsedPayload = JSON.parse(rawText);
            } catch (parseError) {
                showToast('❌ 配置文件格式错误（非有效 JSON）', true);
                return;
            }

            if (
                !parsedPayload ||
                typeof parsedPayload !== 'object' ||
                Array.isArray(parsedPayload)
            ) {
                showToast('❌ 配置文件顶层不是对象', true);
                return;
            }

            let wasLegacyFormat = false;
            if (isLegacyRulesTableFormat(parsedPayload)) {
                wasLegacyFormat = true;
                parsedPayload = convertLegacyPayloadToNewFormat(
                    parsedPayload
                );
            }

            const metaObject = parsedPayload._meta;
            if (
                metaObject &&
                typeof metaObject === 'object' &&
                !Array.isArray(metaObject)
            ) {
                if (typeof metaObject.type !== 'string') {
                    showToast(
                        '❌ 配置文件 _meta.type 字段缺失或类型错误',
                        true
                    );
                    return;
                }
                if (metaObject.type !== SETTINGS_FILE_TYPE) {
                    showToast('❌ 不是 TextPro 的配置文件', true);
                    return;
                }
            } else {
                if (!confirm(
                    '该文件缺少配置文件标识信息，可能来自其他来源。\n' +
                    '继续导入可能导致配置异常，是否继续？'
                )) {
                    return;
                }
            }

            const importedData = parsedPayload.data;
            if (
                !importedData ||
                typeof importedData !== 'object' ||
                Array.isArray(importedData)
            ) {
                showToast('❌ 配置文件缺少 data 字段', true);
                return;
            }

            const legacyWorkDataFields = detectLegacyWorkDataFields(
                importedData
            );

            const importedRules = Array.isArray(importedData.customRules)
                ? importedData.customRules
                : [];
            const importedDefaultRules = Array.isArray(
                importedData.defaultRules
            )
                ? importedData.defaultRules
                : [];
            const importedPresets = Array.isArray(importedData.presets)
                ? importedData.presets
                : [];

            const hasDuplicateRules = hasDuplicateRuleNames(importedRules);
            const hasDuplicateDefaultRules =
                hasDuplicateDefaultRuleNames(importedDefaultRules);
            const hasDuplicatePresets =
                hasDuplicatePresetNames(importedPresets);

            let applyMode = CONFIG.IMPORT_MODE_DEFAULT || 'merge';

            if (
                hasDuplicateRules ||
                hasDuplicateDefaultRules ||
                hasDuplicatePresets
            ) {
                const totalFieldsPresent = SETTINGS_EXPORTABLE_KEYS.filter(
                    function filterKey(key) {
                        return Object.prototype.hasOwnProperty.call(
                            importedData,
                            key
                        );
                    }
                ).length;

                const summaryParts = [];
                if (hasDuplicateRules) {
                    summaryParts.push(
                        '· 当前工作区规则表：' + importedRules.length +
                        ' 条待导入（存在同名）'
                    );
                }
                if (hasDuplicateDefaultRules) {
                    summaryParts.push(
                        '· 默认规则：' + importedDefaultRules.length +
                        ' 条待导入（存在同名）'
                    );
                }
                if (hasDuplicatePresets) {
                    summaryParts.push(
                        '· 预设库：' + importedPresets.length +
                        ' 条待导入（存在同名）'
                    );
                }
                summaryParts.push(
                    '· 文件含 ' + totalFieldsPresent + ' 个可识别字段'
                );
                if (legacyWorkDataFields.length > 0) {
                    summaryParts.push(
                        '· ⚠️ 检测到旧版文件含工作数据（' +
                        legacyWorkDataFields.join('、') +
                        '），导入时将忽略'
                    );
                }

                const summaryText =
                    '检测到与现有配置的同名项，请选择处理方式：\n\n' +
                    summaryParts.join('\n');

                const chosenMode = await showImportModeDialog(summaryText);
                if (chosenMode === null) {
                    return;
                }
                applyMode = chosenMode;
            } else {
                let confirmMessage =
                    '导入将覆盖当前配置（含预设库与默认规则），是否继续？';
                if (legacyWorkDataFields.length > 0) {
                    confirmMessage +=
                        '\n\n⚠️ 检测到旧版文件含工作数据（' +
                        legacyWorkDataFields.join('、') +
                        '），导入时将忽略以保护您当前的文本内容。';
                }
                if (!confirm(confirmMessage)) {
                    return;
                }
            }

            const previousAutoLoadSnapshot = AppState.autoLoadSnapshot;

            const applyResult = applyImportedState(
                importedData,
                { mode: applyMode }
            );

            renderRuleTable();

            if (
                DOM.resultSearchInput &&
                DOM.resultSearchInput.value.trim() !== ''
            ) {
                updateSearchMatches();
            } else {
                if (DOM.resultSearchCount) {
                    DOM.resultSearchCount.textContent = '0/0';
                    DOM.resultSearchCount.classList.remove(
                        'no-match',
                        'has-match'
                    );
                }
                AppState.searchMatches = [];
                AppState.currentMatchIndex = -1;
            }

            scheduleAutoSave();

            let resultMessage;
            if (wasLegacyFormat) {
                resultMessage = '📥 已从旧版替换表导入（' +
                    applyResult.appliedCount + ' 项字段已映射到当前配置）';
            } else {
                resultMessage = '📥 已导入 ' +
                    applyResult.appliedCount + ' 项设置';
            }
            if (applyResult.skippedCount > 0) {
                resultMessage += '，跳过 ' + applyResult.skippedCount +
                    ' 项（格式不兼容）';
            }
            if (Array.isArray(importedData.presets)) {
                resultMessage += '（预设库 ' +
                    AppState.presets.length + ' 条）';
            }
            if (legacyWorkDataFields.length > 0) {
                resultMessage += ' · 已忽略旧版文件中的' +
                    legacyWorkDataFields.join('、');
            }
            showToast(resultMessage);

            if (
                previousAutoLoadSnapshot !== false &&
                AppState.autoLoadSnapshot === false
            ) {
                setTimeout(function deferNotify() {
                    showToast(
                        '⚠️ 配置文件已将"启动时自动加载快照"设为关闭，' +
                        '下次打开页面将从空文本开始',
                        true
                    );
                }, CONFIG.TOAST_DURATION_MS + 200);
            }
        } catch (importError) {
            console.error('导入配置时发生异常:', importError);
            showToast(
                '❌ 导入失败: ' + (importError.message || '未知错误'),
                true
            );
        }
    };

    fileReader.onerror = function onError() {
        showToast('❌ 配置文件读取失败', true);
    };

    fileReader.readAsText(settingsFile, 'utf-8');
}