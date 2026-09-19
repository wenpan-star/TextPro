/**
 * ============================================================================
 * storage.js — IndexedDB 底层 + AES 密钥生命周期 + 持久化存储权限
 * ============================================================================
 *
 * 【本次重构说明】
 *
 *   一、延后申请持久化权限（Firefox 友好）
 *     · 新增 attachPersistentStorageDeferredTrigger() 在首次用户交互时
 *       自动触发申请（一次性）。
 *     · ★ 新增：若 navigator.userActivation.hasBeenActive === true
 *       （用户在本页面会话中已经交互过），立即申请，无需等待新的手势。
 *       这修复了"loadStateOnStartup 的 await 期间用户已点击，但事件
 *       监听器尚未绑定，用户手势被丢弃"的场景。
 *     · 保留 requestPersistentStorage()（立即申请）供启动时使用。
 *
 *   二、保留全部既有能力
 *     · 连接复用、onversionchange 清理、超时保护
 *     · DECRYPT_FAILED / JSON_PARSE_FAILED 错误分类
 * ============================================================================
 */

import { INDEXED_DB_CONFIG, CONFIG } from './config.js';
import {
    generateAesKey,
    importAesKeyFromRawBytes,
    exportAesKeyToRawBytes,
    encryptString,
    decryptString
} from './crypto.js';

// ============================================================================
// 持久化存储权限
// ============================================================================

export async function requestPersistentStorage() {
    try {
        if (
            typeof navigator === 'undefined' ||
            !navigator.storage ||
            typeof navigator.storage.persist !== 'function'
        ) {
            return 'unsupported';
        }

        if (typeof navigator.storage.persisted === 'function') {
            try {
                const alreadyPersisted = await navigator.storage.persisted();
                if (alreadyPersisted === true) {
                    return 'granted';
                }
            } catch (persistedError) {
                console.warn('[TextPro] 查询持久化状态失败:', persistedError);
            }
        }

        const granted = await navigator.storage.persist();
        return granted === true ? 'granted' : 'denied';
    } catch (persistError) {
        console.warn('[TextPro] 申请持久化存储权限失败:', persistError);
        return 'denied';
    }
}

/**
 * 检测"用户是否在本页面会话中已经交互过"。
 *
 * navigator.userActivation 目前在 Chrome / Edge / Firefox 中可用。
 * 若不可用，返回 false，退回到"注册事件等待下次手势"的路径。
 */
function hasUserActivatedInThisSession() {
    try {
        if (
            typeof navigator !== 'undefined' &&
            navigator.userActivation &&
            typeof navigator.userActivation.hasBeenActive === 'boolean'
        ) {
            return navigator.userActivation.hasBeenActive === true;
        }
    } catch (userActivationError) {
        // 忽略
    }
    return false;
}

/**
 * 延后申请持久化权限。
 *
 * 返回一个 Promise，用户首次交互后 resolve。
 * 若 CONFIG.STORAGE_PERSIST_DEFERRED === false，则立即申请。
 *
 * 主要用于 Firefox：在无用户手势时 navigator.storage.persist()
 * 通常直接返回 false，因此等待用户首次点击后再申请。
 *
 * ★ 新增短路：若检测到本会话已有用户交互，则立即申请，跳过事件注册。
 *
 * @param {function} onResult 结果回调（'granted' | 'denied' | 'unsupported'）
 */
export function attachPersistentStorageDeferredTrigger(onResult) {
    if (!CONFIG.STORAGE_PERSIST_DEFERRED) {
        // 不延后 → 立即申请
        requestPersistentStorage().then(function onResolved(result) {
            if (typeof onResult === 'function') {
                onResult(result);
            }
        });
        return;
    }

    if (typeof window === 'undefined' || typeof document === 'undefined') {
        return;
    }

    // 若浏览器不支持 → 直接回调 unsupported
    if (
        typeof navigator === 'undefined' ||
        !navigator.storage ||
        typeof navigator.storage.persist !== 'function'
    ) {
        if (typeof onResult === 'function') {
            onResult('unsupported');
        }
        return;
    }

    // ★ 短路：若用户在本页面会话中已交互过（如 storage.js 被延迟加载，
    //   或 loadStateOnStartup 的 await 期间用户点击过），直接申请。
    if (hasUserActivatedInThisSession()) {
        requestPersistentStorage()
            .then(function onResolved(result) {
                if (typeof onResult === 'function') {
                    onResult(result);
                }
            })
            .catch(function onRejected() {
                if (typeof onResult === 'function') {
                    onResult('denied');
                }
            });
        return;
    }

    let isTriggered = false;

    function cleanup() {
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('keydown', onKeyDown, true);
        document.removeEventListener('touchstart', onTouchStart, true);
    }

    function trigger() {
        if (isTriggered) return;
        isTriggered = true;
        cleanup();

        requestPersistentStorage().then(function onResolved(result) {
            if (typeof onResult === 'function') {
                onResult(result);
            }
        }).catch(function onError(error) {
            console.warn('[TextPro] 延后申请持久化权限失败:', error);
            if (typeof onResult === 'function') {
                onResult('denied');
            }
        });
    }

    function onClick() {
        trigger();
    }

    function onKeyDown() {
        trigger();
    }

    function onTouchStart() {
        trigger();
    }

    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('touchstart', onTouchStart, true);
}

export async function isPersistentStorageGranted() {
    try {
        if (
            typeof navigator === 'undefined' ||
            !navigator.storage ||
            typeof navigator.storage.persisted !== 'function'
        ) {
            return false;
        }
        const persisted = await navigator.storage.persisted();
        return persisted === true;
    } catch (persistError) {
        return false;
    }
}

export async function getStorageEstimate() {
    try {
        if (
            typeof navigator === 'undefined' ||
            !navigator.storage ||
            typeof navigator.storage.estimate !== 'function'
        ) {
            return { usage: 0, quota: 0 };
        }
        const estimate = await navigator.storage.estimate();
        return {
            usage: (estimate && typeof estimate.usage === 'number')
                ? estimate.usage
                : 0,
            quota: (estimate && typeof estimate.quota === 'number')
                ? estimate.quota
                : 0
        };
    } catch (estimateError) {
        return { usage: 0, quota: 0 };
    }
}

// ============================================================================
// IndexedDB 连接管理
// ============================================================================

let cachedDatabaseInstance = null;
let cachedDatabasePromise = null;

function openDatabaseInternal() {
    return new Promise(function executor(resolve, reject) {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('当前浏览器不支持 IndexedDB'));
            return;
        }

        let hasSettled = false;

        const settleTimeoutTimer = setTimeout(function onOpenTimeout() {
            if (hasSettled) return;
            hasSettled = true;
            reject(
                new Error(
                    'IndexedDB 打开超时（可能被其他标签页占用，' +
                    '请关闭其他 TextPro 标签页后重试）'
                )
            );
        }, CONFIG.INDEXED_DB_OPEN_TIMEOUT_MS);

        function safeResolve(databaseInstance) {
            if (hasSettled) {
                try {
                    databaseInstance.close();
                } catch (closeError) {
                    // 忽略
                }
                return;
            }
            hasSettled = true;
            clearTimeout(settleTimeoutTimer);
            resolve(databaseInstance);
        }

        function safeReject(reason) {
            if (hasSettled) return;
            hasSettled = true;
            clearTimeout(settleTimeoutTimer);
            reject(reason);
        }

        let openRequest;
        try {
            openRequest = indexedDB.open(
                INDEXED_DB_CONFIG.NAME,
                INDEXED_DB_CONFIG.VERSION
            );
        } catch (openError) {
            safeReject(openError);
            return;
        }

        openRequest.onupgradeneeded = function onUpgradeNeeded(event) {
            const database = event.target.result;

            if (
                !database.objectStoreNames.contains(
                    INDEXED_DB_CONFIG.STORE_STATE
                )
            ) {
                database.createObjectStore(INDEXED_DB_CONFIG.STORE_STATE, {
                    keyPath: 'id'
                });
            }

            if (
                !database.objectStoreNames.contains(
                    INDEXED_DB_CONFIG.STORE_KEYS
                )
            ) {
                database.createObjectStore(INDEXED_DB_CONFIG.STORE_KEYS, {
                    keyPath: 'id'
                });
            }
        };

        openRequest.onsuccess = function onOpenSuccess(event) {
            safeResolve(event.target.result);
        };

        openRequest.onerror = function onOpenError(event) {
            safeReject(
                (event.target && event.target.error) ||
                new Error('IndexedDB 打开失败')
            );
        };

        openRequest.onblocked = function onOpenBlocked() {
            // 静默等待 —— 由 settleTimeoutTimer 兜底
        };
    });
}

export function getDatabase() {
    if (cachedDatabaseInstance) {
        return Promise.resolve(cachedDatabaseInstance);
    }
    if (cachedDatabasePromise) {
        return cachedDatabasePromise;
    }

    cachedDatabasePromise = openDatabaseInternal()
        .then(function onOpened(database) {
            cachedDatabaseInstance = database;

            database.onversionchange = function onVersionChange() {
                console.log('[TextPro] 检测到数据库版本变化，主动关闭连接');
                try {
                    database.close();
                } catch (closeError) {
                    // 忽略
                }
                cachedDatabaseInstance = null;
                cachedDatabasePromise = null;
            };

            database.onclose = function onClose() {
                cachedDatabaseInstance = null;
                cachedDatabasePromise = null;
            };

            return database;
        })
        .catch(function onOpenFailed(openError) {
            cachedDatabasePromise = null;
            throw openError;
        });

    return cachedDatabasePromise;
}

export function closeDatabase() {
    if (cachedDatabaseInstance) {
        try {
            cachedDatabaseInstance.close();
        } catch (closeError) {
            // 忽略
        }
        cachedDatabaseInstance = null;
        cachedDatabasePromise = null;
    }
}

// ============================================================================
// AES 密钥管理
// ============================================================================

export async function getOrCreateCryptoKey() {
    const database = await getDatabase();

    const readTransaction = database.transaction(
        INDEXED_DB_CONFIG.STORE_KEYS,
        'readonly'
    );
    const keyStore = readTransaction.objectStore(
        INDEXED_DB_CONFIG.STORE_KEYS
    );

    const existingRecord = await new Promise(function executor(
        resolve,
        reject
    ) {
        const getRequest = keyStore.get(INDEXED_DB_CONFIG.STORE_KEYS_ID);
        getRequest.onsuccess = function onSuccess() {
            resolve(getRequest.result);
        };
        getRequest.onerror = function onError(event) {
            reject(event.target.error);
        };
    });

    if (existingRecord && existingRecord.key) {
        return await importAesKeyFromRawBytes(existingRecord.key);
    }

    const newCryptoKey = await generateAesKey();
    const rawKeyBytes = await exportAesKeyToRawBytes(newCryptoKey);

    const writeTransaction = database.transaction(
        INDEXED_DB_CONFIG.STORE_KEYS,
        'readwrite'
    );
    const writeStore = writeTransaction.objectStore(
        INDEXED_DB_CONFIG.STORE_KEYS
    );

    await new Promise(function executor(resolve, reject) {
        const putRequest = writeStore.put({
            id: INDEXED_DB_CONFIG.STORE_KEYS_ID,
            key: rawKeyBytes
        });
        putRequest.onsuccess = function onSuccess() {
            resolve();
        };
        putRequest.onerror = function onError(event) {
            reject(event.target.error);
        };
    });

    return newCryptoKey;
}

// ============================================================================
// 加密状态存取
// ============================================================================

export async function saveEncryptedState(stateJson, cryptoKey) {
    if (!cryptoKey) {
        throw new Error('加密密钥未就绪，无法保存');
    }
    const encryptedBytes = await encryptString(stateJson, cryptoKey);

    const database = await getDatabase();
    const writeTransaction = database.transaction(
        INDEXED_DB_CONFIG.STORE_STATE,
        'readwrite'
    );
    const stateStore = writeTransaction.objectStore(
        INDEXED_DB_CONFIG.STORE_STATE
    );

    await new Promise(function executor(resolve, reject) {
        const putRequest = stateStore.put({
            id: INDEXED_DB_CONFIG.STORE_STATE_KEY,
            data: encryptedBytes
        });
        putRequest.onsuccess = function onSuccess() {
            resolve();
        };
        putRequest.onerror = function onError(event) {
            reject(event.target.error);
        };
    });
}

export async function loadEncryptedState(cryptoKey) {
    if (!cryptoKey) return null;
    const database = await getDatabase();

    const readTransaction = database.transaction(
        INDEXED_DB_CONFIG.STORE_STATE,
        'readonly'
    );
    const stateStore = readTransaction.objectStore(
        INDEXED_DB_CONFIG.STORE_STATE
    );

    const record = await new Promise(function executor(resolve, reject) {
        const getRequest = stateStore.get(
            INDEXED_DB_CONFIG.STORE_STATE_KEY
        );
        getRequest.onsuccess = function onSuccess() {
            resolve(getRequest.result);
        };
        getRequest.onerror = function onError(event) {
            reject(event.target.error);
        };
    });

    if (!record || !record.data) {
        return null;
    }

    let decryptedJson;
    try {
        decryptedJson = await decryptString(record.data, cryptoKey);
    } catch (decryptError) {
        const wrappedError = new Error(
            '解密失败: ' + (decryptError.message || '未知')
        );
        wrappedError.code = 'DECRYPT_FAILED';
        wrappedError.original = decryptError;
        throw wrappedError;
    }

    try {
        return JSON.parse(decryptedJson);
    } catch (jsonError) {
        const wrappedError = new Error(
            'JSON 解析失败: ' + (jsonError.message || '未知')
        );
        wrappedError.code = 'JSON_PARSE_FAILED';
        wrappedError.original = jsonError;
        throw wrappedError;
    }
}

// ============================================================================
// localStorage 明文备份
// ============================================================================

export function saveLocalBackup(storageKey, value) {
    try {
        localStorage.setItem(storageKey, JSON.stringify(value));
    } catch (storageError) {
        // 静默降级（无痕模式 / 配额耗尽）
    }
}

export function loadLocalBackup(storageKey, defaultValue) {
    try {
        const storedItem = localStorage.getItem(storageKey);
        if (storedItem === null) {
            return defaultValue;
        }
        return JSON.parse(storedItem);
    } catch (parseError) {
        return defaultValue;
    }
}