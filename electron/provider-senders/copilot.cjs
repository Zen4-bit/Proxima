module.exports = async function sendToCopilot({ webContents, message, runtime }) {
    const previousState = await runtime.capturePreviousResponse('copilot', { force: true });
    const previousFingerprint = previousState.fingerprint || '';

    console.log('[Copilot] Captured old response fingerprint:', previousFingerprint.substring(0, 50) + '...');

    const prepared = await webContents.executeJavaScript(`
        (function() {
            const textarea = document.querySelector('textarea[data-testid="composer-input"]') ||
                document.querySelector('textarea[placeholder*="Copilot"]') ||
                document.querySelector('textarea');

            if (!textarea) {
                return { ready: false, error: 'No Copilot textarea found' };
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
        return { sent: false, error: prepared?.error || 'Failed to prepare Copilot input' };
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

            const submitButton = document.querySelector('button[data-testid="submit-button"]') ||
                document.querySelector('button[aria-label="Submit message"]') ||
                document.querySelector('button[aria-label*="Submit"]');

            if (!submitButton) {
                return { clicked: false, reason: 'No submit button found' };
            }

            const ariaDisabled = submitButton.getAttribute('aria-disabled');
            const disabled = !!submitButton.disabled || submitButton.hasAttribute('disabled') || ariaDisabled === 'true';

            if (disabled || !isVisible(submitButton)) {
                return {
                    clicked: false,
                    reason: disabled ? 'Submit button disabled' : 'Submit button not visible'
                };
            }

            submitButton.click();
            return { clicked: true };
        })()
    `);

    if (!clickResult?.clicked) {
        await webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        await webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    }

    return { sent: true };
};
