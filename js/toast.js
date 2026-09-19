/**
 * ============================================================================
 * toast.js — 顶部滑入式提示（独立浮层 + 支持操作按钮）
 * ============================================================================
 *
 * 【本次重构说明】
 *
 *   一、Toast 堆叠数量限制
 *     · 新增 AppState.toastLiveCount 记录当前存活数量。
 *     · 新增 addToastToContainer 检查上限：
 *       超出时立即消退最旧的 toast。
 *     · 使用 CONFIG.TOAST_MAX_STACK_COUNT 控制上限。
 *
 *   二、保留全部既有能力
 *     · 错误配色 / 暗色配色
 *     · 操作按钮
 *     · 进入 / 退出动画
 *     · 自动消退
 * ============================================================================
 */

import { CONFIG } from './config.js';
import { AppState } from './state.js';

let toastContainerElement = null;

const TOAST_ENTER_DURATION_MS = 250;
const TOAST_EXIT_DURATION_MS = 300;

/**
 * 内部：所有存活的 toast 元素（用于 FIFO 淘汰）。
 * 存储在容器上的自定义属性。
 */
const TOAST_ITEMS_KEY = '__textproToastItems__';

function getOrCreateToastContainer() {
    if (
        toastContainerElement &&
        document.body.contains(toastContainerElement)
    ) {
        return toastContainerElement;
    }

    toastContainerElement = document.createElement('div');
    toastContainerElement.id = 'textpro-toast-container';
    toastContainerElement.style.cssText =
        'position: fixed;' +
        'top: 24px;' +
        'left: 50%;' +
        'transform: translateX(-50%);' +
        'z-index: 3000;' +
        'display: flex;' +
        'flex-direction: column;' +
        'align-items: center;' +
        'gap: 8px;' +
        'pointer-events: none;' +
        'max-width: 90vw;';

    // 内部记录数组
    toastContainerElement[TOAST_ITEMS_KEY] = [];

    document.body.appendChild(toastContainerElement);

    return toastContainerElement;
}

/**
 * ★ 新增：检查堆叠上限，超出时立即消退最旧的。
 */
function enforceToastStackLimit(container) {
    const items = container[TOAST_ITEMS_KEY];
    if (!Array.isArray(items)) return;

    const maxCount = CONFIG.TOAST_MAX_STACK_COUNT || 4;
    while (items.length >= maxCount) {
        const oldest = items.shift();
        if (oldest && typeof oldest.dismiss === 'function') {
            oldest.dismiss();
        }
    }
}

function resolveToastColorPalette(isError) {
    const isDarkMode = document.body.classList.contains('dark');

    if (isDarkMode) {
        return {
            background: isError ? '#5e2a2a' : '#1e3a4d',
            color: isError ? '#ffc9c9' : '#d9e9ff',
            borderColor: isError ? '#ef4444' : '#3b82f6'
        };
    }

    return {
        background: isError ? '#ffe6e5' : '#d9e9f7',
        color: isError ? '#b13b2a' : '#0b3b4f',
        borderColor: isError ? '#ffbbb3' : '#b9d8ef'
    };
}

export function showToast(message, isError, options) {
    const container = getOrCreateToastContainer();

    // ★ 堆叠上限检查
    enforceToastStackLimit(container);

    const palette = resolveToastColorPalette(isError === true);
    const actionText = options && typeof options.action === 'string'
        ? options.action
        : null;
    const onAction = options && typeof options.onAction === 'function'
        ? options.onAction
        : null;
    const hasAction = actionText !== null && onAction !== null;

    const toastElement = document.createElement('div');
    toastElement.className = isError
        ? 'textpro-toast textpro-toast-error'
        : 'textpro-toast';
    toastElement.style.cssText =
        'padding: 10px 20px;' +
        'border-radius: 40px;' +
        'font-size: 0.9rem;' +
        'font-weight: 500;' +
        'letter-spacing: 0.2px;' +
        'line-height: 1.4;' +
        'box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);' +
        'max-width: 80vw;' +
        'word-break: break-word;' +
        'text-align: center;' +
        'pointer-events: auto;' +
        'opacity: 0;' +
        'transform: translateY(-12px);' +
        'transition: opacity ' + TOAST_ENTER_DURATION_MS + 'ms ease-out, ' +
                     'transform ' + TOAST_ENTER_DURATION_MS + 'ms ease-out;' +
        'background: ' + palette.background + ';' +
        'color: ' + palette.color + ';' +
        'border: 1px solid ' + palette.borderColor + ';' +
        (hasAction
            ? 'display: flex; align-items: center; gap: 12px;'
            : '');

    const messageSpan = document.createElement('span');
    messageSpan.textContent = message;
    toastElement.appendChild(messageSpan);

    if (hasAction) {
        const actionButton = document.createElement('button');
        actionButton.type = 'button';
        actionButton.textContent = actionText;
        actionButton.style.cssText =
            'background: transparent;' +
            'border: 1px solid currentColor;' +
            'color: inherit;' +
            'padding: 4px 12px;' +
            'border-radius: 20px;' +
            'font-size: 0.8rem;' +
            'font-weight: 600;' +
            'cursor: pointer;' +
            'min-height: 0;' +
            'box-shadow: none;' +
            'white-space: nowrap;';
        actionButton.addEventListener('click', function onActionClick(event) {
            event.stopPropagation();
            try {
                onAction();
            } catch (actionError) {
                console.warn('Toast 操作回调异常:', actionError);
            }
            dismissToast();
        });
        toastElement.appendChild(actionButton);
    }

    container.appendChild(toastElement);

    // 双重 requestAnimationFrame 保证过渡生效
    window.requestAnimationFrame(function onFirstFrame() {
        window.requestAnimationFrame(function onSecondFrame() {
            toastElement.style.opacity = '1';
            toastElement.style.transform = 'translateY(0)';
        });
    });

    const stayDuration = hasAction
        ? CONFIG.TOAST_WITH_ACTION_DURATION_MS
        : CONFIG.TOAST_DURATION_MS;

    let autoDismissTimer = setTimeout(dismissToast, stayDuration);
    let isDismissed = false;

    function dismissToast() {
        if (isDismissed) return;
        isDismissed = true;

        if (autoDismissTimer) {
            clearTimeout(autoDismissTimer);
            autoDismissTimer = null;
        }

        // 从内部记录数组移除
        const items = container[TOAST_ITEMS_KEY];
        if (Array.isArray(items)) {
            const index = items.indexOf(record);
            if (index !== -1) {
                items.splice(index, 1);
            }
        }

        if (!toastElement.parentNode) return;

        toastElement.style.transition =
            'opacity ' + TOAST_EXIT_DURATION_MS + 'ms ease-in, ' +
            'transform ' + TOAST_EXIT_DURATION_MS + 'ms ease-in';
        toastElement.style.opacity = '0';
        toastElement.style.transform = 'translateY(-12px)';

        setTimeout(function removeElement() {
            if (container.contains(toastElement)) {
                container.removeChild(toastElement);
            }
        }, TOAST_EXIT_DURATION_MS);
    }

    // 记录到内部数组，供堆叠限制使用
    const record = {
        element: toastElement,
        dismiss: dismissToast
    };
    const items = container[TOAST_ITEMS_KEY];
    if (Array.isArray(items)) {
        items.push(record);
    }
}