module.exports = async function sendToClaude({ webContents, message, runtime }) {
    const previousState = await runtime.capturePreviousResponse('claude', { force: true });
    const previousFingerprint = previousState.fingerprint || '';

    console.log('[Claude] Captured old response fingerprint:', previousFingerprint.substring(0, 50) + '...');

    await webContents.executeJavaScript(`
        (function() {
            const input = document.querySelector('[contenteditable="true"]') ||
                document.querySelector('div[data-placeholder*="Reply"]');
            if (input) {
                input.focus();
                input.innerHTML = '';
                return true;
            }
            return false;
        })()
    `);

    await runtime.typeIntoPage(webContents, message);
    await runtime.sleep(200);

    await webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    await webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });

    return { sent: true };
};
