/**
 * ============================================================================
 * changelog.js — 版本历史与更新说明
 * ============================================================================
 *
 * 【本模块职责】
 *   集中记录本工具所有版本的更新内容。
 *
 * 【核心原则 — 绝对静态化】
 *   1. 本模块内容为纯静态常量，绝对不进入 AppState，绝不参与撤销快照。
 *   2. 仅在启动时打印一次，或在 UI 层按需渲染，绝不参与 IndexedDB 自动保存。
 *   3. 版本记录的粒度按模块汇总，不细化到代码级改动。
 *
 * 【对外导出】
 *   - CHANGELOG                完整的版本历史数组（最新在前）
 *   - CURRENT_VERSION          当前应用版本号（与 config.js 保持一致）
 *   - getLatestChangelog()     获取最新版本的更新说明
 *   - getChangelogByVersion(v) 按版本号获取更新说明
 *   - printChangelog()         在控制台打印全部版本历史
 *   - getChangelogSummary()    获取当前版本的一句话摘要
 *   - getChangelogStats(v)     获取指定版本的变更条目统计
 *
 * 【本次修订要点】
 *   · 修复：移除文件开头误粘贴的 Markdown 围栏（--- / # ★ 16. / ```javascript）
 *     与末尾多余的 ```。此前混入会导致浏览器抛出
 *     "Uncaught SyntaxError: Invalid or unexpected token (at changelog.js:4:1)"。
 *   · 新增：模块加载时做一次"版本号一致性"断言，防止发版时
 *     CONFIG.APP_VERSION 与 CHANGELOG[0].version 不一致导致显示自相矛盾。
 *   · 其余逻辑与结构保持不变。
 * ============================================================================
 */

import { CONFIG } from './config.js';

/**
 * 当前应用版本号。
 *
 * 与 config.js 的 CONFIG.APP_VERSION 严格同源 —— 保证
 * 启动横幅、changelog 摘要、导出配置里的 appVersion 三处一致。
 */
export const CURRENT_VERSION = CONFIG.APP_VERSION;

/**
 * 完整的版本历史数组（最新在前）。
 */
export const CHANGELOG = [
    // ========================================================================
    // 最新版本（当前版本）
    // ========================================================================
    {
        version: '9.3.0',
        date: '2025-01-01',
        type: 'minor',
        summary: '流畅度系统性重构：增量渲染 + 并发保存保护 + 按规则 JS 信任 + 全链路性能优化',
        sections: [
            {
                title: '新增功能',
                items: [
                    '【按规则 JS 信任】JS 模式的信任粒度从"会话级"升级为"按规则"——每条规则首次启用时确认，同意后仅对该规则生效，避免导入他人配置后隐藏的恶意规则被静默信任',
                    '【信任集合跨会话保留】按规则信任集合镜像到 localStorage，用户明确信任过的规则下次打开不再重复询问',
                    '【一键撤销全部信任】顶部 🔓 指示器可一键撤销全部 JS 规则信任，撤销后所有规则重新弹确认',
                    '【增量存在性索引】新增 existenceIndexRulePositions / existenceIndexPresetHashes 副索引，编辑单条规则只更新该条索引，不再全量重建',
                    '【预设过滤缓存】预设搜索过滤结果按"查询词 + 字段范围 + 数据源 + 预设库引用"4 元组缓存，避免每次渲染都全量遍历',
                    '【beforeunload 离开确认】存在未同步修改时，关闭页面会弹出浏览器原生离开确认，防止误关标签页丢失编辑',
                    '【错误边界降级 UI】应用启动失败时显示专用降级卡（含"重新加载"按钮和可展开的错误详情）',
                    '【noscript 降级提示】禁用 JavaScript 时显示居中提示卡，说明需要启用 JavaScript',
                    '【持久化权限延后申请】首次用户交互后再申请 navigator.storage.persist()，对 Firefox 更友好',
                    '【导入默认"合并"策略】导入配置对话框默认选中"合并"（同名项以文件为准，新项追加），避免用户直接回车覆盖现有配置',
                    '【时间戳钳制】导入配置时把 createdAt / updatedAt 钳制到合理范围，防止未来时间扰乱排序',
                    '【Toast 堆叠限制】最多同时显示 4 个 toast，超出时淘汰最旧的，避免高频提示堆叠',
                    '【搜索上限警告抑制】达到匹配上限的提示在 5 秒窗口内不重复弹出'
                ]
            },
            {
                title: '性能优化',
                items: [
                    '【增量渲染主表】renderRuleTable 检查 lastRenderedRuleOrderKey，id 序列完全一致时只更新行的动态部分（值、勾选状态、徽章），完全不碰 DOM 结构',
                    '【重复检测缓存】detectMainTableDuplicates 按内容签名缓存，编辑名称/勾选状态不触发重算',
                    '【自动保存并发保护】autoSaveInProgress + autoSavePendingRetry 标记，保存进行中时新变更排队，避免两次保存并发导致旧数据覆盖新数据',
                    '【lower-case 缓存惰性失效】编辑结果区只设置 dirty 标记，不清空 20MB 文本的 toLowerCase 缓存，下次搜索才真正重算',
                    '【结果区输入搜索防抖】手动编辑结果区时搜索延迟 300ms 触发，避免每次按键都触发全量搜索',
                    '【同步滚动 rAF 节流】触摸板惯性滚动下合帧处理，避免另一侧 textarea 频繁重排',
                    '【scrollTop rAF 恢复】预设列表、预设详情滚动位置延迟一帧恢复，避免 replaceChildren 后布局未完成时被钳制',
                    '【IndexedDB 连接复用】模块级缓存连接，避免每次 save/load/open 都 close + open 的开销',
                    '【大文本滚动定位零副本】search.js 大文本分支直接在原字符串上遍历换行符，不生成 substring 副本',
                    '【Worker 进度节流】批量运行进度消息按 100ms 节流，最后一条必然上报'
                ]
            },
            {
                title: '安全与健壮性',
                items: [
                    '【JS 模式强制走 Worker】即使小文本也走后台计算线程，统一受 60 秒超时保护，避免死循环卡死主线程',
                    '【Worker 不可用时明确拒绝】含 JS 规则的批量替换在 Worker 不可用时直接拒绝执行，不降级到主线程',
                    '【加解密错误分类】loadEncryptedState 区分 DECRYPT_FAILED 与 JSON_PARSE_FAILED，避免 JSON 损坏被误判为密钥不匹配',
                    '【ID 冲突解决】replaceMainTableWithRules 校验 id 唯一性，源规则 id 与已有规则冲突时派生新 id，避免出现两条 id 相同的规则',
                    '【预设删除级联清理】删除预设后强制重渲染当前规则卡片，清理指向已删除预设的引用',
                    '【主表添加/删除/排序同步索引】新增规则时 addRuleToExistenceIndex，删除规则时 removeRuleFromExistenceIndex',
                    '【IndexedDB 打开超时保护】15 秒超时降级，避免多标签页 blocked 导致启动流程永久挂起'
                ]
            },
            {
                title: '一致性修复',
                items: [
                    '【主表→预设自动同步接入】所有主表操作（增/删/改/排序/勾选）都调用 scheduleSyncToActivePreset，彻底修复"编辑后必须手动保存回预设"的交互断裂',
                    '【applyFullUiState 微任务渲染】使用 Promise.resolve().then 而非同时调用 import().then，避免与 main.js 中的同步 renderRuleTable 冲突导致少渲染一次',
                    '【forceSaveBeforeUnload 一致性】与 saveStateImmediately 行为一致，先 flush 待同步的预设变更',
                    '【replaceMainTableWithRules 前缀转换】补 applyRulePrefixConversionInPlace，避免 @js: / @@js: 前缀静默不生效',
                    '【启动恢复一致性校验】ensureStartupStateConsistent 检测主表与预设不一致时，按"主表优先"策略同步',
                    '【时间戳字段钳制】normalizeImportedPreset 的 createdAt / updatedAt 钳制到 [0, now + 60_000]'
                ]
            },
            {
                title: '体验优化',
                items: [
                    '【搜索过滤下排序修正】过滤视图下的上移/下移按钮按"当前可见列表"的相对位置移动，符合视觉预期',
                    '【追加目标过滤精确化】主表条目匹配改为"前缀匹配 + 完整别名匹配"，不再因 "in" 匹配 "main"',
                    '【批量运行取消无二次确认】取消本身是安全操作，不再弹确认框',
                    '【Ctrl+Shift+D 切换暗色】不再劫持 Ctrl+D（浏览器的"添加书签"）',
                    '【Ctrl+S 立即保存】与文本编辑器习惯一致',
                    '【启动 toast 精确化】skipped 分支只在权限已授予时才承诺"旧快照仍在本地"',
                    '【页面生命周期补强】visibilitychange(hidden) 作为主触发点（比 pagehide 更早），pagehide 兜底；页面重新可见时重置标志',
                    '【持久化权限通知监听】textpro:persistent-storage-updated 事件联动顶部提示条',
                    '【导入对话框默认模式可视化】HTML 中"合并（推荐）"默认选中'
                ]
            },
            {
                title: '配置项新增',
                items: [
                    '【TOAST_MAX_STACK_COUNT】Toast 最大堆叠数量（默认 4）',
                    '【IMPORT_MODE_DEFAULT】导入配置默认选中的模式（默认 merge）',
                    '【JS_TRUST_RULE_BASED】是否启用按规则信任模型（默认 true）',
                    '【INDEX_EXISTENCE_INCREMENTAL】存在性索引是否增量更新（默认 true）',
                    '【STORAGE_PERSIST_DEFERRED】持久化权限是否延后申请（默认 true）',
                    '【BEFORE_UNLOAD_GUARD_ENABLED】是否启用离开确认（默认 true）',
                    '【WORKER_SINGLE_REPLACE_CANCELLABLE】单次替换是否允许取消（默认 false，正则 replace 无法中途打断）',
                    '【SEARCH_LIMIT_WARNING_REPEAT_MS】搜索上限警告重复抑制窗口（默认 5000ms）',
                    '【RESULT_INPUT_SEARCH_DEBOUNCE_MS】结果区手动输入的搜索防抖（默认 300ms）',
                    '【TIMESTAMP_FUTURE_TOLERANCE_MS】时间戳未来容差（默认 60_000ms）',
                    '【UI_JS_TRUSTED_RULE_IDS】localStorage key：按规则 JS 信任集合的镜像'
                ]
            },
            {
                title: '状态字段新增',
                items: [
                    '【jsTrustedRuleIds】按规则 JS 信任集合（Set<string>）',
                    '【existenceIndexRulePositions】增量索引：ruleId -> Set<presetId>',
                    '【existenceIndexPresetHashes】增量索引：presetId -> Map<hash, Set<ruleId>>',
                    '【lastPresetFilterQuery / Scope / DataSource / PresetsSnapshot / Result】预设过滤缓存',
                    '【searchLimitWarningLastAt】搜索上限警告上次触发时间',
                    '【toastLiveCount】当前存活 toast 数量',
                    '【pendingBeforeUnloadArmed】是否已挂载 beforeunload 拦截',
                    '【persistenceRequestDeferred】持久化权限申请是否已延后',
                    '【importModeDefaultApplied】本次导入对话框是否已按默认模式预选'
                ]
            },
            {
                title: '代码清理',
                items: [
                    '【security.js 信任模型重构】sessionTrustGranted 保留为旧模型兼容，新增 jsTrustedRuleIds 为按规则信任权威来源',
                    '【rules.js 副索引构建】rebuildExistenceIndex 同步构建 contentHashMap / rulePositions / presetHashes 三个结构',
                    '【persistence.js 持久化权限调度】schedulePersistentStorageRequest 集中管理权限申请时机'
                ]
            }
        ]
    },

    // ========================================================================
    // 历史版本
    // ========================================================================
    {
        version: '9.2.0',
        date: '2024-01-01',
        type: 'minor',
        summary: '命名预设管理 + 编辑闭环 + 三级去重 + 循环导入修复 + 焦点保持 + 20MB 大文本处理',
        sections: [
            {
                title: '新增功能',
                items: [
                    '【命名预设管理】将当前替换表保存为命名预设，支持创建、重命名、删除、另存为、搜索过滤',
                    '【预设内独立编辑】每个预设含独立的规则列表，可增删改、排序、编辑',
                    '【卡片式规则列表】预设内规则以三行卡片形式展示，无需横向滚动',
                    '【一键加载】将预设加载到主替换表，加载前有覆盖确认',
                    '【单条规则追加到目标】预设规则卡片有"→追加"按钮，可选择追加到主表或其他预设',
                    '【模态框放大显示】预设模态框支持全屏模式（点击标题栏 ⛶ 按钮）',
                    '【键盘无障碍】预设列表支持 Tab 聚焦、↑↓ 导航、Enter/Space 选择',
                    '【焦点返还】关闭预设模态框后焦点还给触发按钮（WAI-ARIA 标准）',
                    '【编辑闭环】加载预设到主表后，主表自动"关联"该预设；主表的所有修改自动同步回预设',
                    '【主表关联指示器】主表顶部显示"来源：XXX"，可一键"保存回预设"或"清除来源标记"',
                    '【重复项检测】主表渲染时检测内容相同的规则，为重复组所有行加 ⚠️ 徽章',
                    '【版本历史模块】新增 js/changelog.js 集中记录每次更新内容',
                    '【启动版本提示】应用启动时在控制台自动打印当前版本摘要与变更统计',
                    '【控制台快捷入口】暴露 window.printChangelog()，用户可随时查看完整版本历史',
                    '【主表焦点保持】renderRuleTable 重建 DOM 时保存 / 恢复焦点位置',
                    '【20MB 大文本处理】文本处理能力从 5MB 提升至 20MB',
                    '【Web Worker 计算线程】超过 1MB 的文本自动走 Worker，主线程完全不阻塞',
                    '【实时进度条】批量运行期间显示"正在运行 N/M · 规则名"，进度百分比实时更新',
                    '【批量运行取消】大文本运行期间可点击"✕ 取消"按钮终止',
                    '【Worker 降级保护】Worker 不可用时自动降级到主线程同步处理',
                    '【虚拟主表条目】预设列表顶部置顶"📋 主表"虚拟条目',
                    '【跨预设存在性徽章】预设规则卡片底部显示"存在于：📋 主表 · ⭐ 其他 N 处"',
                    '【预设搜索扩展】支持搜索预设名 + 规则内容（名称 / 正则 / 替换）',
                    '【追加目标模态框】"→追加"弹出目标选择器，显示每个目标的追加状态',
                    '【模态框栈】处理嵌套模态框的 Esc 键冲突，只关闭栈顶'
                ]
            },
            {
                title: '优化改进',
                items: [
                    '【去重逻辑升级】从"完全字符串比较"升级为"内容层面等价比较"（严格等价 + 实质等价）',
                    '【追加规则智能提示】严格等价静默跳过 + "仍要追加"操作；实质等价弹出 confirm 确认',
                    '【删除二次确认】主表规则删除在剩余规则数 >= 2 时弹 confirm',
                    '【主表操作按钮居中】.action-buttons 改为 justify-content: center',
                    '【按钮溢出滚动】主表操作按钮列从 overflow: hidden 改为 overflow-x: auto',
                    '【导入反馈智能区分】旧版文件提示"已从旧版替换表导入"，新版提示"已导入 N 项设置"',
                    '【导入模式对话框摘要增强】展示规则条数、预设条数、可识别字段数',
                    '【预设同步防抖】主表编辑单元格后停手 400ms 才同步到关联预设',
                    '【焦点保存通用化】captureRuleTableFocusState 扩展支持 INPUT 与 BUTTON 两种元素类型',
                    '【大文本 Worker 阈值】超过 1MB 自动切换 Worker',
                    '【结果零拷贝回传】Worker 通过 Transferable ArrayBuffer 回传结果',
                    '【Worker 单例复用】Worker 实例全局复用'
                ]
            },
            {
                title: '关键修复',
                items: [
                    '【P0】persistence.js ↔ rules.js 循环静态导入：改为动态 import 加载 flushPendingPresetSync',
                    '【P0】追加规则时未做去重检测：引入严格/实质两级等价判断',
                    '【P1】主表输入框 change 后焦点丢失：renderRuleTable 增加焦点保存/恢复机制',
                    '【P1】追加目标模态框的"仍要追加"流程未闭环：新增 textpro:rule-appended 事件',
                    '【P1】预设规则 id 稳定性被破坏：replaceMainTableWithRules 保留源规则 id',
                    '【P1】导入 JSON 原型污染风险：所有外部导入对象经 safeCopyPlainObject 拷贝',
                    '【P2】Worker 超时保护：超过 60 秒自动终止任务',
                    '【P2】Worker 崩溃恢复：Worker 内部异常时自动销毁并重建'
                ]
            }
        ]
    },

    {
        version: '9.1.0',
        date: '2023-12-15',
        type: 'minor',
        summary: '模块化重构 + 大文本保护',
        sections: [
            {
                title: '新增功能',
                items: [
                    '【模块化拆分】单文件 V9.0 按职责拆分为 17 个 ES Module',
                    '【CSS 拆分】styles.css / themes.css / components.css 三文件分离',
                    '【大文本保护】超过 500KB 提示，超过 5MB 拒绝处理',
                    '【结果区流转按钮】结果 → 源 / 交换 / 重置三个按钮',
                    '【搜索结果用于替换】搜索计数旁"⤴ 用于替换"按钮',
                    '【快速替换存为规则】试出好规则可一键固化为规则表项'
                ]
            },
            {
                title: '优化改进',
                items: [
                    '【循环替换性能优化】performLoopReplace 循环外编译一次正则和 JS 函数',
                    '【批量运行分帧执行】每执行 3 条规则让出一次主线程',
                    '【搜索结果无重叠】与浏览器 Ctrl+F 语义一致',
                    '【搜索不抢选区】输入搜索词时不改变结果区选区',
                    '【Enter 立即导航】flush 掉输入防抖，保证用最新搜索词导航'
                ]
            }
        ]
    },

    {
        version: '9.0.0',
        date: '2023-11-20',
        type: 'major',
        summary: '完整 UI 状态持久化 + AES-GCM 加密 + JS 模式安全防御',
        sections: [
            {
                title: '新增功能',
                items: [
                    '【完整 UI 状态持久化】下次打开自动恢复上次编辑状态与所有设置',
                    '【AES-GCM 加密】所有持久化数据加密后存入 IndexedDB',
                    '【明文备份】主题 / 上次导入文件名 / 同步滚动模式在 localStorage 中明文备份',
                    '【暗色模式】一键切换，切换即持久化',
                    '【同步滚动】比例同步 / 像素同步 / 关闭三种模式',
                    '【配置导出 / 导入】JSON 格式，支持覆盖 / 追加 / 合并三种策略',
                    '【JS 模式三重防御】危险 API 黑名单 + 字符串拼接绕过检测 + 原型链属性访问检测',
                    '【会话级信任】同会话内同意一次后不再重复弹窗',
                    '【存储状态透明化】IndexedDB 不可用时顶部常驻警告横幅',
                    '【批量运行错误汇总条】出错规则汇总到可展开的错误条'
                ]
            },
            {
                title: '安全与健壮性',
                items: [
                    '【解密失败保护】密钥不匹配时弹窗询问，避免用新密钥覆盖旧密文',
                    '【应用预设前的覆盖确认】避免误操作丢失当前规则表',
                    '【破坏性操作可撤销】均带"撤销"按钮'
                ]
            }
        ]
    }
];

// ============================================================================
// 模块加载时的版本一致性断言
// ============================================================================
//
// 防止发版时只改了 CONFIG.APP_VERSION 或只改了 CHANGELOG[0].version 中的一处，
// 导致启动横幅显示 "vX.Y.Z" 而 printChangelog() 末尾显示 "当前版本：A.B.C"，
// 两者自相矛盾。
//
// 只在控制台打一条警告，不阻塞应用运行。
// ============================================================================
if (
    CHANGELOG.length > 0 &&
    CHANGELOG[0].version !== CONFIG.APP_VERSION
) {
    if (typeof console !== 'undefined' && console.warn) {
        console.warn(
            '[TextPro] 版本号不一致：' +
            'CONFIG.APP_VERSION = ' + CONFIG.APP_VERSION + '，' +
            'CHANGELOG[0].version = ' + CHANGELOG[0].version + '。' +
            '请检查发版时是否漏改一处。'
        );
    }
}

/**
 * 获取最新版本的更新说明。
 */
export function getLatestChangelog() {
    if (CHANGELOG.length === 0) return null;
    return CHANGELOG[0];
}

/**
 * 按版本号获取更新说明。
 */
export function getChangelogByVersion(version) {
    if (typeof version !== 'string') return null;
    for (let index = 0; index < CHANGELOG.length; index++) {
        if (CHANGELOG[index].version === version) {
            return CHANGELOG[index];
        }
    }
    return null;
}

/**
 * 获取当前版本的一句话摘要。
 */
export function getChangelogSummary() {
    const latest = getLatestChangelog();
    if (!latest) return '';
    return latest.summary || '';
}

/**
 * 将单个版本的更新说明格式化为纯文本。
 *
 * 供 printChangelog 内部使用。
 */
function formatChangelogEntry(changelogEntry) {
    if (!changelogEntry) return '';

    const lines = [];

    lines.push('='.repeat(72));
    lines.push('版本 ' + changelogEntry.version +
        '  (' + changelogEntry.date + ')  [' + changelogEntry.type + ']');
    lines.push('摘要：' + (changelogEntry.summary || ''));
    lines.push('='.repeat(72));

    if (Array.isArray(changelogEntry.sections)) {
        changelogEntry.sections.forEach(function forEachSection(section) {
            lines.push('');
            lines.push('【' + section.title + '】');
            if (Array.isArray(section.items)) {
                section.items.forEach(function forEachItem(item) {
                    if (item.startsWith('  ')) {
                        lines.push('    ' + item.trim());
                    } else {
                        lines.push('  · ' + item);
                    }
                });
            }
        });
    }

    return lines.join('\n');
}

/**
 * 在控制台打印全部版本历史。
 */
export function printChangelog() {
    if (typeof console === 'undefined' || !console.log) return;

    console.log('');
    console.log('%c TextPro 文本净化工具 · 版本历史 ',
        'background:#0f6b8c;color:#fff;font-weight:bold;padding:4px 12px;border-radius:4px;');
    console.log('');

    CHANGELOG.forEach(function forEachEntry(changelogEntry) {
        console.log(formatChangelogEntry(changelogEntry));
        console.log('');
    });

    console.log('当前版本：' + CURRENT_VERSION);
    console.log('');
}

/**
 * 统计指定版本的变更条目总数。
 */
export function getChangelogStats(version) {
    const targetEntry = version
        ? getChangelogByVersion(version)
        : getLatestChangelog();

    const stats = { '新增': 0, '优化': 0, '修复': 0, '其他': 0 };
    if (!targetEntry || !Array.isArray(targetEntry.sections)) {
        return stats;
    }

    targetEntry.sections.forEach(function forEachSection(section) {
        const itemCount = Array.isArray(section.items)
            ? section.items.length
            : 0;
        const title = section.title || '';

        if (title.indexOf('新增') !== -1) {
            stats['新增'] += itemCount;
        } else if (
            title.indexOf('优化') !== -1 ||
            title.indexOf('改进') !== -1 ||
            title.indexOf('性能') !== -1 ||
            title.indexOf('体验') !== -1 ||
            title.indexOf('配置') !== -1 ||
            title.indexOf('状态') !== -1
        ) {
            stats['优化'] += itemCount;
        } else if (
            title.indexOf('修复') !== -1 ||
            title.indexOf('一致') !== -1 ||
            title.indexOf('安全') !== -1 ||
            title.indexOf('健壮') !== -1 ||
            title.indexOf('清理') !== -1
        ) {
            stats['修复'] += itemCount;
        } else {
            stats['其他'] += itemCount;
        }
    });

    return stats;
}