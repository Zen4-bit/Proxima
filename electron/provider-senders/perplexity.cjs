const {
    buildComposerScript,
    getShortcutModifier,
    clearFocusedInput,
    typeWithClipboardPaste,
    typeWithNativeInsert,
    submissionLikelyStarted,
    clickAtPoint
} = require('./composer-helpers.cjs');

const PERPLEXITY_COMPOSER_CONFIG = {
    inputSelectors: [
        '#ask-input',
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

async function getPerplexityComposerState(webContents) {
    return webContents.executeJavaScript(buildComposerScript({
        ...PERPLEXITY_COMPOSER_CONFIG,
        action: 'state'
    }));
}

async function waitForPerplexityExpectedText(webContents, runtime, expectedText, options = {}) {
    const attempts = options.attempts || 14;
    const delayMs = options.delayMs || 160;
    const expected = normalizePerplexityText(expectedText);

    let state = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
        state = await getPerplexityComposerState(webContents);
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

    return state || await getPerplexityComposerState(webContents);
}

function perplexitySubmissionStarted(state, previousUrl) {
    if (submissionLikelyStarted(state)) {
        return true;
    }

    return !!(
        previousUrl &&
        state?.url &&
        state.url !== previousUrl
    );
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

    const beforeSubmitState = await getPerplexityComposerState(webContents);

    let clickResult = await webContents.executeJavaScript(buildComposerScript({
        ...PERPLEXITY_COMPOSER_CONFIG,
        action: 'click'
    }));
    await runtime.sleep(200);

    let postClickState = await getPerplexityComposerState(webContents);

    if (!perplexitySubmissionStarted(postClickState, beforeSubmitState?.url) && clickResult?.clickPoint) {
        console.log('[Perplexity] DOM click did not change composer state, retrying with real mouse click...');
        await clickAtPoint(webContents, clickResult.clickPoint);
        await runtime.sleep(200);
        postClickState = await getPerplexityComposerState(webContents);
        clickResult = { ...(clickResult || {}), physicalClick: true };
    }

    console.log('[Perplexity] Click result:', clickResult);
    console.log('[Perplexity] Post-click state:', postClickState);

    if (!perplexitySubmissionStarted(postClickState, beforeSubmitState?.url)) {
        await focusPerplexityInput(webContents);
        await runtime.sleep(100);
        await webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        await webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
        await runtime.sleep(180);
        postClickState = await getPerplexityComposerState(webContents);
    }

    return {
        sent: true,
        method: inputMethod,
        compose: composerState,
        submit: clickResult,
        postClick: postClickState
    };
};
