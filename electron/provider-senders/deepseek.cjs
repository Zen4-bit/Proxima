module.exports = async function sendToDeepSeek({ webContents, message, runtime }) {
    const previousState = await runtime.capturePreviousResponse('deepseek', { force: true });
    const previousFingerprint = previousState.fingerprint || '';

    console.log('[DeepSeek] Captured old response fingerprint:', previousFingerprint.substring(0, 50) + '...');

    const prepared = await webContents.executeJavaScript(`
        (function() {
            const textarea = document.querySelector('textarea[placeholder*="DeepSeek"]') ||
                document.querySelector('textarea[name="search"]') ||
                document.querySelector('textarea');

            if (!textarea) {
                return { ready: false, error: 'No DeepSeek textarea found' };
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
        return { sent: false, error: prepared?.error || 'Failed to prepare DeepSeek input' };
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

            const textarea = document.querySelector('textarea[placeholder*="DeepSeek"]') ||
                document.querySelector('textarea[name="search"]') ||
                document.querySelector('textarea');

            const composerRoot = textarea?.parentElement?.parentElement;
            if (!composerRoot) {
                return { clicked: false, reason: 'Composer root not found' };
            }

            const controls = Array.from(composerRoot.querySelectorAll('[role="button"], button'))
                .filter(isVisible);

            if (controls.length === 0) {
                return { clicked: false, reason: 'No composer controls found' };
            }

            const sendButton = controls[controls.length - 1];
            const ariaDisabled = sendButton.getAttribute('aria-disabled');
            const className = String(sendButton.className || '');

            if (ariaDisabled === 'true' || className.includes('disabled')) {
                return {
                    clicked: false,
                    reason: 'Send button disabled',
                    ariaDisabled,
                    className
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
