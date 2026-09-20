// filename: js/replace-core.js
/**
 * ============================================================================
 * replace-core.js — 纯替换核心逻辑（无 Worker 依赖）
 * ============================================================================
 *
 * 【本次修订说明 — 修复第一行非法字符】
 *   · 第一行 `# filename:` 改为 `// filename:`。
 *   · 其余逻辑与上一版一致。
 * ============================================================================
 */

import { CONFIG } from './config.js';
import { isJSCodeSafe } from './security.js';

export function escapeRegexLiteral(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
    let hasChanged = false;

    for (
        let iteration = 0;
        iteration < CONFIG.LOOP_REPLACE_MAX_ITERATIONS;
        iteration++
    ) {
        iterationCount = iteration + 1;
        const newText = isJS
            ? applyJsReplace(currentText, regex, jsReplacerFunction)
            : applyRegexReplace(currentText, regex, effectiveReplacement);

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
                    changed: hasChanged,
                    error: null,
                    iterations: iterationCount,
                    cancelled: true
                };
            }
        }

        if (newText === currentText) {
            return {
                newText: currentText,
                changed: hasChanged,
                error: null,
                iterations: iterationCount,
                cancelled: false
            };
        }

        hasChanged = true;
        currentText = newText;
    }

    return {
        newText: currentText,
        changed: hasChanged,
        error: null,
        iterations: iterationCount,
        cancelled: false
    };
}

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