const {
    buildComposerScript,
    getShortcutModifier,
    clearFocusedInput,
    typeWithClipboardPaste,
    typeWithNativeInsert
} = require('./composer-helpers.cjs');

const PERPLEXITY_COMPOSER_CONFIG = {
    inputSelectors: [
        '[contenteditable="true"][role="textbox"]',
        '[contenteditable="true"]',
        'textarea[placeholder*="follow"]',
        'textarea[placeholder*="Ask"]',
        'textarea'
    ],
    buttonSelectors: [
        'button[aria-label="Submit"]',
        'button[aria-label*="Submit"]',
        'button[type="submit"]'
    ],
    buttonClassHints: ['submit'],
    buttonTestIdHints: ['submit'],
    notFoundMessage: 'No Perplexity input found',
    noButtonMessage: 'No Perplexity submit button found'
};

function normalizePerplexityText(text) {
    return String(text || '')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

async function focusPerplexityInput(webContents) {
    return webContents.executeJavaScript(buildComposerScript({
        ...PERPLEXITY_COMPOSER_CONFIG,
        action: 'focus'
    }));
}

async function getPerplexityState(webContents) {
    return webContents.executeJavaScript(`
        (function() {
            const isVisible = (element) => {
                if (!element) return false;
                const style = window.getComputedStyle(element);
                return style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    (element.offsetWidth > 0 || element.offsetHeight > 0 || element.getClientRects().length > 0);
            };

            const input = document.querySelector('[contenteditable="true"][role="textbox"]') ||
                document.querySelector('[contenteditable="true"]') ||
                document.querySelector('textarea[placeholder*="follow"]') ||
                document.querySelector('textarea[placeholder*="Ask"]') ||
                document.querySelector('textarea');

            const button = document.querySelector('button[aria-label="Submit"]') ||
                document.querySelector('button[aria-label*="Submit"]') ||
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
                sendButtonVisible: isVisible(button),
                sendButtonDisabled: sendDisabled,
                sendButtonAria: button?.getAttribute('aria-label') || '',
                url: window.location.href
            };
        })()
    `);
}

async function waitForPerplexityExpectedText(webContents, runtime, expectedText, options = {}) {
    const attempts = options.attempts || 14;
    const delayMs = options.delayMs || 160;
    const expected = normalizePerplexityText(expectedText);

    let state = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
        state = await getPerplexityState(webContents);
        if (
            state?.ready &&
            state.sendButtonFound &&
            state.sendButtonVisible &&
            !state.sendButtonDisabled &&
            normalizePerplexityText(state.text) === expected
        ) {
            return state;
        }

        await runtime.sleep(delayMs);
    }

    return state || await getPerplexityState(webContents);
}

async function clickPerplexitySubmit(webContents) {
    return webContents.executeJavaScript(`
        (function() {
            const isVisible = (element) => {
                if (!element) return false;
                const style = window.getComputedStyle(element);
                return style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    (element.offsetWidth > 0 || element.offsetHeight > 0 || element.getClientRects().length > 0);
            };

            const button = document.querySelector('button[aria-label="Submit"]') ||
                document.querySelector('button[aria-label*="Submit"]') ||
                document.querySelector('button[type="submit"]');

            if (!button) {
                return { clicked: false, reason: 'No Perplexity submit button found' };
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
                    reason: disabled ? 'Perplexity submit button disabled' : 'Perplexity submit button not visible'
                };
            }

            button.click();
            return {
                clicked: true,
                ariaLabel: button.getAttribute('aria-label') || '',
                className: String(button.className || '').slice(0, 160)
            };
        })()
    `);
}

async function waitForPerplexitySubmissionStart(webContents, runtime, previousUrl, options = {}) {
    const attempts = options.attempts || 16;
    const delayMs = options.delayMs || 180;

    let state = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
        state = await getPerplexityState(webContents);
        if (
            state?.sendButtonDisabled ||
            state?.textLength === 0 ||
            (previousUrl && state?.url && state.url !== previousUrl)
        ) {
            return { started: true, state };
        }

        await runtime.sleep(delayMs);
    }

    return { started: false, state: state || await getPerplexityState(webContents) };
}

module.exports = async function sendToPerplexity({ webContents, message, runtime }) {
    console.log('[Perplexity] Sending message...');

    const currentUrl = await webContents.executeJavaScript('window.location.href');
    if (!currentUrl.includes(runtime.providerMap.perplexity.cookieDomain)) {
        await webContents.loadURL(runtime.providerMap.perplexity.url);
        await runtime.sleep(2000);
    }

    const previousState = await runtime.capturePreviousResponse('perplexity', { force: true });
    console.log('[Perplexity] Old response data:', {
        count: previousState.blockCount || 0,
        fingerprint: (previousState.fingerprint || '').substring(0, 50) + '...'
    });

    const focusResult = await focusPerplexityInput(webContents);
    console.log('[Perplexity] Focus result:', focusResult);

    if (!focusResult?.ready) {
        return { sent: false, error: focusResult?.error || 'No Perplexity input found' };
    }

    const shortcutModifier = getShortcutModifier();
    const expectedMessage = normalizePerplexityText(message);

    await clearFocusedInput(webContents, runtime, shortcutModifier);

    let inputMethod = 'clipboard-paste';
    await typeWithClipboardPaste(webContents, runtime, message, shortcutModifier);

    let composerState = await waitForPerplexityExpectedText(webContents, runtime, expectedMessage, {
        attempts: 12,
        delayMs: 150
    });

    if (normalizePerplexityText(composerState?.text) !== expectedMessage) {
        console.log('[Perplexity] Clipboard paste did not fully land, retrying with native insert...');
        await focusPerplexityInput(webContents);
        await clearFocusedInput(webContents, runtime, shortcutModifier);

        inputMethod = 'native-insertText';
        await typeWithNativeInsert(webContents, message);

        composerState = await waitForPerplexityExpectedText(webContents, runtime, expectedMessage, {
            attempts: 12,
            delayMs: 150
        });
    }

    console.log('[Perplexity] Composer state before submit:', composerState);

    if (normalizePerplexityText(composerState?.text) !== expectedMessage) {
        return {
            sent: false,
            error: 'Perplexity composer text did not stabilize before submit',
            method: inputMethod,
            compose: composerState
        };
    }

    const beforeSubmitState = await getPerplexityState(webContents);
    const clickResult = await clickPerplexitySubmit(webContents);
    const submissionResult = await waitForPerplexitySubmissionStart(
        webContents,
        runtime,
        beforeSubmitState?.url,
        { attempts: 16, delayMs: 180 }
    );

    console.log('[Perplexity] Click result:', clickResult);
    console.log('[Perplexity] Submission result:', submissionResult);

    if (!submissionResult.started) {
        await focusPerplexityInput(webContents);
        await runtime.sleep(100);
        await webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        await webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
        await runtime.sleep(180);
    }

    return {
        sent: true,
        method: inputMethod,
        compose: composerState,
        submit: clickResult,
        postClick: submissionResult.state
    };
};
