/**
 * ============================================================================
 * config.js — 全局配置中心
 * ============================================================================
 *
 * 【本次重构说明 — 配置持久化 / 内容不持久化】
 *
 *   一、设计原则调整
 *     · 参考 Notepad++ / VS Code / regex101 等同类产品的成熟做法：
 *         用户配置（规则、预设、界面偏好）→ 跨会话保留
 *         工作内容（源文本、结果文本、搜索输入）→ 不持久化
 *
 *   二、常量调整
 *     · SETTINGS_EXPORTABLE_KEYS：
 *         移除 'searchInput' / 'searchCase'
 *         保留 'searchDataSource' / 'presetSearchScope'（纯界面偏好）
 *     · SESSION_STATE_KEYS：
 *         移除 'sourceText' / 'resultText' / 'searchInput' / 'searchCase'
 *         （该常量目前未被任何模块导入，保留用于语义说明与未来扩展）
 *
 *   三、保留全部既有常量
 *     · 所有其他常量无一删除，语义不变
 * ============================================================================
 */

export const CONFIG = Object.freeze({
    // ---- 应用元信息 ----
    APP_NAME: 'TextPro 文本净化工具',
    APP_VERSION: '9.3.0',

    // ---- 大文本保护阈值 ----
    LARGE_TEXT_THRESHOLD_BYTES: 2 * 1024 * 1024,
    ABSOLUTE_TEXT_SIZE_LIMIT_BYTES: 20 * 1024 * 1024,
    LARGE_TEXT_WORKER_THRESHOLD_BYTES: 2 * 1024 * 1024,

    // ---- Web Worker ----
    WORKER_TASK_TIMEOUT_MS: 60000,
    WORKER_LOOP_PROGRESS_EVERY: 1,
    WORKER_PROGRESS_THROTTLE_MS: 100,
    JS_MODE_FORCE_WORKER_MIN_CHARS: 0,
    // 单次替换是否允许取消
    //   正则 String.replace 是一次性操作，无法中途打断。
    //   设为 true 时上层会明确提示"单次替换不支持取消"。
    WORKER_SINGLE_REPLACE_CANCELLABLE: false,

    // ---- Toast 提示 ----
    TOAST_DURATION_MS: 3500,
    TOAST_WITH_ACTION_DURATION_MS: 6000,
    // Toast 最大堆叠数量
    //   超出时最旧的 toast 会被立即消退，保证界面整洁。
    TOAST_MAX_STACK_COUNT: 4,

    // ---- 自动保存防抖 ----
    AUTO_SAVE_DEBOUNCE_MS: 500,
    LARGE_TEXT_AUTOSAVE_THROTTLE_MS: 3000,
    LARGE_TEXT_AUTOSAVE_THRESHOLD_BYTES: 2 * 1024 * 1024,
    MAX_AUTO_SAVE_WAIT_MS: 8000,

    // ---- 主表 → 预设 同步防抖 ----
    PRESET_SYNC_DEBOUNCE_MS: 400,

    // ---- 循环替换 ----
    LOOP_REPLACE_MAX_ITERATIONS: 200,

    // ---- 批量运行 ----
    BATCH_RUN_FRAME_YIELD_EVERY: 3,
    BATCH_RUN_YIELD_DELAY_MS: 0,

    // ---- 搜索结果 ----
    SEARCH_INPUT_DEBOUNCE_MS: 120,
    SEARCH_MAX_MATCHES: 10000,
    RESULT_INPUT_SEARCH_DEBOUNCE_MS: 300,
    SEARCH_LARGE_TEXT_MIRROR_BYPASS_CHARS: 500000,
    SEARCH_MATCH_VISUAL_VIEWPORT_RATIO: 0.35,
    // 搜索上限警告重复抑制窗口
    SEARCH_LIMIT_WARNING_REPEAT_MS: 5000,

    // ---- 设置文件 ----
    SETTINGS_FILE_MAX_SIZE_BYTES: 50 * 1024 * 1024,
    SETTINGS_RELOAD_DELAY_MS: 1500,
    // 导入配置对话框默认选中的模式
    IMPORT_MODE_DEFAULT: 'merge',

    // ---- 表格列宽 ----
    TABLE_COLUMN_MIN_WIDTH_PX: 40,

    // ---- 导出文件名前缀 ----
    EXPORT_FILENAME_PREFIX: '自定义替换表_',

    // ---- 命名预设管理 ----
    PRESET_SEARCH_DEBOUNCE_MS: 150,
    PRESET_SOFT_LIMIT: 50,
    PRESET_MOBILE_BREAKPOINT_PX: 780,
    PRESET_NAME_MAX_LENGTH: 60,

    // ---- 悬停提示相关常量 ----
    PRESET_HELP_HOVER_SHOW_DELAY_MS: 120,
    PRESET_HELP_HOVER_HIDE_DELAY_MS: 180,
    PRESET_HELP_TOOLTIP_MAX_WIDTH_PX: 320,
    PRESET_HELP_REPOSITION_THROTTLE_MS: 60,

    // ---- 虚拟主表 ID ----
    MAIN_TABLE_VIRTUAL_ID: '__main_table__',

    // ---- 删除主表规则的二次确认阈值 ----
    DELETE_RULE_CONFIRM_THRESHOLD: 2,

    // ---- IndexedDB 打开超时 ----
    INDEXED_DB_OPEN_TIMEOUT_MS: 15000,

    // ---- 预设追加防抖窗口 ----
    APPEND_ATTEMPT_DEBOUNCE_MS: 2000,

    // ---- 追加规则到预设时产生新 id 的碰撞规避 ----
    ID_COLLISION_RANDOM_RANGE: 100000,

    // ---- 重复检测缓存开关 ----
    DUPLICATE_DETECTION_CACHE_ENABLED: true,

    // ---- 存在性索引增量更新开关 ----
    INDEX_EXISTENCE_INCREMENTAL: true,

    // ---- JS 模式信任模型 ----
    JS_TRUST_RULE_BASED: true,

    // ---- 持久化权限申请时机 ----
    STORAGE_PERSIST_DEFERRED: true,

    // ---- 离开确认 ----
    BEFORE_UNLOAD_GUARD_ENABLED: true,

    // ---- 时间戳钳制 ----
    TIMESTAMP_FUTURE_TOLERANCE_MS: 60000
});

export const STORAGE_KEYS = Object.freeze({
    ENCRYPTED_STATE: 'encryptedState',
    AES_KEY: 'aes-key',
    UI_THEME: 'textpro-ui-theme-v1',
    UI_LAST_IMPORTED_FILENAME: 'textpro-last-imported-filename-v1',
    UI_SYNC_SCROLL_MODE: 'textpro-sync-scroll-mode-v1',
    UI_AUTO_LOAD_SNAPSHOT: 'textpro-auto-load-snapshot-v1',
    UI_PERSISTENT_STORAGE: 'textpro-persistent-storage-v1',
    // 按规则 JS 信任集合的镜像（跨会话保留）
    //   值语义：string[]（规则 id 字符串数组）
    UI_JS_TRUSTED_RULE_IDS: 'textpro-js-trusted-rule-ids-v1'
});

export const INDEXED_DB_CONFIG = Object.freeze({
    NAME: 'TextProDB',
    VERSION: 1,
    STORE_STATE: 'appState',
    STORE_STATE_KEY: 'encryptedState',
    STORE_KEYS: 'keyStore',
    STORE_KEYS_ID: 'aes-key'
});

export const DARK_MODE_TOGGLE_TEXT = Object.freeze({
    light: '🌙 暗色',
    dark: '☀️ 亮色'
});

export const SEARCH_DATA_SOURCE = Object.freeze({
    CURRENT: 'current',
    ALL: 'all'
});

export const SEARCH_FIELD_SCOPE = Object.freeze({
    NAME_ONLY: 'nameOnly',
    ALL: 'all'
});

export const SYNC_SCROLL_MODES = Object.freeze({
    PROPORTION: 'proportion',
    PIXEL: 'pixel',
    OFF: 'off'
});

export const defaultCustomRulesRaw = [];

export const defaultCustomRules = Object.freeze(
    defaultCustomRulesRaw.map(function(ruleRaw, ruleIndex) {
        let replacementText = String(ruleRaw.replacement || '');
        let isJSRule = ruleRaw.isJS === true;

        if (replacementText.trim().startsWith('@@js:')) {
            replacementText = replacementText.replace(/^@@js:\s*/, '@js:');
            isJSRule = false;
        } else if (replacementText.trim().startsWith('@js:')) {
            replacementText = replacementText.replace(/^@js:\s*/, '').trim();
            isJSRule = true;
        }

        return Object.freeze({
            id: 4000 + ruleIndex,
            name: ruleRaw.name,
            pattern: ruleRaw.pattern,
            replacement: replacementText,
            enabled: true,
            order: ruleIndex + 1,
            runChecked: ruleRaw.runChecked !== false,
            isRegex: ruleRaw.isRegex !== false,
            isJS: isJSRule
        });
    })
);

/**
 * 设置文件导出 / 导入字段清单。
 *
 * ★ 修订：从清单中移除 'searchInput' / 'searchCase'。
 *
 *   设计原则（配置持久化 / 内容不持久化）：
 *     · 结果区搜索词与结果文本强绑定
 *     · 结果文本不持久化 → 恢复搜索词只会得到一个空搜索栏
 *     · 因此不再导出 / 导入这两项
 *
 *   保留 'searchDataSource' / 'presetSearchScope'：
 *     这两项描述的是"预设管理面板的搜索偏好"（数据源范围与字段范围），
 *     属于纯界面偏好，与具体文本内容无关，继续导出。
 */
export const SETTINGS_EXPORTABLE_KEYS = Object.freeze([
    // ---- 全局正则标志与运行选项 ----
    'flagG',
    'flagI',
    'flagM',
    'loopUntilStable',
    'autoLoadSnapshot',

    // ---- 快速替换面板 ----
    'quickPattern',
    'quickReplacement',
    'quickG',
    'quickI',
    'quickM',
    'quickJsMode',

    // ---- 界面偏好 ----
    'syncScrollMode',
    'darkMode',
    'helpPanelOpen',
    'columnWidths',

    // ★ 修订：不再导出 searchInput / searchCase（见上方注释）

    // ---- 预设搜索偏好（与具体文本无关，保留） ----
    'searchDataSource',
    'presetSearchScope',

    // ---- 用户配置 ----
    'defaultRules',
    'defaultRulesName',
    'customRules',
    'presets',
    'activePresetId',

    // ---- 元信息 ----
    'lastImportedFileName'
]);

/**
 * 会话状态字段清单（当前未被任何模块导入，保留用于语义说明）。
 *
 * ★ 修订：移除 'sourceText' / 'resultText' / 'searchInput' / 'searchCase'。
 *   理由与 SETTINGS_EXPORTABLE_KEYS 一致 —— 这些属于"内容"而非"配置"。
 */
export const SESSION_STATE_KEYS = Object.freeze([
    'flagG',
    'flagI',
    'flagM',
    'loopUntilStable',
    'autoLoadSnapshot',
    'quickPattern',
    'quickReplacement',
    'quickG',
    'quickI',
    'quickM',
    'quickJsMode',
    'syncScrollMode',
    'darkMode',
    'helpPanelOpen',
    'columnWidths',
    'searchDataSource',
    'presetSearchScope',
    'defaultRules',
    'defaultRulesName',
    'customRules',
    'presets',
    'activePresetId',
    'lastImportedFileName'
]);

export const SETTINGS_FILE_TYPE = 'textpro-settings';

export const SETTINGS_FILE_VERSION = 2;