// filename: js/security.js
/**
 * ============================================================================
 * security.js — JS 模式安全检测 + 按规则信任
 * ============================================================================
 *
 * 【本次修订说明 — 修复第一行非法字符】
 *   · 第一行 `# filename:` 改为 `// filename:`。
 *   · 其余逻辑与上一版一致。
 * ============================================================================
 */

import { CONFIG, STORAGE_KEYS } from './config.js';
import { AppState } from './state.js';
import { saveLocalBackup, loadLocalBackup } from './storage.js';

const DANGEROUS_API_PATTERNS = [
    /\blocalstorage\b/i,
    /\bsessionstorage\b/i,
    /\bindexeddb\b/i,
    /\bcaches\b/i,
    /\bfetch\s*\(/i,
    /\bxmlhttprequest\b/i,
    /\bwebsocket\s*\(/i,
    /\beventsource\s*\(/i,
    /\bnavigator\.sendbeacon\b/i,
    /\bimportscripts\s*\(/i,

    /\beval\s*\(/i,
    /\bnew\s+function\s*\(/i,
    /\bnew\s+asyncfunction\s*\(/i,
    /\bnew\s+generatorfunction\s*\(/i,

    /\bdocument\b/i,
    /\bwindow\b/i,
    /\bself\b/i,
    /\btop\b/i,
    /\bparent\b/i,
    /\bframes\b/i,
    /\bglobalthis\b/i,
    /\blocation\.href\b/i,
    /\blocation\.replace\b/i,
    /\blocation\.assign\b/i,
    /\bnew\s+image\s*\(/i,

    /\breflect\s*\./i,
    /\bproxy\s*\(/i,
    /\bproxyrevolkable\s*\(/i,

    /\balert\s*\(/i,
    /\bconfirm\s*\(/i,
    /\bprompt\s*\(/i,

    /\bimport\s*\(/i,
    /\brequire\s*\(/i,
    /\bdefine\s*\(/i,

    /\bsettimeout\s*\(\s*['"`]/i,
    /\bsetinterval\s*\(\s*['"`]/i,

    /\bsharedarraybuffer\b/i,
    /\batomics\b/i,
    /\bwebassembly\b/i
];

const DANGEROUS_PROTOTYPE_PATTERNS = [
    /\.\s*constructor\b/i,
    /\.\s*__proto__\b/i,
    /\[\s*['"`]\s*constructor\s*['"`]\s*\]/i,
    /\[\s*['"`]\s*__proto__\s*['"`]\s*\]/i,
    /\[\s*['"`]\s*prototype\s*['"`]\s*\]/i
];

const BRACKET_ACCESS_PATTERN = /\[\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1\s*\]/g;

const DANGEROUS_BRACKET_ACCESS_KEYWORDS = Object.freeze([
    'window', 'document', 'self', 'top', 'parent', 'frames', 'globalthis',
    'eval', 'function', 'asyncfunction', 'generatorfunction', 'fetch',
    'cookie', 'localstorage', 'sessionstorage', 'indexeddb', 'xmlhttprequest',
    'websocket', 'eventsource', 'location', 'navigator', 'alert', 'confirm',
    'prompt', 'require', 'import', 'importscripts', 'constructor',
    '__proto__', 'prototype', 'sendbeacon', 'reflect', 'proxy',
    'sharedarraybuffer', 'atomics', 'webassembly'
]);

let sessionTrustGranted = false;
let jsTrustedRuleIdsLoaded = false;

function ensureJsTrustedRuleIdsLoaded() {
    if (jsTrustedRuleIdsLoaded) return;
    jsTrustedRuleIdsLoaded = true;

    try {
        const stored = loadLocalBackup(
            STORAGE_KEYS.UI_JS_TRUSTED_RULE_IDS,
            []
        );
        if (Array.isArray(stored)) {
            stored.forEach(function addId(id) {
                if (id !== undefined && id !== null) {
                    AppState.jsTrustedRuleIds.add(String(id));
                }
            });
        }
    } catch (loadError) {
        console.warn('[TextPro] 恢复 JS 信任集合失败:', loadError);
    }
}

function persistJsTrustedRuleIds() {
    try {
        const idArray = Array.from(AppState.jsTrustedRuleIds);
        saveLocalBackup(STORAGE_KEYS.UI_JS_TRUSTED_RULE_IDS, idArray);
    } catch (saveError) {
        console.warn('[TextPro] 保存 JS 信任集合失败:', saveError);
    }
}

function dispatchJsTrustChangedEvent(detailOverride) {
    try {
        document.dispatchEvent(
            new CustomEvent('textpro:js-trust-changed', {
                detail: detailOverride || {
                    trusted: hasAnyJsTrust()
                }
            })
        );
    } catch (dispatchError) {
        // 静默降级
    }
}

export function isRuleJsTrusted(ruleId) {
    ensureJsTrustedRuleIdsLoaded();
    if (ruleId === undefined || ruleId === null) return false;
    return AppState.jsTrustedRuleIds.has(String(ruleId));
}

export function markRuleJsTrusted(ruleId) {
    ensureJsTrustedRuleIdsLoaded();
    if (ruleId === undefined || ruleId === null) return;
    AppState.jsTrustedRuleIds.add(String(ruleId));
    persistJsTrustedRuleIds();
    dispatchJsTrustChangedEvent({
        granted: true,
        ruleId: String(ruleId),
        mode: 'rule'
    });
}

export function revokeRuleJsTrust(ruleId) {
    ensureJsTrustedRuleIdsLoaded();
    if (ruleId === undefined || ruleId === null) return;
    AppState.jsTrustedRuleIds.delete(String(ruleId));
    persistJsTrustedRuleIds();
    dispatchJsTrustChangedEvent({
        granted: false,
        ruleId: String(ruleId),
        mode: 'rule'
    });
}

export function clearAllRuleJsTrust() {
    ensureJsTrustedRuleIdsLoaded();
    AppState.jsTrustedRuleIds.clear();
    persistJsTrustedRuleIds();
    dispatchJsTrustChangedEvent({
        granted: false,
        ruleId: null,
        mode: 'rule',
        clearedAll: true
    });
}

export function isSessionTrustGranted() {
    return sessionTrustGranted === true;
}

export function revokeSessionTrust() {
    const wasGranted = sessionTrustGranted === true;
    sessionTrustGranted = false;
    if (wasGranted) {
        dispatchJsTrustChangedEvent({
            granted: false,
            ruleId: null,
            mode: 'session'
        });
    }
}

export function hasAnyJsTrust() {
    ensureJsTrustedRuleIdsLoaded();

    if (CONFIG.JS_TRUST_RULE_BASED) {
        return AppState.jsTrustedRuleIds.size > 0;
    }

    return AppState.jsTrustedRuleIds.size > 0 || sessionTrustGranted === true;
}

function collapseStringConcatenations(sourceCode) {
    if (!sourceCode || typeof sourceCode !== 'string') {
        return sourceCode;
    }

    let currentCode = sourceCode;
    const maximumIterations = 20;

    const concatenationPattern =
        /(['"`])((?:\\.|(?!\1)[^\\])*)\1\s*\+\s*(['"`])((?:\\.|(?!\3)[^\\])*)\3/g;

    for (
        let iterationIndex = 0;
        iterationIndex < maximumIterations;
        iterationIndex++
    ) {
        const collapsedCode = currentCode.replace(
            concatenationPattern,
            function onMatch(
                fullMatch,
                firstQuote,
                firstContent,
                secondQuote,
                secondContent
            ) {
                const isFirstSimpleQuote =
                    firstQuote === "'" ||
                    firstQuote === '"' ||
                    firstQuote === '`';
                const isSecondSimpleQuote =
                    secondQuote === "'" ||
                    secondQuote === '"' ||
                    secondQuote === '`';

                if (!isFirstSimpleQuote || !isSecondSimpleQuote) {
                    return fullMatch;
                }

                if (
                    firstQuote === '`' &&
                    firstContent.indexOf('${') !== -1
                ) {
                    return fullMatch;
                }
                if (
                    secondQuote === '`' &&
                    secondContent.indexOf('${') !== -1
                ) {
                    return fullMatch;
                }

                if (
                    firstContent.indexOf(firstQuote) !== -1 ||
                    secondContent.indexOf(secondQuote) !== -1
                ) {
                    return fullMatch;
                }

                return firstQuote + firstContent + secondContent + firstQuote;
            }
        );

        if (collapsedCode === currentCode) {
            break;
        }
        currentCode = collapsedCode;
    }

    return currentCode;
}

function detectBracketAccessToDangerousKeyword(sourceCode) {
    if (!sourceCode || typeof sourceCode !== 'string') {
        return false;
    }

    BRACKET_ACCESS_PATTERN.lastIndex = 0;

    let matchResult;
    while ((matchResult = BRACKET_ACCESS_PATTERN.exec(sourceCode)) !== null) {
        const bracketContent = String(matchResult[2] || '').toLowerCase();

        for (
            let keywordIndex = 0;
            keywordIndex < DANGEROUS_BRACKET_ACCESS_KEYWORDS.length;
            keywordIndex++
        ) {
            if (
                bracketContent ===
                DANGEROUS_BRACKET_ACCESS_KEYWORDS[keywordIndex]
            ) {
                return true;
            }
        }
    }

    return false;
}

export function isJSCodeSafe(code) {
    if (!code) return true;

    const lowerCaseCode = String(code).toLowerCase();

    for (
        let patternIndex = 0;
        patternIndex < DANGEROUS_API_PATTERNS.length;
        patternIndex++
    ) {
        if (DANGEROUS_API_PATTERNS[patternIndex].test(lowerCaseCode)) {
            return false;
        }
    }

    for (
        let patternIndex = 0;
        patternIndex < DANGEROUS_PROTOTYPE_PATTERNS.length;
        patternIndex++
    ) {
        if (DANGEROUS_PROTOTYPE_PATTERNS[patternIndex].test(code)) {
            return false;
        }
    }

    const collapsedCode = collapseStringConcatenations(code);
    if (collapsedCode !== code) {
        const lowerCaseCollapsedCode = collapsedCode.toLowerCase();

        for (
            let patternIndex = 0;
            patternIndex < DANGEROUS_API_PATTERNS.length;
            patternIndex++
        ) {
            if (
                DANGEROUS_API_PATTERNS[patternIndex].test(
                    lowerCaseCollapsedCode
                )
            ) {
                return false;
            }
        }

        for (
            let patternIndex = 0;
            patternIndex < DANGEROUS_PROTOTYPE_PATTERNS.length;
            patternIndex++
        ) {
            if (
                DANGEROUS_PROTOTYPE_PATTERNS[patternIndex].test(collapsedCode)
            ) {
                return false;
            }
        }
    }

    if (detectBracketAccessToDangerousKeyword(collapsedCode)) {
        return false;
    }

    return true;
}

export function confirmJSMode(componentName, ruleId) {
    if (CONFIG.JS_TRUST_RULE_BASED) {
        if (ruleId !== undefined && ruleId !== null) {
            ensureJsTrustedRuleIdsLoaded();
            if (AppState.jsTrustedRuleIds.has(String(ruleId))) {
                return true;
            }
        }
    } else {
        if (sessionTrustGranted) {
            return true;
        }
    }

    const isRuleScoped = CONFIG.JS_TRUST_RULE_BASED &&
        ruleId !== undefined && ruleId !== null;

    let scopeMessage;
    if (isRuleScoped) {
        scopeMessage =
            '本次同意后，仅此规则在本设备上不再重复询问。\n' +
            '（可在"我的预设"中删除该规则，或手动清理本地信任）\n\n';
    } else if (CONFIG.JS_TRUST_RULE_BASED) {
        scopeMessage =
            '本次为单次授权，不会记住您的选择。\n' +
            '如需避免重复确认，请先把这段 JS 保存为规则后再启用。\n\n';
    } else {
        scopeMessage =
            '本次同意后，本页面会话内所有 JS 模式组件将不再重复询问。\n' +
            '（可通过页面顶部的 🔓 指示器随时撤销信任）\n\n';
    }

    const confirmMessage =
        '⚠️ 安全警告\n' +
        '您正在启用"' + componentName + '"的 JS 模式。\n' +
        'JS 模式可执行任意代码，仅当您完全信任规则来源时才可继续。\n\n' +
        scopeMessage +
        '确定要启用吗？';

    const granted = confirm(confirmMessage);

    if (granted) {
        if (isRuleScoped) {
            markRuleJsTrusted(ruleId);
        } else if (!CONFIG.JS_TRUST_RULE_BASED) {
            sessionTrustGranted = true;
            dispatchJsTrustChangedEvent({
                granted: true,
                ruleId: null,
                mode: 'session'
            });
        }
    }

    return granted;
}