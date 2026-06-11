const {
    buildComposerScript,
    getShortcutModifier,
    clearFocusedInput,
    typeWithClipboardPaste,
    typeWithNativeInsert,
    submissionLikelyStarted,
    clickAtPoint
} = require('./composer-helpers.cjs');

const GROK_COMPOSER_CONFIG = {
    inputSelectors: [
        'textarea[aria-label="Ask Grok anything"]',
        '.ProseMirror[contenteditable="true"]',
        '[contenteditable="true"]',
        'textarea',
        '[role="textbox"]'
    ],
    buttonSelectors: [
        'button[type="submit"][aria-label="Submit"]',
        'button[type="submit"]'
    ],
    buttonClassHints: ['submit', 'send'],
    buttonTestIdHints: ['submit', 'send'],
    notFoundMessage: 'No Grok input found',
    noButtonMessage: 'No Grok submit button found'
};

function normalizeGrokText(text) {
    return String(text || '')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

async function focusGrokInput(webContents) {
    return webContents.executeJavaScript(buildComposerScript({
        ...GROK_COMPOSER_CONFIG,
        action: 'focus'
    }));
}

async function getGrokFullState(webContents) {
    return webContents.executeJavaScript(`
        (function() {
            const config = ${JSON.stringify(GROK_COMPOSER_CONFIG)};

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

            const getText = (element) => String(element?.value || element?.innerText || element?.textContent || '')
                .replace(/\\u00a0/g, ' ')
                .replace(/\\s+/g, ' ')
                .trim();

            const findInput = () => {
                for (const selector of config.inputSelectors || []) {
                    const match = Array.from(document.querySelectorAll(selector)).find(isVisible);
                    if (match) {
                        return { element: match, selector };
                    }
                }

                return { element: null, selector: '' };
            };

            const findSendButton = (input) => {
                if (!input) {
                    return null;
                }

                const roots = [];
                let current = input;
                while (current && roots.length < 8) {
                    roots.push(current);
                    current = current.parentElement;
                }

                for (const root of roots) {
                    for (const selector of config.buttonSelectors || []) {
                        const match = Array.from(root.querySelectorAll(selector)).find(isVisible);
                        if (match) {
                            return { element: match, selector };
                        }
                    }
                }

                for (const selector of config.buttonSelectors || []) {
                    const match = Array.from(document.querySelectorAll(selector)).find(isVisible);
                    if (match) {
                        return { element: match, selector };
                    }
                }

                return null;
            };

            const { element: input, selector: inputSelector } = findInput();
            const sendButton = findSendButton(input);
            const rect = sendButton?.element?.getBoundingClientRect();

            return {
                ready: !!input,
                inputSelector,
                text: getText(input),
                textLength: getText(input).length,
                inputTag: input?.tagName || '',
                sendButtonFound: !!sendButton?.element,
                sendButtonSelector: sendButton?.selector || '',
                sendButtonVisible: isVisible(sendButton?.element),
                sendButtonDisabled: isDisabled(sendButton?.element),
                sendButtonAria: sendButton?.element?.getAttribute('aria-label') || '',
                clickPoint: rect ? {
                    x: Math.round(rect.left + (rect.width / 2)),
                    y: Math.round(rect.top + (rect.height / 2))
                } : null,
                url: window.location.href
            };
        })()
    `);
}

async function waitForGrokExpectedText(webContents, runtime, expectedText, options = {}) {
    const attempts = options.attempts || 16;
    const delayMs = options.delayMs || 160;
    const expected = normalizeGrokText(expectedText);

    let state = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
        state = await getGrokFullState(webContents);
        if (
            state?.ready &&
            state.sendButtonFound &&
            state.sendButtonVisible &&
            !state.sendButtonDisabled &&
            normalizeGrokText(state.text) === expected
        ) {
            return state;
        }

        await runtime.sleep(delayMs);
    }

    return state || getGrokFullState(webContents);
}

module.exports = async function sendToGrok({ webContents, message, runtime }) {
    const previousState = await runtime.capturePreviousResponse('grok', { force: true });
    const previousFingerprint = previousState.fingerprint || '';
    const shortcutModifier = getShortcutModifier();
    const expectedMessage = normalizeGrokText(message);

    console.log('[Grok] Captured old response fingerprint:', previousFingerprint.substring(0, 50) + '...');

    const focusResult = await focusGrokInput(webContents);
    console.log('[Grok] Focus result:', focusResult);

    if (!focusResult?.ready) {
        return { sent: false, error: focusResult?.error || 'No Grok input found' };
    }

    await clearFocusedInput(webContents, runtime, shortcutModifier);

    let inputMethod = 'clipboard-paste';
    await typeWithClipboardPaste(webContents, runtime, message, shortcutModifier);

    let composerState = await waitForGrokExpectedText(webContents, runtime, expectedMessage, {
        attempts: 12,
        delayMs: 150
    });

    if (normalizeGrokText(composerState?.text) !== expectedMessage) {
        console.log('[Grok] Clipboard paste did not stabilize, retrying with native insert...');

        await focusGrokInput(webContents);
        await clearFocusedInput(webContents, runtime, shortcutModifier);
        inputMethod = 'native-insertText';
        await typeWithNativeInsert(webContents, message);

        composerState = await waitForGrokExpectedText(webContents, runtime, expectedMessage, {
            attempts: 12,
            delayMs: 150
        });
    }

    console.log('[Grok] Composer state before submit:', composerState);

    if (normalizeGrokText(composerState?.text) !== expectedMessage) {
        return {
            sent: false,
            error: 'Grok composer text did not stabilize before submit',
            method: inputMethod,
            compose: composerState
        };
    }

    let submitMethod = 'native-click';
    let submitResult = null;
    if (composerState?.clickPoint) {
        await clickAtPoint(webContents, composerState.clickPoint);
        submitResult = { clicked: true, method: submitMethod, point: composerState.clickPoint };
    } else {
        submitMethod = 'enter-fallback';
    }

    await runtime.sleep(250);

    let postSubmitState = await getGrokFullState(webContents);
    console.log('[Grok] Post-submit state:', postSubmitState);

    if (!submissionLikelyStarted(postSubmitState)) {
        await focusGrokInput(webContents);
        await runtime.sleep(100);
        await webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        await webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
        submitMethod = 'enter-fallback';
        submitResult = { clicked: false, method: submitMethod };
        await runtime.sleep(250);
        postSubmitState = await getGrokFullState(webContents);
        console.log('[Grok] Post-enter state:', postSubmitState);
    }

    return {
        sent: true,
        method: inputMethod,
        compose: composerState,
        submit: submitResult,
        postClick: postSubmitState,
        submitMethod
    };
};
