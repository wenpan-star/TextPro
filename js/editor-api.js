/**
 * ============================================================================
 * editor-api.js — 编辑器内容统一入口
 * ============================================================================
 *
 * 【本次重构说明 — 搜索缓存策略调整】
 *
 *   一、不再直接清空 search lower-case 缓存，改为标记 dirty
 *     · 旧策略：文本整体替换时清空缓存。这会导致用户仅编辑一个字符时，
 *       20MB 文本的 toLowerCase 结果（~40MB）被丢弃，下次搜索要重算。
 *     · 新策略：仅设置 AppState.searchLargeTextLowercaseDirty = true，
 *       search.js 下次真正搜索时才判断是否重算。
 *     · 同时保留 search.js 内部的"引用相等比较"作为兜底：
 *       若文本引用变了（例如 setResultText），即使 dirty 未设置，
 *       也会自动重算。
 *
 *   二、字节长度缓存的清理保留
 *     · 文本整体替换后，旧缓存命中的概率极低，主动清理降低内存。
 *
 *   三、其余逻辑保持不变
 * ============================================================================
 */

import { CONFIG } from './config.js';
import { AppState } from './state.js';
import { DOM } from './dom.js';
import { showToast } from './toast.js';

// ==================== TextEncoder 单例 ====================

let cachedTextEncoder = null;

/**
 * 获取 TextEncoder 单例。
 */
function getTextEncoder() {
    if (cachedTextEncoder === null && typeof TextEncoder !== 'undefined') {
        cachedTextEncoder = new TextEncoder();
    }
    return cachedTextEncoder;
}

// ==================== 字节长度缓存 ====================

const BYTE_LENGTH_CACHE_MAX_ENTRIES = 5;
const BYTE_LENGTH_CACHE_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const BYTE_LENGTH_CACHE_SINGLE_ENTRY_MAX_BYTES = 4 * 1024 * 1024;

const byteLengthCache = [];

/**
 * 从缓存中查找字符串的字节长度。
 */
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

/**
 * 将结果写入缓存。
 */
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

/**
 * 清空字节长度缓存。
 */
export function clearByteLengthCache() {
    byteLengthCache.length = 0;
}

// ==================== search lower-case 缓存策略 ====================

/**
 * 标记 search lower-case 缓存为"需要重算"。
 *
 * ★ 与原实现的区别：
 *   旧实现直接清空 cache 和 source，会导致下次搜索重算。
 *   新实现只设置 dirty 标记，等下次搜索时才真正重算（惰性失效）。
 *
 * 说明：search.js 内部仍有"引用相等比较"作为兜底 —— 若文本引用
 *       改变（例如 setResultText 用新字符串），即使 dirty 未设置，
 *       也会自动重算。dirty 标记主要用于"用户手动编辑导致引用变化
 *       但内容基本不变"的边界场景。
 */
function markSearchLowercaseCacheDirty() {
    AppState.searchLargeTextLowercaseDirty = true;
}

// ==================== 内容设置 ====================

export function setSourceText(newText, dispatchInput) {
    const shouldDispatch = dispatchInput !== false;
    const textarea = DOM.sourceTextarea;
    if (!textarea) return;

    // 文本整体替换 → 旧字节长度缓存几乎不会命中，主动清理
    clearByteLengthCache();

    // ★ 惰性失效 search lower-case 缓存
    markSearchLowercaseCacheDirty();

    AppState.sourceText = newText;
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

    // ★ 惰性失效 search lower-case 缓存
    markSearchLowercaseCacheDirty();

    AppState.resultText = newText;
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

/**
 * 计算文本 UTF-8 字节数（带缓存）。
 */
export function getTextByteLength(text) {
    if (!text) return 0;

    const cachedLength = findInCache(text);
    if (cachedLength !== -1) {
        return cachedLength;
    }

    let byteLength;
    const textEncoder = getTextEncoder();
    if (textEncoder) {
        byteLength = textEncoder.encode(text).length;
    } else {
        byteLength = new Blob([text]).size;
    }

    storeInCache(text, byteLength);
    return byteLength;
}

/**
 * 获取文本统计信息。
 */
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