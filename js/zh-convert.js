// filename: js/zh-convert.js
/**
 * ============================================================================
 * zh-convert.js — 繁简中文转换模块（基于 opencc-js）
 * ============================================================================
 *
 * 【模块职责】
 *   为项目提供高质量的繁简中文转换能力，底层使用 opencc-js
 *   （OpenCC 的纯 JavaScript 移植版）。
 *
 * 【为什么用 OpenCC 而不是简单字符映射】
 *   繁简转换存在大量多对一、一对多关系：
 *     · 繁→简：「發/髮 → 发」「乾/幹/干 → 干」等
 *     · 简→繁：「发 → 發 或 髮」「干 → 乾 或 幹 或 干」等
 *   纯逐字映射无法正确处理这些歧义。
 *   OpenCC 通过词汇短语表可大幅提升准确率（尤其简→繁方向）。
 *
 * 【为什么选用 full 包而不是 t2cn + cn2t 两个小包】
 *   opencc-js 的 t2cn.js 和 cn2t.js 都定义了同名的 OpenCC 全局变量，
 *   两个都加载会相互覆盖。只有 full.js 同时包含双向转换能力。
 *
 * 【加载策略】
 *   通过 script-loader.js 实现四级兜底：
 *     内存缓存 → localStorage 缓存 → 多 CDN 依次尝试 → 本地文件兜底
 *
 * 【本次修订说明 — 修复并发调用创建多个转换器实例】
 *
 *   · 原实现：getT2SConverter / getS2TConverter 在 async 函数中
 *     先检查实例、再 await 加载、最后赋值。两次并发调用时，
 *     两者都会通过 null 检查并各自执行一遍 OpenCC.Converter 构造，
 *     浪费一次构造开销，最终后完成的覆盖先完成的。
 *
 *   · 现实现：使用 Promise 缓存转换器实例的创建过程。
 *     当第一次调用开始创建时，同步把一个 Promise 记录到模块级变量；
 *     后续调用直接复用该 Promise，等同一个实例。
 *     创建完成后（无论成功失败）清空 Promise 缓存，
 *     保证下次失败时可以重试，成功时直接走实例缓存。
 *
 * 【对外导出】
 *   - getT2SConverter()            获取「繁→简」转换函数（异步，单例）
 *   - getS2TConverter()            获取「简→繁」转换函数（异步，单例）
 *   - convertToSimplified(text)    直接把文本转为简体（异步）
 *   - convertToTraditional(text)   直接把文本转为繁体（异步）
 *   - isOpenCCReady()              检查 opencc-js 是否已就绪
 *   - preloadOpenCC()              后台预加载 opencc-js（不抛异常）
 * ============================================================================
 */

import { loadLibraryWithFallback } from './script-loader.js';

// ============================================================================
// opencc-js 加载配置
// ============================================================================

/**
 * opencc-js（full 包）的加载配置。
 *
 * 关于版本与路径：
 *   · 1.0.5 是目前稳定的版本，UMD 产物路径为 dist/umd/full.js
 *   · full.js 同时支持繁→简、简→繁、繁→台、繁→港等多方向转换
 *   · 使用多 CDN 兜底，避免单点不可用
 */
const OPENCC_LIBRARY_CONFIG = Object.freeze({
    libraryDisplayName: 'opencc-js (full)',
    globalVariableName: 'OpenCC',
    localStorageCacheKey: 'textpro-opencc-full-cache-v1',
    timeoutMs: 20000,
    cdnUrlList: Object.freeze([
        'https://cdn.jsdelivr.net/npm/opencc-js@1.0.5/dist/umd/full.js',
        'https://unpkg.com/opencc-js@1.0.5/dist/umd/full.js',
        'https://cdn.jsdelivr.net/npm/opencc-js/dist/umd/full.js'
    ]),
    localFallbackUrl: 'vendor/opencc-js/full.js'
});

// ============================================================================
// 模块级状态：转换器单例 + 创建过程 Promise 缓存
// ============================================================================

/**
 * 繁→简转换函数实例（单例）。
 * 由 OpenCC.Converter({ from: 'tw', to: 'cn' }) 生成。
 */
let t2sConverterInstance = null;

/**
 * 简→繁转换函数实例（单例）。
 * 由 OpenCC.Converter({ from: 'cn', to: 'tw' }) 生成。
 */
let s2tConverterInstance = null;

/**
 * 繁→简转换器"正在创建中"的 Promise 缓存。
 *
 * 当第一次调用 getT2SConverter 时，如果实例尚不存在，
 * 我们会立即创建一个 Promise 并记录在此。后续并发调用
 * 直接返回这个 Promise，等同一个实例。
 *
 * 创建完成后（无论成功还是失败）此变量会被清空：
 *   · 成功：实例已缓存在 t2sConverterInstance，后续调用命中实例缓存
 *   · 失败：允许下次调用重新尝试
 */
let t2sConverterPromise = null;

/**
 * 简→繁转换器"正在创建中"的 Promise 缓存。语义同 t2sConverterPromise。
 */
let s2tConverterPromise = null;

// ============================================================================
// 内部工具函数
// ============================================================================

/**
 * 确保 opencc-js 已加载并可用。
 *
 * 若尚未加载，则通过 script-loader.js 触发四级兜底加载流程。
 * 由于 script-loader.js 内部做了内存缓存，本函数可安全多次调用。
 *
 * @returns {Promise<void>}
 * @throws {Error} 加载失败或全局变量异常时抛出
 */
async function ensureOpenCCLoaded() {
    await loadLibraryWithFallback(OPENCC_LIBRARY_CONFIG);

    if (typeof OpenCC === 'undefined') {
        throw new Error('opencc-js 加载后未找到 OpenCC 全局变量');
    }

    if (typeof OpenCC.Converter !== 'function') {
        throw new Error('opencc-js 的 OpenCC.Converter 不是函数');
    }
}

// ============================================================================
// 对外导出：转换器获取
// ============================================================================

/**
 * 获取「繁→简」转换函数（异步，单例）。
 *
 * 转换函数签名：(text: string) => string
 *   · from: 'tw'（台湾正体）to: 'cn'（大陆简体）
 *   · 也适用于香港繁体，OpenCC 会做正确映射
 *
 * ★ 并发安全：
 *   · 若实例已存在 → 直接返回实例
 *   · 若正在创建中 → 返回同一个创建 Promise
 *   · 否则 → 启动创建过程，记录 Promise 供并发调用复用
 *
 * @returns {Promise<Function>} 转换函数
 */
export async function getT2SConverter() {
    // ---- 快路径：实例已就绪 ----
    if (t2sConverterInstance) {
        return t2sConverterInstance;
    }

    // ---- 并发路径：正在创建中，复用同一个 Promise ----
    if (t2sConverterPromise) {
        return t2sConverterPromise;
    }

    // ---- 首次创建 ----
    t2sConverterPromise = (async function createT2SConverter() {
        try {
            await ensureOpenCCLoaded();
            t2sConverterInstance = OpenCC.Converter({
                from: 'tw',
                to: 'cn'
            });
            return t2sConverterInstance;
        } finally {
            // 清空创建中的标记：
            //   · 成功：后续调用走 t2sConverterInstance 实例缓存
            //   · 失败：后续调用可以重新尝试
            t2sConverterPromise = null;
        }
    })();

    return t2sConverterPromise;
}

/**
 * 获取「简→繁」转换函数（异步，单例）。
 *
 * 转换函数签名：(text: string) => string
 *   · from: 'cn'（大陆简体）to: 'tw'（台湾正体）
 *
 * ★ 并发安全：语义同 getT2SConverter。
 *
 * @returns {Promise<Function>} 转换函数
 */
export async function getS2TConverter() {
    if (s2tConverterInstance) {
        return s2tConverterInstance;
    }

    if (s2tConverterPromise) {
        return s2tConverterPromise;
    }

    s2tConverterPromise = (async function createS2TConverter() {
        try {
            await ensureOpenCCLoaded();
            s2tConverterInstance = OpenCC.Converter({
                from: 'cn',
                to: 'tw'
            });
            return s2tConverterInstance;
        } finally {
            s2tConverterPromise = null;
        }
    })();

    return s2tConverterPromise;
}

// ============================================================================
// 对外导出：便捷转换函数
// ============================================================================

/**
 * 直接把文本转换为简体中文。
 *
 * @param {string} sourceText 源文本
 * @returns {Promise<string>} 转换后的文本
 */
export async function convertToSimplified(sourceText) {
    const converterFunction = await getT2SConverter();
    return converterFunction(String(sourceText === null ||
        sourceText === undefined ? '' : sourceText));
}

/**
 * 直接把文本转换为繁体中文。
 *
 * @param {string} sourceText 源文本
 * @returns {Promise<string>} 转换后的文本
 */
export async function convertToTraditional(sourceText) {
    const converterFunction = await getS2TConverter();
    return converterFunction(String(sourceText === null ||
        sourceText === undefined ? '' : sourceText));
}

// ============================================================================
// 对外导出：状态查询与预加载
// ============================================================================

/**
 * 检查 opencc-js 是否已就绪（全局变量已存在且 API 可用）。
 *
 * 注意：本函数只做同步检查，不会触发加载。
 *
 * @returns {boolean}
 */
export function isOpenCCReady() {
    return (
        typeof OpenCC !== 'undefined' &&
        typeof OpenCC.Converter === 'function'
    );
}

/**
 * 后台预加载 opencc-js。
 *
 * 用于在用户未主动点击转换按钮前提前预热，加快首次响应速度。
 * 本函数吞掉所有异常（预加载失败不应影响主流程），
 * 只打印警告日志。
 *
 * @returns {Promise<void>}
 */
export function preloadOpenCC() {
    return ensureOpenCCLoaded().catch(function onPreloadError(preloadError) {
        console.warn(
            '[zh-convert] opencc-js 预加载失败（不影响主流程）：',
            preloadError && preloadError.message
                ? preloadError.message
                : preloadError
        );
    });
}