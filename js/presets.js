// filename: js/presets.js
/**
 * ============================================================================
 * presets.js — 命名预设管理 + 默认规则虚拟条目 + 追加目标选择
 *            + 悬停提示浮层 + 二维搜索模型 + 增量渲染 + 存在性行缓存
 * ============================================================================
 *
 * 【本次修订说明 — 修复第一行非法字符】
 *   · 第一行 `# filename:` 改为 `// filename:`。
 *   · 其余逻辑与上一版一致。
 * ============================================================================
 */

import { CONFIG, SEARCH_DATA_SOURCE } from './config.js';
import { AppState } from './state.js';
import { DOM } from './dom.js';
import { showToast } from './toast.js';
import { confirmJSMode } from './security.js';
import { scheduleAutoSave, saveStateImmediately } from './persistence.js';
import {
    renderRuleTable,
    appendRuleToTarget,
    replaceMainTableWithRules,
    updateActivePresetIndicator,
    areRuleListsEquivalent,
    flushPendingPresetSync,
    isMainTableVirtualId,
    getMainTableAsVirtualPreset,
    findDuplicateRuleInDefaultRules,
    findDuplicateRuleInPreset,
    getRuleLocations,
    getPresetOverlapCount,
    invalidateExistenceIndex,
    normalizeRule,
    syncDefaultRulesToCustomRulesIfActive,
    derivePresetRuleIdFromMainId,
    computeContentHash,
    updateExistenceIndexForRule,
    removeRuleFromExistenceIndex,
    addRuleToExistenceIndex
} from './rules.js';

const PRESET_NAME_MAX_LENGTH = CONFIG.PRESET_NAME_MAX_LENGTH;

const EXPAND_ICON_ENTER = '⛶';
const EXPAND_ICON_EXIT = '⊟';

const APPEND_ATTEMPT_DEBOUNCE_MS = CONFIG.APPEND_ATTEMPT_DEBOUNCE_MS;

const HELP_TOOLTIP_OUTSIDE_CLICK_GRACE_MS = 100;

let selectedPresetId = null;
let searchQuery = '';
let modalIsOpen = false;
let searchDebounceTimer = null;
let isPresetManagerInitialized = false;
let isExpandedMode = false;
let isEventListenerInitialized = false;
let isAppendModalInitialized = false;

let isHelpTooltipInitialized = false;
let helpTooltipShowTimer = null;
let helpTooltipHideTimer = null;
let helpTooltipOutsideClickHandler = null;
let helpTooltipRepositionThrottleTimer = null;
let helpTooltipMountedAt = 0;

let presetRuleIdCounter = 0;

const presetListItemCache = new Map();

const presetRuleCardCache = new Map();

const PRESET_RULE_CARD_ELEMENTS = Symbol('presetRuleCardElements');

// ============================================================================
// 通用工具
// ============================================================================

function generatePresetId() {
    return 'preset_' + Date.now() + '_' +
        Math.floor(Math.random() * CONFIG.ID_COLLISION_RANDOM_RANGE);
}

function generatePresetRuleId() {
    presetRuleIdCounter++;
    return 'preset_rule_' + Date.now() + '_' + presetRuleIdCounter;
}

function findPresetItemElementById(container, presetId) {
    if (!container || presetId === undefined || presetId === null) {
        return null;
    }
    const targetIdString = String(presetId);
    const items = container.querySelectorAll('[data-preset-id]');
    for (let index = 0; index < items.length; index++) {
        if (items[index].getAttribute('data-preset-id') === targetIdString) {
            return items[index];
        }
    }
    return null;
}

function formatRelativeTime(timestamp) {
    if (!timestamp || typeof timestamp !== 'number') {
        return '';
    }

    const now = Date.now();
    const diff = now - timestamp;

    if (diff < 0) return '刚刚';
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 24 * 60 * 60 * 1000) {
        return Math.floor(diff / 3600000) + ' 小时前';
    }
    if (diff < 30 * 24 * 60 * 60 * 1000) {
        return Math.floor(diff / 86400000) + ' 天前';
    }

    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return year + '-' + month + '-' + day;
}

function getDefaultRulesDisplayName() {
    return AppState.defaultRulesName || '默认规则';
}

function getSelectedPreset() {
    if (!selectedPresetId) return null;

    if (isMainTableVirtualId(selectedPresetId)) {
        return getMainTableAsVirtualPreset();
    }

    for (let index = 0; index < AppState.presets.length; index++) {
        if (AppState.presets[index].id === selectedPresetId) {
            return AppState.presets[index];
        }
    }
    return null;
}

function getActivePreset() {
    if (!AppState.activePresetId) return null;
    if (AppState.activePresetId === CONFIG.MAIN_TABLE_VIRTUAL_ID) return null;
    for (let index = 0; index < AppState.presets.length; index++) {
        if (AppState.presets[index].id === AppState.activePresetId) {
            return AppState.presets[index];
        }
    }
    return null;
}

function extractMainRuleIdFromPresetRuleId(presetRuleId) {
    if (presetRuleId === undefined || presetRuleId === null) {
        return null;
    }
    const idString = String(presetRuleId);
    if (idString.indexOf('preset_rule_') === 0) {
        return idString.substring('preset_rule_'.length);
    }
    return idString;
}

function touchSelectedPreset() {
    const preset = getSelectedPreset();
    if (!preset) return;
    if (preset.isVirtual) return;
    preset.updatedAt = Date.now();

    clearPresetFilterCache();

    scheduleAutoSave();
    updatePresetListItemMeta(preset.id);
}

function updatePresetListItemMeta(presetId) {
    const container = DOM.presetListContainer;
    if (!container) return;

    const itemElement = findPresetItemElementById(container, presetId);
    if (!itemElement) return;

    const cachedEntry = presetListItemCache.get(presetId);
    let preset = null;

    if (cachedEntry && cachedEntry.preset) {
        preset = cachedEntry.preset;
    } else {
        for (let index = 0; index < AppState.presets.length; index++) {
            if (AppState.presets[index].id === presetId) {
                preset = AppState.presets[index];
                break;
            }
        }
    }

    if (!preset) return;

    const metaElement = itemElement.querySelector('.preset-item-meta');
    if (!metaElement) return;

    const ruleCount = Array.isArray(preset.rules) ? preset.rules.length : 0;
    const newMetaText =
        ruleCount + ' 条规则 · ' + formatRelativeTime(preset.updatedAt);

    if (metaElement.textContent === newMetaText) {
        return;
    }
    metaElement.textContent = newMetaText;
}

function updateMainTableVirtualItemMeta() {
    const container = DOM.presetListContainer;
    if (!container) return;

    const itemElement = findPresetItemElementById(
        container,
        CONFIG.MAIN_TABLE_VIRTUAL_ID
    );
    if (!itemElement) return;

    const metaElement = itemElement.querySelector('.preset-item-meta');
    if (!metaElement) return;

    const ruleCount = AppState.defaultRules.length;
    const newMetaText = ruleCount + ' 条规则 · ' + getDefaultRulesDisplayName();

    if (metaElement.textContent === newMetaText) {
        return;
    }
    metaElement.textContent = newMetaText;
}

function focusNextPresetItemFromCurrent(currentElement, direction) {
    const container = DOM.presetListContainer;
    if (!container) return;

    const items = container.querySelectorAll('.preset-list-item');
    if (items.length === 0) return;

    let currentIndex = Array.prototype.indexOf.call(items, currentElement);
    if (currentIndex === -1) {
        currentIndex = 0;
    }

    let nextIndex = currentIndex + direction;
    if (nextIndex < 0) {
        nextIndex = items.length - 1;
    } else if (nextIndex >= items.length) {
        nextIndex = 0;
    }

    const nextItem = items[nextIndex];
    if (nextItem && typeof nextItem.focus === 'function') {
        nextItem.focus();
        if (typeof nextItem.scrollIntoView === 'function') {
            nextItem.scrollIntoView({ block: 'nearest' });
        }
    }
}

function toggleExpandedMode() {
    if (!DOM.presetManagerModal) return;

    isExpandedMode = !isExpandedMode;

    if (isExpandedMode) {
        DOM.presetManagerModal.classList.add('fullscreen');
    } else {
        DOM.presetManagerModal.classList.remove('fullscreen');
    }

    updateExpandButtonUI();
    if (AppState.presetHelpTooltipOpen) {
        positionHelpTooltip();
    }
}

function updateExpandButtonUI() {
    if (!DOM.presetModalFullscreenButton) return;

    if (isExpandedMode) {
        DOM.presetModalFullscreenButton.textContent = EXPAND_ICON_EXIT;
        DOM.presetModalFullscreenButton.title = '恢复大小';
        DOM.presetModalFullscreenButton.setAttribute('aria-label', '恢复大小');
    } else {
        DOM.presetModalFullscreenButton.textContent = EXPAND_ICON_ENTER;
        DOM.presetModalFullscreenButton.title = '放大显示';
        DOM.presetModalFullscreenButton.setAttribute('aria-label', '放大显示');
    }
}

function resetExpandedMode() {
    if (!isExpandedMode) return;
    isExpandedMode = false;
    if (DOM.presetManagerModal) {
        DOM.presetManagerModal.classList.remove('fullscreen');
    }
    updateExpandButtonUI();
}

// ============================================================================
// 未保存修改检查（导出供 ui.js 使用）
// ============================================================================

export function checkMainTableHasUnsavedChanges() {
    const activePresetId = AppState.activePresetId;

    if (activePresetId === CONFIG.MAIN_TABLE_VIRTUAL_ID || !activePresetId) {
        return !areRuleListsEquivalent(
            AppState.customRules,
            AppState.defaultRules
        );
    }

    const activePreset = AppState.presets.find(function findPreset(preset) {
        return preset.id === activePresetId;
    });

    if (!activePreset) {
        return true;
    }

    return !areRuleListsEquivalent(
        AppState.customRules,
        activePreset.rules || []
    );
}

// ============================================================================
// 活动预设编辑同步到 customRules
// ============================================================================

function syncPresetRuleEditToCustomRules(preset, editedRule) {
    if (!preset || preset.isVirtual) return;
    if (preset.id !== AppState.activePresetId) return;
    if (!editedRule) return;

    const extractedMainId = extractMainRuleIdFromPresetRuleId(editedRule.id);

    let mainRuleIndex = -1;
    for (let index = 0; index < AppState.customRules.length; index++) {
        const mainRule = AppState.customRules[index];
        const mainIdString = String(mainRule.id);
        const presetIdString = String(editedRule.id);

        if (
            mainIdString === String(extractedMainId) ||
            mainIdString === presetIdString
        ) {
            mainRuleIndex = index;
            break;
        }
    }

    if (mainRuleIndex === -1) {
        const newMainRule = {
            id: editedRule.id,
            name: editedRule.name || '未命名规则',
            pattern: typeof editedRule.pattern === 'string'
                ? editedRule.pattern
                : '',
            replacement: typeof editedRule.replacement === 'string'
                ? editedRule.replacement
                : '',
            enabled: editedRule.enabled !== false,
            order: AppState.customRules.length + 1,
            runChecked: editedRule.runChecked !== false,
            isRegex: editedRule.isRegex !== false,
            isJS: editedRule.isJS === true
        };
        AppState.customRules.push(newMainRule);
        AppState.customRules.forEach(function reindex(rule, index) {
            rule.order = index + 1;
        });
        renderRuleTable();
        return;
    }

    const mainRule = AppState.customRules[mainRuleIndex];
    mainRule.name = editedRule.name || '未命名规则';
    mainRule.pattern = typeof editedRule.pattern === 'string'
        ? editedRule.pattern
        : '';
    mainRule.replacement = typeof editedRule.replacement === 'string'
        ? editedRule.replacement
        : '';
    mainRule.enabled = editedRule.enabled !== false;
    mainRule.order = editedRule.order;
    mainRule.runChecked = editedRule.runChecked !== false;
    mainRule.isRegex = editedRule.isRegex !== false;
    mainRule.isJS = editedRule.isJS === true;

    renderRuleTable();
}

function syncPresetRuleDeleteToCustomRules(preset, deletedRule) {
    if (!preset || preset.isVirtual) return;
    if (preset.id !== AppState.activePresetId) return;
    if (!deletedRule) return;

    const extractedMainId = extractMainRuleIdFromPresetRuleId(deletedRule.id);

    const removedIndex = AppState.customRules.findIndex(function findRule(
        mainRule
    ) {
        const mainIdString = String(mainRule.id);
        const presetIdString = String(deletedRule.id);
        return (
            mainIdString === String(extractedMainId) ||
            mainIdString === presetIdString
        );
    });

    if (removedIndex === -1) return;

    AppState.customRules.splice(removedIndex, 1);
    AppState.customRules.forEach(function reindex(rule, index) {
        rule.order = index + 1;
    });
    renderRuleTable();
}

function syncPresetRuleAddToCustomRules(preset, addedRule) {
    if (!preset || preset.isVirtual) return;
    if (preset.id !== AppState.activePresetId) return;
    if (!addedRule) return;

    AppState.customRules.push({
        id: addedRule.id,
        name: addedRule.name || '未命名规则',
        pattern: typeof addedRule.pattern === 'string' ? addedRule.pattern : '',
        replacement: typeof addedRule.replacement === 'string'
            ? addedRule.replacement
            : '',
        enabled: addedRule.enabled !== false,
        order: AppState.customRules.length + 1,
        runChecked: addedRule.runChecked !== false,
        isRegex: addedRule.isRegex !== false,
        isJS: addedRule.isJS === true
    });
    AppState.customRules.forEach(function reindex(rule, index) {
        rule.order = index + 1;
    });
    renderRuleTable();
}

function syncPresetRuleReorderToCustomRules(preset) {
    if (!preset || preset.isVirtual) return;
    if (preset.id !== AppState.activePresetId) return;
    if (!Array.isArray(preset.rules)) return;

    const customRulesIdMap = new Map();
    for (
        let customIndex = 0;
        customIndex < AppState.customRules.length;
        customIndex++
    ) {
        const mainRule = AppState.customRules[customIndex];
        const mainIdString = String(mainRule.id);
        if (!customRulesIdMap.has(mainIdString)) {
            customRulesIdMap.set(mainIdString, customIndex);
        }
    }

    const consumedCustomIndexes = new Set();
    const reorderedRules = [];

    for (let index = 0; index < preset.rules.length; index++) {
        const presetRule = preset.rules[index];
        const presetRuleIdString = String(presetRule.id);
        const extractedIdString = String(
            extractMainRuleIdFromPresetRuleId(presetRule.id)
        );

        let matchIndex = -1;
        const candidateByPresetId = customRulesIdMap.get(presetRuleIdString);
        const candidateByExtractedId = customRulesIdMap.get(extractedIdString);

        if (
            candidateByPresetId !== undefined &&
            !consumedCustomIndexes.has(candidateByPresetId)
        ) {
            matchIndex = candidateByPresetId;
        } else if (
            candidateByExtractedId !== undefined &&
            !consumedCustomIndexes.has(candidateByExtractedId)
        ) {
            matchIndex = candidateByExtractedId;
        }

        if (matchIndex !== -1) {
            consumedCustomIndexes.add(matchIndex);
            const mainRule = AppState.customRules[matchIndex];
            mainRule.order = index + 1;
            reorderedRules.push(mainRule);
        } else {
            reorderedRules.push({
                id: presetRule.id,
                name: presetRule.name || '未命名规则',
                pattern: typeof presetRule.pattern === 'string'
                    ? presetRule.pattern
                    : '',
                replacement: typeof presetRule.replacement === 'string'
                    ? presetRule.replacement
                    : '',
                enabled: presetRule.enabled !== false,
                order: index + 1,
                runChecked: presetRule.runChecked !== false,
                isRegex: presetRule.isRegex !== false,
                isJS: presetRule.isJS === true
            });
        }
    }

    const baseCount = reorderedRules.length;
    let nextOrderForUnmatched = baseCount + 1;

    for (
        let customIndex = 0;
        customIndex < AppState.customRules.length;
        customIndex++
    ) {
        if (consumedCustomIndexes.has(customIndex)) continue;
        const unmatchedRule = AppState.customRules[customIndex];
        unmatchedRule.order = nextOrderForUnmatched;
        nextOrderForUnmatched++;
        reorderedRules.push(unmatchedRule);
    }

    for (let index = 0; index < reorderedRules.length; index++) {
        reorderedRules[index].order = index + 1;
    }

    AppState.customRules = reorderedRules;
    renderRuleTable();
}

// ============================================================================
// 模态框栈
// ============================================================================

function pushModalToStack(modalId, closeCallback) {
    AppState.modalStack.push({
        id: modalId,
        close: closeCallback
    });
}

function popModalFromStack(modalId) {
    const stack = AppState.modalStack;
    for (let index = stack.length - 1; index >= 0; index--) {
        if (stack[index].id === modalId) {
            stack.splice(index, 1);
            return;
        }
    }
}

function handleModalStackEscape() {
    const stack = AppState.modalStack;
    if (stack.length === 0) return false;
    const topModal = stack[stack.length - 1];
    if (topModal && typeof topModal.close === 'function') {
        topModal.close();
        return true;
    }
    return false;
}

// ============================================================================
// 悬停提示浮层
// ============================================================================

function supportsHover() {
    if (
        typeof window === 'undefined' ||
        typeof window.matchMedia !== 'function'
    ) {
        return true;
    }
    try {
        return window.matchMedia(
            '(hover: hover) and (pointer: fine)'
        ).matches;
    } catch (matchMediaError) {
        return true;
    }
}

function positionHelpTooltip() {
    const button = DOM.presetHelpButton;
    const tooltip = DOM.presetHelpTooltip;
    if (!button || !tooltip) return;

    tooltip.style.visibility = 'hidden';
    tooltip.style.display = 'block';

    const buttonRect = button.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const tooltipWidth = tooltipRect.width ||
        CONFIG.PRESET_HELP_TOOLTIP_MAX_WIDTH_PX;
    const tooltipHeight = tooltipRect.height || 200;

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const margin = 8;

    let left = buttonRect.right - tooltipWidth;
    if (left < margin) {
        left = margin;
    }
    if (left + tooltipWidth > viewportWidth - margin) {
        left = viewportWidth - tooltipWidth - margin;
    }

    let top = buttonRect.bottom + margin;
    if (top + tooltipHeight > viewportHeight - margin) {
        const aboveTop = buttonRect.top - tooltipHeight - margin;
        if (aboveTop >= margin) {
            top = aboveTop;
            tooltip.classList.add('preset-help-tooltip-above');
            tooltip.classList.remove('preset-help-tooltip-no-arrow');
        } else {
            top = Math.max(margin, viewportHeight - tooltipHeight - margin);
            tooltip.classList.remove('preset-help-tooltip-above');
            tooltip.classList.add('preset-help-tooltip-no-arrow');
        }
    } else {
        tooltip.classList.remove('preset-help-tooltip-above');
        tooltip.classList.remove('preset-help-tooltip-no-arrow');
    }

    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
    tooltip.style.visibility = 'visible';
}

function scheduleRepositionHelpTooltip() {
    if (helpTooltipRepositionThrottleTimer !== null) return;

    helpTooltipRepositionThrottleTimer = setTimeout(
        function onThrottleElapsed() {
            helpTooltipRepositionThrottleTimer = null;
            if (AppState.presetHelpTooltipOpen) {
                positionHelpTooltip();
            }
        },
        CONFIG.PRESET_HELP_REPOSITION_THROTTLE_MS
    );
}

function showHelpTooltip() {
    const button = DOM.presetHelpButton;
    const tooltip = DOM.presetHelpTooltip;
    if (!button || !tooltip) return;

    if (helpTooltipHideTimer) {
        clearTimeout(helpTooltipHideTimer);
        helpTooltipHideTimer = null;
    }

    tooltip.style.display = 'block';
    tooltip.setAttribute('aria-hidden', 'false');
    button.setAttribute('aria-expanded', 'true');
    AppState.presetHelpTooltipOpen = true;

    positionHelpTooltip();

    helpTooltipMountedAt = Date.now();

    if (helpTooltipOutsideClickHandler) {
        document.removeEventListener(
            'click',
            helpTooltipOutsideClickHandler,
            true
        );
    }
    helpTooltipOutsideClickHandler = function onOutsideClick(clickEvent) {
        if (
            Date.now() - helpTooltipMountedAt <
            HELP_TOOLTIP_OUTSIDE_CLICK_GRACE_MS
        ) {
            return;
        }

        const target = clickEvent.target;
        if (!target) return;
        if (button.contains(target)) return;
        if (tooltip.contains(target)) return;
        hideHelpTooltip();
    };
    document.addEventListener(
        'click',
        helpTooltipOutsideClickHandler,
        true
    );
}

function hideHelpTooltip() {
    const button = DOM.presetHelpButton;
    const tooltip = DOM.presetHelpTooltip;
    if (!button || !tooltip) return;

    if (helpTooltipShowTimer) {
        clearTimeout(helpTooltipShowTimer);
        helpTooltipShowTimer = null;
    }
    if (helpTooltipHideTimer) {
        clearTimeout(helpTooltipHideTimer);
        helpTooltipHideTimer = null;
    }
    if (helpTooltipRepositionThrottleTimer) {
        clearTimeout(helpTooltipRepositionThrottleTimer);
        helpTooltipRepositionThrottleTimer = null;
    }

    tooltip.style.display = 'none';
    tooltip.setAttribute('aria-hidden', 'true');
    button.setAttribute('aria-expanded', 'false');
    AppState.presetHelpTooltipOpen = false;

    if (helpTooltipOutsideClickHandler) {
        document.removeEventListener(
            'click',
            helpTooltipOutsideClickHandler,
            true
        );
        helpTooltipOutsideClickHandler = null;
    }
}

function initializePresetHelpTooltip() {
    if (isHelpTooltipInitialized) return;
    isHelpTooltipInitialized = true;

    const button = DOM.presetHelpButton;
    const tooltip = DOM.presetHelpTooltip;
    if (!button || !tooltip) return;

    if (supportsHover()) {
        button.addEventListener('mouseenter', function onMouseEnter() {
            if (helpTooltipHideTimer) {
                clearTimeout(helpTooltipHideTimer);
                helpTooltipHideTimer = null;
            }
            if (helpTooltipShowTimer) {
                clearTimeout(helpTooltipShowTimer);
            }
            helpTooltipShowTimer = setTimeout(function onShowDelay() {
                helpTooltipShowTimer = null;
                showHelpTooltip();
            }, CONFIG.PRESET_HELP_HOVER_SHOW_DELAY_MS);
        });

        button.addEventListener('mouseleave', function onMouseLeave() {
            if (helpTooltipShowTimer) {
                clearTimeout(helpTooltipShowTimer);
                helpTooltipShowTimer = null;
            }
            if (helpTooltipHideTimer) {
                clearTimeout(helpTooltipHideTimer);
            }
            helpTooltipHideTimer = setTimeout(function onHideDelay() {
                helpTooltipHideTimer = null;
                hideHelpTooltip();
            }, CONFIG.PRESET_HELP_HOVER_HIDE_DELAY_MS);
        });

        tooltip.addEventListener('mouseenter', function onTooltipEnter() {
            if (helpTooltipHideTimer) {
                clearTimeout(helpTooltipHideTimer);
                helpTooltipHideTimer = null;
            }
        });
        tooltip.addEventListener('mouseleave', function onTooltipLeave() {
            if (helpTooltipHideTimer) {
                clearTimeout(helpTooltipHideTimer);
            }
            helpTooltipHideTimer = setTimeout(function onHideDelay() {
                helpTooltipHideTimer = null;
                hideHelpTooltip();
            }, CONFIG.PRESET_HELP_HOVER_HIDE_DELAY_MS);
        });
    } else {
        button.addEventListener('click', function onButtonClick(clickEvent) {
            clickEvent.stopPropagation();
            if (AppState.presetHelpTooltipOpen) {
                hideHelpTooltip();
            } else {
                showHelpTooltip();
            }
        });
    }

    button.addEventListener('keydown', function onButtonKeyDown(keyEvent) {
        if (keyEvent.key === 'Enter' || keyEvent.key === ' ') {
            keyEvent.preventDefault();
            if (AppState.presetHelpTooltipOpen) {
                hideHelpTooltip();
            } else {
                showHelpTooltip();
            }
        }
    });

    window.addEventListener('resize', function onResize() {
        if (AppState.presetHelpTooltipOpen) {
            scheduleRepositionHelpTooltip();
        }
    });

    window.addEventListener('scroll', function onScroll() {
        if (AppState.presetHelpTooltipOpen) {
            scheduleRepositionHelpTooltip();
        }
    }, { passive: true });

    if (DOM.presetManagerModal) {
        DOM.presetManagerModal.addEventListener('scroll', function onModalScroll() {
            if (AppState.presetHelpTooltipOpen) {
                scheduleRepositionHelpTooltip();
            }
        }, { passive: true, capture: true });
    }
}

// ============================================================================
// 模态框开关
// ============================================================================

export function openPresetManagerModal() {
    if (!DOM.presetManagerModalOverlay) return;
    if (modalIsOpen) return;

    flushPendingPresetSync();

    DOM.presetManagerModalOverlay.style.display = 'flex';
    modalIsOpen = true;
    AppState.presetManagerModalOpen = true;

    pushModalToStack('presetManagerModal', closePresetManagerModal);

    resetExpandedMode();

    selectedPresetId = AppState.activePresetId
        ? AppState.activePresetId
        : CONFIG.MAIN_TABLE_VIRTUAL_ID;

    searchQuery = '';
    if (DOM.presetSearchInput) {
        DOM.presetSearchInput.value = '';
    }

    if (DOM.presetManagerModal) {
        DOM.presetManagerModal.classList.remove('mobile-detail-view');
    }

    clearPresetFilterCache();

    renderPresetList(AppState.presetListScrollTop);
    renderPresetDetail();
    updateSearchScopeButtonUI();
    updateSearchDataSourceButtonUI();

    if (window.innerWidth > CONFIG.PRESET_MOBILE_BREAKPOINT_PX) {
        setTimeout(function deferFocus() {
            if (DOM.presetSearchInput) {
                DOM.presetSearchInput.focus();
            }
        }, 0);
    }
}

export function closePresetManagerModal() {
    if (!DOM.presetManagerModalOverlay) return;

    if (AppState.presetHelpTooltipOpen) {
        hideHelpTooltip();
    }

    if (AppState.appendTargetModalOpen) {
        closeAppendTargetModal();
    }

    if (DOM.presetListContainer) {
        AppState.presetListScrollTop =
            DOM.presetListContainer.scrollTop || 0;
    }

    DOM.presetManagerModalOverlay.style.display = 'none';
    modalIsOpen = false;
    AppState.presetManagerModalOpen = false;

    popModalFromStack('presetManagerModal');

    resetExpandedMode();

    if (
        document.activeElement &&
        typeof document.activeElement.blur === 'function'
    ) {
        document.activeElement.blur();
    }

    selectedPresetId = null;
    searchQuery = '';

    if (searchDebounceTimer) {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = null;
    }

    if (DOM.presetManagerModal) {
        DOM.presetManagerModal.classList.remove('mobile-detail-view');
    }

    presetListItemCache.clear();
    presetRuleCardCache.clear();
    clearPresetFilterCache();

    if (
        DOM.presetManagerButton &&
        typeof DOM.presetManagerButton.focus === 'function'
    ) {
        setTimeout(function deferFocusBack() {
            DOM.presetManagerButton.focus();
        }, 0);
    }
}

// ============================================================================
// 预设列表项构建 / 更新
// ============================================================================

const PRESET_ITEM_ELEMENTS = Symbol('presetItemElements');

function createPresetListItemElement(preset, item, normalizedQuery) {
    const itemElement = document.createElement('div');
    itemElement.className = 'preset-list-item';

    if (preset.id === selectedPresetId) {
        itemElement.classList.add('selected');
    }
    if (preset.id === AppState.activePresetId) {
        itemElement.classList.add('active-preset');
    }

    itemElement.setAttribute('tabindex', '0');
    itemElement.setAttribute('role', 'option');
    itemElement.setAttribute(
        'aria-selected',
        preset.id === selectedPresetId ? 'true' : 'false'
    );
    itemElement.setAttribute('data-preset-id', preset.id);

    const nameElement = document.createElement('div');
    nameElement.className = 'preset-item-name';

    const metaElement = document.createElement('div');
    metaElement.className = 'preset-item-meta';

    itemElement.appendChild(nameElement);
    itemElement.appendChild(metaElement);

    itemElement.addEventListener('click', function onItemClick() {
        selectPreset(preset.id);
    });

    itemElement.addEventListener('keydown', function onItemKeyDown(event) {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            selectPreset(preset.id);
            setTimeout(function refocus() {
                const container = DOM.presetListContainer;
                if (!container) return;
                const refocusedItem = findPresetItemElementById(
                    container,
                    preset.id
                );
                if (
                    refocusedItem &&
                    typeof refocusedItem.focus === 'function'
                ) {
                    refocusedItem.focus();
                }
            }, 0);
        } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            focusNextPresetItemFromCurrent(itemElement, 1);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            focusNextPresetItemFromCurrent(itemElement, -1);
        }
    });

    itemElement[PRESET_ITEM_ELEMENTS] = {
        nameElement: nameElement,
        metaElement: metaElement
    };

    updatePresetListItemDynamicParts(
        itemElement,
        preset,
        item,
        normalizedQuery
    );

    return itemElement;
}

function updatePresetListItemDynamicParts(
    itemElement,
    preset,
    item,
    normalizedQuery
) {
    const elements = itemElement[PRESET_ITEM_ELEMENTS];
    if (!elements) return;

    const shouldBeSelected = (preset.id === selectedPresetId);
    if (itemElement.classList.contains('selected') !== shouldBeSelected) {
        itemElement.classList.toggle('selected', shouldBeSelected);
    }
    const newAriaSelected = shouldBeSelected ? 'true' : 'false';
    if (itemElement.getAttribute('aria-selected') !== newAriaSelected) {
        itemElement.setAttribute('aria-selected', newAriaSelected);
    }

    const shouldBeActive = (preset.id === AppState.activePresetId);
    if (itemElement.classList.contains('active-preset') !== shouldBeActive) {
        itemElement.classList.toggle('active-preset', shouldBeActive);
    }

    elements.nameElement.innerHTML = '';

    if (item.nameMatched && normalizedQuery !== '') {
        elements.nameElement.innerHTML = highlightMatchInText(
            preset.name || '未命名预设',
            normalizedQuery
        );
    } else {
        elements.nameElement.textContent = preset.name || '未命名预设';
    }

    if (shouldBeActive) {
        const badge = document.createElement('span');
        badge.className = 'preset-active-badge';
        badge.textContent = '● 当前工作区';
        badge.title = '该预设是当前工作区';
        elements.nameElement.appendChild(document.createTextNode(' '));
        elements.nameElement.appendChild(badge);
    }

    if (item.matchingRuleCount > 0) {
        const rulesBadge = document.createElement('span');
        rulesBadge.className = 'preset-rules-match-badge';
        rulesBadge.textContent = '[' + item.matchingRuleCount + ' 条匹配]';
        elements.nameElement.appendChild(document.createTextNode(' '));
        elements.nameElement.appendChild(rulesBadge);
    }

    const ruleCount = Array.isArray(preset.rules) ? preset.rules.length : 0;

    const overlapCount = getPresetOverlapCount(preset);
    let metaText = ruleCount + ' 条规则 · ' +
        formatRelativeTime(preset.updatedAt);
    if (overlapCount > 0) {
        metaText += ' · 与' + getDefaultRulesDisplayName() +
            '重叠 ' + overlapCount + ' 条';
    }

    if (elements.metaElement.textContent !== metaText) {
        elements.metaElement.textContent = metaText;
    }
}

// ============================================================================
// 预设过滤缓存
// ============================================================================

function clearPresetFilterCache() {
    AppState.lastPresetFilterQuery = null;
    AppState.lastPresetFilterScope = null;
    AppState.lastPresetFilterDataSource = null;
    AppState.lastPresetFilterPresetsSnapshot = null;
    AppState.lastPresetFilterResult = null;
}

function isPresetFilterCacheValid(normalizedQuery) {
    return (
        AppState.lastPresetFilterQuery === normalizedQuery &&
        AppState.lastPresetFilterScope === AppState.presetSearchScope &&
        AppState.lastPresetFilterDataSource === AppState.searchDataSource &&
        AppState.lastPresetFilterPresetsSnapshot === AppState.presets
    );
}

// ============================================================================
// 列表渲染
// ============================================================================

function shouldRenderMainTableVirtualItem(normalizedQuery) {
    const dataSourceScope = AppState.searchDataSource;

    if (dataSourceScope === SEARCH_DATA_SOURCE.CURRENT) {
        return isMainTableVirtualId(selectedPresetId);
    }

    if (normalizedQuery === '') {
        return true;
    }

    const mainTableDisplayName =
        (getDefaultRulesDisplayName() || '').toLowerCase();
    if (mainTableDisplayName.indexOf(normalizedQuery) !== -1) {
        return true;
    }

    const aliases = ['主表', '默认规则', 'main', 'default'];
    for (let aliasIndex = 0; aliasIndex < aliases.length; aliasIndex++) {
        const alias = aliases[aliasIndex];
        if (alias.indexOf(normalizedQuery) === 0) {
            return true;
        }
        if (normalizedQuery.indexOf(alias) === 0) {
            return true;
        }
    }
    return false;
}

function renderPresetList(preferredScrollTop) {
    const container = DOM.presetListContainer;
    if (!container) return;

    container.setAttribute('role', 'listbox');
    container.setAttribute('aria-label', '预设列表');

    const savedScrollTop = (
        typeof preferredScrollTop === 'number' &&
        preferredScrollTop > 0
    )
        ? preferredScrollTop
        : container.scrollTop;

    const fragment = document.createDocumentFragment();

    const normalizedQuery = searchQuery.trim().toLowerCase();
    const showMainTableVirtualItem =
        shouldRenderMainTableVirtualItem(normalizedQuery);

    if (showMainTableVirtualItem) {
        renderMainTableVirtualItem(fragment);
    }

    if (AppState.presets.length === 0) {
        const emptyHint = document.createElement('div');
        emptyHint.className = 'preset-list-empty';
        emptyHint.textContent = '还没有预设';
        fragment.appendChild(emptyHint);
        container.replaceChildren(fragment);
        return;
    }

    let filteredPresets;
    if (normalizedQuery === '') {
        filteredPresets = AppState.presets.map(function mapPreset(preset) {
            return {
                preset: preset,
                matchingRuleCount: 0,
                nameMatched: false
            };
        });
    } else {
        if (isPresetFilterCacheValid(normalizedQuery)) {
            filteredPresets = AppState.lastPresetFilterResult;
        } else {
            filteredPresets = filterPresetsByQuery(
                AppState.presets,
                normalizedQuery
            );
            AppState.lastPresetFilterQuery = normalizedQuery;
            AppState.lastPresetFilterScope = AppState.presetSearchScope;
            AppState.lastPresetFilterDataSource = AppState.searchDataSource;
            AppState.lastPresetFilterPresetsSnapshot = AppState.presets;
            AppState.lastPresetFilterResult = filteredPresets;
        }
    }

    if (filteredPresets.length === 0) {
        const emptyHint = document.createElement('div');
        emptyHint.className = 'preset-list-empty';
        if (AppState.searchDataSource === SEARCH_DATA_SOURCE.CURRENT) {
            const currentPreset = getSelectedPreset();
            if (!currentPreset) {
                emptyHint.textContent =
                    '请先选中一个预设（搜索数据源当前为"仅当前选中项"）';
            } else if (currentPreset.isVirtual) {
                emptyHint.textContent =
                    '命名预设不参与搜索（当前数据源：仅' +
                    getDefaultRulesDisplayName() + '）';
            } else {
                emptyHint.textContent =
                    '当前选中项「' + (currentPreset.name || '未命名预设') +
                    '」中未找到匹配' +
                    (searchQuery.trim()
                        ? '「' + searchQuery.trim() + '」'
                        : '');
            }
        } else {
            emptyHint.textContent = '未找到匹配的预设';
        }
        fragment.appendChild(emptyHint);
        container.replaceChildren(fragment);
        return;
    }

    filteredPresets.sort(function sortPresets(itemA, itemB) {
        const timeA = itemA.preset.createdAt || 0;
        const timeB = itemB.preset.createdAt || 0;
        if (timeB !== timeA) {
            return timeB - timeA;
        }
        return (itemA.preset.name || '').localeCompare(
            itemB.preset.name || ''
        );
    });

    const newCacheEntries = new Map();

    filteredPresets.forEach(function forEachPreset(item) {
        const preset = item.preset;
        const cachedEntry = presetListItemCache.get(preset.id);
        let itemElement;

        if (cachedEntry && cachedEntry.preset === preset) {
            itemElement = cachedEntry.itemElement;
            updatePresetListItemDynamicParts(
                itemElement,
                preset,
                item,
                normalizedQuery
            );
        } else {
            itemElement = createPresetListItemElement(
                preset,
                item,
                normalizedQuery
            );
        }

        fragment.appendChild(itemElement);
        newCacheEntries.set(preset.id, {
            itemElement: itemElement,
            preset: preset
        });
    });

    container.replaceChildren(fragment);

    presetListItemCache.clear();
    newCacheEntries.forEach(function copyEntry(entry, key) {
        presetListItemCache.set(key, entry);
    });

    if (savedScrollTop > 0) {
        window.requestAnimationFrame(function restoreScrollTop() {
            if (container.scrollTop !== savedScrollTop) {
                container.scrollTop = savedScrollTop;
            }
        });
    }
}

function renderMainTableVirtualItem(container) {
    const mainTableItem = document.createElement('div');
    mainTableItem.className = 'preset-list-item preset-list-item-main-table';
    if (isMainTableVirtualId(selectedPresetId)) {
        mainTableItem.classList.add('selected');
    }
    if (AppState.activePresetId === CONFIG.MAIN_TABLE_VIRTUAL_ID) {
        mainTableItem.classList.add('active-preset');
    }
    mainTableItem.setAttribute('tabindex', '0');
    mainTableItem.setAttribute('role', 'option');
    mainTableItem.setAttribute(
        'aria-selected',
        isMainTableVirtualId(selectedPresetId) ? 'true' : 'false'
    );
    mainTableItem.setAttribute('data-preset-id', CONFIG.MAIN_TABLE_VIRTUAL_ID);

    const displayName = getDefaultRulesDisplayName();

    const nameElement = document.createElement('div');
    nameElement.className = 'preset-item-name';
    nameElement.textContent = '📋 ' + displayName;

    const badge = document.createElement('span');
    badge.className = 'preset-active-badge preset-main-table-badge';
    badge.textContent = displayName;
    badge.title = displayName + '（置顶预设，不可删除）';
    nameElement.appendChild(document.createTextNode(' '));
    nameElement.appendChild(badge);

    if (AppState.activePresetId === CONFIG.MAIN_TABLE_VIRTUAL_ID) {
        const activeBadge = document.createElement('span');
        activeBadge.className = 'preset-active-badge';
        activeBadge.textContent = '● 当前工作区';
        activeBadge.title = '该预设是当前工作区';
        nameElement.appendChild(document.createTextNode(' '));
        nameElement.appendChild(activeBadge);
    }

    const metaElement = document.createElement('div');
    metaElement.className = 'preset-item-meta';
    const ruleCount = AppState.defaultRules.length;
    metaElement.textContent = ruleCount + ' 条规则 · ' + displayName;

    mainTableItem.appendChild(nameElement);
    mainTableItem.appendChild(metaElement);

    mainTableItem.addEventListener('click', function onMainTableClick() {
        selectPreset(CONFIG.MAIN_TABLE_VIRTUAL_ID);
    });

    mainTableItem.addEventListener('keydown', function onMainTableKeyDown(event) {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            selectPreset(CONFIG.MAIN_TABLE_VIRTUAL_ID);
        } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            focusNextPresetItemFromCurrent(mainTableItem, 1);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            focusNextPresetItemFromCurrent(mainTableItem, -1);
        }
    });

    container.appendChild(mainTableItem);
}

function filterPresetsByQuery(presets, normalizedQuery) {
    const result = [];
    const dataSourceScope = AppState.searchDataSource;
    const fieldScope = AppState.presetSearchScope;

    let sourcePresets;
    if (dataSourceScope === SEARCH_DATA_SOURCE.CURRENT) {
        const currentPreset = getSelectedPreset();
        if (!currentPreset) return result;
        if (currentPreset.isVirtual) {
            return result;
        }
        sourcePresets = [currentPreset];
    } else {
        sourcePresets = presets;
    }

    for (let index = 0; index < sourcePresets.length; index++) {
        const preset = sourcePresets[index];
        const presetName = (preset.name || '').toLowerCase();
        const nameMatched = presetName.indexOf(normalizedQuery) !== -1;

        let matchingRuleCount = 0;

        if (fieldScope === 'all') {
            const presetRules = Array.isArray(preset.rules) ? preset.rules : [];
            for (
                let ruleIndex = 0;
                ruleIndex < presetRules.length;
                ruleIndex++
            ) {
                const rule = presetRules[ruleIndex];
                const ruleName = String(rule.name || '').toLowerCase();
                const rulePattern = String(rule.pattern || '').toLowerCase();
                const ruleReplacement = String(
                    rule.replacement || ''
                ).toLowerCase();

                if (
                    ruleName.indexOf(normalizedQuery) !== -1 ||
                    rulePattern.indexOf(normalizedQuery) !== -1 ||
                    ruleReplacement.indexOf(normalizedQuery) !== -1
                ) {
                    matchingRuleCount++;
                }
            }
        }

        if (nameMatched || matchingRuleCount > 0) {
            result.push({
                preset: preset,
                matchingRuleCount: matchingRuleCount,
                nameMatched: nameMatched
            });
        }
    }

    return result;
}

function highlightMatchInText(text, normalizedQuery) {
    if (!normalizedQuery) {
        return escapeHtmlText(text);
    }
    const lowerText = text.toLowerCase();
    let resultHtml = '';
    let searchFromIndex = 0;
    let foundIndex = lowerText.indexOf(normalizedQuery, searchFromIndex);

    while (foundIndex !== -1) {
        resultHtml += escapeHtmlText(
            text.substring(searchFromIndex, foundIndex)
        );
        resultHtml += '<mark class="preset-search-highlight">' +
            escapeHtmlText(
                text.substring(
                    foundIndex,
                    foundIndex + normalizedQuery.length
                )
            ) +
            '</mark>';
        searchFromIndex = foundIndex + normalizedQuery.length;
        foundIndex = lowerText.indexOf(normalizedQuery, searchFromIndex);
    }
    resultHtml += escapeHtmlText(text.substring(searchFromIndex));
    return resultHtml;
}

function escapeHtmlText(text) {
    return String(text).replace(/[&<>"']/g, function escapeChar(match) {
        const escapeMap = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        };
        return escapeMap[match];
    });
}

function selectPreset(presetId) {
    selectedPresetId = presetId;
    clearPresetFilterCache();
    renderPresetList();
    renderPresetDetail();

    if (
        window.innerWidth <= CONFIG.PRESET_MOBILE_BREAKPOINT_PX &&
        DOM.presetManagerModal
    ) {
        DOM.presetManagerModal.classList.add('mobile-detail-view');
    }
}

function renderPresetDetail() {
    const preset = getSelectedPreset();

    if (!preset) {
        if (DOM.presetDetailEmptyHint) {
            DOM.presetDetailEmptyHint.style.display = 'block';
        }
        if (DOM.presetDetailContent) {
            DOM.presetDetailContent.style.display = 'none';
        }
        if (DOM.presetApplyButton) DOM.presetApplyButton.disabled = true;
        if (DOM.presetDeleteButton) DOM.presetDeleteButton.disabled = true;
        if (DOM.presetSaveAsButton) DOM.presetSaveAsButton.disabled = true;
        return;
    }

    if (DOM.presetDetailEmptyHint) {
        DOM.presetDetailEmptyHint.style.display = 'none';
    }
    if (DOM.presetDetailContent) {
        DOM.presetDetailContent.style.display = 'flex';
    }

    const isVirtualMain = preset.isVirtual === true;

    if (isVirtualMain) {
        if (DOM.presetApplyButton) {
            DOM.presetApplyButton.disabled = true;
            DOM.presetApplyButton.style.display = 'none';
        }
        if (DOM.presetDeleteButton) {
            DOM.presetDeleteButton.disabled = true;
            DOM.presetDeleteButton.style.display = 'none';
        }
        if (DOM.presetSaveAsButton) {
            DOM.presetSaveAsButton.disabled = false;
            DOM.presetSaveAsButton.style.display = '';
        }
        if (DOM.presetNameEditButton) {
            DOM.presetNameEditButton.style.display = '';
        }
    } else {
        if (DOM.presetApplyButton) {
            DOM.presetApplyButton.disabled = false;
            DOM.presetApplyButton.style.display = '';
        }
        if (DOM.presetDeleteButton) {
            DOM.presetDeleteButton.disabled = false;
            DOM.presetDeleteButton.style.display = '';
        }
        if (DOM.presetSaveAsButton) {
            DOM.presetSaveAsButton.disabled = false;
            DOM.presetSaveAsButton.style.display = '';
        }
        if (DOM.presetNameEditButton) {
            DOM.presetNameEditButton.style.display = '';
        }
    }

    if (DOM.presetNameDisplay) {
        DOM.presetNameDisplay.textContent = preset.name || '未命名预设';
    }

    if (DOM.presetDetailMeta) {
        const ruleCount = Array.isArray(preset.rules)
            ? preset.rules.length
            : 0;
        let metaText = ruleCount + ' 条规则';
        if (!isVirtualMain) {
            metaText += ' · ' + formatRelativeTime(preset.updatedAt);
            if (preset.id === AppState.activePresetId) {
                metaText += ' · ● 当前工作区';
            }
        } else {
            metaText += ' · ' + getDefaultRulesDisplayName() +
                '（编辑将立即生效）';
            if (AppState.activePresetId === CONFIG.MAIN_TABLE_VIRTUAL_ID) {
                metaText += ' · ● 当前工作区';
            }
        }
        DOM.presetDetailMeta.textContent = metaText;
    }

    renderPresetRulesList();
}

// ============================================================================
// 预设规则列表过滤
// ============================================================================

function getFilteredRulesForPreset(preset, normalizedQuery) {
    if (!preset || !Array.isArray(preset.rules)) return [];
    if (normalizedQuery === '') return preset.rules;
    if (AppState.presetSearchScope !== 'all') return preset.rules;
    if (preset.isVirtual === true) return preset.rules;

    return preset.rules.filter(function filterRule(rule) {
        const ruleName = String(rule.name || '').toLowerCase();
        const rulePattern = String(rule.pattern || '').toLowerCase();
        const ruleReplacement = String(
            rule.replacement || ''
        ).toLowerCase();
        const presetName = String(preset.name || '').toLowerCase();

        if (presetName.indexOf(normalizedQuery) !== -1) return true;

        return (
            ruleName.indexOf(normalizedQuery) !== -1 ||
            rulePattern.indexOf(normalizedQuery) !== -1 ||
            ruleReplacement.indexOf(normalizedQuery) !== -1
        );
    });
}

// ============================================================================
// 预设规则列表渲染（增量渲染 + 存在性行哈希缓存）
// ============================================================================

function renderPresetRulesList() {
    const container = DOM.presetRulesListContainer;
    if (!container) return;

    const preset = getSelectedPreset();
    if (!preset || !Array.isArray(preset.rules)) {
        container.replaceChildren();
        presetRuleCardCache.clear();
        return;
    }

    const isVirtualMain = preset.isVirtual === true;

    if (!isVirtualMain) {
        let needsReorder = false;
        for (let index = 0; index < preset.rules.length; index++) {
            if (preset.rules[index].order !== index + 1) {
                needsReorder = true;
                break;
            }
        }
        if (needsReorder) {
            preset.rules.sort(function sortRules(ruleA, ruleB) {
                return ruleA.order - ruleB.order;
            });
            preset.rules.forEach(function reindex(rule, index) {
                rule.order = index + 1;
            });
        }
    } else {
        let needsReorder = false;
        for (let index = 0; index < AppState.defaultRules.length; index++) {
            if (AppState.defaultRules[index].order !== index + 1) {
                needsReorder = true;
                break;
            }
        }
        if (needsReorder) {
            AppState.defaultRules.sort(function sortRules(ruleA, ruleB) {
                return ruleA.order - ruleB.order;
            });
            AppState.defaultRules.forEach(function reindex(rule, index) {
                rule.order = index + 1;
            });
        }
    }

    const wrapper = container.parentElement;
    const savedDetailScrollTop = wrapper ? wrapper.scrollTop : 0;

    const fragment = document.createDocumentFragment();

    if (preset.rules.length === 0) {
        const emptyHint = document.createElement('div');
        emptyHint.className = 'preset-rules-list-empty';
        emptyHint.textContent = isVirtualMain
            ? '默认规则暂无规则，点击下方"+ 添加规则"开始添加'
            : '该预设暂无规则，点击下方"+ 添加规则"开始添加';
        fragment.appendChild(emptyHint);
        container.replaceChildren(fragment);
        presetRuleCardCache.clear();
        return;
    }

    const normalizedQuery = searchQuery.trim().toLowerCase();

    const displayedRules = getFilteredRulesForPreset(preset, normalizedQuery);
    const isFilteredView = (
        normalizedQuery !== '' &&
        AppState.presetSearchScope === 'all' &&
        !isVirtualMain
    );

    if (isFilteredView && displayedRules.length < preset.rules.length) {
        const filterHint = document.createElement('div');
        filterHint.className = 'preset-filter-hint';
        filterHint.textContent =
            '已过滤 ' + displayedRules.length + '/' +
            preset.rules.length + ' 条 · ';
        const clearFilterBtn = document.createElement('button');
        clearFilterBtn.type = 'button';
        clearFilterBtn.className = 'icon-btn';
        clearFilterBtn.textContent = '显示全部';
        clearFilterBtn.style.cssText =
            'font-size:11px; min-height:24px; padding:2px 8px;';
        clearFilterBtn.onclick = function onClearFilter() {
            if (DOM.presetSearchInput) {
                DOM.presetSearchInput.value = '';
            }
            searchQuery = '';
            clearPresetFilterCache();
            renderPresetList();
            renderPresetDetail();
        };
        filterHint.appendChild(clearFilterBtn);
        fragment.appendChild(filterHint);
    }

    if (isFilteredView && displayedRules.length === 0) {
        const emptyHint = document.createElement('div');
        emptyHint.className = 'preset-rules-list-empty';
        emptyHint.textContent = '该预设内无匹配「' + searchQuery + '」的规则';
        fragment.appendChild(emptyHint);
        container.replaceChildren(fragment);
        presetRuleCardCache.clear();
        return;
    }

    const oldCacheSnapshot = new Map(presetRuleCardCache);
    presetRuleCardCache.clear();

    displayedRules.forEach(function forEachRule(rule) {
        const ruleIdString = String(rule.id);
        const cachedEntry = oldCacheSnapshot.get(ruleIdString);
        let card;

        if (cachedEntry && cachedEntry.rule === rule) {
            card = cachedEntry.card;
            updatePresetRuleCardDynamicParts(
                card,
                rule,
                preset,
                normalizedQuery
            );
        } else {
            card = createPresetRuleCard(rule, preset, normalizedQuery);
        }

        fragment.appendChild(card);
        presetRuleCardCache.set(ruleIdString, {
            card: card,
            rule: rule
        });
    });

    container.replaceChildren(fragment);

    if (wrapper && savedDetailScrollTop > 0) {
        window.requestAnimationFrame(function restoreDetailScroll() {
            if (wrapper.scrollTop !== savedDetailScrollTop) {
                wrapper.scrollTop = savedDetailScrollTop;
            }
        });
    }
}

// ============================================================================
// 存在性行构造
// ============================================================================

function buildExistenceRow(rule, preset) {
    const existenceLocations = getRuleLocations(rule, preset.id);
    if (existenceLocations.length === 0) return null;

    const existenceRow = document.createElement('div');
    existenceRow.className = 'preset-rule-row preset-rule-existence-row';

    const existenceLabel = document.createElement('span');
    existenceLabel.className = 'preset-rule-existence-label';
    existenceLabel.textContent = '存在于：';
    existenceRow.appendChild(existenceLabel);

    const existsInDefaultRules = existenceLocations.indexOf(
        CONFIG.MAIN_TABLE_VIRTUAL_ID
    ) !== -1;
    const otherPresetIds = existenceLocations.filter(function filterId(id) {
        return id !== CONFIG.MAIN_TABLE_VIRTUAL_ID;
    });

    if (existsInDefaultRules) {
        const mainBadge = document.createElement('span');
        mainBadge.className = 'existence-badge existence-badge-main';
        mainBadge.textContent = '📋 ' + getDefaultRulesDisplayName();
        mainBadge.title = '此规则已存在于默认规则';
        existenceRow.appendChild(mainBadge);
    }

    if (otherPresetIds.length > 0) {
        const countBadge = document.createElement('span');
        countBadge.className = 'existence-badge existence-badge-other';
        countBadge.textContent = '⭐ 其他 ' + otherPresetIds.length + ' 处';
        countBadge.title = '点击查看详情';

        const detailPanel = document.createElement('div');
        detailPanel.className = 'existence-detail-panel';
        detailPanel.style.display = 'none';

        otherPresetIds.forEach(function forEachOtherPreset(presetId) {
            const targetPreset = AppState.presets.find(
                function findPreset(p) {
                    return p.id === presetId;
                }
            );
            if (!targetPreset) return;

            const detailItem = document.createElement('div');
            detailItem.className = 'existence-detail-item';
            detailItem.textContent = '⭐ ' +
                (targetPreset.name || '未命名预设');
            detailItem.style.cursor = 'pointer';
            detailItem.title = '点击跳转到此预设';
            detailItem.addEventListener('click', function onDetailClick(
                event
            ) {
                event.stopPropagation();
                selectPreset(targetPreset.id);
            });
            detailPanel.appendChild(detailItem);
        });

        countBadge.style.cursor = 'pointer';
        countBadge.addEventListener('click', function onCountClick(event) {
            event.stopPropagation();
            if (detailPanel.style.display === 'none') {
                detailPanel.style.display = 'block';
            } else {
                detailPanel.style.display = 'none';
            }
        });

        existenceRow.appendChild(countBadge);
        existenceRow.appendChild(detailPanel);
    }

    return existenceRow;
}

// ============================================================================
// 预设规则卡片
// ============================================================================

function afterPresetRuleEdited(preset, rule, isVirtualMain) {
    if (isVirtualMain) {
        syncDefaultRulesToCustomRulesIfActive();
    } else if (preset.id === AppState.activePresetId) {
        syncPresetRuleEditToCustomRules(preset, rule);
    }
}

function createPresetRuleCard(rule, preset, searchQueryForHighlight) {
    const card = document.createElement('div');
    card.className = 'preset-rule-card';
    card.setAttribute('data-rule-id', String(rule.id));

    const isVirtualMain = preset.isVirtual === true;

    // ============ 第一行 ============
    const primaryRow = document.createElement('div');
    primaryRow.className = 'preset-rule-row preset-rule-row-primary';

    const runLabel = document.createElement('label');
    runLabel.className = 'preset-rule-run-label';
    runLabel.title = '启用此规则（参与批量运行）';
    const runCheckbox = document.createElement('input');
    runCheckbox.type = 'checkbox';
    runCheckbox.className = 'preset-rule-run-checkbox';
    runCheckbox.checked = rule.runChecked !== false;
    runCheckbox.addEventListener('change', function onRunChange(event) {
        const newRunChecked = event.target.checked;
        if (newRunChecked === (rule.runChecked !== false)) return;

        rule.runChecked = newRunChecked;
        touchSelectedPreset();

        afterPresetRuleEdited(preset, rule, isVirtualMain);

        scheduleAutoSave();
    });
    runLabel.appendChild(runCheckbox);
    primaryRow.appendChild(runLabel);

    const indexSpan = document.createElement('span');
    indexSpan.className = 'preset-rule-index';
    indexSpan.textContent = '#' + rule.order;
    primaryRow.appendChild(indexSpan);

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'preset-rule-name-input';
    nameInput.value = rule.name || '';
    nameInput.placeholder = '规则名称';
    nameInput.spellcheck = false;
    nameInput.autocomplete = 'off';
    nameInput.addEventListener('change', function onNameChange(event) {
        const newNameValue = event.target.value;
        if (newNameValue === rule.name) return;

        rule.name = newNameValue;
        touchSelectedPreset();

        afterPresetRuleEdited(preset, rule, isVirtualMain);

        scheduleAutoSave();
        if (!isVirtualMain) {
            updatePresetListItemMeta(preset.id);
        }
    });
    primaryRow.appendChild(nameInput);

    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'preset-rule-actions';

    const appendButton = document.createElement('button');
    appendButton.type = 'button';
    appendButton.className = 'icon-btn append-to-target';
    appendButton.textContent = '→追加';
    appendButton.title = '追加此规则到其他预设或默认规则';

    appendButton.onclick = function onAppendClick() {
        openAppendTargetModal(rule, preset.id);
    };
    actionsContainer.appendChild(appendButton);

    const moveUpButton = document.createElement('button');
    moveUpButton.type = 'button';
    moveUpButton.className = 'icon-btn move-up';
    moveUpButton.title = '上移';
    moveUpButton.textContent = '↑';
    moveUpButton.onclick = function onMoveUp() {
        movePresetRuleRelativeToVisible(rule, -1);
    };
    actionsContainer.appendChild(moveUpButton);

    const moveDownButton = document.createElement('button');
    moveDownButton.type = 'button';
    moveDownButton.className = 'icon-btn move-down';
    moveDownButton.title = '下移';
    moveDownButton.textContent = '↓';
    moveDownButton.onclick = function onMoveDown() {
        movePresetRuleRelativeToVisible(rule, 1);
    };
    actionsContainer.appendChild(moveDownButton);

    const moveTopButton = document.createElement('button');
    moveTopButton.type = 'button';
    moveTopButton.className = 'icon-btn top-btn';
    moveTopButton.title = '置顶';
    moveTopButton.textContent = '顶';
    moveTopButton.onclick = function onMoveTop() {
        movePresetRuleToTop(rule.id);
    };
    actionsContainer.appendChild(moveTopButton);

    const moveBottomButton = document.createElement('button');
    moveBottomButton.type = 'button';
    moveBottomButton.className = 'icon-btn bottom-btn';
    moveBottomButton.title = '置底';
    moveBottomButton.textContent = '底';
    moveBottomButton.onclick = function onMoveBottom() {
        movePresetRuleToBottom(rule.id);
    };
    actionsContainer.appendChild(moveBottomButton);

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'icon-btn delete';
    deleteButton.title = '删除此规则';
    deleteButton.textContent = '删';
    deleteButton.onclick = function onDelete() {
        deletePresetRule(rule.id);
    };
    actionsContainer.appendChild(deleteButton);

    primaryRow.appendChild(actionsContainer);
    card.appendChild(primaryRow);

    // ============ 第二行：查找 ============
    const findRow = document.createElement('div');
    findRow.className = 'preset-rule-row preset-rule-row-find';

    const findLabel = document.createElement('span');
    findLabel.className = 'preset-rule-label';
    findLabel.textContent = '查找';
    findRow.appendChild(findLabel);

    const patternInput = document.createElement('input');
    patternInput.type = 'text';
    patternInput.className = 'preset-rule-pattern-input';
    patternInput.value = rule.pattern || '';
    patternInput.placeholder = '(未填写)';
    patternInput.spellcheck = false;
    patternInput.autocomplete = 'off';
    patternInput.addEventListener('change', function onPatternChange(event) {
        const newPatternValue = event.target.value;
        if (newPatternValue === rule.pattern) return;

        const oldHash = computeContentHash(rule);
        rule.pattern = newPatternValue;
        touchSelectedPreset();

        afterPresetRuleEdited(preset, rule, isVirtualMain);

        updateExistenceIndexForRule(rule, preset.id, oldHash);

        scheduleAutoSave();
    });
    findRow.appendChild(patternInput);

    const regexFlagLabel = document.createElement('label');
    regexFlagLabel.className = 'preset-rule-flag-label';
    regexFlagLabel.title = '勾选：按正则表达式解释"查找"内容';
    const regexCheckbox = document.createElement('input');
    regexCheckbox.type = 'checkbox';
    regexCheckbox.checked = rule.isRegex !== false;
    regexCheckbox.addEventListener('change', function onRegexChange(event) {
        const newIsRegex = event.target.checked;
        if (newIsRegex === (rule.isRegex !== false)) return;

        const oldHash = computeContentHash(rule);
        rule.isRegex = newIsRegex;
        touchSelectedPreset();

        afterPresetRuleEdited(preset, rule, isVirtualMain);

        updateExistenceIndexForRule(rule, preset.id, oldHash);

        scheduleAutoSave();
    });
    regexFlagLabel.appendChild(regexCheckbox);
    regexFlagLabel.appendChild(document.createTextNode(' 正则'));
    findRow.appendChild(regexFlagLabel);

    const jsFlagLabel = document.createElement('label');
    jsFlagLabel.className = 'preset-rule-flag-label';
    jsFlagLabel.title = 'JS 模式：替换文本作为函数体（高危，启用需确认）';
    const jsCheckbox = document.createElement('input');
    jsCheckbox.type = 'checkbox';
    jsCheckbox.checked = !!rule.isJS;
    jsCheckbox.addEventListener('change', function onJsChange(event) {
        const newIsJS = event.target.checked;
        if (newIsJS === !!rule.isJS) return;

        if (
            newIsJS &&
            !confirmJSMode('规则"' + (rule.name || '') + '"', rule.id)
        ) {
            jsCheckbox.checked = false;
            return;
        }

        const oldHash = computeContentHash(rule);
        rule.isJS = newIsJS;
        touchSelectedPreset();

        afterPresetRuleEdited(preset, rule, isVirtualMain);

        updateExistenceIndexForRule(rule, preset.id, oldHash);

        scheduleAutoSave();
    });
    jsFlagLabel.appendChild(jsCheckbox);
    jsFlagLabel.appendChild(document.createTextNode(' JS'));
    findRow.appendChild(jsFlagLabel);

    card.appendChild(findRow);

    // ============ 第三行：替换 ============
    const replaceRow = document.createElement('div');
    replaceRow.className = 'preset-rule-row preset-rule-row-replace';

    const replaceLabel = document.createElement('span');
    replaceLabel.className = 'preset-rule-label';
    replaceLabel.textContent = '替换';
    replaceRow.appendChild(replaceLabel);

    const replacementInput = document.createElement('input');
    replacementInput.type = 'text';
    replacementInput.className = 'preset-rule-replacement-input';
    replacementInput.value = rule.replacement || '';
    replacementInput.placeholder = '(空字符串)';
    replacementInput.spellcheck = false;
    replacementInput.autocomplete = 'off';
    replacementInput.addEventListener('change', function onReplaceChange(event) {
        const newReplacementValue = event.target.value;
        if (newReplacementValue === rule.replacement) return;

        const oldHash = computeContentHash(rule);
        const originalReplacement = rule.replacement;
        const originalIsJS = rule.isJS;
        rule.replacement = newReplacementValue;

        const trimmedText = String(rule.replacement || '').trim();
        if (
            !originalIsJS &&
            trimmedText.startsWith('@js:') &&
            !trimmedText.startsWith('@@js:')
        ) {
            if (!confirmJSMode('规则"' + (rule.name || '') + '"', rule.id)) {
                rule.replacement = originalReplacement;
                rule.isJS = originalIsJS;
                event.target.value = originalReplacement;
                return;
            }
        }

        touchSelectedPreset();

        afterPresetRuleEdited(preset, rule, isVirtualMain);

        updateExistenceIndexForRule(rule, preset.id, oldHash);

        scheduleAutoSave();
    });
    replaceRow.appendChild(replacementInput);

    card.appendChild(replaceRow);

    card[PRESET_RULE_CARD_ELEMENTS] = {
        runCheckbox: runCheckbox,
        regexCheckbox: regexCheckbox,
        jsCheckbox: jsCheckbox,
        indexSpan: indexSpan,
        nameInput: nameInput,
        patternInput: patternInput,
        replacementInput: replacementInput,
        existenceRow: null,
        existenceHash: null
    };

    updatePresetRuleCardDynamicParts(
        card,
        rule,
        preset,
        searchQueryForHighlight
    );

    return card;
}

function updatePresetRuleCardDynamicParts(
    card,
    rule,
    preset,
    normalizedQuery
) {
    const elements = card[PRESET_RULE_CARD_ELEMENTS];
    if (!elements) return;

    const newIndexText = '#' + rule.order;
    if (elements.indexSpan.textContent !== newIndexText) {
        elements.indexSpan.textContent = newIndexText;
    }

    const newRunChecked = rule.runChecked !== false;
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
        activeElement !== elements.nameInput &&
        elements.nameInput.value !== newNameValue
    ) {
        elements.nameInput.value = newNameValue;
    }

    const newPatternValue = rule.pattern || '';
    if (
        activeElement !== elements.patternInput &&
        elements.patternInput.value !== newPatternValue
    ) {
        elements.patternInput.value = newPatternValue;
    }

    const newReplacementValue = rule.replacement || '';
    if (
        activeElement !== elements.replacementInput &&
        elements.replacementInput.value !== newReplacementValue
    ) {
        elements.replacementInput.value = newReplacementValue;
    }

    const newExistenceHash = computeContentHash(rule);
    if (elements.existenceHash !== newExistenceHash) {
        if (elements.existenceRow && elements.existenceRow.parentNode) {
            elements.existenceRow.remove();
        }
        elements.existenceRow = null;

        const newExistenceRow = buildExistenceRow(rule, preset);
        if (newExistenceRow) {
            card.appendChild(newExistenceRow);
            elements.existenceRow = newExistenceRow;
        }

        elements.existenceHash = newExistenceHash;
    }

    const shouldHighlight = (
        normalizedQuery &&
        normalizedQuery !== '' &&
        AppState.presetSearchScope === 'all'
    );

    const nameHasHit = shouldHighlight &&
        rule.name &&
        String(rule.name).toLowerCase().indexOf(normalizedQuery) !== -1;
    const patternHasHit = shouldHighlight &&
        rule.pattern &&
        String(rule.pattern).toLowerCase().indexOf(normalizedQuery) !== -1;
    const replacementHasHit = shouldHighlight &&
        rule.replacement &&
        String(rule.replacement).toLowerCase().indexOf(normalizedQuery) !== -1;

    if (nameHasHit) {
        elements.nameInput.classList.add('preset-input-search-hit');
    } else {
        elements.nameInput.classList.remove('preset-input-search-hit');
    }

    if (patternHasHit) {
        elements.patternInput.classList.add('preset-input-search-hit');
    } else {
        elements.patternInput.classList.remove('preset-input-search-hit');
    }

    if (replacementHasHit) {
        elements.replacementInput.classList.add('preset-input-search-hit');
    } else {
        elements.replacementInput.classList.remove('preset-input-search-hit');
    }
}

// ============================================================================
// 追加目标选择模态框
// ============================================================================

function openAppendTargetModal(sourceRule, sourcePresetId) {
    if (!DOM.appendTargetModalOverlay) return;
    if (AppState.appendTargetModalOpen) return;

    AppState.currentAppendRule = sourceRule;
    AppState.currentAppendSourcePresetId = sourcePresetId;
    AppState.appendTargetModalOpen = true;

    AppState.lastAppendAttempt = null;

    renderAppendTargetRulePreview(sourceRule);
    renderAppendTargetList(sourceRule, sourcePresetId, '');

    if (DOM.appendTargetSearchInput) {
        DOM.appendTargetSearchInput.value = '';
    }

    DOM.appendTargetModalOverlay.style.display = 'flex';

    pushModalToStack('appendTargetModal', closeAppendTargetModal);

    setTimeout(function deferFocus() {
        if (DOM.appendTargetSearchInput) {
            DOM.appendTargetSearchInput.focus();
        }
    }, 0);
}

function closeAppendTargetModal() {
    if (!DOM.appendTargetModalOverlay) return;

    DOM.appendTargetModalOverlay.style.display = 'none';
    AppState.appendTargetModalOpen = false;
    AppState.currentAppendRule = null;
    AppState.currentAppendSourcePresetId = null;

    AppState.lastAppendAttempt = null;

    popModalFromStack('appendTargetModal');
}

function renderAppendTargetRulePreview(sourceRule) {
    if (!DOM.appendTargetRulePreview) return;
    const ruleName = sourceRule.name || '未命名规则';
    const patternPreview = String(sourceRule.pattern || '').substring(0, 60);
    DOM.appendTargetRulePreview.textContent =
        '📝 ' + ruleName + (patternPreview ? ' · ' + patternPreview : '');
}

function matchesMainTableFilter(filterQuery) {
    if (!filterQuery) return true;

    const displayName = getDefaultRulesDisplayName().toLowerCase();
    if (displayName.indexOf(filterQuery) !== -1) return true;

    const aliases = ['主表', '默认规则', 'main', 'default'];
    for (let aliasIndex = 0; aliasIndex < aliases.length; aliasIndex++) {
        const alias = aliases[aliasIndex];
        if (alias.indexOf(filterQuery) === 0) return true;
        if (filterQuery.indexOf(alias) === 0) return true;
    }
    return false;
}

function renderAppendTargetList(sourceRule, sourcePresetId, filterQuery) {
    const container = DOM.appendTargetListContainer;
    if (!container) return;

    const fragment = document.createDocumentFragment();

    const normalizedFilter = (filterQuery || '').trim().toLowerCase();

    const isFromMainTable = isMainTableVirtualId(sourcePresetId);

    const mainTableItem = document.createElement('div');
    mainTableItem.className = 'append-target-item';
    if (isFromMainTable) {
        mainTableItem.classList.add('append-target-item-disabled');
    }

    const mainTableName = document.createElement('div');
    mainTableName.className = 'append-target-item-name';
    mainTableName.textContent = '📋 ' + getDefaultRulesDisplayName();
    mainTableItem.appendChild(mainTableName);

    const mainTableMeta = document.createElement('div');
    mainTableMeta.className = 'append-target-item-meta';
    mainTableMeta.textContent = AppState.defaultRules.length + ' 条规则';
    mainTableItem.appendChild(mainTableMeta);

    const mainTableStatus = document.createElement('div');
    mainTableStatus.className = 'append-target-item-status';

    if (isFromMainTable) {
        mainTableStatus.textContent = '当前所在';
        mainTableStatus.classList.add('status-current');
    } else {
        const normalizedSource = normalizeRule(sourceRule);
        const dupInfo = findDuplicateRuleInDefaultRules(normalizedSource);
        if (dupInfo && dupInfo.matchType === 'strict') {
            mainTableStatus.textContent = '✅ 已存在';
            mainTableStatus.classList.add('status-exists');
        } else if (dupInfo && dupInfo.matchType === 'substantial') {
            mainTableStatus.textContent = '⚠️ 同名';
            mainTableStatus.classList.add('status-substantial');
        } else {
            mainTableStatus.textContent = '➕ 追加';
            mainTableStatus.classList.add('status-append');
        }
    }
    mainTableItem.appendChild(mainTableStatus);

    const mainTableMatchesFilter = matchesMainTableFilter(normalizedFilter);

    if (mainTableMatchesFilter) {
        if (!isFromMainTable) {
            mainTableItem.style.cursor = 'pointer';
            mainTableItem.addEventListener('click', function onMainTableClick() {
                handleAppendTargetClick(CONFIG.MAIN_TABLE_VIRTUAL_ID);
            });
        }
        fragment.appendChild(mainTableItem);
    }

    const otherPresets = AppState.presets.filter(function filterPreset(preset) {
        return preset.id !== sourcePresetId;
    });

    const filteredPresets = otherPresets.filter(function filterByName(preset) {
        if (normalizedFilter === '') return true;
        return (preset.name || '').toLowerCase().indexOf(
            normalizedFilter
        ) !== -1;
    });

    if (filteredPresets.length === 0 && !mainTableMatchesFilter) {
        const emptyHint = document.createElement('div');
        emptyHint.className = 'append-target-empty';
        emptyHint.textContent = '未找到匹配的预设';
        fragment.appendChild(emptyHint);
        container.replaceChildren(fragment);
        return;
    }

    filteredPresets.forEach(function forEachPreset(preset) {
        const presetItem = document.createElement('div');
        presetItem.className = 'append-target-item';

        const presetName = document.createElement('div');
        presetName.className = 'append-target-item-name';
        presetName.textContent = '⭐ ' + (preset.name || '未命名预设');
        presetItem.appendChild(presetName);

        const presetMeta = document.createElement('div');
        presetMeta.className = 'append-target-item-meta';
        const ruleCount = Array.isArray(preset.rules) ? preset.rules.length : 0;
        presetMeta.textContent = ruleCount + ' 条规则';
        presetItem.appendChild(presetMeta);

        const presetStatus = document.createElement('div');
        presetStatus.className = 'append-target-item-status';

        const normalizedSource = normalizeRule(sourceRule);
        const dupInfo = findDuplicateRuleInPreset(normalizedSource, preset);
        if (dupInfo && dupInfo.matchType === 'strict') {
            presetStatus.textContent = '✅ 已存在';
            presetStatus.classList.add('status-exists');
        } else if (dupInfo && dupInfo.matchType === 'substantial') {
            presetStatus.textContent = '⚠️ 同名';
            presetStatus.classList.add('status-substantial');
        } else {
            presetStatus.textContent = '➕ 追加';
            presetStatus.classList.add('status-append');
        }
        presetItem.appendChild(presetStatus);

        presetItem.style.cursor = 'pointer';
        presetItem.addEventListener('click', function onPresetClick() {
            handleAppendTargetClick(preset.id);
        });

        fragment.appendChild(presetItem);
    });

    container.replaceChildren(fragment);
}

function handleAppendTargetClick(targetId) {
    const sourceRule = AppState.currentAppendRule;
    if (!sourceRule) return;

    const now = Date.now();
    const lastAttempt = AppState.lastAppendAttempt;
    if (
        lastAttempt &&
        lastAttempt.targetId === targetId &&
        now - lastAttempt.timestamp < APPEND_ATTEMPT_DEBOUNCE_MS
    ) {
        showToast('请勿重复点击（2 秒内同一目标）', true);
        return;
    }
    AppState.lastAppendAttempt = {
        targetId: targetId,
        timestamp: now
    };

    const addedRule = appendRuleToTarget(sourceRule, targetId, false);

    if (addedRule) {
        if (isMainTableVirtualId(targetId)) {
            showToast(
                '已追加到' + getDefaultRulesDisplayName() + '：' +
                (addedRule.name || '未命名规则')
            );
        } else {
            const targetPreset = AppState.presets.find(function findPreset(p) {
                return p.id === targetId;
            });
            showToast(
                '已追加到预设「' +
                (targetPreset ? targetPreset.name : '') +
                '」：' + (addedRule.name || '未命名规则')
            );
            updatePresetListItemMeta(targetId);
            if (selectedPresetId === targetId) {
                renderPresetDetail();
            }
        }
        saveStateImmediately().catch(function onSaveError(saveError) {
            console.warn('追加后强制保存失败:', saveError);
        });
    }
}

function initializeAppendTargetModal() {
    if (isAppendModalInitialized) return;
    isAppendModalInitialized = true;

    if (DOM.appendTargetCloseButton) {
        DOM.appendTargetCloseButton.addEventListener('click', function onClose() {
            closeAppendTargetModal();
        });
    }
    if (DOM.appendTargetCancelButton) {
        DOM.appendTargetCancelButton.addEventListener(
            'click',
            function onCancel() {
                closeAppendTargetModal();
            }
        );
    }
    if (DOM.appendTargetModalOverlay) {
        DOM.appendTargetModalOverlay.addEventListener(
            'click',
            function onOverlayClick(event) {
                if (event.target === DOM.appendTargetModalOverlay) {
                    closeAppendTargetModal();
                }
            }
        );
    }
    if (DOM.appendTargetSearchInput) {
        DOM.appendTargetSearchInput.addEventListener(
            'input',
            function onSearchInput(event) {
                const filterQuery = event.target.value;
                renderAppendTargetList(
                    AppState.currentAppendRule,
                    AppState.currentAppendSourcePresetId,
                    filterQuery
                );
            }
        );
        DOM.appendTargetSearchInput.addEventListener(
            'keydown',
            function onSearchKeyDown(event) {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    closeAppendTargetModal();
                }
            }
        );
    }
}

// ============================================================================
// 预设内规则增删改
// ============================================================================

function addRuleToPreset() {
    const preset = getSelectedPreset();
    if (!preset) return;

    const isVirtualMain = preset.isVirtual === true;

    if (isVirtualMain) {
        const newRule = {
            id: Date.now() +
                Math.floor(Math.random() * CONFIG.ID_COLLISION_RANDOM_RANGE),
            name: '新规则' + (AppState.defaultRules.length + 1),
            pattern: '',
            replacement: '',
            enabled: true,
            order: AppState.defaultRules.length + 1,
            runChecked: true,
            isRegex: true,
            isJS: false
        };
        AppState.defaultRules.push(newRule);
        addRuleToExistenceIndex(newRule, CONFIG.MAIN_TABLE_VIRTUAL_ID);
        syncDefaultRulesToCustomRulesIfActive();
        scheduleAutoSave();

        renderPresetList();
        renderPresetDetail();
        showToast('已添加规则到' + getDefaultRulesDisplayName());
        return;
    }

    if (!Array.isArray(preset.rules)) {
        preset.rules = [];
    }

    const newRule = {
        id: generatePresetRuleId(),
        name: '新规则' + (preset.rules.length + 1),
        pattern: '',
        replacement: '',
        enabled: true,
        order: preset.rules.length + 1,
        runChecked: true,
        isRegex: true,
        isJS: false
    };

    preset.rules.push(newRule);

    addRuleToExistenceIndex(newRule, preset.id);

    syncPresetRuleAddToCustomRules(preset, newRule);

    touchSelectedPreset();
    renderPresetDetail();
    showToast('已添加规则');
}

function deletePresetRule(ruleId) {
    const preset = getSelectedPreset();
    if (!preset || !Array.isArray(preset.rules)) return;

    const isVirtualMain = preset.isVirtual === true;

    const removedIndex = preset.rules.findIndex(function findRule(rule) {
        return String(rule.id) === String(ruleId);
    });
    if (removedIndex === -1) return;

    const removedRule = preset.rules[removedIndex];

    if (isVirtualMain) {
        const remainingCount = AppState.defaultRules.length - 1;

        if (remainingCount >= CONFIG.DELETE_RULE_CONFIRM_THRESHOLD) {
            const confirmed = confirm(
                '确定删除' + getDefaultRulesDisplayName() + '中的规则「' +
                (removedRule.name || '未命名规则') + '」吗？\n\n' +
                '· ' + getDefaultRulesDisplayName() + '当前有 ' +
                AppState.defaultRules.length + ' 条规则'
            );
            if (!confirmed) return;
        }

        AppState.defaultRules.splice(removedIndex, 1);
        AppState.defaultRules.forEach(function reindex(rule, index) {
            rule.order = index + 1;
        });
        removeRuleFromExistenceIndex(
            removedRule,
            CONFIG.MAIN_TABLE_VIRTUAL_ID
        );
        syncDefaultRulesToCustomRulesIfActive();
        scheduleAutoSave();

        renderPresetList();
        renderPresetDetail();
        showToast('已删除规则：' + (removedRule.name || '未命名规则'));
        return;
    }

    preset.rules.splice(removedIndex, 1);
    preset.rules.forEach(function reindex(rule, index) {
        rule.order = index + 1;
    });

    removeRuleFromExistenceIndex(removedRule, preset.id);

    syncPresetRuleDeleteToCustomRules(preset, removedRule);

    touchSelectedPreset();
    renderPresetDetail();

    showToast('已删除规则：' + (removedRule.name || '未命名规则'));
}

function movePresetRuleRelativeToVisible(rule, direction) {
    const preset = getSelectedPreset();
    if (!preset || !Array.isArray(preset.rules)) return;

    const isVirtualMain = preset.isVirtual === true;

    const normalizedQuery = searchQuery.trim().toLowerCase();
    const isFilteredView = (
        normalizedQuery !== '' &&
        AppState.presetSearchScope === 'all' &&
        !isVirtualMain
    );

    if (isFilteredView) {
        const visibleRulesReference = getFilteredRulesForPreset(
            preset,
            normalizedQuery
        );

        const visibleIndex = visibleRulesReference.findIndex(
            function findRule(r) {
                return String(r.id) === String(rule.id);
            }
        );
        if (visibleIndex === -1) return;

        const targetVisibleIndex = visibleIndex + direction;
        if (
            targetVisibleIndex < 0 ||
            targetVisibleIndex >= visibleRulesReference.length
        ) {
            return;
        }

        const targetVisibleRule = visibleRulesReference[targetVisibleIndex];

        const fullIndexA = preset.rules.findIndex(function findRule(r) {
            return String(r.id) === String(rule.id);
        });
        const fullIndexB = preset.rules.findIndex(function findRule(r) {
            return String(r.id) === String(targetVisibleRule.id);
        });
        if (fullIndexA === -1 || fullIndexB === -1) return;

        const tempOrder = preset.rules[fullIndexA].order;
        preset.rules[fullIndexA].order = preset.rules[fullIndexB].order;
        preset.rules[fullIndexB].order = tempOrder;

        preset.rules.sort(function sortRules(a, b) {
            return a.order - b.order;
        });
        preset.rules.forEach(function reindex(r, index) {
            r.order = index + 1;
        });

        if (isVirtualMain) {
            syncDefaultRulesToCustomRulesIfActive();
            scheduleAutoSave();
            renderPresetList();
            renderPresetDetail();
            showToast(getDefaultRulesDisplayName() + '顺序已调整');
            return;
        }

        syncPresetRuleReorderToCustomRules(preset);
        touchSelectedPreset();
        renderPresetDetail();
        showToast('顺序已调整');
        return;
    }

    movePresetRule(rule.order, direction);
}

function movePresetRule(currentOrder, delta) {
    const preset = getSelectedPreset();
    if (!preset || !Array.isArray(preset.rules)) return;

    const isVirtualMain = preset.isVirtual === true;

    const currentIndex = preset.rules.findIndex(function findRule(rule) {
        return rule.order === currentOrder;
    });
    if (currentIndex === -1) return;

    const targetIndex = currentIndex + delta;
    if (targetIndex < 0 || targetIndex >= preset.rules.length) return;

    const temporaryOrder = preset.rules[currentIndex].order;
    preset.rules[currentIndex].order = preset.rules[targetIndex].order;
    preset.rules[targetIndex].order = temporaryOrder;

    preset.rules.sort(function sortRules(ruleA, ruleB) {
        return ruleA.order - ruleB.order;
    });
    preset.rules.forEach(function reindex(rule, index) {
        rule.order = index + 1;
    });

    if (isVirtualMain) {
        syncDefaultRulesToCustomRulesIfActive();
        scheduleAutoSave();
        renderPresetList();
        renderPresetDetail();
        showToast(getDefaultRulesDisplayName() + '顺序已调整');
        return;
    }

    syncPresetRuleReorderToCustomRules(preset);

    touchSelectedPreset();
    renderPresetDetail();
    showToast('顺序已调整');
}

function movePresetRuleToTop(ruleId) {
    const preset = getSelectedPreset();
    if (!preset || !Array.isArray(preset.rules)) return;

    const isVirtualMain = preset.isVirtual === true;

    const currentIndex = preset.rules.findIndex(function findRule(rule) {
        return String(rule.id) === String(ruleId);
    });
    if (currentIndex <= 0) return;

    const removedRule = preset.rules.splice(currentIndex, 1)[0];
    preset.rules.unshift(removedRule);
    preset.rules.forEach(function reindex(rule, index) {
        rule.order = index + 1;
    });

    if (isVirtualMain) {
        syncDefaultRulesToCustomRulesIfActive();
        scheduleAutoSave();
        renderPresetList();
        renderPresetDetail();
        showToast('已置顶');
        return;
    }

    syncPresetRuleReorderToCustomRules(preset);

    touchSelectedPreset();
    renderPresetDetail();
    showToast('已置顶');
}

function movePresetRuleToBottom(ruleId) {
    const preset = getSelectedPreset();
    if (!preset || !Array.isArray(preset.rules)) return;

    const isVirtualMain = preset.isVirtual === true;

    const currentIndex = preset.rules.findIndex(function findRule(rule) {
        return String(rule.id) === String(ruleId);
    });
    if (
        currentIndex === -1 ||
        currentIndex === preset.rules.length - 1
    ) {
        return;
    }

    const removedRule = preset.rules.splice(currentIndex, 1)[0];
    preset.rules.push(removedRule);
    preset.rules.forEach(function reindex(rule, index) {
        rule.order = index + 1;
    });

    if (isVirtualMain) {
        syncDefaultRulesToCustomRulesIfActive();
        scheduleAutoSave();
        renderPresetList();
        renderPresetDetail();
        showToast('已置底');
        return;
    }

    syncPresetRuleReorderToCustomRules(preset);

    touchSelectedPreset();
    renderPresetDetail();
    showToast('已置底');
}

// ============================================================================
// 预设创建 / 重命名 / 另存为
// ============================================================================

function createFromCurrentTable() {
    if (
        !Array.isArray(AppState.customRules) ||
        AppState.customRules.length === 0
    ) {
        if (!confirm(
            '⚠️ 当前工作区为空。\n\n' +
            '从空内容创建预设将得到一个不包含任何规则的预设。\n' +
            '仍要继续吗？'
        )) {
            return;
        }
    }

    const defaultName = '预设 ' + (AppState.presets.length + 1);
    const userInput = prompt('请输入预设名称：', defaultName);
    if (userInput === null) return;

    const trimmedName = userInput.trim();
    if (!trimmedName) {
        showToast('预设名称不能为空', true);
        return;
    }
    if (trimmedName.length > PRESET_NAME_MAX_LENGTH) {
        showToast(
            '预设名称不能超过 ' + PRESET_NAME_MAX_LENGTH + ' 字符',
            true
        );
        return;
    }

    const rulesCopy = JSON.parse(
        JSON.stringify(AppState.customRules || [])
    );
    rulesCopy.forEach(function reindex(rule, index) {
        rule.id = derivePresetRuleIdFromMainId(rule.id);
        rule.order = index + 1;
    });

    const newPreset = {
        id: generatePresetId(),
        name: trimmedName,
        rules: rulesCopy,
        createdAt: Date.now(),
        updatedAt: Date.now()
    };

    AppState.presets.push(newPreset);
    AppState.activePresetId = newPreset.id;
    invalidateExistenceIndex();
    clearPresetFilterCache();
    scheduleAutoSave();

    selectedPresetId = newPreset.id;
    renderPresetList();
    renderPresetDetail();
    updateActivePresetIndicator();

    showToast(
        '已从当前工作区创建预设：' + trimmedName + '（已设为当前工作区）'
    );
}

function createBlankPreset() {
    const defaultName = '预设 ' + (AppState.presets.length + 1);
    const userInput = prompt('请输入预设名称：', defaultName);
    if (userInput === null) return;

    const trimmedName = userInput.trim();
    if (!trimmedName) {
        showToast('预设名称不能为空', true);
        return;
    }
    if (trimmedName.length > PRESET_NAME_MAX_LENGTH) {
        showToast(
            '预设名称不能超过 ' + PRESET_NAME_MAX_LENGTH + ' 字符',
            true
        );
        return;
    }

    const newPreset = {
        id: generatePresetId(),
        name: trimmedName,
        rules: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
    };

    AppState.presets.push(newPreset);
    invalidateExistenceIndex();
    clearPresetFilterCache();
    scheduleAutoSave();

    selectedPresetId = newPreset.id;
    renderPresetList();
    renderPresetDetail();

    showToast('已创建空白预设：' + trimmedName);
}

function renamePreset() {
    const preset = getSelectedPreset();
    if (!preset) return;

    if (preset.isVirtual) {
        renameDefaultRules();
        return;
    }

    const userInput = prompt('请输入新的预设名称：', preset.name);
    if (userInput === null) return;

    const trimmedName = userInput.trim();
    if (!trimmedName) {
        showToast('预设名称不能为空', true);
        return;
    }
    if (trimmedName.length > PRESET_NAME_MAX_LENGTH) {
        showToast(
            '预设名称不能超过 ' + PRESET_NAME_MAX_LENGTH + ' 字符',
            true
        );
        return;
    }
    if (trimmedName === preset.name) return;

    preset.name = trimmedName;
    preset.updatedAt = Date.now();
    clearPresetFilterCache();
    scheduleAutoSave();

    renderPresetList();
    renderPresetDetail();
    updateActivePresetIndicator();

    showToast('已重命名为：' + trimmedName);
}

function renameDefaultRules() {
    const currentName = getDefaultRulesDisplayName();
    const userInput = prompt('请输入新的默认规则名称：', currentName);
    if (userInput === null) return;

    const trimmedName = userInput.trim();
    if (!trimmedName) {
        showToast('名称不能为空', true);
        return;
    }
    if (trimmedName === currentName) return;
    if (trimmedName.length > PRESET_NAME_MAX_LENGTH) {
        showToast(
            '名称不能超过 ' + PRESET_NAME_MAX_LENGTH + ' 字符',
            true
        );
        return;
    }

    const confirmed = confirm(
        '确定把「' + currentName + '」重命名为「' + trimmedName + '」吗？\n\n' +
        '· 默认规则是置顶的特殊预设，与命名预设平级\n' +
        '· 重命名后，所有相关提示与徽章将使用新名称'
    );
    if (!confirmed) return;

    AppState.defaultRulesName = trimmedName;
    invalidateExistenceIndex();
    clearPresetFilterCache();
    updateActivePresetIndicator();
    scheduleAutoSave();

    renderPresetList();
    renderPresetDetail();

    showToast('已重命名为：' + trimmedName);
}

function saveAsPreset() {
    const preset = getSelectedPreset();
    if (!preset) return;

    if (preset.isVirtual) {
        const defaultName = getDefaultRulesDisplayName() + ' 副本 ' +
            (AppState.presets.length + 1);
        const userInput = prompt('请输入新预设名称：', defaultName);
        if (userInput === null) return;

        const trimmedName = userInput.trim();
        if (!trimmedName) {
            showToast('预设名称不能为空', true);
            return;
        }
        if (trimmedName.length > PRESET_NAME_MAX_LENGTH) {
            showToast(
                '预设名称不能超过 ' + PRESET_NAME_MAX_LENGTH + ' 字符',
                true
            );
            return;
        }

        const rulesCopy = JSON.parse(
            JSON.stringify(AppState.defaultRules || [])
        );
        rulesCopy.forEach(function reindex(rule) {
            rule.id = derivePresetRuleIdFromMainId(rule.id);
        });

        const newPreset = {
            id: generatePresetId(),
            name: trimmedName,
            rules: rulesCopy,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };

        AppState.presets.push(newPreset);
        invalidateExistenceIndex();
        clearPresetFilterCache();
        scheduleAutoSave();

        selectedPresetId = newPreset.id;
        renderPresetList();
        renderPresetDetail();

        showToast(
            '已把' + getDefaultRulesDisplayName() + '另存为：' + trimmedName
        );
        return;
    }

    const defaultName = preset.name + ' - 副本';
    const userInput = prompt('请输入新预设名称：', defaultName);
    if (userInput === null) return;

    const trimmedName = userInput.trim();
    if (!trimmedName) {
        showToast('预设名称不能为空', true);
        return;
    }
    if (trimmedName.length > PRESET_NAME_MAX_LENGTH) {
        showToast(
            '预设名称不能超过 ' + PRESET_NAME_MAX_LENGTH + ' 字符',
            true
        );
        return;
    }

    const rulesCopy = JSON.parse(JSON.stringify(preset.rules || []));
    rulesCopy.forEach(function reindex(rule) {
        rule.id = generatePresetRuleId();
    });

    const newPreset = {
        id: generatePresetId(),
        name: trimmedName,
        rules: rulesCopy,
        createdAt: Date.now(),
        updatedAt: Date.now()
    };

    AppState.presets.push(newPreset);
    invalidateExistenceIndex();
    clearPresetFilterCache();
    scheduleAutoSave();

    selectedPresetId = newPreset.id;
    renderPresetList();
    renderPresetDetail();

    showToast('已另存为：' + trimmedName);
}

// ============================================================================
// 删除预设
// ============================================================================

function deletePreset() {
    const preset = getSelectedPreset();
    if (!preset) return;
    if (preset.isVirtual) {
        showToast(
            getDefaultRulesDisplayName() + '是特殊预设，不可删除',
            true
        );
        return;
    }

    const isActive = preset.id === AppState.activePresetId;

    let confirmMessage = '确定删除预设「' + preset.name + '」吗？';
    if (isActive) {
        const hasUnsavedChanges = checkMainTableHasUnsavedChanges();
        confirmMessage = '⚠️ 该预设是当前工作区。\n\n' +
            confirmMessage + '\n\n（删除后将切换到' +
            getDefaultRulesDisplayName() + '）';
        if (hasUnsavedChanges) {
            confirmMessage +=
                '\n\n⚠️ 当前工作区有未保存的修改，删除后将丢失！';
        }
    }

    if (!confirm(confirmMessage)) {
        return;
    }

    const presetIndex = AppState.presets.findIndex(function findPreset(item) {
        return item.id === preset.id;
    });
    if (presetIndex === -1) return;

    const removedPreset = AppState.presets[presetIndex];
    const wasActive = removedPreset.id === AppState.activePresetId;

    AppState.presets.splice(presetIndex, 1);
    if (wasActive) {
        AppState.activePresetId = CONFIG.MAIN_TABLE_VIRTUAL_ID;
        AppState.customRules = AppState.defaultRules.map(function mapRule(rule) {
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
        AppState.mainTableDirtyForActivePreset = false;
        renderRuleTable();
        updateActivePresetIndicator();
    }
    invalidateExistenceIndex();
    clearPresetFilterCache();
    scheduleAutoSave();

    if (AppState.presets.length > 0) {
        const nextIndex = Math.min(
            presetIndex,
            AppState.presets.length - 1
        );
        selectedPresetId = AppState.presets[nextIndex].id;
    } else {
        selectedPresetId = CONFIG.MAIN_TABLE_VIRTUAL_ID;
    }

    renderPresetList();
    renderPresetDetail();

    showToast('已删除预设：' + removedPreset.name);
}

// ============================================================================
// 加载预设为当前工作区
// ============================================================================

function loadPresetToMain() {
    const preset = getSelectedPreset();
    if (!preset) return;
    if (preset.isVirtual) {
        showToast(
            getDefaultRulesDisplayName() + '本身就是当前工作区',
            true
        );
        return;
    }

    flushPendingPresetSync();

    const hasUnsavedChanges = checkMainTableHasUnsavedChanges();
    const presetRuleCount = Array.isArray(preset.rules)
        ? preset.rules.length
        : 0;
    const currentRuleCount = AppState.customRules.length;

    let confirmMessage = '';
    if (hasUnsavedChanges) {
        confirmMessage += '⚠️ 当前工作区有未保存的修改。\n\n';
    }

    if (presetRuleCount === 0) {
        if (currentRuleCount > 0) {
            confirmMessage +=
                '⚠️ 预设「' + preset.name + '」为空。\n\n' +
                '加载后，当前工作区的 ' + currentRuleCount +
                ' 条规则将被清空。\n\n' +
                '确定继续吗？';
        } else {
            confirmMessage +=
                '确定加载空预设「' + preset.name + '」吗？\n\n' +
                '（当前工作区已为空，加载后仍为空）';
        }
    } else {
        confirmMessage +=
            '确定把预设「' + preset.name + '」加载为当前工作区吗？\n\n' +
            '· 当前工作区的 ' + currentRuleCount +
            ' 条规则将被替换为 ' + presetRuleCount + ' 条';
        if (hasUnsavedChanges) {
            confirmMessage +=
                '\n· 当前工作区未保存的修改将被丢弃';
        }
    }

    if (!confirm(confirmMessage)) {
        return;
    }

    const previousActivePresetId = AppState.activePresetId;
    const previousCustomRules = AppState.customRules;

    AppState.activePresetId = preset.id;

    try {
        const sourceRules = JSON.parse(JSON.stringify(preset.rules || []));
        replaceMainTableWithRules(sourceRules, {
            skipDefaultRulesSync: true
        });
    } catch (loadError) {
        AppState.activePresetId = previousActivePresetId;
        AppState.customRules = previousCustomRules;
        invalidateExistenceIndex();
        renderRuleTable();
        updateActivePresetIndicator();
        console.error('加载预设失败:', loadError);
        showToast(
            '加载预设失败: ' + (loadError.message || '未知错误'),
            true
        );
        return;
    }

    AppState.mainTableDirtyForActivePreset = false;

    updateActivePresetIndicator();

    closePresetManagerModal();
    showToast('已加载预设「' + preset.name + '」为当前工作区');
}

// ============================================================================
// 主表 → 预设 显式同步
// ============================================================================

function handleSyncToActivePreset() {
    const preset = getActivePreset();
    if (!preset) {
        if (AppState.activePresetId === CONFIG.MAIN_TABLE_VIRTUAL_ID) {
            showToast(
                '当前工作区就是' + getDefaultRulesDisplayName() +
                '本身，无需保存回预设'
            );
            return;
        }

        showToast('当前没有指定的工作区预设', true);
        AppState.activePresetId = CONFIG.MAIN_TABLE_VIRTUAL_ID;
        updateActivePresetIndicator();
        scheduleAutoSave();
        return;
    }

    if (AppState.customRules.length === 0) {
        const currentRuleCount = preset.rules ? preset.rules.length : 0;
        if (currentRuleCount > 0) {
            if (!confirm(
                '⚠️ 当前工作区为空。\n\n' +
                '同步后预设「' + preset.name + '」的 ' +
                currentRuleCount + ' 条规则将被清空。\n\n' +
                '是否继续？'
            )) {
                return;
            }
        }
    }

    preset.rules = AppState.customRules.map(function mapRule(mainRule, index) {
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
    preset.updatedAt = Date.now();

    invalidateExistenceIndex();
    clearPresetFilterCache();
    AppState.mainTableDirtyForActivePreset = false;
    scheduleAutoSave();

    renderPresetList();
    if (selectedPresetId === preset.id) {
        renderPresetDetail();
    }
    updatePresetListItemMeta(preset.id);

    const syncedCount = preset.rules.length;
    showToast(
        '💾 已保存 ' + syncedCount + ' 条规则到预设「' + preset.name + '」'
    );
}

// ============================================================================
// 搜索范围切换
// ============================================================================

function updateSearchScopeButtonUI() {
    if (!DOM.presetSearchScopeButton) return;
    if (AppState.presetSearchScope === 'all') {
        DOM.presetSearchScopeButton.classList.add('all-active');
        DOM.presetSearchScopeButton.classList.remove('name-only-active');
        DOM.presetSearchScopeButton.textContent = '🔍';
        DOM.presetSearchScopeButton.title =
            '当前：搜索预设名 + 规则内容。点击切换为仅搜索预设名';
    } else {
        DOM.presetSearchScopeButton.classList.remove('all-active');
        DOM.presetSearchScopeButton.classList.add('name-only-active');
        DOM.presetSearchScopeButton.textContent = '🏷️';
        DOM.presetSearchScopeButton.title =
            '当前：仅搜索预设名。点击切换为搜索全部';
    }
}

function updateSearchDataSourceButtonUI() {
    if (!DOM.presetSearchDataSourceButton) return;
    if (AppState.searchDataSource === SEARCH_DATA_SOURCE.ALL) {
        DOM.presetSearchDataSourceButton.classList.add('all-active');
        DOM.presetSearchDataSourceButton.classList.remove('current-active');
        DOM.presetSearchDataSourceButton.textContent = '🌐';
        DOM.presetSearchDataSourceButton.title =
            '当前：搜索全部预设。点击切换为仅搜索当前选中项';
    } else {
        DOM.presetSearchDataSourceButton.classList.remove('all-active');
        DOM.presetSearchDataSourceButton.classList.add('current-active');
        DOM.presetSearchDataSourceButton.textContent = '🏷️';
        DOM.presetSearchDataSourceButton.title =
            '当前：仅搜索当前选中项。点击切换为搜索全部预设';
    }
}

function togglePresetSearchScope() {
    if (AppState.presetSearchScope === 'all') {
        AppState.presetSearchScope = 'nameOnly';
    } else {
        AppState.presetSearchScope = 'all';
    }
    clearPresetFilterCache();
    updateSearchScopeButtonUI();
    renderPresetList();
    renderPresetDetail();
    scheduleAutoSave();
}

function toggleSearchDataSource() {
    if (AppState.searchDataSource === SEARCH_DATA_SOURCE.ALL) {
        AppState.searchDataSource = SEARCH_DATA_SOURCE.CURRENT;
    } else {
        AppState.searchDataSource = SEARCH_DATA_SOURCE.ALL;
    }
    clearPresetFilterCache();
    updateSearchDataSourceButtonUI();
    renderPresetList();
    renderPresetDetail();
    scheduleAutoSave();
}

// ============================================================================
// 初始化
// ============================================================================

export function initializePresetManager() {
    if (isPresetManagerInitialized) return;
    isPresetManagerInitialized = true;

    if (DOM.presetModalFullscreenButton) {
        DOM.presetModalFullscreenButton.addEventListener(
            'click',
            toggleExpandedMode
        );
    }

    if (DOM.presetModalCloseButton) {
        DOM.presetModalCloseButton.addEventListener(
            'click',
            closePresetManagerModal
        );
    }

    if (DOM.presetManagerModalOverlay) {
        DOM.presetManagerModalOverlay.addEventListener(
            'click',
            function onOverlayClick(event) {
                if (event.target === DOM.presetManagerModalOverlay) {
                    closePresetManagerModal();
                }
            }
        );
    }

    if (DOM.presetCancelButton) {
        DOM.presetCancelButton.addEventListener(
            'click',
            closePresetManagerModal
        );
    }

    if (DOM.presetSearchInput) {
        DOM.presetSearchInput.addEventListener('input', function onInput(
            event
        ) {
            if (searchDebounceTimer) {
                clearTimeout(searchDebounceTimer);
            }
            const inputValue = event.target.value;
            searchDebounceTimer = setTimeout(function onDebounce() {
                searchDebounceTimer = null;
                searchQuery = inputValue;
                clearPresetFilterCache();
                renderPresetList();
                renderPresetDetail();
            }, CONFIG.PRESET_SEARCH_DEBOUNCE_MS);
        });
    }

    if (DOM.presetSearchScopeButton) {
        DOM.presetSearchScopeButton.addEventListener('click', function onClick() {
            togglePresetSearchScope();
        });
    }

    if (DOM.presetSearchDataSourceButton) {
        DOM.presetSearchDataSourceButton.addEventListener(
            'click',
            function onClick() {
                toggleSearchDataSource();
            }
        );
    }

    if (DOM.presetCreateFromCurrentButton) {
        DOM.presetCreateFromCurrentButton.addEventListener(
            'click',
            createFromCurrentTable
        );
    }

    if (DOM.presetCreateBlankButton) {
        DOM.presetCreateBlankButton.addEventListener(
            'click',
            createBlankPreset
        );
    }

    if (DOM.presetEmptyCreateFromCurrentButton) {
        DOM.presetEmptyCreateFromCurrentButton.addEventListener(
            'click',
            createFromCurrentTable
        );
    }
    if (DOM.presetEmptyCreateBlankButton) {
        DOM.presetEmptyCreateBlankButton.addEventListener(
            'click',
            createBlankPreset
        );
    }

    if (DOM.presetNameEditButton) {
        DOM.presetNameEditButton.addEventListener('click', renamePreset);
    }

    if (DOM.presetAddRuleButton) {
        DOM.presetAddRuleButton.addEventListener('click', addRuleToPreset);
    }

    if (DOM.presetSaveAsButton) {
        DOM.presetSaveAsButton.addEventListener('click', saveAsPreset);
    }

    if (DOM.presetDeleteButton) {
        DOM.presetDeleteButton.addEventListener('click', deletePreset);
    }

    if (DOM.presetApplyButton) {
        DOM.presetApplyButton.addEventListener('click', loadPresetToMain);
    }

    if (DOM.presetMobileBackButton) {
        DOM.presetMobileBackButton.addEventListener(
            'click',
            function onBack() {
                if (DOM.presetManagerModal) {
                    DOM.presetManagerModal.classList.remove(
                        'mobile-detail-view'
                    );
                }
            }
        );
    }

    initializeAppendTargetModal();
    initializePresetHelpTooltip();

    document.addEventListener('keydown', function onGlobalKeyDown(event) {
        if (event.key === 'Escape') {
            if (AppState.presetHelpTooltipOpen) {
                event.preventDefault();
                event.stopPropagation();
                hideHelpTooltip();
                return;
            }

            if (modalIsOpen) {
                if (AppState.modalStack.length > 0) {
                    const topModal = AppState.modalStack[
                        AppState.modalStack.length - 1
                    ];
                    if (topModal && topModal.id !== 'presetManagerModal') {
                        event.preventDefault();
                        event.stopPropagation();
                        handleModalStackEscape();
                        return;
                    }
                }
                closePresetManagerModal();
            }
        }
    });

    if (!isEventListenerInitialized) {
        isEventListenerInitialized = true;

        document.addEventListener(
            'textpro:sync-to-active-preset',
            function onSyncToActivePreset() {
                handleSyncToActivePreset();
            }
        );

        document.addEventListener(
            'textpro:clear-active-preset-association',
            function onClearAssociation() {
                if (AppState.activePresetId === CONFIG.MAIN_TABLE_VIRTUAL_ID) {
                    showToast(
                        '当前工作区已经是' + getDefaultRulesDisplayName(),
                        true
                    );
                    return;
                }

                const activePreset = getActivePreset();

                const confirmed = confirm(
                    '确定切换回' + getDefaultRulesDisplayName() + '吗？\n\n' +
                    '· 当前工作区内容将被替换为' +
                    getDefaultRulesDisplayName() + '的规则\n' +
                    '· 未保存的修改将丢弃'
                );
                if (!confirmed) return;

                AppState.activePresetId = CONFIG.MAIN_TABLE_VIRTUAL_ID;

                AppState.customRules = AppState.defaultRules.map(
                    function mapRule(rule) {
                        return {
                            id: rule.id,
                            name: rule.name || '未命名规则',
                            pattern: typeof rule.pattern === 'string'
                                ? rule.pattern
                                : '',
                            replacement: typeof rule.replacement === 'string'
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

                AppState.mainTableDirtyForActivePreset = false;

                invalidateExistenceIndex();
                renderRuleTable();
                updateActivePresetIndicator();
                scheduleAutoSave();

                renderPresetList();
                renderPresetDetail();

                showToast(
                    '已切换回' +
                    (activePreset
                        ? '（原预设「' + activePreset.name + '」）'
                        : '') +
                    getDefaultRulesDisplayName()
                );
            }
        );

        document.addEventListener(
            'textpro:preset-updated',
            function onPresetUpdated(event) {
                if (!modalIsOpen) return;
                const presetId = event.detail && event.detail.presetId;
                if (!presetId) return;
                clearPresetFilterCache();
                updatePresetListItemMeta(presetId);
                if (selectedPresetId === presetId) {
                    renderPresetDetail();
                }
            }
        );

        document.addEventListener(
            'textpro:main-table-rendered',
            function onMainTableRendered() {
                if (!modalIsOpen) return;
                updateMainTableVirtualItemMeta();
            }
        );

        document.addEventListener(
            'textpro:rule-appended',
            function onRuleAppended() {
                if (!AppState.appendTargetModalOpen) return;

                closeAppendTargetModal();

                clearPresetFilterCache();
                renderPresetList();
                if (selectedPresetId) {
                    renderPresetDetail();
                }
            }
        );
    }

    updateExpandButtonUI();
    updateSearchScopeButtonUI();
    updateSearchDataSourceButtonUI();
}