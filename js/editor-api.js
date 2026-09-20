// filename: js/editor-api.js
/**
 * ============================================================================
 * editor-api.js — 编辑器内容统一入口
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

// ==================== TextEncoder 单例 ====================

let cachedTextEncoder = null;

function getTextEncoder() {
    if (cachedTextEncoder === null && typeof TextEncoder !== 'undefined') {
        cachedTextEncoder = new TextEncoder();
    }
    return cachedTextEncoder;
}

// ==================== 字节长度缓存 ====================

const BYTE_LENGTH_CACHE_MAX_ENTRIES = 5;
const BYTE_LENGTH_CACHE_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const BYTE_LENGTH_CACHE_SINGLE_ENTRY_MAX_BYTES = 24 * 1024 * 1024;

const byteLengthCache = [];

let lastQueriedText = null;
let lastQueriedByteLength = 0;

function findInCache(text) {
    const textLength = text.length;

    for (let index = 0; index < byteLengthCache.length; index++) {
        const cachedEntry = byteLengthCache[index];

        if (cachedEntry.text.length !== textLength) {
            continue;
        }

        if (cachedEntry.text === text) {
            return cachedEntry.byteLength;
        }
    }
    return -1;
}

function storeInCache(text, byteLength) {
    for (let index = byteLengthCache.length - 1; index >= 0; index--) {
        if (byteLengthCache[index].text === text) {
            byteLengthCache.splice(index, 1);
        }
    }

    if (byteLength > BYTE_LENGTH_CACHE_SINGLE_ENTRY_MAX_BYTES) {
        return;
    }

    byteLengthCache.unshift({ text: text, byteLength: byteLength });

    while (byteLengthCache.length > BYTE_LENGTH_CACHE_MAX_ENTRIES) {
        byteLengthCache.pop();
    }

    let totalBytes = 0;
    for (let index = 0; index < byteLengthCache.length; index++) {
        totalBytes += byteLengthCache[index].byteLength;
    }
    while (
        totalBytes > BYTE_LENGTH_CACHE_MAX_TOTAL_BYTES &&
        byteLengthCache.length > 1
    ) {
        const removedEntry = byteLengthCache.pop();
        totalBytes -= removedEntry.byteLength;
    }
}

export function clearByteLengthCache() {
    byteLengthCache.length = 0;
    lastQueriedText = null;
    lastQueriedByteLength = 0;
}

function markSearchLowercaseCacheDirty() {
    AppState.searchLargeTextLowercaseDirty = true;
}

// ==================== 内容设置 ====================

export function setSourceText(newText, dispatchInput) {
    const shouldDispatch = dispatchInput !== false;
    const textarea = DOM.sourceTextarea;
    if (!textarea) return;

    clearByteLengthCache();
    markSearchLowercaseCacheDirty();

    AppState.sourceText = newText;
    AppState.sourceTextStale = false;

    textarea.value = newText;

    if (shouldDispatch) {
        AppState.internalUpdateInProgress = true;
        try {
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        } finally {
            AppState.internalUpdateInProgress = false;
        }
    }
}

export function setResultText(newText, dispatchInput) {
    const shouldDispatch = dispatchInput !== false;
    const textarea = DOM.resultTextarea;
    if (!textarea) return;

    clearByteLengthCache();
    markSearchLowercaseCacheDirty();

    AppState.resultText = newText;
    AppState.resultTextStale = false;

    textarea.value = newText;

    if (shouldDispatch) {
        AppState.internalUpdateInProgress = true;
        try {
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        } finally {
            AppState.internalUpdateInProgress = false;
        }
    }
}

export function getSourceText() {
    return DOM.sourceTextarea ? DOM.sourceTextarea.value : '';
}

export function getResultText() {
    return DOM.resultTextarea ? DOM.resultTextarea.value : '';
}

// ==================== 文本统计 ====================

export function getTextByteLength(text) {
    if (!text) return 0;

    if (text === lastQueriedText) {
        return lastQueriedByteLength;
    }

    const cachedLength = findInCache(text);
    if (cachedLength !== -1) {
        lastQueriedText = text;
        lastQueriedByteLength = cachedLength;
        return cachedLength;
    }

    let byteLength;
    const textEncoder = getTextEncoder();
    if (textEncoder) {
        byteLength = textEncoder.encode(text).length;
    } else {
        byteLength = new Blob([text]).size;
    }

    lastQueriedText = text;
    lastQueriedByteLength = byteLength;

    storeInCache(text, byteLength);
    return byteLength;
}

export function getTextStatistics(text) {
    if (!text) {
        return { chars: 0, lines: 0, bytes: 0 };
    }

    const chars = text.length;

    let lines = 1;
    for (let index = 0; index < text.length; index++) {
        if (text.charCodeAt(index) === 10) {
            lines++;
        }
    }

    const bytes = getTextByteLength(text);

    return { chars: chars, lines: lines, bytes: bytes };
}

// ==================== 大文本保护 ====================

export function checkTextSize(text, operationName) {
    if (!text) return true;

    const byteLength = getTextByteLength(text);

    if (byteLength > CONFIG.ABSOLUTE_TEXT_SIZE_LIMIT_BYTES) {
        const limitMegabytes = (
            CONFIG.ABSOLUTE_TEXT_SIZE_LIMIT_BYTES / (1024 * 1024)
        ).toFixed(1);
        showToast(
            '❌ 文本超过 ' + limitMegabytes + 'MB 上限，已阻止"' +
            operationName + '"',
            true
        );
        return false;
    }

    if (byteLength > CONFIG.LARGE_TEXT_THRESHOLD_BYTES) {
        const sizeKilobytes = (byteLength / 1024).toFixed(1);
        return confirm(
            '⚠️ 文本较大 (' + sizeKilobytes + ' KB)\n' +
            '执行"' + operationName + '"可能导致浏览器卡顿。\n' +
            '是否继续？'
        );
    }

    return true;
}