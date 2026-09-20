// filename: js/search.js
/**
 * ============================================================================
 * search.js — 结果区搜索导航
 * ============================================================================
 *
 * 【本次修订说明 — 修复第一行非法字符】
 *   · 第一行 `# filename:` 改为 `// filename:`。
 *   · 其余逻辑与上一版一致。
 * ============================================================================
 */

import { CONFIG } from './config.js';
import { AppState } from './state.js';
import { DOM } from './dom.js';
import { showToast } from './toast.js';
import { scheduleAutoSave } from './persistence.js';

let isResultSearchInitialized = false;

function getLowercaseTextForSearch(originalText) {
    if (!originalText) return '';

    if (
        originalText.length > CONFIG.SEARCH_LARGE_TEXT_MIRROR_BYPASS_CHARS
    ) {
        const needsRecompute = (
            AppState.searchLargeTextLowercaseDirty === true ||
            AppState.searchLargeTextLowercaseSource !== originalText
        );

        if (!needsRecompute) {
            return AppState.searchLargeTextLowercaseCache || '';
        }

        const lowercase = originalText.toLowerCase();
        AppState.searchLargeTextLowercaseSource = originalText;
        AppState.searchLargeTextLowercaseCache = lowercase;
        AppState.searchLargeTextLowercaseDirty = false;
        return lowercase;
    }

    return originalText.toLowerCase();
}

export function findAllMatches(text, searchTerm, caseSensitive) {
    const matches = [];
    if (!searchTerm || !text) return matches;

    const maxMatches = CONFIG.SEARCH_MAX_MATCHES;

    let sourceText;
    let targetText;
    if (caseSensitive) {
        sourceText = text;
        targetText = searchTerm;
    } else {
        sourceText = getLowercaseTextForSearch(text);
        targetText = searchTerm.toLowerCase();
    }

    let searchFromIndex = 0;
    while (matches.length < maxMatches) {
        const foundIndex = sourceText.indexOf(targetText, searchFromIndex);
        if (foundIndex === -1) break;
        matches.push({
            start: foundIndex,
            end: foundIndex + targetText.length
        });
        searchFromIndex = foundIndex + targetText.length;
    }

    return matches;
}

export function getClosestMatchIndex(matches, cursorPosition) {
    if (matches.length === 0) return -1;
    if (cursorPosition === undefined || cursorPosition === null) return 0;

    for (let matchIndex = 0; matchIndex < matches.length; matchIndex++) {
        if (
            cursorPosition >= matches[matchIndex].start &&
            cursorPosition <= matches[matchIndex].end
        ) {
            return matchIndex;
        }
    }

    let bestIndex = 0;
    let bestDistance = Math.abs(matches[0].start - cursorPosition);
    for (let matchIndex = 1; matchIndex < matches.length; matchIndex++) {
        const distance = Math.abs(
            matches[matchIndex].start - cursorPosition
        );
        if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = matchIndex;
        }
    }
    return bestIndex;
}

function scrollToCaretInTextarea(textarea, caretPosition) {
    if (!textarea || caretPosition === undefined) return;

    const LARGE_TEXT_MIRROR_BYPASS_THRESHOLD =
        CONFIG.SEARCH_LARGE_TEXT_MIRROR_BYPASS_CHARS;
    const VISUAL_VIEWPORT_RATIO =
        CONFIG.SEARCH_MATCH_VISUAL_VIEWPORT_RATIO;

    if (textarea.value.length > LARGE_TEXT_MIRROR_BYPASS_THRESHOLD) {
        const fullText = textarea.value;

        let lineCount = 1;
        let searchIndex = fullText.indexOf('\n');
        while (searchIndex !== -1 && searchIndex < caretPosition) {
            lineCount++;
            searchIndex = fullText.indexOf('\n', searchIndex + 1);
        }

        const computedStyle = getComputedStyle(textarea);
        let lineHeightPx = parseFloat(computedStyle.lineHeight);
        if (!isFinite(lineHeightPx) || lineHeightPx <= 0) {
            const fontSizePx = parseFloat(computedStyle.fontSize) || 16;
            lineHeightPx = fontSizePx * 1.5;
        }

        const targetScrollTop =
            (lineCount - 1) * lineHeightPx -
            textarea.clientHeight * VISUAL_VIEWPORT_RATIO;
        textarea.scrollTop = Math.max(0, targetScrollTop);
        return;
    }

    const mirrorDiv = document.createElement('div');
    const computedStyle = getComputedStyle(textarea);
    mirrorDiv.style.cssText =
        'position:absolute;top:-9999px;left:-9999px;' +
        'white-space:pre-wrap;word-wrap:break-word;' +
        'font-family:' + computedStyle.fontFamily + ';' +
        'font-size:' + computedStyle.fontSize + ';' +
        'line-height:' + computedStyle.lineHeight + ';' +
        'padding:' + computedStyle.padding + ';' +
        'width:' + textarea.clientWidth + 'px;' +
        'border:none;overflow:auto;';

    mirrorDiv.textContent = textarea.value.substring(0, caretPosition);
    document.body.appendChild(mirrorDiv);

    const caretY = mirrorDiv.scrollHeight;
    document.body.removeChild(mirrorDiv);

    const targetScrollTop =
        caretY - textarea.clientHeight * VISUAL_VIEWPORT_RATIO;
    textarea.scrollTop = Math.max(0, targetScrollTop);
}

function flashResultBackground() {
    if (!DOM.resultTextarea) return;
    DOM.resultTextarea.classList.add('flash-highlight');
    setTimeout(function removeFlash() {
        DOM.resultTextarea.classList.remove('flash-highlight');
    }, 300);
}

function updateSearchCountDisplay() {
    if (!DOM.resultSearchCount) return;

    const totalMatches = AppState.searchMatches.length;
    const currentDisplayIndex = totalMatches > 0
        ? AppState.currentMatchIndex + 1
        : 0;

    const isAtLimit = totalMatches >= CONFIG.SEARCH_MAX_MATCHES;
    const countPrefix = isAtLimit ? '≥' : '';

    DOM.resultSearchCount.textContent =
        currentDisplayIndex + '/' + countPrefix + totalMatches;

    DOM.resultSearchCount.classList.remove('no-match', 'has-match');
    if (totalMatches > 0) {
        DOM.resultSearchCount.classList.add('has-match');
    } else if (
        DOM.resultSearchInput &&
        DOM.resultSearchInput.value.trim() !== ''
    ) {
        DOM.resultSearchCount.classList.add('no-match');
    }
}

function warnAboutMatchLimitIfNeeded(matchCount) {
    if (matchCount < CONFIG.SEARCH_MAX_MATCHES) {
        return;
    }

    const now = Date.now();
    const elapsed = now - AppState.searchLimitWarningLastAt;
    if (elapsed < CONFIG.SEARCH_LIMIT_WARNING_REPEAT_MS) {
        return;
    }

    AppState.searchLimitWarningLastAt = now;
    showToast(
        '⚠️ 匹配项超过 ' + CONFIG.SEARCH_MAX_MATCHES +
        ' 个，仅显示前 ' + CONFIG.SEARCH_MAX_MATCHES +
        ' 个结果。请细化搜索词以获得更精确的匹配。',
        true
    );
}

export function updateSearchMatches() {
    const searchText = DOM.resultSearchInput
        ? DOM.resultSearchInput.value
        : '';
    const caseSensitive = DOM.resultSearchCase
        ? DOM.resultSearchCase.checked
        : false;

    if (AppState.resultTextStale) {
        AppState.resultText = DOM.resultTextarea
            ? DOM.resultTextarea.value
            : '';
        AppState.resultTextStale = false;
    }

    const resultText = AppState.resultText || '';

    AppState.searchMatches = findAllMatches(
        resultText,
        searchText,
        caseSensitive
    );

    warnAboutMatchLimitIfNeeded(AppState.searchMatches.length);

    if (AppState.searchMatches.length > 0) {
        const cursorPosition = DOM.resultTextarea
            ? DOM.resultTextarea.selectionStart
            : 0;
        AppState.currentMatchIndex = getClosestMatchIndex(
            AppState.searchMatches,
            cursorPosition
        );
    } else {
        AppState.currentMatchIndex = -1;
    }

    updateSearchCountDisplay();
}

function highlightMatch(matchIndex, focusResult) {
    if (matchIndex < 0 || matchIndex >= AppState.searchMatches.length) return;

    const match = AppState.searchMatches[matchIndex];
    AppState.currentMatchIndex = matchIndex;

    if (focusResult && DOM.resultTextarea) {
        DOM.resultTextarea.focus();
    }
    if (DOM.resultTextarea) {
        DOM.resultTextarea.setSelectionRange(match.start, match.end);
    }

    if (focusResult) {
        scrollToCaretInTextarea(DOM.resultTextarea, match.start);
        flashResultBackground();
    }

    updateSearchCountDisplay();
}

export function navigateToMatch(direction) {
    if (AppState.searchMatches.length === 0) {
        updateSearchMatches();
        if (AppState.searchMatches.length === 0) return;
    }

    let newIndex = AppState.currentMatchIndex + direction;
    if (newIndex < 0) {
        newIndex = AppState.searchMatches.length - 1;
    } else if (newIndex >= AppState.searchMatches.length) {
        newIndex = 0;
    }

    highlightMatch(newIndex, true);
}

export function clearSearchState() {
    if (AppState.searchDebounceTimer) {
        clearTimeout(AppState.searchDebounceTimer);
        AppState.searchDebounceTimer = null;
    }
    if (AppState.resultInputSearchDebounceTimer) {
        clearTimeout(AppState.resultInputSearchDebounceTimer);
        AppState.resultInputSearchDebounceTimer = null;
    }

    if (DOM.resultSearchInput) {
        DOM.resultSearchInput.value = '';
    }
    AppState.searchMatches = [];
    AppState.currentMatchIndex = -1;
    AppState.searchLimitWarningLastAt = 0;
    updateSearchCountDisplay();

    if (DOM.resultTextarea) {
        const currentPosition = DOM.resultTextarea.selectionStart;
        DOM.resultTextarea.setSelectionRange(
            currentPosition,
            currentPosition
        );
    }
}

export function initializeResultSearch() {
    if (isResultSearchInitialized) return;
    if (!DOM.resultSearchInput) return;

    isResultSearchInitialized = true;

    DOM.resultSearchInput.addEventListener('input', function onInput() {
        if (AppState.searchDebounceTimer) {
            clearTimeout(AppState.searchDebounceTimer);
        }
        AppState.searchDebounceTimer = setTimeout(function onDebounce() {
            AppState.searchDebounceTimer = null;
            updateSearchMatches();
            scheduleAutoSave();
        }, CONFIG.SEARCH_INPUT_DEBOUNCE_MS);
    });

    DOM.resultSearchInput.addEventListener(
        'keydown',
        function onKeyDown(event) {
            if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                if (AppState.searchDebounceTimer) {
                    clearTimeout(AppState.searchDebounceTimer);
                    AppState.searchDebounceTimer = null;
                    updateSearchMatches();
                }
                if (event.shiftKey) {
                    navigateToMatch(-1);
                } else {
                    navigateToMatch(1);
                }
            } else if (event.key === 'Escape') {
                event.preventDefault();
                clearSearchState();
            }
        }
    );

    if (DOM.resultSearchPrev) {
        DOM.resultSearchPrev.onclick = function onPrev() {
            navigateToMatch(-1);
        };
    }
    if (DOM.resultSearchNext) {
        DOM.resultSearchNext.onclick = function onNext() {
            navigateToMatch(1);
        };
    }
    if (DOM.resultSearchClear) {
        DOM.resultSearchClear.onclick = function onClear() {
            clearSearchState();
            if (DOM.resultSearchInput) {
                DOM.resultSearchInput.focus();
            }
        };
    }

    if (DOM.resultSearchUseForReplace) {
        DOM.resultSearchUseForReplace.addEventListener(
            'click',
            function onUseForReplace() {
                const searchTerm = DOM.resultSearchInput
                    ? DOM.resultSearchInput.value
                    : '';

                if (!searchTerm) {
                    showToast('请先在搜索框输入搜索词', true);
                    if (DOM.resultSearchInput) {
                        DOM.resultSearchInput.focus();
                    }
                    return;
                }

                if (DOM.quickPatternInput) {
                    DOM.quickPatternInput.value = searchTerm;
                }
                if (DOM.quickReplacementInput) {
                    DOM.quickReplacementInput.focus();
                    DOM.quickReplacementInput.select();
                }
                scheduleAutoSave();
                showToast('已把搜索词填入快速替换的正则输入框');
            }
        );
    }

    if (DOM.resultSearchCase) {
        DOM.resultSearchCase.addEventListener('change', function onChange() {
            updateSearchMatches();
            scheduleAutoSave();
        });
    }

    if (DOM.resultTextarea) {
        DOM.resultTextarea.addEventListener('mouseup', function onMouseUp() {
            if (AppState.searchMatches.length === 0) return;
            const cursorPosition = DOM.resultTextarea.selectionStart;
            const newIndex = getClosestMatchIndex(
                AppState.searchMatches,
                cursorPosition
            );
            if (newIndex !== AppState.currentMatchIndex) {
                AppState.currentMatchIndex = newIndex;
                updateSearchCountDisplay();
            }
        });
    }
}