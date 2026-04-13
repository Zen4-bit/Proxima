function buildComposerScript(config) {
    return `
        (function() {
            const config = ${JSON.stringify(config)};

            const isVisible = (element) => {
                if (!element) return false;
                const style = window.getComputedStyle(element);
                return style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    (element.offsetWidth > 0 || element.offsetHeight > 0 || element.getClientRects().length > 0);
            };

            const isDisabled = (element) => {
                if (!element) return true;

                const className = String(element.className || '').toLowerCase();
                const ariaDisabled = String(element.getAttribute('aria-disabled') || '').toLowerCase();

                return !!element.disabled ||
                    element.hasAttribute('disabled') ||
                    ariaDisabled === 'true' ||
                    className.includes('disabled');
            };

            const getText = (element) => {
                if (!element) return '';
                return String(element.value || element.innerText || element.textContent || '')
                    .replace(/\\s+/g, ' ')
                    .trim();
            };

            const setCaretToEnd = (element) => {
                if (!element) return;

                try {
                    element.focus();
                    if (typeof element.setSelectionRange === 'function' && typeof element.value === 'string') {
                        const end = element.value.length;
                        element.setSelectionRange(end, end);
                        return;
                    }

                    if (element.isContentEditable || element.contentEditable === 'true') {
                        const selection = window.getSelection();
                        if (!selection) return;
                        const range = document.createRange();
                        range.selectNodeContents(element);
                        range.collapse(false);
                        selection.removeAllRanges();
                        selection.addRange(range);
                    }
                } catch (error) {}
            };

            const findInput = () => {
                for (const selector of config.inputSelectors || []) {
                    const matches = Array.from(document.querySelectorAll(selector)).filter(isVisible);
                    if (matches.length > 0) {
                        return { element: matches[0], selector };
                    }
                }

                return { element: null, selector: '' };
            };

            const findSendButton = (input) => {
                if (!input) {
                    return null;
                }

                const inputRect = input.getBoundingClientRect();
                const seen = new Set();
                const candidates = [];
                const ancestors = [];
                let current = input;

                while (current && ancestors.length < 10) {
                    ancestors.push(current);
                    current = current.parentElement;
                }

                const scoreButton = (button, depth, selector) => {
                    if (!isVisible(button)) {
                        return Number.NEGATIVE_INFINITY;
                    }

                    const className = String(button.className || '').toLowerCase();
                    const ariaLabel = String(button.getAttribute('aria-label') || '').toLowerCase();
                    const title = String(button.getAttribute('title') || '').toLowerCase();
                    const text = String(button.innerText || button.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
                    const testId = String(button.getAttribute('data-testid') || '').toLowerCase();
                    const type = String(button.getAttribute('type') || '').toLowerCase();
                    const rect = button.getBoundingClientRect();
                    const dx = Math.abs(rect.left - inputRect.right);
                    const dy = Math.abs(rect.top - inputRect.top);
                    const disabled = isDisabled(button);
                    let score = 0;

                    for (const hint of config.buttonClassHints || []) {
                        if (className.includes(String(hint).toLowerCase())) {
                            score += 140;
                        }
                    }

                    for (const hint of config.buttonTestIdHints || []) {
                        if (testId.includes(String(hint).toLowerCase())) {
                            score += 110;
                        }
                    }

                    if (type === 'submit') {
                        score += 90;
                    }

                    if (disabled) {
                        score -= 120;
                    } else {
                        score += 36;
                    }

                    if (selector === 'button,[role="button"]' || button.tagName === 'BUTTON') {
                        score += 10;
                    }

                    if (!text) {
                        score += 6;
                    }

                    if (button.querySelector('svg, mat-icon, [class*="icon"], [data-icon]')) {
                        score += 12;
                    }

                    if (button.closest('form') && input.closest('form') === button.closest('form')) {
                        score += 24;
                    }

                    score -= depth * 12;
                    score -= Math.min(dx, 320) / 18;
                    score -= Math.min(dy, 320) / 16;

                    if (rect.left >= inputRect.left) {
                        score += 8;
                    }

                    if (rect.top >= inputRect.top - 48 && rect.bottom <= inputRect.bottom + 96) {
                        score += 12;
                    }

                    if (ariaLabel || title) {
                        score += 4;
                    }

                    return score;
                };

                const addCandidate = (button, selector, depth) => {
                    if (!button || seen.has(button)) {
                        return;
                    }

                    seen.add(button);

                    const rect = button.getBoundingClientRect();
                    const score = scoreButton(button, depth, selector);
                    if (!Number.isFinite(score)) {
                        return;
                    }

                    candidates.push({
                        element: button,
                        selector,
                        score,
                        disabled: isDisabled(button),
                        visible: isVisible(button),
                        rect: {
                            left: rect.left,
                            top: rect.top,
                            width: rect.width,
                            height: rect.height
                        }
                    });
                };

                ancestors.forEach((root, depth) => {
                    for (const selector of config.buttonSelectors || []) {
                        let matches = [];
                        try {
                            matches = Array.from(root.querySelectorAll(selector));
                        } catch (error) {
                            matches = [];
                        }

                        matches.forEach((button) => addCandidate(button, selector, depth));
                    }

                    Array.from(root.querySelectorAll('button, [role="button"]'))
                        .forEach((button) => addCandidate(button, 'button,[role="button"]', depth + 4));
                });

                if (candidates.length === 0) {
                    for (const selector of config.buttonSelectors || []) {
                        let matches = [];
                        try {
                            matches = Array.from(document.querySelectorAll(selector));
                        } catch (error) {
                            matches = [];
                        }

                        matches.forEach((button) => addCandidate(button, selector, 12));
                    }
                }

                candidates.sort((a, b) => b.score - a.score);
                return candidates[0] || null;
            };

            const { element: input, selector: inputSelector } = findInput();
            const inputText = getText(input);
            const candidate = findSendButton(input);

            const baseState = {
                ready: !!input,
                inputSelector,
                textPreview: inputText.slice(0, 160),
                textLength: inputText.length,
                sendButtonFound: !!candidate,
                sendButtonSelector: candidate?.selector || '',
                sendButtonVisible: !!candidate?.visible,
                sendButtonDisabled: !!candidate?.disabled,
                sendButtonClass: candidate?.element ? String(candidate.element.className || '').slice(0, 160) : '',
                sendButtonAria: candidate?.element?.getAttribute('aria-label') || '',
                clickPoint: candidate ? {
                    x: Math.round(candidate.rect.left + (candidate.rect.width / 2)),
                    y: Math.round(candidate.rect.top + (candidate.rect.height / 2))
                } : null
            };

            if (config.action === 'focus') {
                if (!input) {
                    return {
                        ...baseState,
                        ready: false,
                        error: config.notFoundMessage || 'Composer input not found'
                    };
                }

                try {
                    input.focus();
                    if (typeof input.click === 'function') {
                        input.click();
                    }
                    setCaretToEnd(input);
                } catch (error) {}

                return baseState;
            }

            if (config.action === 'click') {
                if (!candidate?.element) {
                    return {
                        ...baseState,
                        clicked: false,
                        reason: config.noButtonMessage || 'No send button found'
                    };
                }

                if (candidate.disabled || !candidate.visible) {
                    return {
                        ...baseState,
                        clicked: false,
                        reason: candidate.disabled ? 'Send button disabled' : 'Send button not visible'
                    };
                }

                const target = candidate.element;
                const { x, y } = baseState.clickPoint || { x: 0, y: 0 };

                try {
                    target.focus();
                } catch (error) {}

                const dispatchPointerEvent = (type, buttons) => {
                    try {
                        target.dispatchEvent(new PointerEvent(type, {
                            bubbles: true,
                            cancelable: true,
                            clientX: x,
                            clientY: y,
                            pointerType: 'mouse',
                            isPrimary: true,
                            button: 0,
                            buttons
                        }));
                    } catch (error) {}
                };

                const dispatchMouseEvent = (type, buttons) => {
                    try {
                        target.dispatchEvent(new MouseEvent(type, {
                            bubbles: true,
                            cancelable: true,
                            view: window,
                            clientX: x,
                            clientY: y,
                            button: 0,
                            buttons
                        }));
                    } catch (error) {}
                };

                dispatchPointerEvent('pointerdown', 1);
                dispatchMouseEvent('mousedown', 1);
                dispatchPointerEvent('pointerup', 0);
                dispatchMouseEvent('mouseup', 0);
                dispatchMouseEvent('click', 0);

                try {
                    if (typeof target.click === 'function') {
                        target.click();
                    }
                } catch (error) {}

                return {
                    ...baseState,
                    clicked: true
                };
            }

            return baseState;
        })()
    `;
}

function getShortcutModifier() {
    return process.platform === 'darwin' ? 'meta' : 'control';
}

async function clearFocusedInput(webContents, runtime, modifier = getShortcutModifier()) {
    await webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: [modifier] });
    await webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: [modifier] });
    await runtime.sleep(60);
    await webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
    await webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
    await runtime.sleep(140);
}

async function typeWithNativeInsert(webContents, message) {
    if (typeof webContents.insertText !== 'function') {
        return { ok: false, method: 'native-insert-unavailable' };
    }

    await Promise.resolve(webContents.insertText(message));
    return { ok: true, method: 'native-insertText' };
}

async function typeWithClipboardPaste(webContents, runtime, message, modifier = getShortcutModifier()) {
    const previousClipboard = runtime.clipboard.readText();
    runtime.clipboard.writeText(message);

    try {
        if (typeof webContents.paste === 'function') {
            await Promise.resolve(webContents.paste());
        } else {
            await webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: [modifier] });
            await webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: [modifier] });
        }
        await runtime.sleep(180);
    } finally {
        runtime.clipboard.writeText(previousClipboard);
    }

    return { ok: true, method: 'clipboard-paste' };
}

async function waitForComposerReady(getState, runtime, options = {}) {
    const attempts = options.attempts || 12;
    const delayMs = options.delayMs || 150;

    let state = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
        state = await getState();
        if (state?.sendButtonFound && state.sendButtonVisible && !state.sendButtonDisabled && state.textLength > 0) {
            return state;
        }

        await runtime.sleep(delayMs);
    }

    return state || getState();
}

function submissionLikelyStarted(state) {
    if (!state || !state.ready) {
        return false;
    }

    if (state.textLength === 0) {
        return true;
    }

    return state.sendButtonFound && state.sendButtonDisabled;
}

async function clickAtPoint(webContents, point) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        return false;
    }

    const x = Math.round(point.x);
    const y = Math.round(point.y);

    await webContents.sendInputEvent({ type: 'mouseMove', x, y });
    await webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    await webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });

    return true;
}

module.exports = {
    buildComposerScript,
    getShortcutModifier,
    clearFocusedInput,
    typeWithNativeInsert,
    typeWithClipboardPaste,
    waitForComposerReady,
    submissionLikelyStarted,
    clickAtPoint
};
