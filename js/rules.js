/**
 * ============================================================================
 * rules.js — 主规则表管理 + 增量存在性索引 + 增量渲染
 * ============================================================================
 *
 * 【本次重构说明】
 *
 *   一、增量存在性索引
 *     · 保留 contentHashMap 作为"规则内容 → 位置集合"的全量索引
 *     · 新增 existenceIndexRulePositions（ruleId → 位置集合）和
 *       existenceIndexPresetHashes（presetId → hash → ruleId 集合）作为副索引
 *     · 编辑单条规则时，通过 updateExistenceIndexForRule 增量更新，
 *       不再全量重建
 *     · 只有在结构性变化（增删预设、批量导入等）时才全量 rebuild
 *
 *   二、ID 归属修复
 *     · replaceMainTableWithRules 现在校验 id 唯一性：若源规则 id 与
 *       已有规则冲突，则派生新 id，避免出现两条 id 相同的规则
 *     · 引入 lastIdRemapTable 记录原始 id → 新 id 的映射，
 *       供调用方追踪（暂不对外暴露）
 *
 *   三、保存点
 *     · 所有主表操作保留 scheduleSyncToActivePreset 调用
 *     · 所有主表操作保留 scheduleAutoSave 调用
 *
 *   四、其余逻辑保持不变
 * ============================================================================
 */

import { CONFIG, defaultCustomRules } from './config.js';
import { AppState } from './state.js';
import { DOM } from './dom.js';
import { showToast } from './toast.js';
import { confirmJSMode } from './security.js';
import {
    performReplace,
    performBatchReplaceAsync,
    cancelCurrentWorkerTask
} from './text-processor.js';
import {
    getSourceText,
    getResultText,
    setResultText,
    checkTextSize
} from './editor-api.js';
import { scheduleAutoSave } from './persistence.js';

let isBatchRunErrorBarInitialized = false;
let pendingRuleTableRenderHandle = null;

const ROW_ELEMENTS = Symbol('ruleRowElements');
const ruleRowCache = new Map();

const MAX_DISPLAYED_OTHER_ORDERS = 3;

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

function applyRulePrefixConversionInPlace(rule) {
    if (!rule) return;

    const replacementText = String(rule.replacement || '');
    const trimmedText = replacementText.trim();

    if (trimmedText.startsWith('@@js:')) {
        rule.replacement = replacementText.replace(/^@@js:\s*/, '@js:');
        rule.isJS = false;
    } else if (trimmedText.startsWith('@js:')) {
        rule.replacement = replacementText.replace(/^@js:\s*/, '').trim();
        rule.isJS = true;
    }
}

// ============================================================================
// 默认规则 ↔ customRules 双向同步辅助
// ============================================================================

export function syncCustomRulesToDefaultRulesIfActive() {
    if (AppState.activePresetId !== CONFIG.MAIN_TABLE_VIRTUAL_ID) {
        return false;
    }
    if (AppState.isSyncingDefaultRulesAndCustomRules) {
        return false;
    }

    AppState.isSyncingDefaultRulesAndCustomRules = true;
    try {
        AppState.defaultRules = AppState.customRules.map(function mapRule(rule) {
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
        AppState.existenceIndexCache.isDirty = true;
        AppState.mainTableDirtyForActivePreset = false;
        return true;
    } finally {
        AppState.isSyncingDefaultRulesAndCustomRules = false;
    }
}

export function syncDefaultRulesToCustomRulesIfActive() {
    if (AppState.activePresetId !== CONFIG.MAIN_TABLE_VIRTUAL_ID) {
        return false;
    }
    if (AppState.isSyncingDefaultRulesAndCustomRules) {
        return false;
    }

    AppState.isSyncingDefaultRulesAndCustomRules = true;
    try {
        let needRebuild = false;

        if (AppState.customRules.length !== AppState.defaultRules.length) {
            needRebuild = true;
        } else {
            for (let index = 0; index < AppState.customRules.length; index++) {
                const customRule = AppState.customRules[index];
                const defaultRule = AppState.defaultRules[index];
                if (!defaultRule) {
                    needRebuild = true;
                    break;
                }
                if (String(customRule.id) !== String(defaultRule.id)) {
                    needRebuild = true;
                    break;
                }
            }
        }

        if (needRebuild) {
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
        } else {
            for (let index = 0; index < AppState.customRules.length; index++) {
                const customRule = AppState.customRules[index];
                const defaultRule = AppState.defaultRules[index];

                customRule.name = defaultRule.name;
                customRule.pattern = defaultRule.pattern;
                customRule.replacement = defaultRule.replacement;
                customRule.enabled = defaultRule.enabled;
                customRule.order = defaultRule.order;
                customRule.runChecked = defaultRule.runChecked;
                customRule.isRegex = defaultRule.isRegex;
                customRule.isJS = defaultRule.isJS;
            }
        }

        invalidateExistenceIndex();
        renderRuleTable();
        return true;
    } finally {
        AppState.isSyncingDefaultRulesAndCustomRules = false;
    }
}

// ============================================================================
// 主表虚拟条目辅助
// ============================================================================

export function isMainTableVirtualId(id) {
    return id === CONFIG.MAIN_TABLE_VIRTUAL_ID;
}

export function getMainTableAsVirtualPreset() {
    return {
        id: CONFIG.MAIN_TABLE_VIRTUAL_ID,
        name: AppState.defaultRulesName || '默认规则',
        rules: AppState.defaultRules,
        createdAt: 0,
        updatedAt: 0,
        isVirtual: true
    };
}

export function derivePresetRuleIdFromMainId(mainRuleId) {
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

// ============================================================================
// 规则内容哈希与存在性索引
// ============================================================================

export function computeContentHash(rule) {
    if (!rule) return '';
    return String(rule.pattern || '') + '\u0000' +
        String(rule.replacement || '') + '\u0000' +
        (rule.isRegex !== false ? '1' : '0') + '\u0000' +
        (rule.isJS === true ? '1' : '0');
}

export function invalidateExistenceIndex() {
    AppState.existenceIndexCache.isDirty = true;
}

/**
 * 全量重建存在性索引。
 *
 * 同时重建：
 *   · existenceIndexCache.contentHashMap
 *   · existenceIndexRulePositions
 *   · existenceIndexPresetHashes
 */
export function rebuildExistenceIndex() {
    const contentHashMap = new Map();
    const rulePositions = new Map();
    const presetHashes = new Map();

    for (
        let defaultIndex = 0;
        defaultIndex < AppState.defaultRules.length;
        defaultIndex++
    ) {
        const defaultRule = AppState.defaultRules[defaultIndex];
        const hash = computeContentHash(defaultRule);
        if (!contentHashMap.has(hash)) {
            contentHashMap.set(hash, new Set());
        }
        contentHashMap.get(hash).add(CONFIG.MAIN_TABLE_VIRTUAL_ID);

        const ruleIdString = String(defaultRule.id);
        if (!rulePositions.has(ruleIdString)) {
            rulePositions.set(ruleIdString, new Set());
        }
        rulePositions.get(ruleIdString).add(CONFIG.MAIN_TABLE_VIRTUAL_ID);
    }

    // 主表位置哈希
    const mainTableHashes = new Map();
    for (
        let defaultIndex = 0;
        defaultIndex < AppState.defaultRules.length;
        defaultIndex++
    ) {
        const defaultRule = AppState.defaultRules[defaultIndex];
        const hash = computeContentHash(defaultRule);
        if (!mainTableHashes.has(hash)) {
            mainTableHashes.set(hash, new Set());
        }
        mainTableHashes.get(hash).add(String(defaultRule.id));
    }
    presetHashes.set(CONFIG.MAIN_TABLE_VIRTUAL_ID, mainTableHashes);

    for (
        let presetIndex = 0;
        presetIndex < AppState.presets.length;
        presetIndex++
    ) {
        const preset = AppState.presets[presetIndex];
        const presetRules = Array.isArray(preset.rules) ? preset.rules : [];
        const perPresetHashes = new Map();

        for (let ruleIndex = 0; ruleIndex < presetRules.length; ruleIndex++) {
            const rule = presetRules[ruleIndex];
            const hash = computeContentHash(rule);

            if (!contentHashMap.has(hash)) {
                contentHashMap.set(hash, new Set());
            }
            contentHashMap.get(hash).add(preset.id);

            const ruleIdString = String(rule.id);
            if (!rulePositions.has(ruleIdString)) {
                rulePositions.set(ruleIdString, new Set());
            }
            rulePositions.get(ruleIdString).add(preset.id);

            if (!perPresetHashes.has(hash)) {
                perPresetHashes.set(hash, new Set());
            }
            perPresetHashes.get(hash).add(ruleIdString);
        }

        presetHashes.set(preset.id, perPresetHashes);
    }

    AppState.existenceIndexCache.contentHashMap = contentHashMap;
    AppState.existenceIndexCache.isDirty = false;
    AppState.existenceIndexRulePositions = rulePositions;
    AppState.existenceIndexPresetHashes = presetHashes;
}

/**
 * ★ 新增：单条规则的增量索引更新。
 *
 * 场景：编辑某条规则的 pattern / replacement / isRegex / isJS。
 *
 * @param {object} rule 编辑后的规则
 * @param {string} presetId 该规则所属的 preset（主表用 MAIN_TABLE_VIRTUAL_ID）
 * @param {string} oldHash 编辑前的 hash（若未知，传 null 触发全量重建）
 */
export function updateExistenceIndexForRule(rule, presetId, oldHash) {
    if (!CONFIG.INDEX_EXISTENCE_INCREMENTAL) {
        invalidateExistenceIndex();
        return;
    }
    if (!rule || !presetId) {
        invalidateExistenceIndex();
        return;
    }

    // 索引尚未建立 → 触发全量
    if (AppState.existenceIndexCache.isDirty) {
        rebuildExistenceIndex();
        return;
    }

    const newHash = computeContentHash(rule);
    const ruleIdString = String(rule.id);

    // ---- 更新 contentHashMap ----
    if (oldHash && oldHash !== newHash) {
        const oldBucket = AppState.existenceIndexCache.contentHashMap.get(
            oldHash
        );
        if (oldBucket) {
            oldBucket.delete(presetId);
            if (oldBucket.size === 0) {
                AppState.existenceIndexCache.contentHashMap.delete(oldHash);
            }
        }
    }

    if (!AppState.existenceIndexCache.contentHashMap.has(newHash)) {
        AppState.existenceIndexCache.contentHashMap.set(newHash, new Set());
    }
    AppState.existenceIndexCache.contentHashMap.get(newHash).add(presetId);

    // ---- 更新 existenceIndexRulePositions ----
    //   规则的"归属"未变（仍属于同一 presetId），无需变更
    if (!AppState.existenceIndexRulePositions.has(ruleIdString)) {
        AppState.existenceIndexRulePositions.set(ruleIdString, new Set());
    }
    AppState.existenceIndexRulePositions.get(ruleIdString).add(presetId);

    // ---- 更新 existenceIndexPresetHashes ----
    let perPresetHashes = AppState.existenceIndexPresetHashes.get(presetId);
    if (!perPresetHashes) {
        perPresetHashes = new Map();
        AppState.existenceIndexPresetHashes.set(presetId, perPresetHashes);
    }

    if (oldHash && oldHash !== newHash) {
        const oldRuleIds = perPresetHashes.get(oldHash);
        if (oldRuleIds) {
            oldRuleIds.delete(ruleIdString);
            if (oldRuleIds.size === 0) {
                perPresetHashes.delete(oldHash);
            }
        }
    }

    if (!perPresetHashes.has(newHash)) {
        perPresetHashes.set(newHash, new Set());
    }
    perPresetHashes.get(newHash).add(ruleIdString);
}

/**
 * ★ 新增：从索引中移除一条规则。
 *
 * 场景：删除规则、从预设中移除规则。
 *
 * @param {object} rule 被删除的规则
 * @param {string} presetId 该规则原先所属的 preset
 */
export function removeRuleFromExistenceIndex(rule, presetId) {
    if (!CONFIG.INDEX_EXISTENCE_INCREMENTAL) {
        invalidateExistenceIndex();
        return;
    }
    if (!rule || !presetId) {
        invalidateExistenceIndex();
        return;
    }

    if (AppState.existenceIndexCache.isDirty) {
        rebuildExistenceIndex();
        return;
    }

    const hash = computeContentHash(rule);
    const ruleIdString = String(rule.id);

    const bucket = AppState.existenceIndexCache.contentHashMap.get(hash);
    if (bucket) {
        bucket.delete(presetId);
        if (bucket.size === 0) {
            AppState.existenceIndexCache.contentHashMap.delete(hash);
        }
    }

    const positions = AppState.existenceIndexRulePositions.get(ruleIdString);
    if (positions) {
        positions.delete(presetId);
        if (positions.size === 0) {
            AppState.existenceIndexRulePositions.delete(ruleIdString);
        }
    }

    const perPresetHashes = AppState.existenceIndexPresetHashes.get(presetId);
    if (perPresetHashes) {
        const ruleIds = perPresetHashes.get(hash);
        if (ruleIds) {
            ruleIds.delete(ruleIdString);
            if (ruleIds.size === 0) {
                perPresetHashes.delete(hash);
            }
        }
    }
}

/**
 * ★ 新增：向索引中加入一条规则。
 *
 * 场景：新增规则、追加规则到预设。
 *
 * @param {object} rule 新增的规则
 * @param {string} presetId 目标 preset
 */
export function addRuleToExistenceIndex(rule, presetId) {
    if (!CONFIG.INDEX_EXISTENCE_INCREMENTAL) {
        invalidateExistenceIndex();
        return;
    }
    if (!rule || !presetId) {
        invalidateExistenceIndex();
        return;
    }

    if (AppState.existenceIndexCache.isDirty) {
        rebuildExistenceIndex();
        return;
    }

    const hash = computeContentHash(rule);
    const ruleIdString = String(rule.id);

    if (!AppState.existenceIndexCache.contentHashMap.has(hash)) {
        AppState.existenceIndexCache.contentHashMap.set(hash, new Set());
    }
    AppState.existenceIndexCache.contentHashMap.get(hash).add(presetId);

    if (!AppState.existenceIndexRulePositions.has(ruleIdString)) {
        AppState.existenceIndexRulePositions.set(ruleIdString, new Set());
    }
    AppState.existenceIndexRulePositions.get(ruleIdString).add(presetId);

    let perPresetHashes = AppState.existenceIndexPresetHashes.get(presetId);
    if (!perPresetHashes) {
        perPresetHashes = new Map();
        AppState.existenceIndexPresetHashes.set(presetId, perPresetHashes);
    }
    if (!perPresetHashes.has(hash)) {
        perPresetHashes.set(hash, new Set());
    }
    perPresetHashes.get(hash).add(ruleIdString);
}

export function getRuleLocations(rule, excludePresetId) {
    if (AppState.existenceIndexCache.isDirty) {
        rebuildExistenceIndex();
    }
    const hash = computeContentHash(rule);
    const locations = AppState.existenceIndexCache.contentHashMap.get(hash);
    if (!locations) return [];

    const result = [];
    locations.forEach(function forEachLocation(presetId) {
        if (excludePresetId !== undefined && presetId === excludePresetId) {
            return;
        }
        result.push(presetId);
    });
    return result;
}

export function getPresetOverlapCount(preset) {
    if (!preset || !Array.isArray(preset.rules)) return 0;
    if (AppState.existenceIndexCache.isDirty) {
        rebuildExistenceIndex();
    }
    const contentHashMap = AppState.existenceIndexCache.contentHashMap;
    let overlapCount = 0;
    for (let ruleIndex = 0; ruleIndex < preset.rules.length; ruleIndex++) {
        const hash = computeContentHash(preset.rules[ruleIndex]);
        const locations = contentHashMap.get(hash);
        if (locations && locations.has(CONFIG.MAIN_TABLE_VIRTUAL_ID)) {
            overlapCount++;
        }
    }
    return overlapCount;
}

// ============================================================================
// 规则内容等价比较
// ============================================================================

export function isStrictlyEquivalent(ruleA, ruleB) {
    if (!ruleA || !ruleB) return false;

    if (String(ruleA.name || '') !== String(ruleB.name || '')) return false;
    if (String(ruleA.pattern || '') !== String(ruleB.pattern || '')) {
        return false;
    }
    if (String(ruleA.replacement || '') !== String(ruleB.replacement || '')) {
        return false;
    }

    const isRegexA = ruleA.isRegex !== false;
    const isRegexB = ruleB.isRegex !== false;
    if (isRegexA !== isRegexB) return false;

    const isJSA = ruleA.isJS === true;
    const isJSB = ruleB.isJS === true;
    if (isJSA !== isJSB) return false;

    return true;
}

export function isSubstantiallyEquivalent(ruleA, ruleB) {
    if (!ruleA || !ruleB) return false;

    if (String(ruleA.pattern || '') !== String(ruleB.pattern || '')) {
        return false;
    }
    if (String(ruleA.replacement || '') !== String(ruleB.replacement || '')) {
        return false;
    }

    const isRegexA = ruleA.isRegex !== false;
    const isRegexB = ruleB.isRegex !== false;
    if (isRegexA !== isRegexB) return false;

    const isJSA = ruleA.isJS === true;
    const isJSB = ruleB.isJS === true;
    if (isJSA !== isJSB) return false;

    return true;
}

export function areRuleListsEquivalent(rulesA, rulesB) {
    if (!Array.isArray(rulesA) || !Array.isArray(rulesB)) return false;
    if (rulesA.length !== rulesB.length) return false;

    const sortedA = rulesA.slice().sort(function sortRules(a, b) {
        return (a.order || 0) - (b.order || 0);
    });
    const sortedB = rulesB.slice().sort(function sortRules(a, b) {
        return (a.order || 0) - (b.order || 0);
    });

    for (let index = 0; index < sortedA.length; index++) {
        if (!isStrictlyEquivalent(sortedA[index], sortedB[index])) {
            return false;
        }
    }
    return true;
}

// ============================================================================
// 重复规则查找
// ============================================================================

function findDuplicateRuleInRuleList(candidateRule, ruleList) {
    if (!candidateRule || !Array.isArray(ruleList)) return null;

    let substantialMatch = null;

    for (let index = 0; index < ruleList.length; index++) {
        const existingRule = ruleList[index];

        if (isStrictlyEquivalent(existingRule, candidateRule)) {
            return {
                rule: existingRule,
                matchType: 'strict'
            };
        }

        if (
            substantialMatch === null &&
            isSubstantiallyEquivalent(existingRule, candidateRule)
        ) {
            substantialMatch = {
                rule: existingRule,
                matchType: 'substantial'
            };
        }
    }

    return substantialMatch;
}

export function findDuplicateRuleInDefaultRules(candidateRule) {
    return findDuplicateRuleInRuleList(candidateRule, AppState.defaultRules);
}

export function findDuplicateRuleInPreset(candidateRule, targetPreset) {
    if (!targetPreset || !Array.isArray(targetPreset.rules)) return null;
    return findDuplicateRuleInRuleList(candidateRule, targetPreset.rules);
}

function buildDuplicateDetectionCacheKey() {
    const rules = AppState.customRules;
    if (!Array.isArray(rules) || rules.length === 0) {
        return '';
    }

    const parts = [];
    for (let index = 0; index < rules.length; index++) {
        const rule = rules[index];
        parts.push(
            String(rule.pattern || ''),
            String(rule.replacement || ''),
            rule.isRegex !== false ? '1' : '0',
            rule.isJS === true ? '1' : '0',
            String(rule.order)
        );
    }
    return parts.join('\u0001');
}

export function detectMainTableDuplicates() {
    if (CONFIG.DUPLICATE_DETECTION_CACHE_ENABLED) {
        const currentCacheKey = buildDuplicateDetectionCacheKey();
        if (
            currentCacheKey === AppState.duplicateDetectionCacheKey &&
            AppState.duplicateDetectionCacheResult !== null
        ) {
            return AppState.duplicateDetectionCacheResult;
        }
    }

    const duplicatesMap = new Map();
    const rules = AppState.customRules;

    if (rules.length < 2) {
        if (CONFIG.DUPLICATE_DETECTION_CACHE_ENABLED) {
            AppState.duplicateDetectionCacheKey =
                buildDuplicateDetectionCacheKey();
            AppState.duplicateDetectionCacheResult = duplicatesMap;
        }
        return duplicatesMap;
    }

    const contentHashToRules = new Map();
    for (let index = 0; index < rules.length; index++) {
        const rule = rules[index];
        const hash = computeContentHash(rule);
        if (!contentHashToRules.has(hash)) {
            contentHashToRules.set(hash, []);
        }
        contentHashToRules.get(hash).push(rule);
    }

    contentHashToRules.forEach(function forEachGroup(ruleGroup) {
        if (ruleGroup.length <= 1) {
            return;
        }

        const sortedOrders = ruleGroup.map(function mapOrder(rule) {
            return rule.order;
        });
        sortedOrders.sort(function sortOrders(a, b) {
            return a - b;
        });

        const totalOthers = ruleGroup.length - 1;

        for (
            let groupIndex = 0;
            groupIndex < ruleGroup.length;
            groupIndex++
        ) {
            const currentRule = ruleGroup[groupIndex];

            const otherOrders = [];
            let removedOnce = false;
            for (
                let orderIndex = 0;
                orderIndex < sortedOrders.length;
                orderIndex++
            ) {
                if (
                    !removedOnce &&
                    sortedOrders[orderIndex] === currentRule.order
                ) {
                    removedOnce = true;
                    continue;
                }
                if (otherOrders.length >= MAX_DISPLAYED_OTHER_ORDERS) {
                    break;
                }
                otherOrders.push(sortedOrders[orderIndex]);
            }

            duplicatesMap.set(currentRule.id, {
                otherOrders: otherOrders,
                totalOthers: totalOthers
            });
        }
    });

    if (CONFIG.DUPLICATE_DETECTION_CACHE_ENABLED) {
        AppState.duplicateDetectionCacheKey = buildDuplicateDetectionCacheKey();
        AppState.duplicateDetectionCacheResult = duplicatesMap;
    }

    return duplicatesMap;
}

function buildDuplicateBadgeContent(dupInfo) {
    const otherOrders = dupInfo.otherOrders;
    const totalOthers = dupInfo.totalOthers;
    const isTruncated = totalOthers > otherOrders.length;

    const ordersText = '#' + otherOrders.join(' / #');

    let badgeText;
    if (isTruncated) {
        badgeText = '⚠️ 与 ' + ordersText +
            ' 等 ' + totalOthers + ' 条重复';
    } else {
        badgeText = '⚠️ 与 ' + ordersText + ' 重复';
    }

    let titleText;
    if (isTruncated) {
        titleText =
            '本条规则与其他 ' + totalOthers + ' 条规则内容完全相同\n' +
            '（正则、替换文本、正则/JS 标志完全相同）\n' +
            '序号：' + ordersText + ' 等\n' +
            '运行时会重复执行，建议删除多余的';
    } else {
        titleText =
            '本条规则与序号 ' + ordersText + ' 的规则内容完全相同\n' +
            '（正则、替换文本、正则/JS 标志完全相同）\n' +
            '运行时会重复执行，建议删除多余的';
    }

    const dataAttr = otherOrders.join(',');

    return {
        text: badgeText,
        title: titleText,
        dataAttr: dataAttr
    };
}

// ============================================================================
// 焦点保存 / 恢复
// ============================================================================

function captureRuleTableFocusState() {
    if (typeof document === 'undefined') return null;

    const activeElement = document.activeElement;
    if (!activeElement) return null;
    if (!DOM.customRuleTbody) return null;
    if (!DOM.customRuleTbody.contains(activeElement)) return null;

    const tagName = activeElement.tagName;
    if (tagName !== 'INPUT' && tagName !== 'BUTTON') return null;

    const containingRow = activeElement.closest('tr');
    if (!containingRow) return null;

    const rowRuleId = containingRow.getAttribute('data-rule-id');
    if (rowRuleId === null) return null;

    const containingCell = activeElement.closest('td');
    if (!containingCell) return null;

    const cellIndex = Array.prototype.indexOf.call(
        containingRow.children,
        containingCell
    );
    if (cellIndex < 0) return null;

    if (tagName === 'INPUT') {
        const cellInputs = containingCell.querySelectorAll('input');
        const elementIndexInCell = Array.prototype.indexOf.call(
            cellInputs,
            activeElement
        );

        let selectionStart = null;
        let selectionEnd = null;
        try {
            if (typeof activeElement.selectionStart === 'number') {
                selectionStart = activeElement.selectionStart;
                selectionEnd = activeElement.selectionEnd;
            }
        } catch (selectionError) {
            // 忽略
        }

        return {
            elementType: 'input',
            ruleId: rowRuleId,
            cellIndex: cellIndex,
            elementIndexInCell: elementIndexInCell,
            selectionStart: selectionStart,
            selectionEnd: selectionEnd
        };
    }

    const cellButtons = containingCell.querySelectorAll('button');
    const buttonIndexInCell = Array.prototype.indexOf.call(
        cellButtons,
        activeElement
    );

    return {
        elementType: 'button',
        ruleId: rowRuleId,
        cellIndex: cellIndex,
        elementIndexInCell: buttonIndexInCell,
        selectionStart: null,
        selectionEnd: null
    };
}

function restoreRuleTableFocusState(savedState) {
    if (!savedState) return;
    if (!DOM.customRuleTbody) return;

    const newRow = DOM.customRuleTbody.querySelector(
        'tr[data-rule-id="' + savedState.ruleId + '"]'
    );
    if (!newRow) return;

    if (
        savedState.cellIndex < 0 ||
        savedState.cellIndex >= newRow.children.length
    ) {
        return;
    }

    const newCell = newRow.children[savedState.cellIndex];

    let newElement = null;
    if (savedState.elementType === 'input') {
        const newInputs = newCell.querySelectorAll('input');
        newElement = newInputs[savedState.elementIndexInCell] || newInputs[0];
    } else if (savedState.elementType === 'button') {
        const newButtons = newCell.querySelectorAll('button');
        newElement = newButtons[savedState.elementIndexInCell] || newButtons[0];
    }

    if (!newElement) return;

    try {
        newElement.focus({ preventScroll: true });
    } catch (focusError) {
        try {
            newElement.focus();
        } catch (fallbackError) {
            return;
        }
    }

    if (
        savedState.elementType === 'input' &&
        savedState.selectionStart !== null &&
        typeof newElement.setSelectionRange === 'function'
    ) {
        try {
            newElement.setSelectionRange(
                savedState.selectionStart,
                savedState.selectionEnd
            );
        } catch (selectError) {
            // 忽略
        }
    }
}

// ==================== 规则标准化 ====================

export function normalizeRule(rule) {
    const normalizedRule = safeCopyPlainObject(rule);

    normalizedRule.isRegex = normalizedRule.isRegex !== false;
    normalizedRule.isJS = normalizedRule.isJS === true;
    normalizedRule.enabled = normalizedRule.enabled !== false;
    normalizedRule.runChecked = normalizedRule.runChecked !== false;

    let replacementText = String(normalizedRule.replacement || '');
    if (replacementText.trim().startsWith('@@js:')) {
        normalizedRule.replacement = replacementText.replace(/^@@js:\s*/, '@js:');
        normalizedRule.isJS = false;
    } else if (replacementText.trim().startsWith('@js:')) {
        normalizedRule.isJS = true;
        normalizedRule.replacement = replacementText.replace(/^@js:\s*/, '').trim();
    } else {
        normalizedRule.replacement = replacementText;
    }

    if (!normalizedRule.id) {
        normalizedRule.id = Date.now() +
            Math.floor(Math.random() * CONFIG.ID_COLLISION_RANDOM_RANGE);
    }

    if (!normalizedRule.name) {
        normalizedRule.name = '未命名规则';
    }

    if (typeof normalizedRule.pattern !== 'string') {
        normalizedRule.pattern = '';
    }

    return normalizedRule;
}

function applyPrefixConversionInPlace(rule, newReplacementText) {
    const replacementText = String(newReplacementText || '');
    const trimmedText = replacementText.trim();

    if (trimmedText.startsWith('@@js:')) {
        rule.replacement = replacementText.replace(/^@@js:\s*/, '@js:');
        rule.isJS = false;
        return true;
    }

    if (trimmedText.startsWith('@js:')) {
        // 按规则信任模型下，把 ruleId 传入
        if (
            !rule.isJS &&
            !confirmJSMode('规则"' + (rule.name || '') + '"', rule.id)
        ) {
            return false;
        }
        rule.isJS = true;
        rule.replacement = replacementText.replace(/^@js:\s*/, '').trim();
        return true;
    }

    rule.replacement = replacementText;
    return true;
}

// ============================================================================
// 主表 → 当前工作区预设 同步
// ============================================================================

export function syncMainTableToActivePreset() {
    if (AppState.isSyncingBetweenPresetAndMain) return false;
    if (!AppState.activePresetId) return false;

    if (AppState.activePresetId === CONFIG.MAIN_TABLE_VIRTUAL_ID) {
        AppState.mainTableDirtyForActivePreset = false;
        return false;
    }

    const activePreset = AppState.presets.find(function findPreset(preset) {
        return preset.id === AppState.activePresetId;
    });

    if (!activePreset) {
        AppState.activePresetId = CONFIG.MAIN_TABLE_VIRTUAL_ID;
        AppState.mainTableDirtyForActivePreset = false;
        updateActivePresetIndicator();
        return false;
    }

    AppState.isSyncingBetweenPresetAndMain = true;
    try {
        activePreset.rules = AppState.customRules.map(function mapRule(
            mainRule,
            index
        ) {
            return {
                id: derivePresetRuleIdFromMainId(mainRule.id),
                name: mainRule.name || '未命名规则',
                pattern: typeof mainRule.pattern === 'string'
                    ? mainRule.pattern
                    : '',
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

        invalidateExistenceIndex();
        AppState.mainTableDirtyForActivePreset = false;

        try {
            document.dispatchEvent(
                new CustomEvent('textpro:preset-updated', {
                    detail: { presetId: activePreset.id }
                })
            );
        } catch (dispatchError) {
            // 忽略
        }

        scheduleAutoSave();
        return true;
    } finally {
        AppState.isSyncingBetweenPresetAndMain = false;
    }
}

export function scheduleSyncToActivePreset(immediate) {
    if (!AppState.activePresetId) return;
    if (AppState.activePresetId === CONFIG.MAIN_TABLE_VIRTUAL_ID) return;

    AppState.mainTableDirtyForActivePreset = true;

    if (AppState.presetSyncTimer) {
        clearTimeout(AppState.presetSyncTimer);
        AppState.presetSyncTimer = null;
    }

    if (immediate === true) {
        syncMainTableToActivePreset();
        return;
    }

    AppState.presetSyncTimer = setTimeout(function onSyncTimer() {
        AppState.presetSyncTimer = null;
        syncMainTableToActivePreset();
    }, CONFIG.PRESET_SYNC_DEBOUNCE_MS);
}

export function flushPendingPresetSync() {
    if (AppState.presetSyncTimer) {
        clearTimeout(AppState.presetSyncTimer);
        AppState.presetSyncTimer = null;
    }
    syncMainTableToActivePreset();
}

// ==================== 排序 ====================

export function reorderRules() {
    AppState.customRules.sort(function sortRules(ruleA, ruleB) {
        return ruleA.order - ruleB.order;
    });
    AppState.customRules.forEach(function reindex(rule, ruleIndex) {
        rule.order = ruleIndex + 1;
    });
}

// ============================================================================
// 规则行构建 / 更新（增量渲染）
// ============================================================================

function createRuleRowElement(rule, duplicatesMap) {
    const tableRow = document.createElement('tr');
    tableRow.setAttribute('data-rule-id', String(rule.id));

    // ---------- 运行 checkbox ----------
    const runCheckboxCell = document.createElement('td');
    const runCheckbox = document.createElement('input');
    runCheckbox.type = 'checkbox';
    runCheckbox.checked = rule.runChecked;
    runCheckbox.addEventListener('change', function onRunChange(event) {
        const newRunChecked = event.target.checked;
        if (newRunChecked === rule.runChecked) return;

        rule.runChecked = newRunChecked;
        syncCustomRulesToDefaultRulesIfActive();
        scheduleSyncToActivePreset();
        updateBatchRunButtonLabel();
        scheduleAutoSave();
    });
    runCheckboxCell.appendChild(runCheckbox);
    tableRow.appendChild(runCheckboxCell);

    // ---------- 正则 checkbox ----------
    const regexCheckboxCell = document.createElement('td');
    const regexCheckbox = document.createElement('input');
    regexCheckbox.type = 'checkbox';
    regexCheckbox.checked = rule.isRegex;
    regexCheckbox.addEventListener('change', function onRegexChange(event) {
        const newIsRegex = event.target.checked;
        if (newIsRegex === rule.isRegex) return;

        const oldHash = computeContentHash(rule);
        rule.isRegex = newIsRegex;
        syncCustomRulesToDefaultRulesIfActive();
        scheduleSyncToActivePreset();
        scheduleAutoSave();
        updateExistenceIndexForRule(
            rule,
            CONFIG.MAIN_TABLE_VIRTUAL_ID,
            oldHash
        );
        renderRuleTable();
    });
    regexCheckboxCell.appendChild(regexCheckbox);
    tableRow.appendChild(regexCheckboxCell);

    // ---------- JS 模式 checkbox ----------
    const jsCheckboxCell = document.createElement('td');
    const jsCheckbox = document.createElement('input');
    jsCheckbox.type = 'checkbox';
    jsCheckbox.checked = !!rule.isJS;
    jsCheckbox.addEventListener('change', function onJsChange(event) {
        const newIsJS = event.target.checked;
        if (newIsJS === !!rule.isJS) return;

        // 按规则信任：传入 rule.id
        if (newIsJS && !confirmJSMode('规则"' + rule.name + '"', rule.id)) {
            jsCheckbox.checked = false;
            return;
        }

        const oldHash = computeContentHash(rule);
        rule.isJS = newIsJS;
        syncCustomRulesToDefaultRulesIfActive();
        scheduleSyncToActivePreset();
        scheduleAutoSave();
        updateExistenceIndexForRule(
            rule,
            CONFIG.MAIN_TABLE_VIRTUAL_ID,
            oldHash
        );
        renderRuleTable();
    });
    jsCheckboxCell.appendChild(jsCheckbox);
    tableRow.appendChild(jsCheckboxCell);

    // ---------- 序号 ----------
    const orderCell = document.createElement('td');
    orderCell.textContent = rule.order;
    tableRow.appendChild(orderCell);

    // ---------- 规则名称 ----------
    const nameCell = document.createElement('td');

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = rule.name;
    nameInput.style.width = '96%';
    nameInput.addEventListener('change', function onNameChange(event) {
        const newNameValue = event.target.value;
        if (newNameValue === rule.name) return;

        rule.name = newNameValue;
        syncCustomRulesToDefaultRulesIfActive();
        scheduleSyncToActivePreset();
        scheduleAutoSave();
        renderRuleTable();
    });
    nameCell.appendChild(nameInput);
    tableRow.appendChild(nameCell);

    // ---------- 正则表达式 ----------
    const patternCell = document.createElement('td');
    const patternInput = document.createElement('input');
    patternInput.type = 'text';
    patternInput.value = rule.pattern;
    patternInput.style.width = '96%';
    patternInput.style.fontFamily = 'monospace';
    patternInput.addEventListener('change', function onPatternChange(event) {
        const newPatternValue = event.target.value;
        if (newPatternValue === rule.pattern) return;

        const oldHash = computeContentHash(rule);
        rule.pattern = newPatternValue;
        syncCustomRulesToDefaultRulesIfActive();
        scheduleSyncToActivePreset();
        scheduleAutoSave();
        updateExistenceIndexForRule(
            rule,
            CONFIG.MAIN_TABLE_VIRTUAL_ID,
            oldHash
        );
        renderRuleTable();
    });
    patternCell.appendChild(patternInput);
    tableRow.appendChild(patternCell);

    // ---------- 替换文本 ----------
    const replacementCell = document.createElement('td');
    const replacementInput = document.createElement('input');
    replacementInput.type = 'text';
    replacementInput.value = rule.replacement;
    replacementInput.style.width = '96%';
    replacementInput.addEventListener('change', function onReplaceChange(event) {
        const userInput = event.target.value;
        if (userInput === rule.replacement) return;

        const oldHash = computeContentHash(rule);
        const applied = applyPrefixConversionInPlace(rule, userInput);

        if (applied) {
            event.target.value = rule.replacement;
            jsCheckbox.checked = !!rule.isJS;
            syncCustomRulesToDefaultRulesIfActive();
            scheduleSyncToActivePreset();
            scheduleAutoSave();
            updateExistenceIndexForRule(
                rule,
                CONFIG.MAIN_TABLE_VIRTUAL_ID,
                oldHash
            );
            renderRuleTable();
        } else {
            event.target.value = rule.replacement;
        }
    });
    replacementCell.appendChild(replacementInput);
    tableRow.appendChild(replacementCell);

    // ---------- 操作按钮 ----------
    const actionCell = document.createElement('td');
    actionCell.className = 'action-buttons';

    const moveUpButton = document.createElement('button');
    moveUpButton.textContent = '↑';
    moveUpButton.className = 'icon-btn move-up';
    moveUpButton.onclick = function onMoveUp() {
        moveRuleByOrder(rule.order, -1);
    };

    const moveDownButton = document.createElement('button');
    moveDownButton.textContent = '↓';
    moveDownButton.className = 'icon-btn move-down';
    moveDownButton.onclick = function onMoveDown() {
        moveRuleByOrder(rule.order, 1);
    };

    const moveTopButton = document.createElement('button');
    moveTopButton.textContent = '顶';
    moveTopButton.className = 'icon-btn top-btn';
    moveTopButton.onclick = function onMoveTop() {
        moveRuleToTop(rule.id);
    };

    const moveBottomButton = document.createElement('button');
    moveBottomButton.textContent = '底';
    moveBottomButton.className = 'icon-btn bottom-btn';
    moveBottomButton.onclick = function onMoveBottom() {
        moveRuleToBottom(rule.id);
    };

    const deleteButton = document.createElement('button');
    deleteButton.textContent = '删';
    deleteButton.className = 'icon-btn delete';
    deleteButton.onclick = function onDelete() {
        deleteRuleById(rule.id);
    };

    actionCell.append(
        moveUpButton,
        moveDownButton,
        moveTopButton,
        moveBottomButton,
        deleteButton
    );
    tableRow.appendChild(actionCell);

    // ---------- 重复警告徽章 ----------
    if (duplicatesMap && duplicatesMap.has(rule.id)) {
        const dupInfo = duplicatesMap.get(rule.id);
        const badgeContent = buildDuplicateBadgeContent(dupInfo);

        const warningBadge = document.createElement('span');
        warningBadge.className = 'warning-badge';
        warningBadge.textContent = badgeContent.text;
        warningBadge.title = badgeContent.title;
        nameCell.insertBefore(warningBadge, nameCell.firstChild);

        tableRow.classList.add('has-duplicate-warning');
        tableRow.setAttribute(
            'data-duplicate-orders',
            badgeContent.dataAttr
        );
    }

    tableRow[ROW_ELEMENTS] = {
        runCheckbox: runCheckbox,
        regexCheckbox: regexCheckbox,
        jsCheckbox: jsCheckbox,
        orderCell: orderCell,
        nameCell: nameCell,
        nameInput: nameInput,
        patternInput: patternInput,
        replacementInput: replacementInput
    };

    return tableRow;
}

function updateRuleRowDynamicParts(rowElement, rule, duplicatesMap) {
    const elements = rowElement[ROW_ELEMENTS];
    if (!elements) return;

    const newOrderText = String(rule.order);
    if (elements.orderCell.textContent !== newOrderText) {
        elements.orderCell.textContent = newOrderText;
    }

    const newRunChecked = !!rule.runChecked;
    if (elements.runCheckbox.checked !== newRunChecked) {
        elements.runCheckbox.checked = newRunChecked;
    }

    const newIsRegex = rule.isRegex !== false;
    if (elements.regexCheckbox.checked !== newIsRegex) {
        elements.regexCheckbox.checked = newIsRegex;
    }

    const newIsJS = !!rule.isJS;
    if (elements.jsCheckbox.checked !== newIsJS) {
        elements.jsCheckbox.checked = newIsJS;
    }

    const activeElement = document.activeElement;

    const newNameValue = rule.name || '';
    if (
        elements.nameInput.value !== newNameValue &&
        activeElement !== elements.nameInput
    ) {
        elements.nameInput.value = newNameValue;
    }

    const newPatternValue = rule.pattern || '';
    if (
        elements.patternInput.value !== newPatternValue &&
        activeElement !== elements.patternInput
    ) {
        elements.patternInput.value = newPatternValue;
    }

    const newReplacementValue = rule.replacement || '';
    if (
        elements.replacementInput.value !== newReplacementValue &&
        activeElement !== elements.replacementInput
    ) {
        elements.replacementInput.value = newReplacementValue;
    }

    const existingBadge = elements.nameCell.querySelector('.warning-badge');

    if (duplicatesMap && duplicatesMap.has(rule.id)) {
        const dupInfo = duplicatesMap.get(rule.id);
        const badgeContent = buildDuplicateBadgeContent(dupInfo);

        if (existingBadge) {
            if (existingBadge.textContent !== badgeContent.text) {
                existingBadge.textContent = badgeContent.text;
            }
            if (existingBadge.title !== badgeContent.title) {
                existingBadge.title = badgeContent.title;
            }
        } else {
            const warningBadge = document.createElement('span');
            warningBadge.className = 'warning-badge';
            warningBadge.textContent = badgeContent.text;
            warningBadge.title = badgeContent.title;
            elements.nameCell.insertBefore(
                warningBadge,
                elements.nameCell.firstChild
            );
        }

        if (!rowElement.classList.contains('has-duplicate-warning')) {
            rowElement.classList.add('has-duplicate-warning');
        }
        if (
            rowElement.getAttribute('data-duplicate-orders') !==
            badgeContent.dataAttr
        ) {
            rowElement.setAttribute(
                'data-duplicate-orders',
                badgeContent.dataAttr
            );
        }
    } else {
        if (existingBadge) {
            existingBadge.remove();
        }
        if (rowElement.classList.contains('has-duplicate-warning')) {
            rowElement.classList.remove('has-duplicate-warning');
        }
        if (rowElement.hasAttribute('data-duplicate-orders')) {
            rowElement.removeAttribute('data-duplicate-orders');
        }
    }
}

function buildCurrentRuleOrderKey() {
    const rules = AppState.customRules;
    const parts = [];
    for (let index = 0; index < rules.length; index++) {
        parts.push(String(rules[index].id));
    }
    return parts.join('\u0000');
}

// ==================== 渲染 ====================

function performRuleTableRenderInternal() {
    const tbody = DOM.customRuleTbody;
    if (!tbody) return;

    const savedFocusState = captureRuleTableFocusState();

    reorderRules();

    const duplicatesMap = detectMainTableDuplicates();

    const currentOrderKey = buildCurrentRuleOrderKey();
    const canSkipStructureRebuild = (
        AppState.lastRenderedRuleOrderKey === currentOrderKey &&
        ruleRowCache.size === AppState.customRules.length &&
        tbody.children.length === AppState.customRules.length
    );

    if (canSkipStructureRebuild) {
        let allCacheHit = true;
        for (let index = 0; index < AppState.customRules.length; index++) {
            const rule = AppState.customRules[index];
            const cachedEntry = ruleRowCache.get(rule.id);
            if (!cachedEntry || cachedEntry.rule !== rule) {
                allCacheHit = false;
                break;
            }
        }

        if (allCacheHit) {
            AppState.customRules.forEach(function forEachRule(rule) {
                const cachedEntry = ruleRowCache.get(rule.id);
                if (cachedEntry) {
                    updateRuleRowDynamicParts(
                        cachedEntry.rowElement,
                        rule,
                        duplicatesMap
                    );
                }
            });

            if (AppState.columnWidths && AppState.columnWidths.length > 0) {
                applyColumnWidths(AppState.columnWidths);
            }

            updateBatchRunButtonLabel();
            updateActivePresetIndicator();
            restoreRuleTableFocusState(savedFocusState);

            try {
                document.dispatchEvent(
                    new CustomEvent('textpro:main-table-rendered')
                );
            } catch (dispatchError) {
                // 忽略
            }
            return;
        }
    }

    // ---- 全量重建 ----
    const fragment = document.createDocumentFragment();
    const newCacheEntries = new Map();

    AppState.customRules.forEach(function forEachRule(rule) {
        const cachedEntry = ruleRowCache.get(rule.id);
        let rowElement;

        if (cachedEntry && cachedEntry.rule === rule) {
            rowElement = cachedEntry.rowElement;
            updateRuleRowDynamicParts(rowElement, rule, duplicatesMap);
        } else {
            rowElement = createRuleRowElement(rule, duplicatesMap);
        }

        fragment.appendChild(rowElement);
        newCacheEntries.set(rule.id, {
            rowElement: rowElement,
            rule: rule
        });
    });

    tbody.replaceChildren(fragment);

    ruleRowCache.clear();
    newCacheEntries.forEach(function copyEntry(entry, key) {
        ruleRowCache.set(key, entry);
    });

    AppState.lastRenderedRuleOrderKey = currentOrderKey;

    if (AppState.columnWidths && AppState.columnWidths.length > 0) {
        applyColumnWidths(AppState.columnWidths);
    }

    updateBatchRunButtonLabel();
    updateActivePresetIndicator();

    restoreRuleTableFocusState(savedFocusState);

    try {
        document.dispatchEvent(new CustomEvent('textpro:main-table-rendered'));
    } catch (dispatchError) {
        // 忽略
    }
}

export function renderRuleTable() {
    if (pendingRuleTableRenderHandle !== null) {
        return;
    }

    if (
        typeof window === 'undefined' ||
        typeof window.requestAnimationFrame !== 'function'
    ) {
        performRuleTableRenderInternal();
        return;
    }

    pendingRuleTableRenderHandle = window.requestAnimationFrame(
        function onFrame() {
            pendingRuleTableRenderHandle = null;
            performRuleTableRenderInternal();
        }
    );
}

export function updateBatchRunButtonLabel() {
    if (!DOM.batchRunCheckedButton) return;
    if (AppState.batchRunInProgress) return;

    const totalCount = AppState.customRules.length;
    const checkedCount = AppState.customRules.filter(function filterRule(
        rule
    ) {
        return rule.runChecked === true;
    }).length;

    if (totalCount === 0) {
        DOM.batchRunCheckedButton.textContent = '⚡ 批量运行';
    } else {
        DOM.batchRunCheckedButton.textContent =
            '⚡ 批量运行 (' + checkedCount + '/' + totalCount + ')';
    }
}

export function updateActivePresetIndicator() {
    const indicator = DOM.activePresetIndicator;
    if (!indicator) return;

    const defaultRulesDisplayName = AppState.defaultRulesName || '默认规则';

    if (AppState.activePresetId === CONFIG.MAIN_TABLE_VIRTUAL_ID) {
        indicator.style.display = 'inline-flex';
        const labelElement = indicator.querySelector('.active-preset-label');
        if (labelElement) {
            labelElement.textContent = '当前工作区：' + defaultRulesDisplayName;
        }

        if (DOM.syncToActivePresetButton) {
            DOM.syncToActivePresetButton.style.display = 'none';
        }
        if (DOM.clearActivePresetButton) {
            DOM.clearActivePresetButton.style.display = 'none';
        }
        return;
    }

    if (!AppState.activePresetId) {
        AppState.activePresetId = CONFIG.MAIN_TABLE_VIRTUAL_ID;
        indicator.style.display = 'inline-flex';
        const labelElement = indicator.querySelector('.active-preset-label');
        if (labelElement) {
            labelElement.textContent = '当前工作区：' + defaultRulesDisplayName;
        }
        if (DOM.syncToActivePresetButton) {
            DOM.syncToActivePresetButton.style.display = 'none';
        }
        if (DOM.clearActivePresetButton) {
            DOM.clearActivePresetButton.style.display = 'none';
        }
        return;
    }

    const activePreset = AppState.presets.find(function findPreset(preset) {
        return preset.id === AppState.activePresetId;
    });

    if (!activePreset) {
        AppState.activePresetId = CONFIG.MAIN_TABLE_VIRTUAL_ID;
        indicator.style.display = 'inline-flex';
        const labelElement = indicator.querySelector('.active-preset-label');
        if (labelElement) {
            labelElement.textContent = '当前工作区：' + defaultRulesDisplayName;
        }
        if (DOM.syncToActivePresetButton) {
            DOM.syncToActivePresetButton.style.display = 'none';
        }
        if (DOM.clearActivePresetButton) {
            DOM.clearActivePresetButton.style.display = 'none';
        }
        return;
    }

    indicator.style.display = 'inline-flex';
    const labelElement = indicator.querySelector('.active-preset-label');
    if (labelElement) {
        labelElement.textContent = '当前工作区：' + activePreset.name;
    }

    if (DOM.syncToActivePresetButton) {
        DOM.syncToActivePresetButton.style.display = '';
    }
    if (DOM.clearActivePresetButton) {
        DOM.clearActivePresetButton.style.display = '';
    }
}

// ==================== 增删改 ====================

export function addNewRule() {
    const newRule = {
        id: Date.now() +
            Math.floor(Math.random() * CONFIG.ID_COLLISION_RANDOM_RANGE),
        name: '新规则' + (AppState.customRules.length + 1),
        pattern: '',
        replacement: '',
        enabled: true,
        order: AppState.customRules.length + 1,
        runChecked: true,
        isRegex: true,
        isJS: false
    };

    AppState.customRules.push(newRule);
    reorderRules();
    syncCustomRulesToDefaultRulesIfActive();
    scheduleSyncToActivePreset();
    addRuleToExistenceIndex(newRule, CONFIG.MAIN_TABLE_VIRTUAL_ID);
    renderRuleTable();
    scheduleAutoSave();

    showToast('已添加规则');
}

export function appendRuleToDefaultRulesFromPreset(sourceRule, forceAppend) {
    const normalizedSource = normalizeRule(sourceRule);

    if (forceAppend !== true) {
        const duplicateInfo = findDuplicateRuleInDefaultRules(normalizedSource);

        if (duplicateInfo && duplicateInfo.matchType === 'strict') {
            const duplicateRule = duplicateInfo.rule;
            showToast(
                '⚠️ 默认规则中已存在完全相同的规则（#' +
                duplicateRule.order +
                '「' + (duplicateRule.name || '未命名规则') + '」），已跳过',
                true
            );
            return null;
        }

        if (duplicateInfo && duplicateInfo.matchType === 'substantial') {
            const duplicateRule = duplicateInfo.rule;
            const confirmed = confirm(
                '⚠️ 默认规则中已存在内容相同的规则：\n\n' +
                '· 已存在：# ' + duplicateRule.order +
                '「' + (duplicateRule.name || '未命名规则') + '」\n' +
                '· 待追加：「' + (normalizedSource.name || '未命名规则') +
                '」\n\n' +
                '两者的正则、替换文本、正则/JS 标志完全相同，仅名称不同。\n\n' +
                '仍要追加吗？'
            );
            if (!confirmed) {
                return null;
            }
        }
    }

    const newRule = {
        id: Date.now() +
            Math.floor(Math.random() * CONFIG.ID_COLLISION_RANDOM_RANGE),
        name: normalizedSource.name || '未命名规则',
        pattern: typeof normalizedSource.pattern === 'string'
            ? normalizedSource.pattern
            : '',
        replacement: typeof normalizedSource.replacement === 'string'
            ? normalizedSource.replacement
            : '',
        enabled: normalizedSource.enabled !== false,
        order: AppState.defaultRules.length + 1,
        runChecked: normalizedSource.runChecked !== false,
        isRegex: normalizedSource.isRegex !== false,
        isJS: normalizedSource.isJS === true
    };

    AppState.defaultRules.push(newRule);
    AppState.defaultRules.sort(function sortRules(ruleA, ruleB) {
        return (ruleA.order || 0) - (ruleB.order || 0);
    });
    AppState.defaultRules.forEach(function reindex(rule, index) {
        rule.order = index + 1;
    });

    addRuleToExistenceIndex(newRule, CONFIG.MAIN_TABLE_VIRTUAL_ID);

    if (AppState.activePresetId === CONFIG.MAIN_TABLE_VIRTUAL_ID) {
        syncDefaultRulesToCustomRulesIfActive();
    }

    scheduleAutoSave();

    try {
        document.dispatchEvent(
            new CustomEvent('textpro:rule-appended', {
                detail: {
                    targetId: CONFIG.MAIN_TABLE_VIRTUAL_ID,
                    ruleId: newRule.id,
                    ruleName: newRule.name
                }
            })
        );
    } catch (dispatchError) {
        // 忽略
    }

    return newRule;
}

export function appendRuleToPresetFromRule(
    sourceRule,
    targetPresetId,
    forceAppend
) {
    if (!sourceRule || !targetPresetId) return null;

    const targetPreset = AppState.presets.find(function findPreset(preset) {
        return preset.id === targetPresetId;
    });
    if (!targetPreset) {
        showToast('目标预设不存在', true);
        return null;
    }

    const normalizedSource = normalizeRule(sourceRule);

    if (forceAppend !== true) {
        const duplicateInfo = findDuplicateRuleInPreset(
            normalizedSource,
            targetPreset
        );

        if (duplicateInfo && duplicateInfo.matchType === 'strict') {
            const duplicateRule = duplicateInfo.rule;
            showToast(
                '⚠️ 预设「' + targetPreset.name + '」中已存在完全相同的规则' +
                '（#' + duplicateRule.order +
                '「' + (duplicateRule.name || '未命名规则') + '」），已跳过',
                true
            );
            return null;
        }

        if (duplicateInfo && duplicateInfo.matchType === 'substantial') {
            const duplicateRule = duplicateInfo.rule;
            const confirmed = confirm(
                '⚠️ 预设「' + targetPreset.name +
                '」中已存在内容相同的规则：\n\n' +
                '· 已存在：# ' + duplicateRule.order +
                '「' + (duplicateRule.name || '未命名规则') + '」\n' +
                '· 待追加：「' + (normalizedSource.name || '未命名规则') +
                '」\n\n' +
                '两者的正则、替换文本、正则/JS 标志完全相同，仅名称不同。\n\n' +
                '仍要追加吗？'
            );
            if (!confirmed) {
                return null;
            }
        }
    }

    if (!Array.isArray(targetPreset.rules)) {
        targetPreset.rules = [];
    }

    const newRule = {
        id: 'preset_rule_' + Date.now() + '_' +
            Math.floor(Math.random() * CONFIG.ID_COLLISION_RANDOM_RANGE),
        name: normalizedSource.name || '未命名规则',
        pattern: typeof normalizedSource.pattern === 'string'
            ? normalizedSource.pattern
            : '',
        replacement: typeof normalizedSource.replacement === 'string'
            ? normalizedSource.replacement
            : '',
        enabled: normalizedSource.enabled !== false,
        order: targetPreset.rules.length + 1,
        runChecked: normalizedSource.runChecked !== false,
        isRegex: normalizedSource.isRegex !== false,
        isJS: normalizedSource.isJS === true
    };

    targetPreset.rules.push(newRule);
    targetPreset.rules.forEach(function reindex(rule, index) {
        rule.order = index + 1;
    });
    targetPreset.updatedAt = Date.now();

    addRuleToExistenceIndex(newRule, targetPreset.id);

    if (targetPresetId === AppState.activePresetId) {
        AppState.customRules.push({
            id: newRule.id,
            name: newRule.name,
            pattern: newRule.pattern,
            replacement: newRule.replacement,
            enabled: newRule.enabled,
            order: AppState.customRules.length + 1,
            runChecked: newRule.runChecked,
            isRegex: newRule.isRegex,
            isJS: newRule.isJS
        });
        AppState.customRules.forEach(function reindex(rule, index) {
            rule.order = index + 1;
        });
        renderRuleTable();
    }

    scheduleAutoSave();

    try {
        document.dispatchEvent(
            new CustomEvent('textpro:preset-updated', {
                detail: { presetId: targetPreset.id }
            })
        );
    } catch (dispatchError) {
        // 忽略
    }

    try {
        document.dispatchEvent(
            new CustomEvent('textpro:rule-appended', {
                detail: {
                    targetId: targetPreset.id,
                    ruleId: newRule.id,
                    ruleName: newRule.name
                }
            })
        );
    } catch (dispatchError) {
        // 忽略
    }

    return newRule;
}

export function appendRuleToTarget(sourceRule, targetId, forceAppend) {
    if (isMainTableVirtualId(targetId)) {
        return appendRuleToDefaultRulesFromPreset(sourceRule, forceAppend);
    }
    return appendRuleToPresetFromRule(sourceRule, targetId, forceAppend);
}

/**
 * ★ 改进：用给定规则集整体替换主表，并保证新主表内 id 唯一。
 *
 * 冲突解决：
 *   · 收集已用 id 集合
 *   · 每条规则优先保留源 id；若冲突则生成新 id
 */
export function replaceMainTableWithRules(newRules, options) {
    const opts = options || {};
    const skipDefaultRulesSync = opts.skipDefaultRulesSync === true;

    const usedIdSet = new Set();

    const preparedRules = (newRules || []).map(function mapRule(
        sourceRule,
        index
    ) {
        const normalized = normalizeRule(sourceRule);

        let ruleId;
        if (
            sourceRule &&
            sourceRule.id !== undefined &&
            sourceRule.id !== null
        ) {
            const sourceIdString = String(sourceRule.id);
            if (!usedIdSet.has(sourceIdString)) {
                ruleId = sourceRule.id;
                usedIdSet.add(sourceIdString);
            }
        }

        if (ruleId === undefined) {
            // 冲突或缺失 → 派生新 id
            ruleId = 'main_rule_' + Date.now() + '_' + index + '_' +
                Math.floor(Math.random() * CONFIG.ID_COLLISION_RANDOM_RANGE);
            usedIdSet.add(String(ruleId));
        }

        const newRuleObject = {
            id: ruleId,
            name: normalized.name || '未命名规则',
            pattern: typeof normalized.pattern === 'string'
                ? normalized.pattern
                : '',
            replacement: typeof normalized.replacement === 'string'
                ? normalized.replacement
                : '',
            enabled: normalized.enabled !== false,
            order: index + 1,
            runChecked: normalized.runChecked !== false,
            isRegex: normalized.isRegex !== false,
            isJS: normalized.isJS === true
        };

        applyRulePrefixConversionInPlace(newRuleObject);

        return newRuleObject;
    });

    AppState.customRules = preparedRules;
    reorderRules();

    if (!skipDefaultRulesSync) {
        syncCustomRulesToDefaultRulesIfActive();
    }

    // 结构完全变化 → 全量重建索引
    invalidateExistenceIndex();

    AppState.lastRenderedRuleOrderKey = '';
    AppState.duplicateDetectionCacheKey = '';
    AppState.duplicateDetectionCacheResult = null;

    renderRuleTable();
    scheduleAutoSave();

    return preparedRules.length;
}

export function deleteRuleById(ruleId) {
    const removedIndex = AppState.customRules.findIndex(function findRule(rule) {
        return String(rule.id) === String(ruleId);
    });
    if (removedIndex === -1) return;

    const removedRule = AppState.customRules[removedIndex];
    const remainingCount = AppState.customRules.length - 1;

    if (remainingCount >= CONFIG.DELETE_RULE_CONFIRM_THRESHOLD) {
        const confirmed = confirm(
            '确定删除规则「' + (removedRule.name || '未命名规则') +
            '」吗？\n\n' +
            '· 当前有 ' + AppState.customRules.length + ' 条规则'
        );
        if (!confirmed) return;
    }

    AppState.customRules.splice(removedIndex, 1);
    reorderRules();
    syncCustomRulesToDefaultRulesIfActive();
    scheduleSyncToActivePreset();
    removeRuleFromExistenceIndex(removedRule, CONFIG.MAIN_TABLE_VIRTUAL_ID);
    renderRuleTable();
    scheduleAutoSave();

    showToast('已删除规则：' + removedRule.name);
}

export function moveRuleByOrder(currentOrder, delta) {
    const currentIndex = AppState.customRules.findIndex(function findRule(rule) {
        return rule.order === currentOrder;
    });
    if (currentIndex === -1) return;

    const targetIndex = currentIndex + delta;
    if (targetIndex < 0 || targetIndex >= AppState.customRules.length) return;

    const currentRuleOrder = AppState.customRules[currentIndex].order;
    const targetRuleOrder = AppState.customRules[targetIndex].order;
    AppState.customRules[currentIndex].order = targetRuleOrder;
    AppState.customRules[targetIndex].order = currentRuleOrder;

    reorderRules();
    syncCustomRulesToDefaultRulesIfActive();
    scheduleSyncToActivePreset();
    renderRuleTable();
    scheduleAutoSave();

    showToast('顺序已调整');
}

export function moveRuleToTop(ruleId) {
    const currentIndex = AppState.customRules.findIndex(function findRule(rule) {
        return String(rule.id) === String(ruleId);
    });
    if (currentIndex <= 0) return;

    const removedRule = AppState.customRules.splice(currentIndex, 1)[0];
    AppState.customRules.unshift(removedRule);

    reorderRules();
    syncCustomRulesToDefaultRulesIfActive();
    scheduleSyncToActivePreset();
    renderRuleTable();
    scheduleAutoSave();

    showToast('已置顶');
}

export function moveRuleToBottom(ruleId) {
    const currentIndex = AppState.customRules.findIndex(function findRule(rule) {
        return String(rule.id) === String(ruleId);
    });
    if (
        currentIndex === -1 ||
        currentIndex === AppState.customRules.length - 1
    ) {
        return;
    }

    const removedRule = AppState.customRules.splice(currentIndex, 1)[0];
    AppState.customRules.push(removedRule);

    reorderRules();
    syncCustomRulesToDefaultRulesIfActive();
    scheduleSyncToActivePreset();
    renderRuleTable();
    scheduleAutoSave();

    showToast('已置底');
}

export function resetToDefaultRules() {
    const defaultRuleCount = defaultCustomRules.length;

    let confirmMessage;
    if (defaultRuleCount === 0) {
        confirmMessage =
            '重置为出厂状态（清空所有规则）？\n\n' +
            '当前所有自定义规则（' + AppState.customRules.length +
            ' 条）将被清空。\n' +
            '（说明：当前版本起出厂状态不含任何默认规则）';
    } else {
        confirmMessage =
            '重置为默认规则集？\n\n' +
            '当前所有自定义规则（' + AppState.customRules.length + ' 条）' +
            '将被覆盖为 ' + defaultRuleCount + ' 条默认规则。';
    }

    if (!confirm(confirmMessage)) {
        return;
    }

    AppState.customRules = JSON.parse(JSON.stringify(defaultCustomRules));
    reorderRules();
    syncCustomRulesToDefaultRulesIfActive();
    scheduleSyncToActivePreset(true);
    invalidateExistenceIndex();

    AppState.lastRenderedRuleOrderKey = '';
    AppState.duplicateDetectionCacheKey = '';
    AppState.duplicateDetectionCacheResult = null;

    renderRuleTable();
    scheduleAutoSave();

    const resetMessage = defaultRuleCount === 0
        ? '已清空规则表（出厂状态不含默认规则）'
        : '已重置为默认规则集';
    showToast(resetMessage);
}

export function selectAllRunChecks(checked) {
    AppState.customRules.forEach(function forEachRule(rule) {
        rule.runChecked = checked;
    });
    renderRuleTable();
    syncCustomRulesToDefaultRulesIfActive();
    scheduleSyncToActivePreset();
    scheduleAutoSave();
    showToast(checked ? '已全选' : '已全不选');
}

// ==================== 批量运行错误汇总条 ====================

function showBatchRunErrorBar(errors) {
    if (!DOM.batchRunErrorBar || !DOM.batchRunErrorList) return;

    DOM.batchRunErrorList.innerHTML = '';

    errors.forEach(function forEachError(errorItem) {
        const itemElement = document.createElement('div');
        itemElement.className = 'batch-run-error-item';
        itemElement.style.cssText =
            'display: flex; align-items: center; gap: 8px; ' +
            'padding: 4px 0; font-size: 0.8rem; color: var(--text-secondary);';

        const nameSpan = document.createElement('span');
        nameSpan.style.cssText =
            'font-weight:600; color: var(--text-primary); flex-shrink:0;';
        nameSpan.textContent = errorItem.ruleName + ':';
        itemElement.appendChild(nameSpan);

        const messageSpan = document.createElement('span');
        messageSpan.style.cssText =
            'flex:1; min-width:0; word-break:break-word;';
        messageSpan.textContent = errorItem.errorMessage;
        itemElement.appendChild(messageSpan);

        const locateButton = document.createElement('button');
        locateButton.type = 'button';
        locateButton.className = 'icon-btn';
        locateButton.textContent = '定位';
        locateButton.style.cssText =
            'flex-shrink:0; font-size:11px; min-height:26px;';
        locateButton.onclick = function onLocate() {
            locateRuleInTable(errorItem.ruleId);
        };
        itemElement.appendChild(locateButton);

        DOM.batchRunErrorList.appendChild(itemElement);
    });

    DOM.batchRunErrorBar.style.display = 'block';

    if (DOM.batchRunErrorList) {
        DOM.batchRunErrorList.style.display = 'block';
    }
    if (DOM.batchRunErrorToggle) {
        DOM.batchRunErrorToggle.textContent = '▲ 收起';
    }
}

function hideBatchRunErrorBar() {
    if (!DOM.batchRunErrorBar) return;
    DOM.batchRunErrorBar.style.display = 'none';
    if (DOM.batchRunErrorList) {
        DOM.batchRunErrorList.innerHTML = '';
    }
}

function locateRuleInTable(ruleId) {
    if (!DOM.customRuleTbody) return;
    const row = DOM.customRuleTbody.querySelector(
        '[data-rule-id="' + ruleId + '"]'
    );
    if (!row) {
        showToast('未找到该规则（可能已被删除）', true);
        return;
    }
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row.classList.add('flash-highlight');

    const firstFocusable = row.querySelector(
        'input[type="checkbox"], button'
    );
    if (firstFocusable && typeof firstFocusable.focus === 'function') {
        try {
            firstFocusable.focus({ preventScroll: true });
        } catch (focusError) {
            firstFocusable.focus();
        }
    }

    setTimeout(function removeFlash() {
        row.classList.remove('flash-highlight');
    }, 800);
}

// ==================== 批量运行进度条 ====================

function showBatchRunProgressBar() {
    if (DOM.batchRunProgressBar) {
        DOM.batchRunProgressBar.style.display = 'flex';
    }
}

function hideBatchRunProgressBar() {
    if (DOM.batchRunProgressBar) {
        DOM.batchRunProgressBar.style.display = 'none';
    }
    if (DOM.batchRunProgressFill) {
        DOM.batchRunProgressFill.style.width = '0%';
    }
}

function updateBatchRunProgress(current, total, ruleName) {
    if (DOM.batchRunProgressText) {
        DOM.batchRunProgressText.textContent =
            '正在运行 ' + current + '/' + total + ' · ' + (ruleName || '');
    }
    if (DOM.batchRunProgressPercent) {
        const percent = total > 0 ? Math.round((current / total) * 100) : 0;
        DOM.batchRunProgressPercent.textContent = percent + '%';
    }
    if (DOM.batchRunProgressFill) {
        const percent = total > 0 ? (current / total) * 100 : 0;
        DOM.batchRunProgressFill.style.width = percent + '%';
    }
}

// ==================== 批量运行 ====================

export async function batchRunCheckedRules() {
    if (AppState.batchRunInProgress) {
        showToast('批量运行已在执行中', true);
        return;
    }

    const sourceText = getSourceText();
    if (!sourceText.trim()) {
        showToast('源文本为空', true);
        return;
    }
    if (!checkTextSize(sourceText, '批量运行')) {
        return;
    }

    const rulesToRun = AppState.customRules
        .filter(function filterRule(rule) {
            return rule.runChecked;
        })
        .sort(function sortRules(ruleA, ruleB) {
            return ruleA.order - ruleB.order;
        });

    if (rulesToRun.length === 0) {
        showToast('没有勾选任何规则', true);
        return;
    }

    AppState.batchRunInProgress = true;
    if (DOM.batchRunCheckedButton) {
        DOM.batchRunCheckedButton.disabled = true;
    }

    hideBatchRunErrorBar();
    showBatchRunProgressBar();
    updateBatchRunProgress(0, rulesToRun.length, '准备中...');

    const flags =
        (AppState.flagG ? 'g' : '') +
        (AppState.flagI ? 'i' : '') +
        (AppState.flagM ? 'm' : '');

    const globalLoop = AppState.loopUntilStable;

    try {
        const replaceResult = await performBatchReplaceAsync(
            sourceText,
            rulesToRun,
            flags,
            globalLoop,
            function onProgress(current, total, ruleName) {
                updateBatchRunProgress(current, total, ruleName);
            }
        );

        if (replaceResult.cancelled) {
            showToast('批量运行已取消');
            return;
        }

        setResultText(replaceResult.newText);

        if (replaceResult.errors.length > 0) {
            showBatchRunErrorBar(replaceResult.errors);
            showToast(
                '批量完成，' + replaceResult.errors.length +
                ' 条规则出错（详见错误条）',
                true
            );
        } else {
            showToast('批量完成，共应用 ' + rulesToRun.length + ' 条规则');
        }
    } catch (batchError) {
        if (batchError && batchError.cancelled) {
            showToast('批量运行已取消');
        } else {
            console.error('批量运行异常:', batchError);
            showToast(
                '批量运行异常: ' + (batchError.message || '未知错误'),
                true
            );
        }
    } finally {
        AppState.batchRunInProgress = false;
        if (DOM.batchRunCheckedButton) {
            DOM.batchRunCheckedButton.disabled = false;
        }
        hideBatchRunProgressBar();
        updateBatchRunButtonLabel();
    }
}

export function cancelBatchRun() {
    if (!AppState.batchRunInProgress) return;
    cancelCurrentWorkerTask();
}

// ==================== 列宽管理 ====================

export function applyColumnWidths(widths) {
    if (!widths || widths.length === 0) return;
    if (!DOM.customRuleTable) return;

    const widthSignature = widths.join(',');
    if (AppState.lastAppliedColumnWidthsSignature === widthSignature) {
        return;
    }

    const headerCells = DOM.customRuleTable.querySelectorAll('th');
    if (headerCells.length !== widths.length) return;

    for (
        let columnIndex = 0;
        columnIndex < headerCells.length;
        columnIndex++
    ) {
        headerCells[columnIndex].style.width = widths[columnIndex] + 'px';
        headerCells[columnIndex].style.minWidth =
            CONFIG.TABLE_COLUMN_MIN_WIDTH_PX + 'px';
    }

    AppState.lastAppliedColumnWidthsSignature = widthSignature;
}

export function initializeRuleTableColumns() {
    if (!DOM.customRuleTable) return;

    const headerCells = DOM.customRuleTable.querySelectorAll('th');
    if (headerCells.length === 0) return;

    headerCells.forEach(function removeOldResizer(headerCell) {
        const existingResizer = headerCell.querySelector('.resizer');
        if (existingResizer) {
            existingResizer.remove();
        }
    });

    headerCells.forEach(function attachResizer(headerCell) {
        const resizerElement = document.createElement('div');
        resizerElement.className = 'resizer';
        headerCell.style.position = 'relative';
        headerCell.appendChild(resizerElement);

        let dragStartX = 0;
        let dragStartWidth = 0;
        let isDragging = false;
        let latestPointerX = 0;
        let pendingAnimationFrameId = null;

        function applyWidthFromLatestPointer() {
            pendingAnimationFrameId = null;
            const deltaX = latestPointerX - dragStartX;
            let newWidth = dragStartWidth + deltaX;
            if (newWidth < CONFIG.TABLE_COLUMN_MIN_WIDTH_PX) {
                newWidth = CONFIG.TABLE_COLUMN_MIN_WIDTH_PX;
            }
            headerCell.style.width = newWidth + 'px';
            if (DOM.customRuleTable) {
                DOM.customRuleTable.style.width = '100%';
            }
            AppState.lastAppliedColumnWidthsSignature = '';
        }

        function requestWidthUpdate(clientX) {
            latestPointerX = clientX;
            if (pendingAnimationFrameId === null) {
                pendingAnimationFrameId = window.requestAnimationFrame(
                    applyWidthFromLatestPointer
                );
            }
        }

        function cancelPendingWidthUpdate() {
            if (pendingAnimationFrameId !== null) {
                window.cancelAnimationFrame(pendingAnimationFrameId);
                pendingAnimationFrameId = null;
            }
        }

        function onMouseMove(moveEvent) {
            if (!isDragging) return;
            requestWidthUpdate(moveEvent.clientX);
        }

        function onTouchMove(touchEvent) {
            if (!isDragging) return;
            touchEvent.preventDefault();
            const touch = touchEvent.touches[0];
            if (!touch) return;
            requestWidthUpdate(touch.clientX);
        }

        function onDragEnd() {
            if (!isDragging) return;

            if (pendingAnimationFrameId !== null) {
                cancelPendingWidthUpdate();
                applyWidthFromLatestPointer();
            }

            isDragging = false;
            document.body.style.userSelect = '';
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onDragEnd);
            document.removeEventListener('touchmove', onTouchMove);
            document.removeEventListener('touchend', onDragEnd);
            window.removeEventListener('blur', onDragEnd);
            document.removeEventListener('visibilitychange', onVisibilityChange);
            saveColumnWidths();
        }

        function onVisibilityChange() {
            if (document.visibilityState === 'hidden') {
                onDragEnd();
            }
        }

        function onDragStart(startEvent) {
            startEvent.preventDefault();
            const clientX = startEvent.touches
                ? startEvent.touches[0].clientX
                : startEvent.clientX;
            dragStartX = clientX;
            latestPointerX = clientX;
            dragStartWidth = headerCell.offsetWidth;
            isDragging = true;
            document.body.style.userSelect = 'none';
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onDragEnd);
            document.addEventListener(
                'touchmove',
                onTouchMove,
                { passive: false }
            );
            document.addEventListener('touchend', onDragEnd);
            window.addEventListener('blur', onDragEnd);
            document.addEventListener('visibilitychange', onVisibilityChange);
        }

        resizerElement.addEventListener('mousedown', onDragStart);
        resizerElement.addEventListener(
            'touchstart',
            onDragStart,
            { passive: false }
        );
    });
}

function saveColumnWidths() {
    if (!DOM.customRuleTable) return;

    const headerCells = DOM.customRuleTable.querySelectorAll('th');
    if (!headerCells.length) return;

    const widths = [];
    headerCells.forEach(function collectWidth(headerCell) {
        widths.push(headerCell.offsetWidth);
    });

    AppState.columnWidths = widths;
    AppState.lastAppliedColumnWidthsSignature = widths.join(',');
    scheduleAutoSave();
}

// ==================== 批量运行错误条初始化 ====================

export function initializeBatchRunErrorBar() {
    if (isBatchRunErrorBarInitialized) return;
    isBatchRunErrorBarInitialized = true;

    if (DOM.batchRunErrorToggle) {
        DOM.batchRunErrorToggle.addEventListener('click', function onToggle() {
            if (!DOM.batchRunErrorList) return;
            const isCurrentlyVisible =
                DOM.batchRunErrorList.style.display !== 'none';
            if (isCurrentlyVisible) {
                DOM.batchRunErrorList.style.display = 'none';
                DOM.batchRunErrorToggle.textContent = '▼ 展开';
            } else {
                DOM.batchRunErrorList.style.display = 'block';
                DOM.batchRunErrorToggle.textContent = '▲ 收起';
            }
        });
    }

    if (DOM.batchRunErrorCopy) {
        DOM.batchRunErrorCopy.addEventListener('click', function onCopy() {
            if (!DOM.batchRunErrorList) return;
            const textToCopy = DOM.batchRunErrorList.textContent || '';
            if (!textToCopy.trim()) return;
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(textToCopy).then(
                    function onCopied() {
                        showToast('错误信息已复制');
                    }
                ).catch(function onCopyError() {
                    showToast('复制失败', true);
                });
            } else {
                showToast('当前浏览器不支持一键复制', true);
            }
        });
    }
}