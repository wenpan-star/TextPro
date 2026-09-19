/**
 * ============================================================================
 * replace-core.js — 纯替换核心逻辑（无 Worker 依赖）
 * ============================================================================
 *
 * 【本次修订重点】
 *
 *   一、【增强】unescapeReplacementString 支持 \$ 转义（问题 51）
 *     · 用户写 \$ 想表达"字面的 $"，避免后续字符被 String.replace
 *       解释为捕获组（$1 / $2 ...）或特殊模式（$$ / $& / $` / $'）。
 *     · 实现方式：\$ → $$ （$$ 是 JS replace 里表达字面 $ 的标准写法）。
 *
 *   二、其余逻辑保持不变
 * ============================================================================
 */

import { CONFIG } from './config.js';
import { isJSCodeSafe } from './security.js';

// ==================== 转义工具 ====================

export function escapeRegexLiteral(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 转义用户在替换文本里输入的"字面转义序列"。
 *
 * 支持的转义：
 *   \n  → 换行符
 *   \r  → 回车符
 *   \t  → 制表符
 *   \\  → 反斜杠字面
 *   \$  → 字面 $（避免被 String.replace 解释为捕获组/特殊模式）
 *
 * 说明：
 *   JS 的 String.prototype.replace 会把替换字符串里的 $ 视为特殊字符：
 *     $$  → $
 *     $&  → 匹配子串
 *     $1  → 捕获组
 *     等等
 *   用户若想表达"字面的 $ 后面跟字符"，需要写 $$。本函数让用户可以
 *   用更自然的 \$ 来表达同样的意图。
 *
 * 注意：若用户本来就想引用捕获组（如 $1），直接写 $1 即可，
 *       不需要也不应该加反斜杠。
 */
export function unescapeReplacementString(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/\\(n|r|t|\$|\\)/g, function replaceEscape(
        match,
        escapeChar
    ) {
        const escapeMap = {
            n: '\n',
            r: '\r',
            t: '\t',
            '$': '$$',
            '\\': '\\'
        };
        return escapeMap[escapeChar] !== undefined
            ? escapeMap[escapeChar]
            : match;
    });
}

// ==================== 编译工具 ====================

function compileRegex(pattern, flags, isRegex) {
    const effectivePattern = isRegex ? pattern : escapeRegexLiteral(pattern);
    try {
        return new RegExp(effectivePattern, flags);
    } catch (compileError) {
        return null;
    }
}

function compileJsReplacerFunction(jsFunctionBody) {
    if (!isJSCodeSafe(jsFunctionBody)) {
        return null;
    }
    try {
        return new Function('result', jsFunctionBody);
    } catch (compileError) {
        return null;
    }
}

// ==================== 替换执行器 ====================

function applyRegexReplace(text, regex, effectiveReplacement) {
    return text.replace(regex, effectiveReplacement);
}

function applyJsReplace(text, regex, jsReplacerFunction) {
    const jsReplacer = function jsReplacer(match) {
        try {
            const result = jsReplacerFunction(match);
            if (result === undefined || result === null) {
                return match;
            }
            return String(result);
        } catch (runtimeError) {
            return match;
        }
    };
    return text.replace(regex, jsReplacer);
}

// ==================== 单次替换 ====================

export function performSingleReplace(
    text,
    pattern,
    replacement,
    flags,
    isRegex,
    isJS
) {
    if (!pattern) {
        return { newText: text, changed: false, error: null };
    }

    const regex = compileRegex(pattern, flags, isRegex);
    if (!regex) {
        return { newText: text, changed: false, error: '正则表达式编译失败' };
    }

    if (isJS) {
        const jsReplacerFunction = compileJsReplacerFunction(replacement);
        if (!jsReplacerFunction) {
            return {
                newText: text,
                changed: false,
                error: '安全拦截: JS 代码包含危险 API 或编译失败'
            };
        }

        const newText = applyJsReplace(text, regex, jsReplacerFunction);
        return {
            newText: newText,
            changed: newText !== text,
            error: null
        };
    }

    const effectiveReplacement = unescapeReplacementString(replacement);
    const newText = applyRegexReplace(text, regex, effectiveReplacement);
    return {
        newText: newText,
        changed: newText !== text,
        error: null
    };
}

// ==================== 循环替换 ====================

export function performLoopReplace(
    text,
    pattern,
    replacement,
    flags,
    isRegex,
    isJS
) {
    return performLoopReplaceWithProgress(
        text,
        pattern,
        replacement,
        flags,
        isRegex,
        isJS,
        null
    );
}

export function performLoopReplaceWithProgress(
    text,
    pattern,
    replacement,
    flags,
    isRegex,
    isJS,
    onIterationProgress
) {
    if (!pattern) {
        return {
            newText: text,
            changed: false,
            error: null,
            iterations: 0,
            cancelled: false
        };
    }

    const regex = compileRegex(pattern, flags, isRegex);
    if (!regex) {
        return {
            newText: text,
            changed: false,
            error: '正则表达式编译失败',
            iterations: 0,
            cancelled: false
        };
    }

    let jsReplacerFunction = null;
    let effectiveReplacement = null;

    if (isJS) {
        jsReplacerFunction = compileJsReplacerFunction(replacement);
        if (!jsReplacerFunction) {
            return {
                newText: text,
                changed: false,
                error: '安全拦截: JS 代码包含危险 API 或编译失败',
                iterations: 0,
                cancelled: false
            };
        }
    } else {
        effectiveReplacement = unescapeReplacementString(replacement);
    }

    let currentText = text;
    let iterationCount = 0;

    for (
        let iteration = 0;
        iteration < CONFIG.LOOP_REPLACE_MAX_ITERATIONS;
        iteration++
    ) {
        iterationCount = iteration + 1;
        const newText = isJS
            ? applyJsReplace(currentText, regex, jsReplacerFunction)
            : applyRegexReplace(currentText, regex, effectiveReplacement);

        // 上报循环进度（回调可返回 false 中止循环）
        if (typeof onIterationProgress === 'function') {
            let progressResult;
            try {
                progressResult = onIterationProgress(
                    iterationCount,
                    CONFIG.LOOP_REPLACE_MAX_ITERATIONS
                );
            } catch (progressError) {
                progressResult = undefined;
            }

            if (progressResult === false) {
                return {
                    newText: currentText,
                    changed: currentText !== text,
                    error: null,
                    iterations: iterationCount,
                    cancelled: true
                };
            }
        }

        if (newText === currentText) {
            return {
                newText: currentText,
                changed: currentText !== text,
                error: null,
                iterations: iterationCount,
                cancelled: false
            };
        }

        currentText = newText;
    }

    return {
        newText: currentText,
        changed: currentText !== text,
        error: null,
        iterations: iterationCount,
        cancelled: false
    };
}

// ==================== 统一入口 ====================

export function performReplace(
    text,
    pattern,
    replacement,
    flags,
    isRegex,
    isJS,
    loop
) {
    if (loop) {
        return performLoopReplace(
            text,
            pattern,
            replacement,
            flags,
            isRegex,
            isJS
        );
    }
    const singleResult = performSingleReplace(
        text,
        pattern,
        replacement,
        flags,
        isRegex,
        isJS
    );
    return {
        newText: singleResult.newText,
        changed: singleResult.changed,
        error: singleResult.error,
        iterations: 1,
        cancelled: false
    };
}