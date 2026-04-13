const {
    buildComposerScript,
    getShortcutModifier,
    clearFocusedInput,
    typeWithClipboardPaste,
    typeWithNativeInsert
} = require('./composer-helpers.cjs');

const META_COMPOSER_CONFIG = {
    inputSelectors: [
        '[data-testid="composer-input"][contenteditable="true"]',
        '[role="textbox"][data-testid="composer-input"]',
        '[contenteditable="true"][data-testid="composer-input"]',
        '[role="textbox"][contenteditable="true"]',
        '[data-testid="composer-input"]',
        '[contenteditable="true"]',
        'textarea',
        'input[type="text"]'
    ],
    buttonSelectors: [
        '[data-testid="composer-send-button"]',
        'button[type="submit"]'
    ],
    buttonClassHints: ['send', 'submit'],
    buttonTestIdHints: ['composer-send-button', 'send', 'submit'],
    notFoundMessage: 'No Meta AI input found',
    noButtonMessage: 'No Meta AI send button found'
};

async function focusMetaInput(webContents) {
    return webContents.executeJavaScript(buildComposerScript({
        ...META_COMPOSER_CONFIG,
        action: 'focus'
    }));
}

function normalizeMetaText(text) {
    return String(text || '')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

async function getMetaFullState(webContents) {
    return webContents.executeJavaScript(`
        (function() {
            const isVisible = (element) => {
                if (!element) return false;
                const style = window.getComputedStyle(element);
                return style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    (element.offsetWidth > 0 || element.offsetHeight > 0 || element.getClientRects().length > 0);
            };

            const input = document.querySelector('[data-testid="composer-input"][contenteditable="true"]') ||
                document.querySelector('[role="textbox"][data-testid="composer-input"]') ||
                document.querySelector('[contenteditable="true"][data-testid="composer-input"]') ||
                document.querySelector('[role="textbox"][contenteditable="true"]') ||
                document.querySelector('[data-testid="composer-input"]') ||
                document.querySelector('[contenteditable="true"]') ||
                document.querySelector('textarea') ||
                document.querySelector('input[type="text"]');

            const button = document.querySelector('[data-testid="composer-send-button"]') ||
                document.querySelector('button[type="submit"]');

            const rawText = String(input?.value || input?.innerText || input?.textContent || '');
            const text = rawText.replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
            const className = String(button?.className || '').toLowerCase();
            const ariaDisabled = String(button?.getAttribute('aria-disabled') || '').toLowerCase();
            const sendDisabled = !!button &&
                (!!button.disabled ||
                    button.hasAttribute('disabled') ||
                    ariaDisabled === 'true' ||
                    className.includes('disabled'));

            return {
                ready: !!input,
                text,
                textLength: text.length,
                sendButtonFound: !!button,
                sendButtonDisabled: sendDisabled,
                sendButtonVisible: isVisible(button),
                sendButtonAria: button?.getAttribute('aria-label') || '',
                sendButtonTestId: button?.getAttribute('data-testid') || '',
                url: window.location.href
            };
        })()
    `);
}

async function waitForMetaExpectedText(webContents, runtime, expectedText, options = {}) {
    const attempts = options.attempts || 16;
    const delayMs = options.delayMs || 160;
    const expected = normalizeMetaText(expectedText);

    let state = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
        state = await getMetaFullState(webContents);
        if (
            state?.ready &&
            state.sendButtonFound &&
            state.sendButtonVisible &&
            !state.sendButtonDisabled &&
            normalizeMetaText(state.text) === expected
        ) {
            return state;
        }

        await runtime.sleep(delayMs);
    }

    return state || getMetaFullState(webContents);
}

async function typeRemainingSuffix(webContents, runtime, expectedText, currentText) {
    const expected = normalizeMetaText(expectedText);
    const current = normalizeMetaText(currentText);

    if (!current || !expected.startsWith(current)) {
        return { ok: false, reason: 'current_text_not_prefix' };
    }

    const suffix = expected.slice(current.length);
    if (!suffix) {
        return { ok: true, suffixLength: 0 };
    }

    if (typeof webContents.insertText === 'function') {
        await Promise.resolve(webContents.insertText(suffix));
    } else {
        for (const ch of suffix) {
            await webContents.sendInputEvent({ type: 'char', keyCode: ch });
            await runtime.sleep(14);
        }
    }

    await runtime.sleep(120);
    return { ok: true, suffixLength: suffix.length };
}

async function clickMetaSendButton(webContents) {
    return webContents.executeJavaScript(`
        (function() {
            const isVisible = (element) => {
                if (!element) return false;
                const style = window.getComputedStyle(element);
                return style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    (element.offsetWidth > 0 || element.offsetHeight > 0 || element.getClientRects().length > 0);
            };

            const button = document.querySelector('[data-testid="composer-send-button"]') ||
                document.querySelector('button[type="submit"]');

            if (!button) {
                return { clicked: false, reason: 'No Meta AI send button found' };
            }

            const className = String(button.className || '').toLowerCase();
            const ariaDisabled = String(button.getAttribute('aria-disabled') || '').toLowerCase();
            const disabled = !!button.disabled ||
                button.hasAttribute('disabled') ||
                ariaDisabled === 'true' ||
                className.includes('disabled');

            if (disabled || !isVisible(button)) {
                return {
                    clicked: false,
                    reason: disabled ? 'Meta AI send button disabled' : 'Meta AI send button not visible',
                    sendButtonDisabled: disabled,
                    sendButtonVisible: isVisible(button)
                };
            }

            button.click();
            return {
                clicked: true,
                sendButtonAria: button.getAttribute('aria-label') || '',
                sendButtonTestId: button.getAttribute('data-testid') || ''
            };
        })()
    `);
}

module.exports = async function sendToMetaAI({ webContents, message, runtime }) {
    const previousState = await runtime.capturePreviousResponse('metaai', { force: true });
    const previousFingerprint = previousState.fingerprint || '';
    const shortcutModifier = getShortcutModifier();
    const expectedMessage = normalizeMetaText(message);

    console.log('[Meta AI] Captured old response fingerprint:', previousFingerprint.substring(0, 50) + '...');

    const focusResult = await focusMetaInput(webContents);
    console.log('[Meta AI] Focus result:', focusResult);

    if (!focusResult?.ready) {
        return { sent: false, error: focusResult?.error || 'No Meta AI input found' };
    }

    await clearFocusedInput(webContents, runtime, shortcutModifier);

    let inputMethod = 'clipboard-paste';
    await typeWithClipboardPaste(webContents, runtime, message, shortcutModifier);

    let composerState = await waitForMetaExpectedText(webContents, runtime, expectedMessage, {
        attempts: 12,
        delayMs: 150
    });

    if (normalizeMetaText(composerState?.text) !== expectedMessage) {
        const suffixResult = await typeRemainingSuffix(webContents, runtime, expectedMessage, composerState?.text);
        console.log('[Meta AI] Suffix repair result:', suffixResult);
        composerState = await waitForMetaExpectedText(webContents, runtime, expectedMessage, {
            attempts: 8,
            delayMs: 150
        });
    }

    if (normalizeMetaText(composerState?.text) !== expectedMessage) {
        console.log('[Meta AI] Clipboard paste did not produce the expected text, retrying with native insert...');

        await focusMetaInput(webContents);
        await clearFocusedInput(webContents, runtime, shortcutModifier);
        inputMethod = 'native-insertText';
        await typeWithNativeInsert(webContents, message);

        composerState = await waitForMetaExpectedText(webContents, runtime, expectedMessage, {
            attempts: 12,
            delayMs: 150
        });

        if (normalizeMetaText(composerState?.text) !== expectedMessage) {
            const suffixResult = await typeRemainingSuffix(webContents, runtime, expectedMessage, composerState?.text);
            console.log('[Meta AI] Native insert suffix repair result:', suffixResult);
            composerState = await waitForMetaExpectedText(webContents, runtime, expectedMessage, {
                attempts: 8,
                delayMs: 150
            });
        }
    }

    console.log('[Meta AI] Composer state before submit:', composerState);

    if (normalizeMetaText(composerState?.text) !== expectedMessage) {
        return {
            sent: false,
            error: 'Meta AI composer text did not stabilize before submit',
            method: inputMethod,
            compose: composerState
        };
    }

    const clickResult = await clickMetaSendButton(webContents);
    console.log('[Meta AI] Click result:', clickResult);

    if (!clickResult?.clicked) {
        await focusMetaInput(webContents);
        await runtime.sleep(100);
        await webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        await webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    }
    await runtime.sleep(250);

    const postSubmitState = await getMetaFullState(webContents);
    console.log('[Meta AI] Post-submit state:', postSubmitState);

    return {
        sent: true,
        method: inputMethod,
        compose: composerState,
        submit: clickResult || { clicked: false, reason: 'Used Enter fallback' },
        postClick: postSubmitState
    };
};
