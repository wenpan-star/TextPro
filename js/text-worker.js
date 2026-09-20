/**
 * ============================================================================
 * text-worker.js — 大文本替换计算线程
 * ============================================================================
 *
 * 【本次修订重点】
 *
 *   一、【关键修复】批量替换的普通模式也使用进度节流（问题 49）
 *     · 原先 handleBatchReplace 每条规则都 postMessage progress，
 *       10000 条规则会产生 10000 条进度消息，主线程被高频 DOM 更新拖累。
 *     · 现在统一用 WORKER_PROGRESS_THROTTLE_MS 节流，
 *       且每次都确保"最后一条规则"的进度必然上报。
 *
 *   二、保留全部原有能力：
 *     · 单条替换错误通过 'complete' 消息 + errors 数组上报
 *     · 'error' 消息保留为内部异常通道（try/catch 兜底）
 *     · 取消机制：'cancel' 消息设置 isCancelled 标志
 *
 *   三、其余逻辑保持不变
 * ============================================================================
 */

import { CONFIG } from './config.js';
import {
    performReplace,
    performLoopReplaceWithProgress
} from './replace-core.js';

let currentTaskId = null;
let isCancelled = false;
let lastProgressPostTime = 0;

self.onmessage = function onMessage(event) {
    const messageData = event.data;
    if (!messageData || typeof messageData !== 'object') return;

    const taskId = messageData.taskId;
    const messageType = messageData.type;

    if (messageType === 'cancel') {
        if (currentTaskId === taskId || taskId === '*') {
            isCancelled = true;
            if (currentTaskId === null) {
                postMessage({ taskId: taskId, type: 'cancelled' });
            }
        }
        return;
    }

    if (messageType === 'batchReplace') {
        currentTaskId = taskId;
        isCancelled = false;
        lastProgressPostTime = 0;
        try {
            handleBatchReplace(messageData);
        } catch (batchError) {
            postMessage({
                taskId: taskId,
                type: 'error',
                message: batchError && batchError.message
                    ? batchError.message
                    : '批量替换内部错误'
            });
        }
        currentTaskId = null;
        isCancelled = false;
        lastProgressPostTime = 0;
        return;
    }

    if (messageType === 'replace') {
        currentTaskId = taskId;
        isCancelled = false;
        lastProgressPostTime = 0;
        try {
            handleSingleReplace(messageData);
        } catch (singleError) {
            postMessage({
                taskId: taskId,
                type: 'error',
                message: singleError && singleError.message
                    ? singleError.message
                    : '单条替换内部错误'
            });
        }
        currentTaskId = null;
        isCancelled = false;
        lastProgressPostTime = 0;
        return;
    }
};

/**
 * 统一的上报节流辅助。
 *
 * @param taskId 任务 ID
 * @param current 当前进度（第几条）
 * @param total 总数
 * @param ruleName 规则名
 * @param iteration 循环迭代次数（可为 null）
 * @param maxIterations 最大迭代次数（可为 null）
 * @param forcePost 是否强制上报（用于最后一条规则）
 */
function reportProgressThrottled(
    taskId,
    current,
    total,
    ruleName,
    iteration,
    maxIterations,
    forcePost
) {
    const now = Date.now();
    const isThrottleWindowElapsed =
        (now - lastProgressPostTime) >= CONFIG.WORKER_PROGRESS_THROTTLE_MS;

    if (!isThrottleWindowElapsed && !forcePost) {
        return;
    }

    postMessage({
        taskId: taskId,
        type: 'progress',
        current: current,
        total: total,
        ruleName: ruleName || '未命名规则',
        iteration: iteration,
        maxIterations: maxIterations
    });
    lastProgressPostTime = now;
}

function handleBatchReplace(messageData) {
    const taskId = messageData.taskId;
    const originalText = messageData.text;
    const rules = messageData.rules || [];
    const flags = messageData.flags || '';
    const globalLoop = messageData.loop === true;

    let currentText = originalText;
    const errors = [];
    const totalRules = rules.length;

    for (let ruleIndex = 0; ruleIndex < totalRules; ruleIndex++) {
        if (isCancelled) {
            postMessage({ taskId: taskId, type: 'cancelled' });
            return;
        }

        const rule = rules[ruleIndex];
        const isLastRule = (ruleIndex === totalRules - 1);

        if (!rule.pattern || !rule.pattern.trim()) {
            // ★ 修复问题 49：统一用节流，最后一条强制上报
            reportProgressThrottled(
                taskId,
                ruleIndex + 1,
                totalRules,
                rule.name,
                null,
                null,
                isLastRule
            );
            continue;
        }

        let replaceResult;

        if (globalLoop) {
            replaceResult = executeRuleWithLoopProgress(
                currentText,
                rule,
                flags,
                taskId,
                ruleIndex,
                totalRules
            );

            if (replaceResult && replaceResult.cancelled) {
                postMessage({ taskId: taskId, type: 'cancelled' });
                return;
            }
        } else {
            replaceResult = performReplace(
                currentText,
                rule.pattern,
                rule.replacement,
                flags,
                rule.isRegex,
                !!rule.isJS,
                false
            );
        }

        if (isCancelled) {
            postMessage({ taskId: taskId, type: 'cancelled' });
            return;
        }

        if (replaceResult.error) {
            errors.push({
                ruleId: rule.id,
                ruleName: rule.name,
                errorMessage: replaceResult.error
            });
        } else if (replaceResult.changed) {
            currentText = replaceResult.newText;
        }

        // ★ 修复问题 49：统一用节流
        reportProgressThrottled(
            taskId,
            ruleIndex + 1,
            totalRules,
            rule.name,
            null,
            null,
            isLastRule
        );
    }

    sendResultBuffer(taskId, currentText, errors);
}

function executeRuleWithLoopProgress(
    currentText,
    rule,
    flags,
    taskId,
    ruleIndex,
    totalRules
) {
    const isJS = !!rule.isJS;
    const replacement = rule.replacement;

    const onIterationProgress = function onIterationProgress(
        iteration,
        maxIterations
    ) {
        if (isCancelled) {
            return false;
        }

        const isFinalIteration = (iteration === maxIterations);

        // 循环模式下的进度上报：由节流辅助统一管理
        reportProgressThrottled(
            taskId,
            ruleIndex + 1,
            totalRules,
            rule.name,
            iteration,
            maxIterations,
            isFinalIteration
        );

        return true;
    };

    return performLoopReplaceWithProgress(
        currentText,
        rule.pattern,
        replacement,
        flags,
        rule.isRegex,
        isJS,
        onIterationProgress
    );
}

function handleSingleReplace(messageData) {
    const taskId = messageData.taskId;
    const originalText = messageData.text;
    const rule = messageData.rule || {};
    const flags = messageData.flags || '';
    const loop = messageData.loop === true;

    if (isCancelled) {
        postMessage({ taskId: taskId, type: 'cancelled' });
        return;
    }

    let replaceResult;

    if (loop) {
        const onIterationProgress = function onIterationProgress(
            iteration,
            maxIterations
        ) {
            if (isCancelled) {
                return false;
            }
            return true;
        };

        replaceResult = performLoopReplaceWithProgress(
            originalText,
            rule.pattern,
            rule.replacement,
            flags,
            rule.isRegex,
            !!rule.isJS,
            onIterationProgress
        );
    } else {
        replaceResult = performReplace(
            originalText,
            rule.pattern,
            rule.replacement,
            flags,
            rule.isRegex,
            !!rule.isJS,
            false
        );
    }

    if (replaceResult && replaceResult.cancelled) {
        postMessage({ taskId: taskId, type: 'cancelled' });
        return;
    }

    if (replaceResult.error) {
        sendResultBuffer(taskId, '', [{
            ruleId: rule.id,
            ruleName: rule.name || '未命名规则',
            errorMessage: replaceResult.error
        }]);
        return;
    }

    sendResultBuffer(taskId, replaceResult.newText, []);
}

/**
 * 通过 Transferable ArrayBuffer 回传结果。
 *
 * 对 resultText 做 null/undefined 兜底，避免 TextEncoder.encode(null)
 * 生成字面 "null" 字符串。
 */
function sendResultBuffer(taskId, resultText, errors) {
    const safeResultText = (resultText === null || resultText === undefined)
        ? ''
        : String(resultText);

    const encodedBytes = new TextEncoder().encode(safeResultText);
    self.postMessage(
        {
            taskId: taskId,
            type: 'complete',
            resultBuffer: encodedBytes.buffer,
            errors: errors || []
        },
        [encodedBytes.buffer]
    );
}