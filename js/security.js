/**
 * ============================================================================
 * security.js — JS 模式安全检测 + 按规则信任
 * ============================================================================
 *
 * 【本次重构说明】
 *
 *   一、按规则信任模型
 *     · 原实现：会话级信任，同意一次后本会话内所有 JS 规则都不再询问。
 *       风险：导入他人配置后，隐藏的恶意 JS 规则不会触发确认。
 *     · 新实现：按规则 id 信任。每条规则首次启用 JS 模式时确认；
 *       已信任的规则不再询问。信任集合镜像到 localStorage，
 *       跨会话保留（用户明确信任过的规则，不用反复确认）。
 *     · 会话级信任作为"降级兼容"保留：
 *       若 CONFIG.JS_TRUST_RULE_BASED === false，退回旧行为。
 *
 *   二、保留全部既有安全检测能力
 *     · 危险 API 黑名单
 *     · 字符串拼接折叠检测
 *     · 方括号访问检测
 *     · 原型链逃逸检测
 *
 *   三、其余逻辑保持不变
 * ============================================================================
 */

import { CONFIG, STORAGE_KEYS } from './config.js';
import { AppState } from './state.js';
import { saveLocalBackup, loadLocalBackup } from './storage.js';

// ============================================================================
// 一、危险模式
// ============================================================================

const DANGEROUS_API_PATTERNS = [
    // ---- 存储 / 网络 ----
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

    // ---- 动态执行 ----
    /\beval\s*\(/i,
    /\bnew\s+function\s*\(/i,
    /\bfunction\s*\(/i,
    /\bnew\s+asyncfunction\s*\(/i,
    /\basyncfunction\b/i,
    /\bgeneratorfunction\b/i,

    // ---- DOM / BOM 逃逸 ----
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

    // ---- 反射 / 代理 ----
    /\breflect\s*\./i,
    /\bproxy\s*\(/i,
    /\bproxyrevolkable\s*\(/i,

    // ---- 危险阻塞式交互 ----
    /\balert\s*\(/i,
    /\bconfirm\s*\(/i,
    /\bprompt\s*\(/i,

    // ---- 模块 / 脚本 ----
    /\bimport\s*\(/i,
    /\brequire\s*\(/i,
    /\bdefine\s*\(/i,

    // ---- 定时器拼接字符串 ----
    /\bsettimeout\s*\(\s*['"`]/i,
    /\bsetinterval\s*\(\s*['"`]/i,

    // ---- 二进制 / 共享内存 ----
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

// ============================================================================
// 二、方括号访问检测
// ============================================================================

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

// ============================================================================
// 三、信任状态管理
// ============================================================================

// 会话级信任（旧模型兼容）
let sessionTrustGranted = false;

// 按规则信任的初始化标记
let jsTrustedRuleIdsLoaded = false;

/**
 * 从 localStorage 恢复按规则信任集合。
 *
 * 首次调用时同步一次；之后 AppState.jsTrustedRuleIds 为权威来源。
 */
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

/**
 * 将按规则信任集合镜像到 localStorage。
 */
function persistJsTrustedRuleIds() {
    try {
        const idArray = Array.from(AppState.jsTrustedRuleIds);
        saveLocalBackup(STORAGE_KEYS.UI_JS_TRUSTED_RULE_IDS, idArray);
    } catch (saveError) {
        console.warn('[TextPro] 保存 JS 信任集合失败:', saveError);
    }
}

/**
 * 查询某条规则是否已被信任启用 JS 模式。
 *
 * @param {string} ruleId
 * @returns {boolean}
 */
export function isRuleJsTrusted(ruleId) {
    ensureJsTrustedRuleIdsLoaded();
    if (ruleId === undefined || ruleId === null) return false;
    return AppState.jsTrustedRuleIds.has(String(ruleId));
}

/**
 * 标记某条规则为已信任。
 *
 * @param {string} ruleId
 */
export function markRuleJsTrusted(ruleId) {
    ensureJsTrustedRuleIdsLoaded();
    if (ruleId === undefined || ruleId === null) return;
    AppState.jsTrustedRuleIds.add(String(ruleId));
    persistJsTrustedRuleIds();
}

/**
 * 撤销某条规则的信任。
 *
 * @param {string} ruleId
 */
export function revokeRuleJsTrust(ruleId) {
    ensureJsTrustedRuleIdsLoaded();
    if (ruleId === undefined || ruleId === null) return;
    AppState.jsTrustedRuleIds.delete(String(ruleId));
    persistJsTrustedRuleIds();
}

/**
 * 清空所有按规则信任。
 */
export function clearAllRuleJsTrust() {
    ensureJsTrustedRuleIdsLoaded();
    AppState.jsTrustedRuleIds.clear();
    persistJsTrustedRuleIds();
}

/**
 * 查询本会话的"全局信任"是否已授予（旧模型）。
 */
export function isSessionTrustGranted() {
    return sessionTrustGranted === true;
}

/**
 * 撤销本会话的全局信任。
 */
export function revokeSessionTrust() {
    sessionTrustGranted = false;
}

/**
 * 检查是否存在任何信任（按规则信任非空，或会话级信任已授予）。
 *
 * 用于 UI 指示器显示。
 */
export function hasAnyJsTrust() {
    ensureJsTrustedRuleIdsLoaded();
    return AppState.jsTrustedRuleIds.size > 0 || sessionTrustGranted === true;
}

// ============================================================================
// 四、字符串拼接折叠
// ============================================================================

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

// ============================================================================
// 五、方括号访问检测
// ============================================================================

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

// ============================================================================
// 六、主检测入口
// ============================================================================

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

// ============================================================================
// 七、JS 模式启用确认
// ============================================================================

/**
 * 弹出 JS 模式启用确认对话框。
 *
 * 信任模型：
 *   · CONFIG.JS_TRUST_RULE_BASED === true
 *       若传入 ruleId 且该 id 已在信任集合中 → 直接放行
 *       否则弹出确认；同意后把 ruleId 加入信任集合
 *   · CONFIG.JS_TRUST_RULE_BASED === false（旧行为）
 *       若本会话已全局信任 → 直接放行
 *       否则弹出确认；同意后 sessionTrustGranted = true
 *
 * @param {string} componentName 用于确认文案中显示的名称
 * @param {string|number} [ruleId] 规则 id。不传时走"会话级信任"分支。
 * @returns {boolean}
 */
export function confirmJSMode(componentName, ruleId) {
    // ---- 优先按规则信任判断 ----
    if (CONFIG.JS_TRUST_RULE_BASED) {
        if (ruleId !== undefined && ruleId !== null) {
            ensureJsTrustedRuleIdsLoaded();
            if (AppState.jsTrustedRuleIds.has(String(ruleId))) {
                return true;
            }
        } else if (sessionTrustGranted) {
            // 未提供 ruleId 时退回会话级信任（如快速替换面板）
            return true;
        }
    } else {
        // ---- 旧模型：会话级信任 ----
        if (sessionTrustGranted) {
            return true;
        }
    }

    const isRuleScoped = CONFIG.JS_TRUST_RULE_BASED &&
        ruleId !== undefined && ruleId !== null;

    const confirmMessage =
        '⚠️ 安全警告\n' +
        '您正在启用"' + componentName + '"的 JS 模式。\n' +
        'JS 模式可执行任意代码，仅当您完全信任规则来源时才可继续。\n\n' +
        (isRuleScoped
            ? '本次同意后，仅此规则在本设备上不再重复询问。\n' +
              '（可在"我的预设"中删除该规则，或手动清理本地信任）\n\n'
            : '本次同意后，本页面会话内所有 JS 模式组件将不再重复询问。\n' +
              '（可通过页面顶部的 🔓 指示器随时撤销信任）\n\n') +
        '确定要启用吗？';

    const granted = confirm(confirmMessage);

    if (granted) {
        if (isRuleScoped) {
            markRuleJsTrusted(ruleId);
        } else {
            sessionTrustGranted = true;
        }

        try {
            document.dispatchEvent(
                new CustomEvent('textpro:js-trust-changed', {
                    detail: {
                        granted: true,
                        ruleId: ruleId !== undefined ? String(ruleId) : null,
                        mode: isRuleScoped ? 'rule' : 'session'
                    }
                })
            );
        } catch (dispatchError) {
            // CustomEvent 不可用时静默降级
        }
    }

    return granted;
}