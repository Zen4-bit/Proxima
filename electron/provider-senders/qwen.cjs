module.exports = async function sendToQwen({ webContents, message, runtime }) {
    const previousState = await runtime.capturePreviousResponse('qwen', { force: true });
    const previousFingerprint = previousState.fingerprint || '';

    console.log('[Qwen] Captured old response fingerprint:', previousFingerprint.substring(0, 50) + '...');

    const prepared = await webContents.executeJavaScript(`
        (function() {
            const textarea = document.querySelector('textarea.message-input-textarea') ||
                document.querySelector('textarea[placeholder*="help you today"]') ||
                document.querySelector('textarea');

            if (!textarea) {
                return { ready: false, error: 'No Qwen textarea found' };
            }

            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
            if (!setter) {
                return { ready: false, error: 'Textarea value setter unavailable' };
            }

            textarea.focus();
            setter.call(textarea, '');
            textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                inputType: 'deleteContentBackward',
                data: null
            }));

            setter.call(textarea, ${JSON.stringify(message)});
            textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                inputType: 'insertText',
                data: ${JSON.stringify(message)}
            }));
            textarea.dispatchEvent(new Event('change', { bubbles: true }));

            return { ready: true };
        })()
    `);

    if (!prepared?.ready) {
        return { sent: false, error: prepared?.error || 'Failed to prepare Qwen input' };
    }

    await runtime.sleep(250);

    const clickResult = await webContents.executeJavaScript(`
        (function() {
            const isVisible = (element) => {
                if (!element) return false;
                const style = window.getComputedStyle(element);
                return style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    (element.offsetWidth > 0 || element.offsetHeight > 0 || element.getClientRects().length > 0);
            };

            const sendButton = document.querySelector('button.send-button') ||
                document.querySelector('button[class*="send-button"]');

            if (!sendButton) {
                return { clicked: false, reason: 'No send button found' };
            }

            const ariaDisabled = sendButton.getAttribute('aria-disabled');
            const className = String(sendButton.className || '');
            const disabled = !!sendButton.disabled || sendButton.hasAttribute('disabled') || ariaDisabled === 'true' || className.includes('disabled');

            if (disabled || !isVisible(sendButton)) {
                return {
                    clicked: false,
                    reason: disabled ? 'Send button disabled' : 'Send button not visible'
                };
            }

            sendButton.click();
            return { clicked: true };
        })()
    `);

    if (!clickResult?.clicked) {
        await webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        await webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    }

    return { sent: true };
};
