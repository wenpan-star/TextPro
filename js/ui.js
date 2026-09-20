// filename: js/ui.js
/**
 * ============================================================================
 * ui.js — 主 UI 事件绑定
 * ============================================================================
 *
 * 【本次修订说明】
 *
 *   一、【P0 修复】模板面板并发点击 Bug（保留上一版修复）
 *     · 在 onPanelClick 开头统一检查 isZhConversionInProgress，
 *       转换进行中时拒绝所有面板内按钮点击，避免结果被后续异步转换覆盖。
 *
 *   二、【P0 修复】模板面板打开时 Esc 无法关闭
 *     · handleGlobalKeyDown 增加最高优先级的 Esc 分支：
 *       若模板面板当前可见，则关闭面板并阻止事件继续传播。
 *     · 此分支必须放在模态框检查之前，保证"最表层 UI 优先关闭"。
 *
 *   三、保留全部既有能力
 *     · 所有原有事件绑定逻辑不变
 *     · 繁简转换的加载态、并发保护、preloadOpenCC 预热全部保留
 *     · updateStorageUnavailableBanner 识别 userSkippedAutoLoad
 *
 *   四、代码风格
 *     · 所有变量名与逻辑完整保留，未做任何简写
 * ============================================================================
 */

import { CONFIG, STORAGE_KEYS } from './config.js';
import { AppState } from './state.js';
import { DOM } from './dom.js';
import { showToast } from './toast.js';
import { saveLocalBackup } from './storage.js';
import {
    getSourceText,
    getResultText,
    setSourceText,
    setResultText,
    checkTextSize,
    getTextStatistics
} from './editor-api.js';
import {
    performReplaceAsync
} from './text-processor.js';
import {
    renderRuleTable,
    addNewRule,
    resetToDefaultRules,
    batchRunCheckedRules,
    cancelBatchRun,
    selectAllRunChecks,
    updateBatchRunButtonLabel,
    initializeBatchRunErrorBar,
    flushPendingPresetSync,
    invalidateExistenceIndex,
    syncCustomRulesToDefaultRulesIfActive
} from './rules.js';
import { updateSearchMatches, clearSearchState } from './search.js';
import {
    exportFullConfig,
    importFullConfigFromFile
} from './settings-io.js';
import {
    scheduleAutoSave,
    saveStateImmediately,
    forceSaveBeforeUnload,
    syncDarkModeToggleButtonText
} from './persistence.js';
import {
    confirmJSMode,
    hasAnyJsTrust,
    revokeSessionTrust,
    clearAllRuleJsTrust
} from './security.js';
import {
    openPresetManagerModal,
    initializePresetManager,
    checkMainTableHasUnsavedChanges
} from './presets.js';
import {
    getT2SConverter,
    getS2TConverter,
    preloadOpenCC
} from './zh-convert.js';

let isUiEventsBound = false;

// ============================================================================
// 顶部状态指示器
// ============================================================================

export function updateStorageUnavailableBanner() {
    if (!DOM.storageUnavailableBanner) return;

    // ★ 用户主动跳过自动加载 → 存储本身没问题，只是用户主动选择不使用。
    //   隐藏"存储不可用"警告，避免误导。
    if (AppState.userSkippedAutoLoad === true) {
        DOM.storageUnavailableBanner.style.display = 'none';
        return;
    }

    if (AppState.databaseReady) {
        DOM.storageUnavailableBanner.style.display = 'none';
    } else {
        DOM.storageUnavailableBanner.style.display = 'block';
        if (!AppState.storageUnavailableBannerShown) {
            AppState.storageUnavailableBannerShown = true;
            showToast(
                '⚠️ 浏览器存储不可用，本次编辑不会被持久化',
                true
            );
        }
    }
}

export function updatePersistentStorageBanner() {
    const banner = DOM.storagePersistenceBanner;
    if (!banner) return;

    const granted = AppState.persistentStorageGranted;

    if (granted === 'denied') {
        banner.style.display = 'block';
    } else {
        banner.style.display = 'none';
    }
}

export function updateJsTrustIndicator() {
    const indicator = DOM.jsTrustIndicator;
    if (!indicator) return;

    const trusted = hasAnyJsTrust();
    if (trusted) {
        if (CONFIG.JS_TRUST_RULE_BASED) {
            indicator.textContent = '🔓 已信任 ' +
                AppState.jsTrustedRuleIds.size + ' 条 JS 规则';
            indicator.title =
                '已按规则信任的 JS 模式不会重复询问；点击可撤销全部信任';
        } else {
            indicator.textContent = '🔓 本会话已信任 JS 模式（点击撤销）';
            indicator.title = '点击后，下次启用 JS 模式会重新弹出安全确认';
        }
        indicator.style.display = 'inline-flex';
        indicator.classList.add('trusted');
    } else {
        indicator.textContent = '🔒 JS 模式需确认';
        indicator.title = '当前会话尚未信任 JS 模式';
        indicator.style.display = 'inline-flex';
        indicator.classList.remove('trusted');
    }
}

// ============================================================================
// 全局选项复选框状态同步
// ============================================================================

function bindGlobalOptionCheckboxesToState() {
    if (DOM.globalFlagG) {
        DOM.globalFlagG.addEventListener('change', function onFlagGChange(event) {
            AppState.flagG = event.target.checked;
            scheduleAutoSave();
        });
    }
    if (DOM.globalFlagI) {
        DOM.globalFlagI.addEventListener('change', function onFlagIChange(event) {
            AppState.flagI = event.target.checked;
            scheduleAutoSave();
        });
    }
    if (DOM.globalFlagM) {
        DOM.globalFlagM.addEventListener('change', function onFlagMChange(event) {
            AppState.flagM = event.target.checked;
            scheduleAutoSave();
        });
    }
    if (DOM.loopUntilStableCheckbox) {
        DOM.loopUntilStableCheckbox.addEventListener(
            'change',
            function onLoopChange(event) {
                AppState.loopUntilStable = event.target.checked;
                scheduleAutoSave();
            }
        );
    }

    if (DOM.autoLoadSnapshotCheckbox) {
        DOM.autoLoadSnapshotCheckbox.addEventListener(
            'change',
            function onAutoLoadChange(event) {
                AppState.autoLoadSnapshot = event.target.checked;
                saveLocalBackup(
                    STORAGE_KEYS.UI_AUTO_LOAD_SNAPSHOT,
                    event.target.checked
                );
                scheduleAutoSave();
            }
        );
    }

    if (DOM.quickCheckboxG) {
        DOM.quickCheckboxG.addEventListener(
            'change',
            function onQuickGChange(event) {
                AppState.quickG = event.target.checked;
                scheduleAutoSave();
            }
        );
    }
    if (DOM.quickCheckboxI) {
        DOM.quickCheckboxI.addEventListener(
            'change',
            function onQuickIChange(event) {
                AppState.quickI = event.target.checked;
                scheduleAutoSave();
            }
        );
    }
    if (DOM.quickCheckboxM) {
        DOM.quickCheckboxM.addEventListener(
            'change',
            function onQuickMChange(event) {
                AppState.quickM = event.target.checked;
                scheduleAutoSave();
            }
        );
    }
    if (DOM.quickCheckboxJsMode) {
        DOM.quickCheckboxJsMode.addEventListener(
            'change',
            function onQuickJsModeChange(event) {
                AppState.quickJsMode = event.target.checked;
                scheduleAutoSave();
            }
        );
    }
}

// ============================================================================
// 导入 / 导出
// ============================================================================

function handleImportTxtFile() {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.txt,text/plain';

    fileInput.onchange = function onFileChange(event) {
        const selectedFile = event.target.files[0];
        if (!selectedFile) return;

        const fileReader = new FileReader();
        fileReader.onload = function onReaderLoad(loadEvent) {
            const importedText = String(loadEvent.target.result || '');

            if (!checkTextSize(importedText, '导入 TXT')) {
                return;
            }

            AppState.lastImportedFileName = selectedFile.name;
            saveLocalBackup(
                STORAGE_KEYS.UI_LAST_IMPORTED_FILENAME,
                selectedFile.name
            );

            setSourceText(importedText, true);
            scheduleAutoSave();
            showToast('已导入 ' + selectedFile.name);
        };
        fileReader.onerror = function onReaderError() {
            showToast('文件读取失败', true);
        };
        fileReader.readAsText(selectedFile, 'UTF-8');
    };

    fileInput.click();
}

function handleExportTxtFile() {
    let exportContent = getResultText();
    if (!exportContent) {
        exportContent = getSourceText();
        if (!exportContent) {
            showToast('没有可导出的文本', true);
            return;
        }
    }

    let fileName;
    if (AppState.lastImportedFileName) {
        const dotIndex = AppState.lastImportedFileName.lastIndexOf('.');
        const baseName = dotIndex === -1
            ? AppState.lastImportedFileName
            : AppState.lastImportedFileName.substring(0, dotIndex);
        const extension = dotIndex === -1
            ? '.txt'
            : AppState.lastImportedFileName.substring(dotIndex);
        fileName = baseName + '_净化' + extension;
    } else {
        fileName = CONFIG.EXPORT_FILENAME_PREFIX +
            buildTimestampForFilename(new Date()) + '.txt';
    }

    const blob = new Blob(
        [exportContent],
        { type: 'text/plain;charset=utf-8' }
    );
    const downloadUrl = URL.createObjectURL(blob);
    const downloadLink = document.createElement('a');
    downloadLink.href = downloadUrl;
    downloadLink.download = fileName;
    document.body.appendChild(downloadLink);
    downloadLink.click();
    document.body.removeChild(downloadLink);
    URL.revokeObjectURL(downloadUrl);

    showToast('已导出：' + fileName);
}

function buildTimestampForFilename(dateObject) {
    const year = dateObject.getFullYear();
    const month = String(dateObject.getMonth() + 1).padStart(2, '0');
    const day = String(dateObject.getDate()).padStart(2, '0');
    const hour = String(dateObject.getHours()).padStart(2, '0');
    const minute = String(dateObject.getMinutes()).padStart(2, '0');
    const second = String(dateObject.getSeconds()).padStart(2, '0');
    return year + '-' + month + '-' + day +
        '_T' + hour + '_' + minute + '_' + second;
}

// ============================================================================
// 清空 / 统计
// ============================================================================

function handleClearAll() {
    if (!getSourceText() && !getResultText()) {
        showToast('已为空');
        return;
    }
    if (!confirm('确定清空所有文本吗？')) return;

    flushPendingPresetSync();

    setSourceText('', false);
    setResultText('', true);
    clearSearchState();
    scheduleAutoSave();

    showToast('已清空');
}

// ============================================================================
// 统计对话框
// ============================================================================

let statisticsModalOverlayElement = null;
let statisticsModalBodyElement = null;
let statisticsModalCopyButton = null;
let statisticsModalCloseButton = null;
let statisticsModalLastText = '';

function ensureStatisticsModal() {
    if (statisticsModalOverlayElement) return statisticsModalOverlayElement;

    const overlayElement = document.createElement('div');
    overlayElement.className = 'modal-overlay';
    overlayElement.style.display = 'none';
    overlayElement.setAttribute('role', 'dialog');
    overlayElement.setAttribute('aria-modal', 'true');
    overlayElement.setAttribute('aria-label', '文本统计');

    const dialogElement = document.createElement('div');
    dialogElement.className = 'mode-dialog';

    const titleElement = document.createElement('div');
    titleElement.className = 'mode-dialog-title';
    titleElement.textContent = '📊 文本统计';
    dialogElement.appendChild(titleElement);

    const bodyElement = document.createElement('div');
    bodyElement.className = 'mode-dialog-summary';
    bodyElement.style.whiteSpace = 'pre-line';
    bodyElement.style.fontFamily =
        "'JetBrains Mono', 'Fira Code', 'Consolas', monospace";
    bodyElement.style.fontSize = '0.85rem';
    dialogElement.appendChild(bodyElement);

    const footerElement = document.createElement('div');
    footerElement.className = 'mode-dialog-footer';

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'outline';
    copyButton.textContent = '📋 复制统计';
    footerElement.appendChild(copyButton);

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'primary';
    closeButton.textContent = '关闭';
    footerElement.appendChild(closeButton);

    dialogElement.appendChild(footerElement);
    overlayElement.appendChild(dialogElement);
    document.body.appendChild(overlayElement);

    function closeStatisticsModal() {
        overlayElement.style.display = 'none';
        AppState.statisticsModalOpen = false;
        if (
            DOM.statsButton &&
            typeof DOM.statsButton.focus === 'function'
        ) {
            DOM.statsButton.focus();
        }
    }

    closeButton.addEventListener('click', closeStatisticsModal);

    overlayElement.addEventListener('click', function onOverlayClick(event) {
        if (event.target === overlayElement) {
            closeStatisticsModal();
        }
    });

    copyButton.addEventListener('click', function onCopy() {
        if (!statisticsModalLastText) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(statisticsModalLastText).then(
                function onCopied() {
                    showToast('统计已复制');
                }
            ).catch(function onCopyError() {
                showToast('复制失败，请手动选择', true);
            });
        } else {
            showToast('当前浏览器不支持一键复制', true);
        }
    });

    document.addEventListener('keydown', function onKeyDown(event) {
        if (event.key !== 'Escape') return;
        if (overlayElement.style.display === 'none') return;
        if (AppState.presetManagerModalOpen) return;
        if (AppState.importModeDialogOpen) return;
        if (AppState.appendTargetModalOpen) return;

        event.preventDefault();
        event.stopPropagation();
        closeStatisticsModal();
    });

    statisticsModalOverlayElement = overlayElement;
    statisticsModalBodyElement = bodyElement;
    statisticsModalCopyButton = copyButton;
    statisticsModalCloseButton = closeButton;

    return overlayElement;
}

function handleShowStatistics() {
    const sourceStatistics = getTextStatistics(getSourceText());
    const resultStatistics = getTextStatistics(getResultText());

    const formatNumber = function formatNumber(numberValue) {
        return String(numberValue).replace(
            /\B(?=(\d{3})+(?!\d))/g,
            ','
        );
    };

    const statisticsText =
        '📄 源文本\n' +
        '  · ' + formatNumber(sourceStatistics.chars) + ' 字符\n' +
        '  · ' + formatNumber(sourceStatistics.lines) + ' 行\n' +
        '  · ' + formatNumber(sourceStatistics.bytes) + ' 字节\n' +
        '\n' +
        '✨ 结果\n' +
        '  · ' + formatNumber(resultStatistics.chars) + ' 字符\n' +
        '  · ' + formatNumber(resultStatistics.lines) + ' 行\n' +
        '  · ' + formatNumber(resultStatistics.bytes) + ' 字节';

    const overlayElement = ensureStatisticsModal();
    statisticsModalLastText = statisticsText;
    statisticsModalBodyElement.textContent = statisticsText;
    overlayElement.style.display = 'flex';
    AppState.statisticsModalOpen = true;

    setTimeout(function deferFocus() {
        if (
            statisticsModalCloseButton &&
            typeof statisticsModalCloseButton.focus === 'function'
        ) {
            statisticsModalCloseButton.focus();
        }
    }, 0);
}

// ============================================================================
// 复制
// ============================================================================

function handleCopySource() {
    const sourceText = getSourceText();
    if (!sourceText) {
        showToast('源文本为空', true);
        return;
    }
    copyTextToClipboard(sourceText, '源文本已复制');
}

function handleCopyResult() {
    const resultText = getResultText();
    if (!resultText) {
        showToast('结果文本为空', true);
        return;
    }
    copyTextToClipboard(resultText, '结果已复制');
}

async function copyTextToClipboard(text, successMessage) {
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
        } else {
            const temporaryTextarea = document.createElement('textarea');
            temporaryTextarea.value = text;
            temporaryTextarea.style.position = 'fixed';
            temporaryTextarea.style.left = '-9999px';
            document.body.appendChild(temporaryTextarea);
            temporaryTextarea.select();
            document.execCommand('copy');
            document.body.removeChild(temporaryTextarea);
        }
        showToast(successMessage);
    } catch (copyError) {
        showToast('复制失败，请手动选择', true);
    }
}

// ============================================================================
// 结果区流转
// ============================================================================

function handleConvertResultToSource() {
    const resultText = getResultText();
    if (!resultText) {
        showToast('结果文本为空', true);
        return;
    }

    flushPendingPresetSync();

    setSourceText(resultText, true);
    setResultText('', false);

    updateSearchMatches();
    scheduleAutoSave();
    showToast('已把结果作为新的源文本');
}

function handleSwapSourceAndResult() {
    const sourceText = getSourceText();
    const resultText = getResultText();

    if (!sourceText && !resultText) {
        showToast('两个文本区都为空', true);
        return;
    }

    flushPendingPresetSync();

    setSourceText(resultText, false);
    setResultText(sourceText, true);
    updateSearchMatches();
    scheduleAutoSave();
    showToast('已交换源 / 结果');
}

function handleResetResult() {
    if (!getResultText()) {
        showToast('结果已为空');
        return;
    }

    flushPendingPresetSync();

    setResultText('', true);
    updateSearchMatches();
    scheduleAutoSave();
    showToast('结果已重置');
}

// ============================================================================
// 暗色模式
// ============================================================================

function handleToggleDarkMode() {
    const isDarkNow = document.body.classList.toggle('dark');
    AppState.darkMode = isDarkNow;
    syncDarkModeToggleButtonText();
    saveLocalBackup(STORAGE_KEYS.UI_THEME, isDarkNow ? 'dark' : 'light');
    scheduleAutoSave();
}

// ============================================================================
// 快速替换
// ============================================================================

async function handleQuickReplace() {
    let currentText = getResultText();
    let usedSourceFallback = false;

    if (!currentText) {
        const sourceText = getSourceText();
        if (sourceText) {
            currentText = sourceText;
            usedSourceFallback = true;
        }
    }

    if (!currentText.trim()) {
        showToast('没有可处理的文本', true);
        return;
    }
    if (!checkTextSize(currentText, '快速替换')) {
        return;
    }

    const quickPattern = DOM.quickPatternInput
        ? DOM.quickPatternInput.value.trim()
        : '';
    if (!quickPattern) {
        showToast('请输入正则表达式', true);
        return;
    }

    const quickReplacement = DOM.quickReplacementInput
        ? DOM.quickReplacementInput.value
        : '';
    const flags =
        (DOM.quickCheckboxG && DOM.quickCheckboxG.checked ? 'g' : '') +
        (DOM.quickCheckboxI && DOM.quickCheckboxI.checked ? 'i' : '') +
        (DOM.quickCheckboxM && DOM.quickCheckboxM.checked ? 'm' : '');
    const useJsMode = DOM.quickCheckboxJsMode
        ? DOM.quickCheckboxJsMode.checked
        : false;

    if (useJsMode && !confirmJSMode('快速替换')) {
        return;
    }

    if (DOM.quickApplyButton) {
        DOM.quickApplyButton.disabled = true;
        DOM.quickApplyButton.textContent = '⏳ 计算中...';
    }

    try {
        const replaceResult = await performReplaceAsync(
            currentText,
            {
                pattern: quickPattern,
                replacement: quickReplacement,
                isRegex: true,
                isJS: useJsMode
            },
            flags,
            false
        );

        if (replaceResult.cancelled) {
            showToast('快速替换已取消');
            return;
        }

        if (replaceResult.error) {
            showToast('快速替换错误: ' + replaceResult.error, true);
            return;
        }

        setResultText(replaceResult.newText, true);
        updateSearchMatches();
        scheduleAutoSave();

        if (usedSourceFallback) {
            showToast('快速替换完成（结果区为空，已改用源文本）');
        } else {
            showToast('快速替换完成');
        }
    } catch (replaceError) {
        console.error('快速替换异常:', replaceError);
        showToast(
            '快速替换失败: ' + (replaceError.message || '未知错误'),
            true
        );
    } finally {
        if (DOM.quickApplyButton) {
            DOM.quickApplyButton.disabled = false;
            DOM.quickApplyButton.textContent = '▶ 快速替换';
        }
    }
}

function handleQuickSaveAsRule() {
    const quickPattern = DOM.quickPatternInput
        ? DOM.quickPatternInput.value.trim()
        : '';
    if (!quickPattern) {
        showToast('请先填写正则表达式', true);
        return;
    }

    try {
        new RegExp(quickPattern);
    } catch (compileError) {
        const confirmed = confirm(
            '⚠️ 当前正则表达式无效：\n\n' +
            compileError.message + '\n\n' +
            '仍要保存为规则吗？\n' +
            '（保存后批量运行时会跳过此规则并报错）'
        );
        if (!confirmed) {
            return;
        }
    }

    const quickReplacement = DOM.quickReplacementInput
        ? DOM.quickReplacementInput.value
        : '';
    const useJsMode = DOM.quickCheckboxJsMode
        ? DOM.quickCheckboxJsMode.checked
        : false;

    if (useJsMode && !confirmJSMode('快速替换规则')) {
        if (DOM.quickCheckboxJsMode) {
            DOM.quickCheckboxJsMode.checked = false;
            AppState.quickJsMode = false;
        }
        return;
    }

    const newRule = {
        id: Date.now() +
            Math.floor(Math.random() * CONFIG.ID_COLLISION_RANDOM_RANGE),
        name: '快速规则 ' + (AppState.customRules.length + 1),
        pattern: quickPattern,
        replacement: quickReplacement,
        enabled: true,
        order: AppState.customRules.length + 1,
        runChecked: true,
        isRegex: true,
        isJS: useJsMode
    };

    AppState.customRules.push(newRule);
    invalidateExistenceIndex();
    syncCustomRulesToDefaultRulesIfActive();
    renderRuleTable();
    scheduleAutoSave();

    showToast('已把快速替换存为规则');
}

// ============================================================================
// 模板面板
// ============================================================================

let templatePanelOutsideClickHandler = null;

/**
 * 繁简转换进行中的标志位。
 * 防止用户重复点击导致并发转换。
 *
 * ★ 该标志位同时在以下两个位置被检查：
 *   1. handleTemplateConvertClick 开头（防止重复触发转换）
 *   2. onPanelClick 开头（防止转换期间用户点击其他模板按钮导致
 *      "规则添加被后续异步转换覆盖"的并发 bug）
 */
let isZhConversionInProgress = false;

/**
 * 判断模板面板当前是否可见。
 *
 * 兼容三种状态：
 *   · 从未显示过（style.display === ''）→ 不可见
 *   · 通过 style.display = 'none' 隐藏 → 不可见
 *   · 通过 style.display = 'block' 显示 → 可见
 *
 * @returns {boolean}
 */
function isTemplatePanelVisible() {
    if (!DOM.templatePanel) return false;
    const displayValue = DOM.templatePanel.style.display;
    return displayValue !== 'none' && displayValue !== '';
}

/**
 * 关闭模板浮动面板，并解除外部点击监听。
 */
function closeTemplatePanel() {
    if (!DOM.templatePanel) return;
    DOM.templatePanel.style.display = 'none';
    if (templatePanelOutsideClickHandler) {
        document.removeEventListener(
            'click',
            templatePanelOutsideClickHandler
        );
        templatePanelOutsideClickHandler = null;
    }
}

function handleToggleTemplatePanel() {
    const templatePanel = DOM.templatePanel;
    if (!templatePanel) return;

    const isCurrentlyVisible = isTemplatePanelVisible();

    if (!isCurrentlyVisible) {
        templatePanel.style.display = 'block';

        const buttonRect = DOM.templateButton.getBoundingClientRect();
        const panelWidth = templatePanel.offsetWidth || 300;
        const panelHeight = templatePanel.offsetHeight || 0;

        let topPosition = buttonRect.bottom + 5;
        if (topPosition + panelHeight > window.innerHeight - 8) {
            const aboveTop = buttonRect.top - panelHeight - 5;
            topPosition = aboveTop > 8
                ? aboveTop
                : Math.max(8, window.innerHeight - panelHeight - 8);
        }

        let leftPosition = buttonRect.left;
        const maxLeftPosition = window.innerWidth - panelWidth - 12;
        if (leftPosition > maxLeftPosition) {
            leftPosition = maxLeftPosition;
        }
        if (leftPosition < 8) {
            leftPosition = 8;
        }

        templatePanel.style.top = topPosition + 'px';
        templatePanel.style.left = leftPosition + 'px';

        if (templatePanelOutsideClickHandler) {
            document.removeEventListener(
                'click',
                templatePanelOutsideClickHandler
            );
            templatePanelOutsideClickHandler = null;
        }

        templatePanelOutsideClickHandler = function onOutsideClick(clickEvent) {
            if (
                !templatePanel.contains(clickEvent.target) &&
                clickEvent.target !== DOM.templateButton
            ) {
                closeTemplatePanel();
            }
        };
        setTimeout(function deferBind() {
            document.addEventListener(
                'click',
                templatePanelOutsideClickHandler
            );
        }, 0);

        // ---- 后台静默预加载 opencc-js ----
        // 打开模板面板时预热转换库，用户点击"繁转简 / 简转繁"时响应更快。
        // preloadOpenCC 内部吞掉所有异常，因此不会影响模板面板的正常使用。
        preloadOpenCC();
    } else {
        closeTemplatePanel();
    }
}

function handleAddTemplateRule(pattern, replacement, templateName) {
    const isJsTemplate = replacement.startsWith('@js:');

    const newRule = {
        id: Date.now() +
            Math.floor(Math.random() * CONFIG.ID_COLLISION_RANDOM_RANGE),
        name: '📚 ' + templateName,
        pattern: pattern,
        replacement: isJsTemplate
            ? replacement.replace(/^@js:\s*/, '')
            : replacement,
        enabled: true,
        order: AppState.customRules.length + 1,
        runChecked: true,
        isRegex: true,
        isJS: isJsTemplate
    };

    AppState.customRules.push(newRule);
    invalidateExistenceIndex();
    syncCustomRulesToDefaultRulesIfActive();
    renderRuleTable();
    scheduleAutoSave();

    showToast('已添加模板规则：' + templateName);
}

/**
 * 处理模板面板中的"繁转简 / 简转繁"按钮点击。
 *
 * 流程：
 *   1. 并发保护：若上一次转换未完成，直接拒绝
 *   2. 方向校验：只接受 't2s' / 's2t'
 *   3. 源文本读取与校验（非空 + 大小合规）
 *   4. 大文本二次确认（≥2MB）
 *   5. 进入加载状态（禁用按钮 + 切换文案）
 *   6. 从 zh-convert.js 异步获取对应的转换函数
 *   7. 让出一帧确保按钮文案更新可被用户看到
 *   8. 执行转换，写入结果区
 *   9. 触发搜索刷新 / 自动保存
 *  10. 关闭模板面板
 *  11. finally 恢复按钮状态
 *
 * @param {string} direction 转换方向：'t2s'（繁转简）或 's2t'（简转繁）
 * @param {HTMLButtonElement} clickedButton 被点击的按钮（用于加载态展示与恢复）
 * @returns {Promise<void>}
 */
async function handleTemplateConvertClick(direction, clickedButton) {
    // ---- 并发保护 ----
    if (isZhConversionInProgress) {
        showToast('上一次繁简转换尚未完成，请稍候', true);
        return;
    }

    // ---- 方向校验 ----
    if (direction !== 't2s' && direction !== 's2t') {
        console.error('[ui.js] 未知的繁简转换方向：', direction);
        showToast('未知的转换方向', true);
        return;
    }

    const directionDisplayName = direction === 't2s'
        ? '繁转简'
        : '简转繁';

    // ---- 源文本读取与校验 ----
    const sourceText = getSourceText();
    if (!sourceText || !sourceText.trim()) {
        showToast('源文本为空', true);
        return;
    }

    if (!checkTextSize(sourceText, directionDisplayName)) {
        return;
    }

    // ---- 大文本额外提示 ----
    // OpenCC 转换速度约 1MB/秒，大文本会有可感知的延迟。
    // 这里给用户一个明确预期，避免误以为界面卡死。
    const approximateMegabytes = sourceText.length / (1024 * 1024);
    if (approximateMegabytes >= 2) {
        const confirmed = confirm(
            '⚠️ 文本较大（约 ' +
            approximateMegabytes.toFixed(1) +
            ' MB），繁简转换可能需要几秒钟。\n\n' +
            '转换期间页面会短暂无响应。是否继续？'
        );
        if (!confirmed) {
            return;
        }
    }

    // ---- 进入加载状态 ----
    isZhConversionInProgress = true;
    const originalButtonTextContent = clickedButton.textContent;
    clickedButton.disabled = true;
    clickedButton.textContent = '⏳ 正在加载转换库...';

    try {
        // ---- 获取转换函数（首次会触发 opencc-js 加载） ----
        let converterFunction;
        if (direction === 't2s') {
            converterFunction = await getT2SConverter();
        } else {
            converterFunction = await getS2TConverter();
        }

        // ---- 更新按钮文案：正在转换 ----
        clickedButton.textContent = '⏳ 正在转换...';

        // ---- 让出一次浏览器绘制帧，确保按钮文案更新可被用户看到 ----
        await new Promise(function deferToNextFrame(resolve) {
            if (typeof window.requestAnimationFrame === 'function') {
                window.requestAnimationFrame(function onFrame() {
                    resolve();
                });
            } else {
                setTimeout(resolve, 0);
            }
        });

        // ---- 执行转换 ----
        const convertedText = converterFunction(sourceText);

        // ---- 写入结果区 ----
        setResultText(convertedText, true);
        updateSearchMatches();
        scheduleAutoSave();

        showToast('已完成' + directionDisplayName);

        // ---- 关闭模板面板 ----
        closeTemplatePanel();
    } catch (conversionError) {
        console.error('[ui.js] 繁简转换失败：', conversionError);
        showToast(
            directionDisplayName + '失败：' +
            (conversionError && conversionError.message
                ? conversionError.message
                : '未知错误'),
            true
        );
    } finally {
        isZhConversionInProgress = false;
        // 恢复按钮状态（若按钮仍存在于 DOM 中）
        if (clickedButton && document.body.contains(clickedButton)) {
            clickedButton.disabled = false;
            clickedButton.textContent = originalButtonTextContent;
        }
    }
}

// ============================================================================
// 同步滚动
// ============================================================================

let pendingSyncScrollFrameHandle = null;
let pendingSyncScrollSource = null;
let pendingSyncScrollTarget = null;

function requestSyncScroll(fromTextarea, toTextarea) {
    pendingSyncScrollSource = fromTextarea;
    pendingSyncScrollTarget = toTextarea;

    if (pendingSyncScrollFrameHandle !== null) {
        return;
    }

    pendingSyncScrollFrameHandle = window.requestAnimationFrame(
        function applySyncScroll() {
            pendingSyncScrollFrameHandle = null;

            if (!pendingSyncScrollSource || !pendingSyncScrollTarget) {
                return;
            }

            syncScrollBetweenTextareas(
                pendingSyncScrollSource,
                pendingSyncScrollTarget
            );

            pendingSyncScrollSource = null;
            pendingSyncScrollTarget = null;
        }
    );
}

function syncScrollBetweenTextareas(fromTextarea, toTextarea) {
    if (AppState.isSyncingScroll) return;
    if (AppState.syncScrollMode === 'off') return;

    AppState.isSyncingScroll = true;

    if (AppState.syncScrollMode === 'pixel') {
        toTextarea.scrollTop = fromTextarea.scrollTop;
        toTextarea.scrollLeft = fromTextarea.scrollLeft;
    } else if (AppState.syncScrollMode === 'proportion') {
        const fromMaxScroll =
            fromTextarea.scrollHeight - fromTextarea.clientHeight;
        if (fromMaxScroll > 0) {
            const percent = fromTextarea.scrollTop / fromMaxScroll;
            const toMaxScroll =
                toTextarea.scrollHeight - toTextarea.clientHeight;
            if (toMaxScroll > 0) {
                toTextarea.scrollTop = percent * toMaxScroll;
            }
        }
    }

    AppState.isSyncingScroll = false;
}

function handleSyncScrollModeChange() {
    if (!DOM.syncScrollSelect) return;
    AppState.syncScrollMode = DOM.syncScrollSelect.value;
    saveLocalBackup(
        STORAGE_KEYS.UI_SYNC_SCROLL_MODE,
        AppState.syncScrollMode
    );

    let modeText = '关闭';
    if (AppState.syncScrollMode === 'pixel') modeText = '像素同步';
    else if (AppState.syncScrollMode === 'proportion') modeText = '比例同步';

    showToast('滚动同步已切换为：' + modeText);
    scheduleAutoSave();
}

// ============================================================================
// 帮助面板
// ============================================================================

function handleToggleHelpPanel() {
    if (!DOM.helpContent) return;
    DOM.helpContent.classList.toggle('show');
    AppState.helpPanelOpen = DOM.helpContent.classList.contains('show');
    scheduleAutoSave();
}

// ============================================================================
// 设置导入触发
// ============================================================================

function handleImportSettings() {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';

    fileInput.onchange = function onFileChange(event) {
        const selectedFile = event.target.files[0];
        if (selectedFile) {
            importFullConfigFromFile(selectedFile);
        }
    };

    fileInput.click();
}

// ============================================================================
// 命名预设管理
// ============================================================================

function handleOpenPresetManager() {
    openPresetManagerModal();
}

// ============================================================================
// 主表关联预设按钮
// ============================================================================

function handleSyncToActivePresetButtonClick() {
    document.dispatchEvent(new CustomEvent('textpro:sync-to-active-preset'));
}

function handleClearActivePresetButtonClick() {
    const defaultRulesDisplayName = AppState.defaultRulesName || '默认规则';

    if (AppState.activePresetId === CONFIG.MAIN_TABLE_VIRTUAL_ID) {
        showToast('当前工作区已经是' + defaultRulesDisplayName, true);
        return;
    }

    if (!confirm(
        '确定切换回' + defaultRulesDisplayName + '吗？\n\n' +
        '· 当前工作区内容将被替换为' + defaultRulesDisplayName + '的规则\n' +
        '· 未保存的修改将丢弃'
    )) {
        return;
    }

    document.dispatchEvent(
        new CustomEvent('textpro:clear-active-preset-association')
    );
}

// ============================================================================
// 批量运行取消
// ============================================================================

function handleCancelBatchRunButtonClick() {
    cancelBatchRun();
}

// ============================================================================
// 立即保存反馈
// ============================================================================

function handleSaveSnapshotClick() {
    flushPendingPresetSync();
    saveStateImmediately()
        .then(function onSaved(saveResult) {
            if (saveResult && saveResult.saved) {
                showToast('已保存');
            } else {
                showToast('保存失败（存储不可用或已跳过自动加载）', true);
            }
        })
        .catch(function onSaveError(saveError) {
            console.warn('立即保存失败:', saveError);
            showToast(
                '保存失败: ' + (saveError.message || '未知错误'),
                true
            );
        });
}

// ============================================================================
// JS 信任撤销
// ============================================================================

function handleJsTrustIndicatorClick() {
    if (!hasAnyJsTrust()) return;

    if (CONFIG.JS_TRUST_RULE_BASED) {
        const trustedCount = AppState.jsTrustedRuleIds.size;
        if (trustedCount === 0) {
            revokeSessionTrust();
            updateJsTrustIndicator();
            showToast('已撤销本会话的 JS 模式信任');
            return;
        }

        if (confirm(
            '确定撤销全部 ' + trustedCount + ' 条 JS 规则的信任吗？\n\n' +
            '撤销后，这些规则下次启用 JS 模式时会重新弹出确认。'
        )) {
            clearAllRuleJsTrust();
            revokeSessionTrust();
            updateJsTrustIndicator();
            showToast('已撤销全部 JS 模式信任');
        }
    } else {
        revokeSessionTrust();
        updateJsTrustIndicator();
        showToast('已撤销本会话的 JS 模式信任');
    }
}

// ============================================================================
// 全局快捷键
// ============================================================================

function isEditableInputFocused() {
    const activeElement = document.activeElement;
    if (!activeElement) return false;

    const tagName = activeElement.tagName;

    if (tagName === 'TEXTAREA') return true;

    if (tagName === 'INPUT') {
        const inputType = (activeElement.type || 'text').toLowerCase();
        if (
            inputType === 'text' ||
            inputType === 'search' ||
            inputType === 'url' ||
            inputType === 'tel' ||
            inputType === 'email' ||
            inputType === 'password' ||
            inputType === 'number'
        ) {
            return true;
        }
        return false;
    }

    if (activeElement.isContentEditable) return true;

    return false;
}

/**
 * 全局键盘快捷键处理。
 *
 * ★ 优先级顺序（从高到低）：
 *   1. 模板面板打开时，Esc 关闭模板面板
 *   2. 模态框打开时，忽略所有快捷键（由模态框自身处理 Esc）
 *   3. Ctrl+S / Cmd+S → 立即保存
 *   4. Ctrl+Shift+D / Cmd+Shift+D → 切换暗色模式
 *
 * @param {KeyboardEvent} keyboardEvent
 */
function handleGlobalKeyDown(keyboardEvent) {
    // ---- 优先级 1：模板面板打开时，Esc 关闭模板面板 ----
    //
    // ★ 修复：原实现未处理模板面板，导致用户按 Esc 无法关闭面板，
    //   与所有浮动面板的通行交互习惯不符。
    //   此分支必须在模态框检查之前，因为模板面板是最"表层"的浮动 UI。
    if (
        keyboardEvent.key === 'Escape' &&
        isTemplatePanelVisible()
    ) {
        keyboardEvent.preventDefault();
        closeTemplatePanel();
        return;
    }

    // ---- 优先级 2：模态框打开时忽略所有快捷键 ----
    if (AppState.importModeDialogOpen) return;
    if (AppState.presetManagerModalOpen) return;
    if (AppState.appendTargetModalOpen) return;
    if (AppState.statisticsModalOpen) return;

    const isCtrlOrMeta = keyboardEvent.ctrlKey || keyboardEvent.metaKey;
    const normalizedKey = keyboardEvent.key
        ? keyboardEvent.key.toLowerCase()
        : '';

    // ---- 优先级 3：Ctrl+S / Cmd+S → 立即保存 ----
    if (isCtrlOrMeta && !keyboardEvent.shiftKey && normalizedKey === 's') {
        keyboardEvent.preventDefault();
        handleSaveSnapshotClick();
        return;
    }

    // ---- 优先级 4：Ctrl+Shift+D / Cmd+Shift+D → 切换暗色模式 ----
    if (
        isCtrlOrMeta &&
        keyboardEvent.shiftKey &&
        normalizedKey === 'd'
    ) {
        if (!isEditableInputFocused()) {
            keyboardEvent.preventDefault();
            handleToggleDarkMode();
        }
        return;
    }
}

// ============================================================================
// 文本区事件（大文本输入 O(1) 化）
// ============================================================================

function handleSourceTextInput() {
    if (AppState.internalUpdateInProgress) return;
    if (AppState.isApplyingImportedState) return;

    AppState.sourceTextStale = true;
}

function handleResultTextInput() {
    if (AppState.internalUpdateInProgress) return;
    if (AppState.isApplyingImportedState) return;

    AppState.resultTextStale = true;
    AppState.searchLargeTextLowercaseDirty = true;

    if (
        DOM.resultSearchInput &&
        DOM.resultSearchInput.value.trim() !== ''
    ) {
        if (AppState.resultInputSearchDebounceTimer) {
            clearTimeout(AppState.resultInputSearchDebounceTimer);
        }
        AppState.resultInputSearchDebounceTimer = setTimeout(
            function onSearchDebounce() {
                AppState.resultInputSearchDebounceTimer = null;
                updateSearchMatches();
            },
            CONFIG.RESULT_INPUT_SEARCH_DEBOUNCE_MS
        );
    }
}

// ============================================================================
// beforeunload 离开确认
// ============================================================================

function handleBeforeUnload(beforeUnloadEvent) {
    if (!CONFIG.BEFORE_UNLOAD_GUARD_ENABLED) return;
    if (AppState.userSkippedAutoLoad === true) return;

    let hasUnsavedChanges = false;
    try {
        hasUnsavedChanges = checkMainTableHasUnsavedChanges();
    } catch (checkError) {
        console.warn(
            '[TextPro] beforeunload 检查失败，使用保守策略:',
            checkError
        );
        hasUnsavedChanges = (
            AppState.activePresetId !== CONFIG.MAIN_TABLE_VIRTUAL_ID &&
            AppState.activePresetId !== null
        );
    }

    if (!hasUnsavedChanges) return;

    forceSaveBeforeUnload().catch(function onForceSaveError(saveError) {
        console.warn('卸载前强制保存失败:', saveError);
    });

    try {
        beforeUnloadEvent.preventDefault();
        beforeUnloadEvent.returnValue = '';
    } catch (preventError) {
        // 忽略
    }
    return '';
}

// ============================================================================
// 持久化权限通知监听
// ============================================================================

function bindPersistentStorageUpdates() {
    document.addEventListener(
        'textpro:persistent-storage-updated',
        function onPersistentStorageUpdated() {
            updatePersistentStorageBanner();
        }
    );
}

// ============================================================================
// 事件绑定总入口
// ============================================================================

export function bindAllUiEvents() {
    if (isUiEventsBound) return;
    isUiEventsBound = true;

    // ---- 1. 顶部工具栏 ----
    if (DOM.importButton) DOM.importButton.onclick = handleImportTxtFile;
    if (DOM.exportButton) DOM.exportButton.onclick = handleExportTxtFile;
    if (DOM.clearAllButton) DOM.clearAllButton.onclick = handleClearAll;
    if (DOM.statsButton) DOM.statsButton.onclick = handleShowStatistics;
    if (DOM.darkModeToggleButton) {
        DOM.darkModeToggleButton.onclick = handleToggleDarkMode;
    }

    // ---- 1.1 JS 信任指示器 ----
    if (DOM.jsTrustIndicator) {
        DOM.jsTrustIndicator.addEventListener('click', function onClick() {
            handleJsTrustIndicatorClick();
        });
        DOM.jsTrustIndicator.addEventListener(
            'keydown',
            function onKeyDown(keyEvent) {
                if (keyEvent.key === 'Enter' || keyEvent.key === ' ') {
                    keyEvent.preventDefault();
                    handleJsTrustIndicatorClick();
                }
            }
        );
    }
    document.addEventListener(
        'textpro:js-trust-changed',
        function onTrustChange() {
            updateJsTrustIndicator();
        }
    );

    // ---- 1.2 全局选项 ----
    bindGlobalOptionCheckboxesToState();

    // ---- 2. 源 / 结果区 ----
    if (DOM.copySourceButton) DOM.copySourceButton.onclick = handleCopySource;
    if (DOM.copyResultButton) DOM.copyResultButton.onclick = handleCopyResult;

    if (DOM.convertResultToSourceButton) {
        DOM.convertResultToSourceButton.onclick = handleConvertResultToSource;
    }
    if (DOM.swapSourceResultButton) {
        DOM.swapSourceResultButton.onclick = handleSwapSourceAndResult;
    }
    if (DOM.resetResultButton) {
        DOM.resetResultButton.onclick = handleResetResult;
    }

    if (DOM.sourceTextarea) {
        DOM.sourceTextarea.addEventListener('input', handleSourceTextInput);
    }
    if (DOM.resultTextarea) {
        DOM.resultTextarea.addEventListener('input', handleResultTextInput);
    }

    // ---- 3. 同步滚动 ----
    if (DOM.syncScrollSelect) {
        DOM.syncScrollSelect.addEventListener(
            'change',
            handleSyncScrollModeChange
        );
    }
    if (DOM.sourceTextarea && DOM.resultTextarea) {
        DOM.sourceTextarea.addEventListener(
            'scroll',
            function onSourceScroll() {
                requestSyncScroll(
                    DOM.sourceTextarea,
                    DOM.resultTextarea
                );
            },
            { passive: true }
        );
        DOM.resultTextarea.addEventListener(
            'scroll',
            function onResultScroll() {
                requestSyncScroll(
                    DOM.resultTextarea,
                    DOM.sourceTextarea
                );
            },
            { passive: true }
        );
    }

    // ---- 4. 快速替换 ----
    if (DOM.quickApplyButton) {
        DOM.quickApplyButton.onclick = handleQuickReplace;
    }
    if (DOM.quickSaveAsRuleButton) {
        DOM.quickSaveAsRuleButton.onclick = handleQuickSaveAsRule;
    }

    // ---- 5. 规则表操作 ----
    if (DOM.addRuleButton) {
        DOM.addRuleButton.onclick = function onAddRule() {
            addNewRule();
        };
    }
    if (DOM.resetDefaultRulesButton) {
        DOM.resetDefaultRulesButton.onclick = function onResetRules() {
            resetToDefaultRules();
        };
    }
    if (DOM.saveSnapshotButton) {
        DOM.saveSnapshotButton.onclick = handleSaveSnapshotClick;
    }
    if (DOM.exportFullConfigButton) {
        DOM.exportFullConfigButton.onclick = exportFullConfig;
    }
    if (DOM.importFullConfigButton) {
        DOM.importFullConfigButton.onclick = handleImportSettings;
    }

    if (DOM.presetManagerButton) {
        DOM.presetManagerButton.onclick = handleOpenPresetManager;
    }

    if (DOM.templateButton) {
        DOM.templateButton.onclick = handleToggleTemplatePanel;
    }

    if (DOM.batchRunCheckedButton) {
        DOM.batchRunCheckedButton.onclick = function onBatchRun() {
            batchRunCheckedRules().then(function onDone() {
                updateSearchMatches();
            }).catch(function onError(batchError) {
                console.error('批量运行异常:', batchError);
                showToast('批量运行异常', true);
            });
        };
    }
    if (DOM.selectAllRulesButton) {
        DOM.selectAllRulesButton.onclick = function onSelectAll() {
            selectAllRunChecks(true);
        };
    }
    if (DOM.deselectAllRulesButton) {
        DOM.deselectAllRulesButton.onclick = function onDeselectAll() {
            selectAllRunChecks(false);
        };
    }

    // ---- 5.1 主表关联预设按钮 ----
    if (DOM.syncToActivePresetButton) {
        DOM.syncToActivePresetButton.addEventListener(
            'click',
            handleSyncToActivePresetButtonClick
        );
    }
    if (DOM.clearActivePresetButton) {
        DOM.clearActivePresetButton.addEventListener(
            'click',
            handleClearActivePresetButtonClick
        );
    }

    // ---- 5.2 批量运行取消按钮 ----
    if (DOM.batchRunCancelButton) {
        DOM.batchRunCancelButton.addEventListener(
            'click',
            handleCancelBatchRunButtonClick
        );
    }

    // ---- 6. 模板浮动面板 ----
    //
    // ★ 点击处理分为两个分支：
    //   · data-convert  → 繁简转换（OpenCC）
    //   · data-pattern  → 原有规则模板
    //
    // ★ P0 修复：在面板级统一拦截并发点击
    //   若繁简转换进行中，拒绝所有面板内按钮的点击，
    //   避免用户点击规则模板后，后续异步转换覆盖结果区。
    if (DOM.templatePanel) {
        DOM.templatePanel.addEventListener(
            'click',
            function onPanelClick(clickEvent) {
                const clickedButton = clickEvent.target.closest('button');
                if (!clickedButton) return;

                // ---- 面板级并发保护 ----
                if (isZhConversionInProgress) {
                    showToast(
                        '繁简转换进行中，请稍候再操作模板',
                        true
                    );
                    return;
                }

                // ---- 分支 1：繁简转换按钮 ----
                if (clickedButton.dataset.convert !== undefined) {
                    const convertDirection = clickedButton.dataset.convert;
                    handleTemplateConvertClick(
                        convertDirection,
                        clickedButton
                    );
                    return;
                }

                // ---- 分支 2：原有规则模板按钮 ----
                if (clickedButton.dataset.pattern !== undefined) {
                    handleAddTemplateRule(
                        clickedButton.dataset.pattern,
                        clickedButton.dataset.replacement,
                        clickedButton.dataset.name
                    );
                    closeTemplatePanel();
                }
            }
        );
    }

    // ---- 7. 帮助面板 ----
    if (DOM.helpToggle) DOM.helpToggle.onclick = handleToggleHelpPanel;

    // ---- 8. 全局快捷键 ----
    document.addEventListener('keydown', handleGlobalKeyDown);

    // ---- 9. 命名预设管理 ----
    initializePresetManager();

    // ---- 10. 批量运行错误条 ----
    initializeBatchRunErrorBar();

    // ---- 11. 顶部状态指示器初始化 ----
    updateStorageUnavailableBanner();
    updatePersistentStorageBanner();
    updateJsTrustIndicator();

    // ---- 12. 批量运行按钮标签 ----
    updateBatchRunButtonLabel();

    // ---- 13. 持久化权限通知监听 ----
    bindPersistentStorageUpdates();

    // ---- 14. beforeunload 拦截 ----
    if (CONFIG.BEFORE_UNLOAD_GUARD_ENABLED) {
        window.addEventListener('beforeunload', handleBeforeUnload);
        AppState.pendingBeforeUnloadArmed = true;
    }
}