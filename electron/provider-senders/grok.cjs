module.exports = async function sendToGrok({ webContents, message, runtime }) {
    const previousState = await runtime.capturePreviousResponse('grok', { force: true });
    const previousFingerprint = previousState.fingerprint || '';

    console.log('[Grok] Captured old response fingerprint:', previousFingerprint.substring(0, 50) + '...');

    const prepared = await webContents.executeJavaScript(`
        (async function() {
            const editor = document.querySelector('.ProseMirror[contenteditable="true"]') ||
                document.querySelector('[contenteditable="true"]');
            const form = editor?.closest('form');

            if (!editor || !form) {
                return { ready: false, error: 'No Grok editor found' };
            }

            editor.focus();

            const selection = window.getSelection();
            if (selection) {
                selection.removeAllRanges();
                const range = document.createRange();
                range.selectNodeContents(editor);
                range.collapse(true);
                selection.addRange(range);
            }

            try {
                document.execCommand('selectAll', false, null);
                document.execCommand('delete', false, null);
            } catch (error) {}

            editor.innerHTML = '';

            let inserted = false;
            try {
                inserted = document.execCommand('insertText', false, ${JSON.stringify(message)});
            } catch (error) {}

            if (!inserted) {
                const paragraph = document.createElement('p');
                paragraph.textContent = ${JSON.stringify(message)};
                editor.appendChild(paragraph);
            }

            editor.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                inputType: 'insertText',
                data: ${JSON.stringify(message)}
            }));
            editor.dispatchEvent(new Event('change', { bubbles: true }));

            await new Promise((resolve) => setTimeout(resolve, 250));

            const submitButton = form.querySelector('button[type="submit"][aria-label="Submit"]') ||
                form.querySelector('button[type="submit"]');

            return {
                ready: true,
                submitPresent: !!submitButton,
                submitDisabled: !!submitButton && (submitButton.disabled || submitButton.hasAttribute('disabled'))
            };
        })()
    `);

    if (!prepared?.ready) {
        return { sent: false, error: prepared?.error || 'Failed to prepare Grok input' };
    }

    await runtime.sleep(100);

    const clickResult = await webContents.executeJavaScript(`
        (function() {
            const isVisible = (element) => {
                if (!element) return false;
                const style = window.getComputedStyle(element);
                return style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    (element.offsetWidth > 0 || element.offsetHeight > 0 || element.getClientRects().length > 0);
            };

            const editor = document.querySelector('.ProseMirror[contenteditable="true"]') ||
                document.querySelector('[contenteditable="true"]');
            const form = editor?.closest('form');
            const submitButton = form?.querySelector('button[type="submit"][aria-label="Submit"]') ||
                form?.querySelector('button[type="submit"]');

            if (!submitButton) {
                return { clicked: false, reason: 'No submit button found' };
            }

            if (submitButton.disabled || submitButton.hasAttribute('disabled')) {
                return { clicked: false, reason: 'Submit button disabled' };
            }

            if (!isVisible(submitButton)) {
                return { clicked: false, reason: 'Submit button not visible' };
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
