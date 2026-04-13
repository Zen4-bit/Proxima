module.exports = async function sendToChatGPT({ webContents, message, runtime }) {
    const previousState = await runtime.capturePreviousResponse('chatgpt', { force: true });
    const previousFingerprint = previousState.fingerprint || '';

    console.log('[ChatGPT] Captured old response fingerprint:', previousFingerprint.substring(0, 50) + '...');

    await webContents.executeJavaScript(`
        (function() {
            const input = document.querySelector('#prompt-textarea') ||
                document.querySelector('textarea[data-id="root"]') ||
                document.querySelector('textarea') ||
                document.querySelector('[contenteditable="true"]');
            if (input) {
                input.focus();
                if (input.value !== undefined) input.value = '';
                return true;
            }
            return false;
        })()
    `);

    await runtime.typeIntoPage(webContents, message);
    await runtime.sleep(300);

    await webContents.executeJavaScript(`
        (function() {
            const input = document.querySelector('#prompt-textarea') ||
                document.querySelector('textarea') ||
                document.querySelector('[contenteditable="true"]');
            if (input) input.focus();
        })()
    `);

    await runtime.sleep(100);

    const clicked = await webContents.executeJavaScript(`
        (function() {
            const button = document.querySelector('[data-testid="send-button"]') ||
                document.querySelector('button[aria-label*="Send"]');
            if (button && !button.disabled) {
                button.click();
                return true;
            }
            return false;
        })()
    `);

    if (!clicked) {
        await webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        await webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    }

    return { sent: true };
};
