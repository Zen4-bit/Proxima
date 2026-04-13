const {
    buildComposerScript,
    getShortcutModifier,
    clearFocusedInput,
    typeWithNativeInsert,
    typeWithClipboardPaste,
    waitForComposerReady,
    submissionLikelyStarted,
    clickAtPoint
} = require('./composer-helpers.cjs');

const GEMINI_COMPOSER_CONFIG = {
    inputSelectors: [
        'rich-textarea .ql-editor',
        '.ql-editor[role="textbox"]',
        'rich-textarea [contenteditable="true"]',
        '[contenteditable="true"][role="textbox"]',
        '[contenteditable="true"][data-placeholder]',
        'textarea',
        'input[type="text"]'
    ],
    buttonSelectors: [
        'button.send-button',
        'button.submit',
        'button[type="submit"]',
        'button[class*="send-button"]',
        'button[class*="submit"]'
    ],
    buttonClassHints: ['send-button', 'submit', 'has-input'],
    buttonTestIdHints: ['send', 'submit'],
    notFoundMessage: 'No Gemini input found',
    noButtonMessage: 'No Gemini send button found'
};

async function focusGeminiInput(webContents) {
    return webContents.executeJavaScript(buildComposerScript({
        ...GEMINI_COMPOSER_CONFIG,
        action: 'focus'
    }));
}

async function getGeminiComposerState(webContents) {
    return webContents.executeJavaScript(buildComposerScript({
        ...GEMINI_COMPOSER_CONFIG,
        action: 'state'
    }));
}

module.exports = async function sendToGemini({ webContents, message, runtime }) {
    console.log('[Gemini] Sending message...');

    const previousState = await runtime.capturePreviousResponse('gemini', { force: true });
    const previousFingerprint = previousState.fingerprint || '';
    const shortcutModifier = getShortcutModifier();

    console.log('[Gemini] Captured old response fingerprint:', previousFingerprint.substring(0, 50) + '...');

    const focusResult = await focusGeminiInput(webContents);
    console.log('[Gemini] Focus result:', focusResult);

    if (!focusResult?.ready) {
        return { sent: false, error: focusResult?.error || 'No Gemini input found' };
    }

    await clearFocusedInput(webContents, runtime, shortcutModifier);

    let inputMethod = 'native-insertText';
    await typeWithNativeInsert(webContents, message);

    let composerState = await waitForComposerReady(
        () => getGeminiComposerState(webContents),
        runtime,
        { attempts: 14, delayMs: 150 }
    );
    console.log('[Gemini] Composer state after native insert:', composerState);

    if (!composerState.sendButtonFound || composerState.sendButtonDisabled || !composerState.sendButtonVisible) {
        console.log('[Gemini] Native insert did not enable send button, retrying with clipboard paste...');

        await focusGeminiInput(webContents);
        await clearFocusedInput(webContents, runtime, shortcutModifier);

        const typeResult = await typeWithClipboardPaste(webContents, runtime, message, shortcutModifier);
        inputMethod = typeResult.method;

        composerState = await waitForComposerReady(
            () => getGeminiComposerState(webContents),
            runtime,
            { attempts: 14, delayMs: 150 }
        );
        console.log('[Gemini] Composer state after clipboard paste:', composerState);
    }

    let clickResult = await webContents.executeJavaScript(buildComposerScript({
        ...GEMINI_COMPOSER_CONFIG,
        action: 'click'
    }));
    await runtime.sleep(180);

    let postClickState = await getGeminiComposerState(webContents);

    if (!submissionLikelyStarted(postClickState) && clickResult?.clickPoint) {
        console.log('[Gemini] DOM click did not change composer state, retrying with real mouse click...');
        await clickAtPoint(webContents, clickResult.clickPoint);
        await runtime.sleep(180);
        postClickState = await getGeminiComposerState(webContents);
        clickResult = { ...(clickResult || {}), physicalClick: true };
    }

    console.log('[Gemini] Click result:', clickResult);
    console.log('[Gemini] Post-click state:', postClickState);

    if (!submissionLikelyStarted(postClickState)) {
        await focusGeminiInput(webContents);
        await runtime.sleep(100);
        await webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        await webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
        await runtime.sleep(120);
        postClickState = await getGeminiComposerState(webContents);
    }

    return {
        sent: true,
        method: inputMethod,
        compose: composerState,
        submit: clickResult || { clicked: false, reason: 'Used Enter fallback' },
        postClick: postClickState
    };
};
