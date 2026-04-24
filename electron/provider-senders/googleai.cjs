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

const GOOGLE_AI_COMPOSER_CONFIG = {
    inputSelectors: [
        'textarea.ITIRGe',
        '[data-active="input-plate-active"] textarea',
        '[data-xid="aim-zero-state-input-plate"] textarea',
        '.Txyg0d textarea',
        'textarea[maxlength="8192"]',
        'textarea'
    ],
    buttonSelectors: [
        'button[data-xid="input-plate-send-button"]',
        'button.uMMzHc.OEueve',
        '.tcA7pd button'
    ],
    buttonClassHints: ['oeueve', 'tcA7pd'],
    buttonTestIdHints: [],
    notFoundMessage: 'No Google AI input found',
    noButtonMessage: 'No Google AI send button found'
};

async function focusGoogleAIInput(webContents) {
    return webContents.executeJavaScript(buildComposerScript({
        ...GOOGLE_AI_COMPOSER_CONFIG,
        action: 'focus'
    }));
}

async function getGoogleAIComposerState(webContents) {
    return webContents.executeJavaScript(buildComposerScript({
        ...GOOGLE_AI_COMPOSER_CONFIG,
        action: 'state'
    }));
}

module.exports = async function sendToGoogleAI({ webContents, message, runtime }) {
    console.log('[GoogleAI] Sending message...');

    const previousState = await runtime.capturePreviousResponse('googleai', { force: true });
    const previousFingerprint = previousState.fingerprint || '';
    const shortcutModifier = getShortcutModifier();

    console.log('[GoogleAI] Captured old response fingerprint:', previousFingerprint.substring(0, 50) + '...');

    const focusResult = await focusGoogleAIInput(webContents);
    console.log('[GoogleAI] Focus result:', focusResult);

    if (!focusResult?.ready) {
        return { sent: false, error: focusResult?.error || 'No Google AI input found' };
    }

    await clearFocusedInput(webContents, runtime, shortcutModifier);

    let inputMethod = 'native-insertText';
    await typeWithNativeInsert(webContents, message);

    let composerState = await waitForComposerReady(
        () => getGoogleAIComposerState(webContents),
        runtime,
        { attempts: 14, delayMs: 150 }
    );
    console.log('[GoogleAI] Composer state after native insert:', composerState);

    if (!composerState.sendButtonFound || composerState.sendButtonDisabled || !composerState.sendButtonVisible) {
        console.log('[GoogleAI] Native insert did not enable send button, retrying with clipboard paste...');

        await focusGoogleAIInput(webContents);
        await clearFocusedInput(webContents, runtime, shortcutModifier);

        const typeResult = await typeWithClipboardPaste(webContents, runtime, message, shortcutModifier);
        inputMethod = typeResult.method;

        composerState = await waitForComposerReady(
            () => getGoogleAIComposerState(webContents),
            runtime,
            { attempts: 14, delayMs: 150 }
        );
        console.log('[GoogleAI] Composer state after clipboard paste:', composerState);
    }

    let clickResult = await webContents.executeJavaScript(buildComposerScript({
        ...GOOGLE_AI_COMPOSER_CONFIG,
        action: 'click'
    }));
    await runtime.sleep(180);

    let postClickState = await getGoogleAIComposerState(webContents);

    if (!submissionLikelyStarted(postClickState) && clickResult?.clickPoint) {
        console.log('[GoogleAI] DOM click did not change composer state, retrying with real mouse click...');
        await clickAtPoint(webContents, clickResult.clickPoint);
        await runtime.sleep(180);
        postClickState = await getGoogleAIComposerState(webContents);
        clickResult = { ...(clickResult || {}), physicalClick: true };
    }

    console.log('[GoogleAI] Click result:', clickResult);
    console.log('[GoogleAI] Post-click state:', postClickState);

    if (!submissionLikelyStarted(postClickState)) {
        await focusGoogleAIInput(webContents);
        await runtime.sleep(100);
        await webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        await webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
        await runtime.sleep(120);
        postClickState = await getGoogleAIComposerState(webContents);
    }

    return {
        sent: true,
        method: inputMethod,
        compose: composerState,
        submit: clickResult || { clicked: false, reason: 'Used Enter fallback' },
        postClick: postClickState
    };
};
