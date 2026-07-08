// Proxima — Runtime environment validation.
// Detects required and optional native dependencies (Python, Chrome, OCR, Linux window managers).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_LINUX = !IS_WIN && !IS_MAC;

function _exists(p) {
    try { return fs.existsSync(p); } catch { return false; }
}

// Locate a command on PATH using async spawn to avoid blocking the main thread.
function _which(cmd) {
    const finder = IS_WIN ? 'where' : 'which';
    return new Promise((resolve) => {
        let proc;
        try {
            proc = spawn(finder, [cmd], { windowsHide: true });
        } catch {
            resolve(null);
            return;
        }
        let out = '';
        let done = false;
        const finish = (val) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(val);
        };
        const timer = setTimeout(() => {
            try { proc.kill(); } catch { /* ignore */ }
            finish(null);
        }, 1000);
        if (proc.stdout) proc.stdout.on('data', (d) => { out += d.toString(); });
        proc.on('error', () => finish(null));
        proc.on('close', (code) => {
            if (code === 0 && out.trim()) finish(out.trim().split('\n')[0].trim());
            else finish(null);
        });
    });
}

async function checkChrome() {
    const winPaths = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    ];
    const macPaths = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
    const linuxCmds = ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium'];

    let found = null;
    if (IS_WIN) {
        found = winPaths.find(_exists) || await _which('chrome');
    } else if (IS_MAC) {
        found = macPaths.find(_exists);
    } else {
        for (const c of linuxCmds) { const p = await _which(c); if (p) { found = p; break; } }
    }
    return {
        name: 'Google Chrome',
        required: true,
        present: !!found,
        path: found || null,
        feature: 'Browser automation (CDP)',
        installHint: IS_MAC
            ? 'Download from https://google.com/chrome'
            : IS_LINUX
                ? 'Install via your package manager, e.g. apt install chromium-browser'
                : 'Download from https://google.com/chrome',
    };
}

async function checkTesseract() {
    const winPaths = [
        'C:\\Program Files\\Tesseract-OCR\\tesseract.exe',
        'C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Programs\\Tesseract-OCR\\tesseract.exe'),
    ];
    let found = IS_WIN ? (winPaths.find(_exists) || await _which('tesseract')) : await _which('tesseract');
    return {
        name: 'Tesseract OCR',
        required: false,
        present: !!found,
        path: found || null,
        feature: 'Screen text reading (OCR)',
        installHint: IS_MAC
            ? 'brew install tesseract'
            : IS_LINUX
                ? 'sudo apt install tesseract-ocr'
                : 'https://github.com/tesseract-ocr/tesseract/releases (note: macOS native OCR is also used as fallback)',
    };
}

async function checkLinuxDesktopTools() {
    const [xdotool, wmctrl] = await Promise.all([_which('xdotool'), _which('wmctrl')]);
    const present = !!(xdotool && wmctrl);
    return {
        name: 'xdotool + wmctrl',
        required: false,
        present,
        path: [xdotool, wmctrl].filter(Boolean).join(', ') || null,
        feature: 'Desktop window control (Linux)',
        installHint: 'sudo apt install xdotool wmctrl',
    };
}

async function runChecks(pythonStatus = null) {
    const checks = [];

    if (pythonStatus) {
        checks.push({
            name: 'Python 3.10+',
            required: true,
            present: pythonStatus.status === 'ready',
            path: pythonStatus.pythonPath || null,
            feature: 'AI agent (CLI, Web UI, computer-use tools)',
            installHint: 'Install Python 3.10+ from https://python.org and restart Proxima.',
            detail: pythonStatus.message || '',
        });
    }

    const probes = [checkChrome(), checkTesseract()];
    if (IS_LINUX) probes.push(checkLinuxDesktopTools());
    checks.push(...await Promise.all(probes));

    const blocking = checks.filter(c => c.required && !c.present);

    return {
        ok: blocking.length === 0,
        platform: process.platform,
        checks,
        blocking,
    };
}

module.exports = { runChecks, checkChrome, checkTesseract, checkLinuxDesktopTools };
