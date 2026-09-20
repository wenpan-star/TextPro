// filename: js/script-loader.js
/**
 * ============================================================================
 * script-loader.js — 外部脚本多级兜底加载器
 * ============================================================================
 *
 * 【模块职责】
 *   为项目提供统一的第三方脚本动态加载能力，支持以下四级兜底策略：
 *
 *     1. 内存缓存（Map，当前会话内）
 *        · 同一个库在同一个会话中只请求一次
 *        · 后续调用直接命中缓存，不产生任何网络请求
 *
 *     2. localStorage 持久化缓存（跨会话）
 *        · 脚本成功加载后，通过 fetch 获取脚本文本写入 localStorage
 *        · 下次启动时优先从 localStorage 注入，避免任何网络请求
 *        · 受同源策略限制，若 CDN 不允许跨域 fetch，则跳过缓存
 *          （仅脚本加载成功，不写入 localStorage）
 *        · localStorage 写入失败（配额耗尽）时静默降级
 *
 *     3. 多 CDN 依次回退
 *        · 按传入顺序依次尝试，任一成功即停止
 *        · 单个 CDN 超时（默认 10 秒）或加载失败时自动切换下一个
 *
 *     4. 本地文件最终兜底
 *        · 所有 CDN 均失败时，尝试加载项目自托管的本地备份文件
 *
 * 【设计原则】
 *   · 无第三方依赖：仅使用浏览器原生 API（fetch / localStorage / DOM）
 *   · 幂等：同一个库无论调用多少次，只会真正加载一次
 *   · 可观测：所有关键步骤输出 console 日志，便于排障
 *   · 可降级：任何一步失败都不抛出未捕获异常，只在最终全部失败时 reject
 *   · 不污染全局：所有状态（内存缓存）封装在模块内部
 *
 * 【对外导出】
 *   - loadLibraryWithFallback(options)   主入口，多级兜底加载一个库
 *   - isLibraryLoadedInMemory(cacheKey)  查询某库是否已在内存缓存中
 *   - clearMemoryCache(cacheKey)         清除某库的内存缓存（仅调试用）
 * ============================================================================
 */

// ============================================================================
// 模块级状态
// ============================================================================

/**
 * 内存缓存：记录每个库的加载 Promise。
 *   key   = localStorageCacheKey（作为库的唯一标识）
 *   value = Promise（加载成功时 resolve，失败时 reject）
 *
 * 使用 Promise 作为值而非布尔标志，是为了支持"并发调用同一库"时，
 * 后续调用直接复用第一次的加载 Promise，而不是重复发起网络请求。
 */
const loadedLibraryPromises = new Map();

// ============================================================================
// 内部工具函数
// ============================================================================

/**
 * 向 document.head 注入 <script> 标签并等待其加载完成。
 *
 * @param {string} scriptUrl 脚本 URL
 * @param {number} timeoutMs 超时毫秒数
 * @returns {Promise<void>} 加载成功时 resolve，超时或失败时 reject
 */
function injectScriptElementAndAwaitLoad(scriptUrl, timeoutMs) {
    return new Promise(function executor(resolvePromise, rejectPromise) {
        const scriptElement = document.createElement('script');
        scriptElement.src = scriptUrl;
        scriptElement.async = true;
        // 注意：这里刻意不设置 crossOrigin 属性。
        //   · 若设置 crossOrigin='anonymous'，CDN 必须返回 CORS 头，
        //     否则脚本本身加载就会失败。
        //   · 不设置时，脚本以 no-cors 方式加载，成功率最高。
        //   · 若后续 fetch 缓存时 CDN 不支持 CORS，仅跳过缓存，不影响功能。

        let hasSettled = false;

        const timeoutTimer = setTimeout(function onTimeout() {
            if (hasSettled) return;
            hasSettled = true;
            scriptElement.onload = null;
            scriptElement.onerror = null;
            scriptElement.remove();
            rejectPromise(new Error(
                '脚本加载超时（' + timeoutMs + 'ms）: ' + scriptUrl
            ));
        }, timeoutMs);

        scriptElement.onload = function onLoad() {
            if (hasSettled) return;
            hasSettled = true;
            clearTimeout(timeoutTimer);
            // 刻意不移除 script 标签：移除会导致某些库的全局变量失效。
            resolvePromise();
        };

        scriptElement.onerror = function onError() {
            if (hasSettled) return;
            hasSettled = true;
            clearTimeout(timeoutTimer);
            scriptElement.remove();
            rejectPromise(new Error('脚本加载失败: ' + scriptUrl));
        };

        document.head.appendChild(scriptElement);
    });
}

/**
 * 直接把脚本文本注入到 document.head 中执行。
 * 用于从 localStorage 缓存恢复脚本，避免任何网络请求。
 *
 * @param {string} scriptText 脚本文本内容
 * @returns {Promise<void>}
 */
function injectScriptTextDirectly(scriptText) {
    return new Promise(function executor(resolvePromise, rejectPromise) {
        try {
            const scriptElement = document.createElement('script');
            scriptElement.textContent = scriptText;
            document.head.appendChild(scriptElement);
            resolvePromise();
        } catch (injectError) {
            rejectPromise(injectError);
        }
    });
}

/**
 * 检查某个全局变量是否已定义。
 *
 * @param {string|null} globalVariableName 全局变量名（null 表示跳过检查）
 * @returns {boolean}
 */
function checkGlobalVariableExists(globalVariableName) {
    if (!globalVariableName) return true;
    try {
        return typeof window[globalVariableName] !== 'undefined';
    } catch (checkError) {
        return false;
    }
}

/**
 * 尝试把脚本内容写入 localStorage 缓存。
 *
 * 若 fetch 被 CORS 阻止，或 localStorage 配额耗尽，都仅打印警告，
 * 不影响主流程。
 *
 * @param {string} scriptUrl 脚本 URL
 * @param {string} cacheKey localStorage 缓存键
 * @param {string} libraryDisplayName 库的展示名（仅用于日志）
 * @returns {Promise<void>}
 */
async function tryCacheScriptText(scriptUrl, cacheKey, libraryDisplayName) {
    try {
        const fetchResponse = await fetch(scriptUrl, {
            credentials: 'omit'
        });

        if (!fetchResponse.ok) {
            console.warn(
                '[ScriptLoader] 缓存跳过（HTTP ' +
                fetchResponse.status + '）：' + libraryDisplayName
            );
            return;
        }

        const scriptText = await fetchResponse.text();
        if (!scriptText || scriptText.length === 0) {
            return;
        }

        try {
            localStorage.setItem(cacheKey, scriptText);
            console.log(
                '[ScriptLoader] 已写入 localStorage 缓存：' +
                libraryDisplayName + '（约 ' +
                Math.round(scriptText.length / 1024) + ' KB）'
            );
        } catch (quotaError) {
            console.warn(
                '[ScriptLoader] localStorage 写入失败（可能配额不足）：' +
                libraryDisplayName,
                quotaError && quotaError.message
                    ? quotaError.message
                    : quotaError
            );
        }
    } catch (fetchError) {
        // 常见原因：CDN 未返回 CORS 头 → fetch 被浏览器拦截。
        // 此时脚本本身已加载成功，只是无法缓存。属于可接受的降级。
        console.warn(
            '[ScriptLoader] fetch 缓存跳过（可能被 CORS 阻止）：' +
            libraryDisplayName,
            fetchError && fetchError.message ? fetchError.message : fetchError
        );
    }
}

/**
 * 尝试从 localStorage 缓存中恢复脚本。
 *
 * @param {string} cacheKey localStorage 缓存键
 * @param {string|null} globalVariableName 加载后需要验证的全局变量名
 * @param {string} libraryDisplayName 库的展示名（仅用于日志）
 * @returns {Promise<boolean>} true 表示从缓存恢复成功，false 表示无缓存或缓存无效
 */
async function tryRestoreFromLocalStorageCache(
    cacheKey,
    globalVariableName,
    libraryDisplayName
) {
    let cachedScriptText = null;

    try {
        cachedScriptText = localStorage.getItem(cacheKey);
    } catch (readError) {
        console.warn(
            '[ScriptLoader] 读取 localStorage 缓存失败：' + libraryDisplayName,
            readError && readError.message ? readError.message : readError
        );
        return false;
    }

    if (!cachedScriptText || cachedScriptText.length === 0) {
        return false;
    }

    console.log(
        '[ScriptLoader] 命中 localStorage 缓存：' + libraryDisplayName
    );

    try {
        await injectScriptTextDirectly(cachedScriptText);
    } catch (injectError) {
        console.warn(
            '[ScriptLoader] 缓存注入失败，准备回退到网络：' + libraryDisplayName,
            injectError && injectError.message ? injectError.message : injectError
        );
        return false;
    }

    if (checkGlobalVariableExists(globalVariableName)) {
        console.log(
            '[ScriptLoader] 从 localStorage 缓存恢复成功：' + libraryDisplayName
        );
        return true;
    }

    // 缓存内容无效（全局变量缺失）：清除缓存，让后续走网络
    console.warn(
        '[ScriptLoader] localStorage 缓存无效，已清除：' + libraryDisplayName
    );
    try {
        localStorage.removeItem(cacheKey);
    } catch (removeError) {
        // 忽略
    }
    return false;
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 多级兜底加载一个外部库。
 *
 * @param {object} options 加载配置
 * @param {string} options.libraryDisplayName 库的展示名（用于日志）
 * @param {string[]} options.cdnUrlList CDN 地址列表（按优先级排序）
 * @param {string|null} options.localFallbackUrl 本地文件兜底 URL
 * @param {string} options.localStorageCacheKey localStorage 缓存键
 * @param {string|null} options.globalVariableName 加载后需要验证的全局变量名
 * @param {number} [options.timeoutMs=10000] 单个脚本的超时毫秒数
 *
 * @returns {Promise<void>} 加载成功时 resolve，全部失败时 reject
 */
export function loadLibraryWithFallback(options) {
    const libraryDisplayName = options.libraryDisplayName || '未命名库';
    const cdnUrlList = Array.isArray(options.cdnUrlList)
        ? options.cdnUrlList
        : [];
    const localFallbackUrl = options.localFallbackUrl || null;
    const localStorageCacheKey =
        options.localStorageCacheKey ||
        ('textpro-script-cache-' + libraryDisplayName);
    const globalVariableName = options.globalVariableName || null;
    const timeoutMs =
        typeof options.timeoutMs === 'number' && options.timeoutMs > 0
            ? options.timeoutMs
            : 10000;

    // ---- 1. 内存缓存检查 ----
    if (loadedLibraryPromises.has(localStorageCacheKey)) {
        return loadedLibraryPromises.get(localStorageCacheKey);
    }

    // ---- 创建加载 Promise 并立即写入内存缓存 ----
    const loadingPromise = (async function performLoading() {
        // ---- 2. localStorage 持久化缓存 ----
        const restoredFromCache = await tryRestoreFromLocalStorageCache(
            localStorageCacheKey,
            globalVariableName,
            libraryDisplayName
        );
        if (restoredFromCache) {
            return;
        }

        // ---- 3. 依次尝试多个 CDN ----
        let lastCdnError = null;
        for (
            let cdnIndex = 0;
            cdnIndex < cdnUrlList.length;
            cdnIndex++
        ) {
            const currentCdnUrl = cdnUrlList[cdnIndex];
            try {
                console.log(
                    '[ScriptLoader] 尝试 CDN [' +
                    (cdnIndex + 1) + '/' + cdnUrlList.length + ']：' +
                    currentCdnUrl
                );
                await injectScriptElementAndAwaitLoad(
                    currentCdnUrl,
                    timeoutMs
                );

                if (!checkGlobalVariableExists(globalVariableName)) {
                    throw new Error(
                        '脚本加载后全局变量缺失：' + globalVariableName
                    );
                }

                console.log(
                    '[ScriptLoader] CDN 加载成功：' + libraryDisplayName
                );
                // 异步写入持久化缓存（不阻塞主流程）
                tryCacheScriptText(
                    currentCdnUrl,
                    localStorageCacheKey,
                    libraryDisplayName
                );
                return;
            } catch (cdnError) {
                lastCdnError = cdnError;
                console.warn(
                    '[ScriptLoader] CDN 加载失败：' + currentCdnUrl,
                    cdnError && cdnError.message
                        ? cdnError.message
                        : cdnError
                );
                // 继续尝试下一个 CDN
            }
        }

        // ---- 4. 本地文件兜底 ----
        if (localFallbackUrl) {
            try {
                console.log(
                    '[ScriptLoader] 尝试本地兜底文件：' + localFallbackUrl
                );
                await injectScriptElementAndAwaitLoad(
                    localFallbackUrl,
                    timeoutMs
                );

                if (!checkGlobalVariableExists(globalVariableName)) {
                    throw new Error(
                        '本地脚本加载后全局变量缺失：' + globalVariableName
                    );
                }

                console.log(
                    '[ScriptLoader] 本地兜底加载成功：' + libraryDisplayName
                );
                return;
            } catch (localError) {
                console.error(
                    '[ScriptLoader] 本地兜底也失败：' + libraryDisplayName,
                    localError && localError.message
                        ? localError.message
                        : localError
                );
            }
        }

        // ---- 全部加载方式均失败 ----
        const lastErrorMessage = lastCdnError
            ? (lastCdnError.message || String(lastCdnError))
            : '未配置任何 CDN 地址';
        throw new Error(
            '所有加载方式均失败：' + libraryDisplayName +
            '（最后错误：' + lastErrorMessage + '）'
        );
    })();

    loadedLibraryPromises.set(localStorageCacheKey, loadingPromise);

    // 失败时清除内存缓存，允许后续重试
    loadingPromise.catch(function onLoadFailed() {
        loadedLibraryPromises.delete(localStorageCacheKey);
    });

    return loadingPromise;
}

/**
 * 查询某库是否已在内存缓存中。
 *
 * @param {string} localStorageCacheKey 库的缓存键
 * @returns {boolean}
 */
export function isLibraryLoadedInMemory(localStorageCacheKey) {
    return loadedLibraryPromises.has(localStorageCacheKey);
}

/**
 * 清除某库的内存缓存（仅调试用）。
 *
 * @param {string} localStorageCacheKey 库的缓存键
 */
export function clearMemoryCache(localStorageCacheKey) {
    loadedLibraryPromises.delete(localStorageCacheKey);
}