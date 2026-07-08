// Proxima — CLI Install/Uninstall IPC Handlers.
// Manages installation, uninstallation, and configuration of the command-line interface shim on the system.

const { ipcMain, app } = require('electron');
const fs = require('fs');
const path = require('path');

function registerCLIHandlers(deps) {

ipcMain.handle('install-cli', async () => {
    try {
        const { exec } = require('child_process');
        const os = require('os');

        const asarPath = path.join(app.getAppPath() + '.unpacked', 'cli', 'proxima-cli.cjs');
        const devPath = path.join(app.getAppPath(), 'cli', 'proxima-cli.cjs');
        const cliSource = fs.existsSync(asarPath) ? asarPath : devPath;

        const nodeRunner = process.execPath;
        const platform = os.platform();

        if (platform === 'win32') {
            const binDir = path.join(app.getPath('userData'), 'bin');
            fs.mkdirSync(binDir, { recursive: true });

            fs.writeFileSync(
                path.join(binDir, 'proxima.cmd'),
                `@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${nodeRunner}" "${cliSource}" %*\r\n`
            );

            // Pass binDir via env var to prevent PowerShell command injection.
            const ps = "$d=$env:PROXIMA_BIN_DIR;$p=[Environment]::GetEnvironmentVariable('Path','User');if($p -notlike \"*$d*\"){[Environment]::SetEnvironmentVariable('Path',$p+';'+$d,'User')}";
            const pathErr = await new Promise((resolve) => {
                exec(`powershell -NoProfile -Command "${ps}"`,
                    { windowsHide: true, env: { ...process.env, PROXIMA_BIN_DIR: binDir } },
                    (err) => resolve(err || null));
            });

            if (pathErr) {
                return {
                    success: true,
                    path: binDir,
                    note: `CLI wrapper created, but updating PATH failed (${pathErr.message}). Add "${binDir}" to your PATH manually, then restart your terminal.`
                };
            }

            return { success: true, path: binDir };
        } else {
            const binDir = path.join(app.getPath('userData'), 'bin');
            fs.mkdirSync(binDir, { recursive: true });

            const shPath = path.join(binDir, 'proxima');
            fs.writeFileSync(shPath, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${nodeRunner}" "${cliSource}" "$@"\n`);
            fs.chmodSync(shPath, '755');

            const symlinkTarget = '/usr/local/bin/proxima';
            try {
                if (fs.existsSync(symlinkTarget)) fs.unlinkSync(symlinkTarget);
                fs.symlinkSync(shPath, symlinkTarget);
                return { success: true, path: symlinkTarget };
            } catch (e) {
                const homeDir = os.homedir();
                const shellRC = platform === 'darwin'
                    ? path.join(homeDir, '.zshrc')
                    : path.join(homeDir, '.bashrc');

                const exportLine = `export PATH="${binDir}:$PATH" # Proxima CLI`;
                try {
                    const rcContent = fs.existsSync(shellRC) ? fs.readFileSync(shellRC, 'utf-8') : '';
                    if (!rcContent.includes('# Proxima CLI')) {
                        fs.appendFileSync(shellRC, `\n${exportLine}\n`);
                    }
                } catch (e2) { }

                return { success: true, path: binDir, note: `Added to ${path.basename(shellRC)}. Restart terminal to use.` };
            }
        }
    } catch (err) {
        console.error('[CLI Install]', err.message);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('is-cli-installed', () => {
    const os = require('os');
    const binDir = path.join(app.getPath('userData'), 'bin');

    if (os.platform() === 'win32') {
        return fs.existsSync(path.join(binDir, 'proxima.cmd'));
    } else {
        return fs.existsSync(path.join(binDir, 'proxima')) || fs.existsSync('/usr/local/bin/proxima');
    }
});

ipcMain.handle('uninstall-cli', async () => {
    try {
        const { exec } = require('child_process');
        const os = require('os');
        const binDir = path.join(app.getPath('userData'), 'bin');

        if (os.platform() === 'win32') {
            const cmdPath = path.join(binDir, 'proxima.cmd');
            if (fs.existsSync(cmdPath)) fs.unlinkSync(cmdPath);

            // Pass binDir via env var to prevent PowerShell command injection.
            const ps = "$d=$env:PROXIMA_BIN_DIR;$p=[Environment]::GetEnvironmentVariable('Path','User');$p=($p -split ';'|Where-Object{$_ -ne $d})-join';';[Environment]::SetEnvironmentVariable('Path',$p,'User')";
            await new Promise((resolve) => {
                exec(`powershell -NoProfile -Command "${ps}"`,
                    { windowsHide: true, env: { ...process.env, PROXIMA_BIN_DIR: binDir } },
                    () => resolve());
            });
        } else {
            const shPath = path.join(binDir, 'proxima');
            if (fs.existsSync(shPath)) fs.unlinkSync(shPath);
            try { if (fs.existsSync('/usr/local/bin/proxima')) fs.unlinkSync('/usr/local/bin/proxima'); } catch (e) { }

            const homeDir = os.homedir();
            const shellRC = os.platform() === 'darwin'
                ? path.join(homeDir, '.zshrc')
                : path.join(homeDir, '.bashrc');
            try {
                if (fs.existsSync(shellRC)) {
                    let content = fs.readFileSync(shellRC, 'utf-8');
                    content = content.replace(/\nexport PATH="[^"]*" # Proxima CLI\n/g, '\n');
                    fs.writeFileSync(shellRC, content);
                }
            } catch (e) { }
        }

        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

}

module.exports = { registerCLIHandlers };
