// filename: js/storage.js
/**
 * ============================================================================
 * storage.js — IndexedDB 底层 + AES 密钥生命周期 + 持久化存储权限
 * ============================================================================
 *
 * 【本次修订说明 — 修复"数据未真正落盘"的 P0 缺陷】
 *
 *   一、【P0 修复】saveEncryptedState 等待事务真正提交
 *     · 原实现只等 putRequest.onsuccess。根据 IndexedDB 规范，
 *       putRequest.onsuccess 只表示"写请求已被事务接受"，数据还在
 *       事务内存缓冲区中；只有 transaction.oncomplete 触发时才真正落盘。
 *     · 如果页面在 onsuccess 与 oncomplete 之间被卸载（例如用户刷新、
 *       关闭标签页），事务会被浏览器回滚，本次写入彻底丢失。
 *     · 现实现：等待 writeTransaction.oncomplete / onerror / onabort，
 *       保证 await 返回时数据已真正持久化。
 *
 *   二、【P0 修复】getOrCreateCryptoKey 写密钥时同样等待事务提交
 *     · 与 saveEncryptedState 同理。若页面在新密钥尚未提交时被卸载，
 *       下次打开会生成另一把新密钥，导致旧密文永远无法解密。
 *
 *   三、读取操作（get）无需修改
 *     · getRequest.onsuccess 触发时数据已经在内存中，直接使用即可。
 *
 *   四、其余逻辑保持不变
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
 */
export function attachPersistentStorageDeferredTrigger(onResult) {
    if (!CONFIG.STORAGE_PERSIST_DEFERRED) {
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

    // ---- 1. 只读事务：尝试获取已有密钥 ----
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

    // ---- 2. 首次创建密钥 ----
    const newCryptoKey = await generateAesKey();
    const rawKeyBytes = await exportAesKeyToRawBytes(newCryptoKey);

    const writeTransaction = database.transaction(
        INDEXED_DB_CONFIG.STORE_KEYS,
        'readwrite'
    );
    const writeStore = writeTransaction.objectStore(
        INDEXED_DB_CONFIG.STORE_KEYS
    );

    // ★ P0 修复：等待事务真正提交。
    await new Promise(function executor(resolve, reject) {
        let hasSettled = false;

        writeTransaction.oncomplete = function onComplete() {
            if (hasSettled) return;
            hasSettled = true;
            resolve();
        };

        writeTransaction.onerror = function onError(event) {
            if (hasSettled) return;
            hasSettled = true;
            reject(
                (event.target && event.target.error) ||
                new Error('密钥写入事务失败')
            );
        };

        writeTransaction.onabort = function onAbort(event) {
            if (hasSettled) return;
            hasSettled = true;
            reject(
                (event.target && event.target.error) ||
                new Error('密钥写入事务被中止')
            );
        };

        try {
            writeStore.put({
                id: INDEXED_DB_CONFIG.STORE_KEYS_ID,
                key: rawKeyBytes
            });
        } catch (putError) {
            if (hasSettled) return;
            hasSettled = true;
            reject(putError);
        }
    });

    return newCryptoKey;
}

// ============================================================================
// 加密状态存取
// ============================================================================

/**
 * 保存加密状态到 IndexedDB。
 *
 * ★ P0 修复要点：等待 writeTransaction.oncomplete。
 */
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

    // ★ 等待事务提交
    await new Promise(function executor(resolve, reject) {
        let hasSettled = false;

        writeTransaction.oncomplete = function onComplete() {
            if (hasSettled) return;
            hasSettled = true;
            resolve();
        };

        writeTransaction.onerror = function onError(event) {
            if (hasSettled) return;
            hasSettled = true;
            reject(
                (event.target && event.target.error) ||
                new Error('状态写入事务失败')
            );
        };

        writeTransaction.onabort = function onAbort(event) {
            if (hasSettled) return;
            hasSettled = true;
            reject(
                (event.target && event.target.error) ||
                new Error('状态写入事务被中止')
            );
        };

        try {
            stateStore.put({
                id: INDEXED_DB_CONFIG.STORE_STATE_KEY,
                data: encryptedBytes
            });
        } catch (putError) {
            if (hasSettled) return;
            hasSettled = true;
            reject(putError);
        }
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