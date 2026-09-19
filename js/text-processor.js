/**
 * ============================================================================
 * text-processor.js — Worker 异步调度 + 纯函数重新导出
 * ============================================================================
 *
 * 【本次重构说明 — JS 模式强制走 Worker】
 *
 *   一、JS 模式强制走 Worker（关键安全/健壮性优化）
 *     · JS 模式可执行任意代码，理论上可能死循环。
 *     · 原实现：小文本走主线程，可能被死循环卡死整个页面。
 *     · 现实现：只要规则中含 isJS === true 的规则，强制走 Worker，
 *       统一受 WORKER_TASK_TIMEOUT_MS 超时保护。
 *     · 若 Worker 不可用，明确拒绝执行 JS 模式，避免卡死。
 *
 *   二、新增 shouldUseWorkerForBatch 判断
 *     · 单条替换走 shouldUseWorkerForSingle。
 *     · 批量替换走 shouldUseWorkerForBatch（含 JS 规则时强制 Worker）。
 *
 *   三、其余逻辑保持不变
 *     · Worker 单例复用、超时保护、崩溃恢复、任务队列、取消机制
 * ============================================================================
 */

import { CONFIG } from './config.js';
import {
    escapeRegexLiteral,
    unescapeReplacementString,
    performSingleReplace,
    performLoopReplace,
    performLoopReplaceWithProgress,
    performReplace
} from './replace-core.js';

// ==================== 重新导出纯函数（保持 API 兼容） ====================

export {
    escapeRegexLiteral,
    unescapeReplacementString,
    performSingleReplace,
    performLoopReplace,
    performLoopReplaceWithProgress,
    performReplace
};

// ==================== Worker 任务队列 ====================

let workerInstance = null;
let workerCreationFailed = false;

let currentTask = null;
let taskQueue = [];

let taskIdCounter = 0;

function generateTaskId() {
    taskIdCounter++;
    return 'task_' + Date.now() + '_' + taskIdCounter;
}

function getWorker() {
    if (workerCreationFailed) return null;
    if (workerInstance) return workerInstance;

    if (typeof Worker === 'undefined') {
        workerCreationFailed = true;
        return null;
    }

    try {
        workerInstance = new Worker(
            new URL('./text-worker.js', import.meta.url),
            { type: 'module' }
        );
        workerInstance.onmessage = handleWorkerMessage;
        workerInstance.onerror = handleWorkerError;
        return workerInstance;
    } catch (creationError) {
        console.warn('Worker 创建失败:', creationError);
        workerCreationFailed = true;
        workerInstance = null;
        return null;
    }
}

function destroyWorker() {
    if (!workerInstance) return;
    try {
        workerInstance.terminate();
    } catch (terminateError) {
        // 忽略
    }
    workerInstance = null;
}

function handleWorkerMessage(event) {
    const messageData = event.data;
    if (!messageData || typeof messageData !== 'object') return;

    if (!currentTask || messageData.taskId !== currentTask.taskId) {
        return;
    }

    const messageType = messageData.type;

    if (messageType === 'progress') {
        if (typeof currentTask.progress === 'function') {
            try {
                currentTask.progress(
                    messageData.current,
                    messageData.total,
                    messageData.ruleName,
                    messageData.iteration,
                    messageData.maxIterations
                );
            } catch (progressError) {
                console.warn('进度回调异常:', progressError);
            }
        }
        return;
    }

    if (messageType === 'complete') {
        const finishedTask = currentTask;
        clearTimeout(finishedTask.timeoutTimer);
        currentTask = null;

        const resultBuffer = messageData.resultBuffer;
        const errors = messageData.errors || [];

        let newText = '';
        if (resultBuffer) {
            newText = new TextDecoder().decode(new Uint8Array(resultBuffer));
        }

        if (typeof finishedTask.resolve === 'function') {
            finishedTask.resolve({
                newText: newText,
                errors: errors,
                cancelled: false
            });
        }

        processNextQueuedTask();
        return;
    }

    if (messageType === 'error') {
        const finishedTask = currentTask;
        clearTimeout(finishedTask.timeoutTimer);
        currentTask = null;

        if (typeof finishedTask.reject === 'function') {
            finishedTask.reject(new Error(messageData.message || 'Worker 执行失败'));
        }

        processNextQueuedTask();
        return;
    }

    if (messageType === 'cancelled') {
        const finishedTask = currentTask;
        clearTimeout(finishedTask.timeoutTimer);
        currentTask = null;

        if (typeof finishedTask.resolve === 'function') {
            finishedTask.resolve({
                newText: null,
                errors: [],
                cancelled: true
            });
        }

        processNextQueuedTask();
        return;
    }
}

function handleWorkerError(errorEvent) {
    console.warn('Worker 内部错误:', errorEvent);

    const finishedTask = currentTask;
    if (finishedTask) {
        clearTimeout(finishedTask.timeoutTimer);
        currentTask = null;

        if (typeof finishedTask.reject === 'function') {
            finishedTask.reject(
                new Error('Worker 内部错误: ' + (errorEvent.message || '未知'))
            );
        }
    }

    destroyWorker();
    processNextQueuedTask();
}

function handleTaskTimeout(taskId) {
    if (!currentTask || currentTask.taskId !== taskId) return;

    const timedOutTask = currentTask;
    clearTimeout(timedOutTask.timeoutTimer);
    currentTask = null;

    destroyWorker();

    if (typeof timedOutTask.reject === 'function') {
        const timeoutError = new Error(
            '任务超时（' + (CONFIG.WORKER_TASK_TIMEOUT_MS / 1000) + '秒）'
        );
        timeoutError.timeout = true;
        timedOutTask.reject(timeoutError);
    }

    processNextQueuedTask();
}

function processNextQueuedTask() {
    if (currentTask !== null) return;
    if (taskQueue.length === 0) return;

    const nextQueued = taskQueue.shift();
    executeTask(nextQueued);
}

function executeTask(queuedTask) {
    const worker = getWorker();

    // ★ Worker 不可用时的处理策略
    if (!worker) {
        // 若有 syncFallback，执行同步降级
        if (typeof queuedTask.syncFallback === 'function') {
            try {
                const syncResult = queuedTask.syncFallback();
                if (typeof queuedTask.resolve === 'function') {
                    queuedTask.resolve(syncResult);
                }
            } catch (syncError) {
                if (typeof queuedTask.reject === 'function') {
                    queuedTask.reject(syncError);
                }
            }
        } else {
            // 无 syncFallback → 直接拒绝
            if (typeof queuedTask.reject === 'function') {
                const unavailableError = new Error(
                    '后台计算线程不可用，无法执行此任务'
                );
                unavailableError.workerUnavailable = true;
                queuedTask.reject(unavailableError);
            }
        }
        processNextQueuedTask();
        return;
    }

    const taskId = queuedTask.taskId;
    const timeoutTimer = setTimeout(function() {
        handleTaskTimeout(taskId);
    }, CONFIG.WORKER_TASK_TIMEOUT_MS);

    currentTask = {
        taskId: taskId,
        resolve: queuedTask.resolve,
        reject: queuedTask.reject,
        progress: queuedTask.progress,
        timeoutTimer: timeoutTimer
    };

    try {
        worker.postMessage(queuedTask.payload);
    } catch (postError) {
        clearTimeout(timeoutTimer);
        currentTask = null;
        destroyWorker();

        if (typeof queuedTask.reject === 'function') {
            queuedTask.reject(postError);
        }

        processNextQueuedTask();
    }
}

// ==================== 判断是否需要 Worker ====================

/**
 * 判断单条替换是否需要走 Worker。
 *
 * @param {string} text 待处理文本
 * @param {object} rule 规则（含 isJS 字段）
 */
function shouldUseWorkerForSingle(text, rule) {
    if (!text) return false;

    // ★ JS 模式强制走 Worker（避免死循环卡死主线程）
    if (rule && rule.isJS === true) {
        return true;
    }

    const lengthThreshold = Math.floor(
        CONFIG.LARGE_TEXT_WORKER_THRESHOLD_BYTES / 3
    );
    return text.length >= lengthThreshold;
}

/**
 * 判断批量替换是否需要走 Worker。
 *
 * @param {string} text 待处理文本
 * @param {Array} rules 规则数组
 */
function shouldUseWorkerForBatch(text, rules) {
    if (!text) return false;

    // ★ 若任一规则是 JS 模式 → 强制走 Worker
    if (Array.isArray(rules)) {
        for (let index = 0; index < rules.length; index++) {
            if (rules[index] && rules[index].isJS === true) {
                return true;
            }
        }
    }

    const lengthThreshold = Math.floor(
        CONFIG.LARGE_TEXT_WORKER_THRESHOLD_BYTES / 3
    );
    return text.length >= lengthThreshold;
}

// ==================== 公开 API ====================

export function cancelCurrentWorkerTask() {
    if (!currentTask) {
        if (taskQueue.length > 0) {
            const queuedTasks = taskQueue.slice();
            taskQueue = [];
            queuedTasks.forEach(function(qTask) {
                if (typeof qTask.reject === 'function') {
                    const cancelError = new Error('任务已取消');
                    cancelError.cancelled = true;
                    qTask.reject(cancelError);
                }
            });
        }
        return;
    }

    const cancelledTask = currentTask;
    clearTimeout(cancelledTask.timeoutTimer);
    currentTask = null;

    if (workerInstance) {
        try {
            workerInstance.postMessage({
                taskId: cancelledTask.taskId,
                type: 'cancel'
            });
        } catch (postError) {
            // 忽略
        }
    }

    destroyWorker();

    if (typeof cancelledTask.reject === 'function') {
        const cancelError = new Error('任务已取消');
        cancelError.cancelled = true;
        cancelError.taskId = cancelledTask.taskId;
        cancelledTask.reject(cancelError);
    }

    if (taskQueue.length > 0) {
        const queuedTasks = taskQueue.slice();
        taskQueue = [];
        queuedTasks.forEach(function(qTask) {
            if (typeof qTask.reject === 'function') {
                const cancelError = new Error('任务已取消');
                cancelError.cancelled = true;
                qTask.reject(cancelError);
            }
        });
    }
}

/**
 * 异步批量替换。
 *
 * ★ 判定策略：
 *   · 含 JS 规则 → 强制走 Worker（无 syncFallback，Worker 不可用则拒绝）
 *   · 大文本 → 走 Worker
 *   · 小文本 + 无 JS 规则 → 主线程同步（低延迟）
 */
export function performBatchReplaceAsync(
    text,
    rules,
    flags,
    loopUntilStable,
    onProgress
) {
    const containsJSRule = Array.isArray(rules) && rules.some(function check(
        rule
    ) {
        return rule && rule.isJS === true;
    });

    const needWorker = shouldUseWorkerForBatch(text, rules);

    // ---- 不需要 Worker：小文本 + 无 JS 规则 ----
    if (!needWorker) {
        return performBatchReplaceSync(text, rules, flags, loopUntilStable, onProgress);
    }

    // ---- Worker 不可用时的处理 ----
    const worker = getWorker();
    if (!worker) {
        // ★ 含 JS 规则：明确拒绝（保护主线程）
        if (containsJSRule) {
            return Promise.reject(new Error(
                '后台计算线程不可用，无法安全执行 JS 模式规则。\n' +
                '请刷新页面或检查浏览器是否支持 Web Worker。'
            ));
        }
        // 普通大文本：降级同步（用户已确认过大小）
        return performBatchReplaceSync(
            text,
            rules,
            flags,
            loopUntilStable,
            onProgress
        );
    }

    return new Promise(function(resolve, reject) {
        const taskId = generateTaskId();

        const queuedTask = {
            taskId: taskId,
            payload: {
                taskId: taskId,
                type: 'batchReplace',
                text: text,
                rules: rules,
                flags: flags,
                loop: loopUntilStable
            },
            resolve: resolve,
            reject: reject,
            progress: onProgress,
            // ★ 含 JS 规则不提供 syncFallback（避免主线程死循环）
            syncFallback: containsJSRule
                ? null
                : function() {
                    return performBatchReplaceSync(
                        text,
                        rules,
                        flags,
                        loopUntilStable,
                        onProgress
                    );
                }
        };

        if (currentTask === null) {
            executeTask(queuedTask);
        } else {
            taskQueue.push(queuedTask);
        }
    });
}

function performBatchReplaceSync(text, rules, flags, loopUntilStable, onProgress) {
    let currentText = text;
    const errors = [];

    for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex++) {
        const rule = rules[ruleIndex];

        if (!rule.pattern || !rule.pattern.trim()) {
            if (typeof onProgress === 'function') {
                onProgress(ruleIndex + 1, rules.length, rule.name, null, null);
            }
            continue;
        }

        const replaceResult = performReplace(
            currentText,
            rule.pattern,
            rule.replacement,
            flags,
            rule.isRegex,
            !!rule.isJS,
            loopUntilStable
        );

        if (replaceResult.error) {
            errors.push({
                ruleId: rule.id,
                ruleName: rule.name,
                errorMessage: replaceResult.error
            });
        } else if (replaceResult.changed) {
            currentText = replaceResult.newText;
        }

        if (typeof onProgress === 'function') {
            onProgress(ruleIndex + 1, rules.length, rule.name, null, null);
        }
    }

    return Promise.resolve({
        newText: currentText,
        errors: errors,
        cancelled: false
    });
}

function extractErrorMessageFromErrors(errors) {
    if (!Array.isArray(errors) || errors.length === 0) return null;
    const firstError = errors[0];
    if (!firstError) return null;
    if (typeof firstError === 'string') return firstError;
    if (typeof firstError.errorMessage === 'string') return firstError.errorMessage;
    if (typeof firstError.message === 'string') return firstError.message;
    return null;
}

/**
 * 异步单条替换。
 *
 * ★ JS 模式规则强制走 Worker。
 */
export function performReplaceAsync(text, rule, flags, loop) {
    const isJSRule = rule && rule.isJS === true;
    const needWorker = shouldUseWorkerForSingle(text, rule);

    // ---- 不需要 Worker ----
    if (!needWorker) {
        const result = performReplace(
            text,
            rule.pattern,
            rule.replacement,
            flags,
            rule.isRegex,
            !!rule.isJS,
            loop
        );

        let errors = [];
        if (result.error) {
            errors.push({
                ruleId: rule.id,
                ruleName: rule.name,
                errorMessage: result.error
            });
        }

        return Promise.resolve({
            newText: result.error ? null : result.newText,
            error: result.error || null,
            errors: errors,
            cancelled: false
        });
    }

    // ---- Worker 不可用 ----
    const worker = getWorker();
    if (!worker) {
        // ★ JS 规则：拒绝执行
        if (isJSRule) {
            return Promise.reject(new Error(
                '后台计算线程不可用，无法安全执行 JS 模式。'
            ));
        }
        // 普通大文本：降级同步
        const result = performReplace(
            text,
            rule.pattern,
            rule.replacement,
            flags,
            rule.isRegex,
            false,
            loop
        );

        let errors = [];
        if (result.error) {
            errors.push({
                ruleId: rule.id,
                ruleName: rule.name,
                errorMessage: result.error
            });
        }

        return Promise.resolve({
            newText: result.error ? null : result.newText,
            error: result.error || null,
            errors: errors,
            cancelled: false
        });
    }

    return new Promise(function(resolve, reject) {
        const taskId = generateTaskId();

        const queuedTask = {
            taskId: taskId,
            payload: {
                taskId: taskId,
                type: 'replace',
                text: text,
                rule: rule,
                flags: flags,
                loop: loop
            },
            resolve: function(workerResult) {
                const rawErrors = Array.isArray(workerResult.errors)
                    ? workerResult.errors
                    : [];

                const errorMessage = extractErrorMessageFromErrors(rawErrors);

                resolve({
                    newText: errorMessage ? null : workerResult.newText,
                    error: errorMessage,
                    errors: rawErrors,
                    cancelled: !!workerResult.cancelled
                });
            },
            reject: reject,
            progress: null,
            // ★ JS 规则不提供 syncFallback
            syncFallback: isJSRule
                ? null
                : function() {
                    const result = performReplace(
                        text,
                        rule.pattern,
                        rule.replacement,
                        flags,
                        rule.isRegex,
                        false,
                        loop
                    );

                    let errors = [];
                    if (result.error) {
                        errors.push({
                            ruleId: rule.id,
                            ruleName: rule.name,
                            errorMessage: result.error
                        });
                    }

                    return {
                        newText: result.error ? null : result.newText,
                        error: result.error || null,
                        errors: errors,
                        cancelled: false
                    };
                }
        };

        if (currentTask === null) {
            executeTask(queuedTask);
        } else {
            taskQueue.push(queuedTask);
        }
    });
}