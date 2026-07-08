// Proxima — Python Environment Manager.
// Manages creation, caching, and dependency installation for the virtualenv running proxima-agent.

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync, spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';
const MIN_PY_MINOR = 10;

function getAgentSourceDir() {
    const candidates = [];
    if (process.resourcesPath) {
        candidates.push(path.join(process.resourcesPath, 'proxima-agent'));
    }
    candidates.push(path.join(__dirname, '..', 'proxima-agent'));
    candidates.push(path.join(process.cwd(), 'proxima-agent'));
    for (const c of candidates) {
        if (fs.existsSync(path.join(c, 'pyproject.toml'))) return c;
    }
    return null;
}

function getManagedEnvDir() {
    const base = app && app.getPath ? app.getPath('userData') : path.join(os.homedir(), '.proxima-agent');
    return path.join(base, 'py-env');
}

// Locate bundled CPython and offline prebuilt wheelhouses if present.
function _firstExisting(paths) {
    for (const p of paths) {
        try { if (p && fs.existsSync(p)) return p; } catch { }
    }
    return null;
}

function getBundledPythonDir() {
    return _firstExisting([
        process.resourcesPath && path.join(process.resourcesPath, 'python'),
        path.join(__dirname, '..', 'python'),
        path.join(__dirname, '..', 'build', 'offline', 'python'),
    ]);
}

function bundledPythonExe() {
    const dir = getBundledPythonDir();
    if (!dir) return null;
    const names = IS_WIN
        ? ['python.exe', path.join('python', 'python.exe'), path.join('install', 'python.exe')]
        : ['bin/python3', 'bin/python', 'python/bin/python3', 'install/bin/python3'];
    return _firstExisting(names.map((n) => path.join(dir, n)));
}

function getWheelhouseDir() {
    const dir = _firstExisting([
        process.resourcesPath && path.join(process.resourcesPath, 'wheels'),
        path.join(__dirname, '..', 'wheels'),
        path.join(__dirname, '..', 'build', 'offline', 'wheels'),
    ]);
    if (dir) {
        try {
            if (fs.readdirSync(dir).some((f) => f.endsWith('.whl'))) return dir;
        } catch { }
    }
    return null;
}

function venvPythonPath(envDir) {
    return IS_WIN
        ? path.join(envDir, 'Scripts', 'python.exe')
        : path.join(envDir, 'bin', 'python');
}

function _pythonVersion(exe) {
    try {
        const r = spawnSync(exe, ['-c', 'import sys;print(sys.version_info[0],sys.version_info[1])'], {
            encoding: 'utf8', timeout: 2000,
        });
        if (r.status !== 0 || !r.stdout) return null;
        const [maj, min] = r.stdout.trim().split(/\s+/).map(Number);
        return { major: maj, minor: min };
    } catch {
        return null;
    }
}

function findSystemPython() {
    const candidates = [];
    if (IS_WIN) {
        candidates.push(['py', ['-3']]);
        candidates.push(['python', []]);
        candidates.push(['python3', []]);
    } else {
        candidates.push(['python3', []]);
        candidates.push(['python3.12', []]);
        candidates.push(['python3.11', []]);
        candidates.push(['python3.10', []]);
        candidates.push(['python', []]);
    }

    for (const [cmd, prefixArgs] of candidates) {
        try {
            const probe = spawnSync(cmd, [...prefixArgs, '-c', 'import sys;print(sys.executable)'], {
                encoding: 'utf8', timeout: 2000,
            });
            if (probe.status === 0 && probe.stdout) {
                const exe = probe.stdout.trim().split('\n').pop().trim();
                const ver = exe && _pythonVersion(exe);
                if (ver && (ver.major > 3 || (ver.major === 3 && ver.minor >= MIN_PY_MINOR))) {
                    return exe;
                }
            }
        } catch {
        }
    }
    return null;
}

function findBaseInterpreter() {
    const bundled = bundledPythonExe();
    if (bundled) {
        const ver = _pythonVersion(bundled);
        if (ver && (ver.major > 3 || (ver.major === 3 && ver.minor >= MIN_PY_MINOR))) {
            return { exe: bundled, bundled: true };
        }
    }
    const sys = findSystemPython();
    if (sys) return { exe: sys, bundled: false };

    return null;
}

let _state = {
    status: 'unknown',
    pythonPath: null,
    message: '',
};

let _provisioningPromise = null;

// Run a child process asynchronously without blocking the event loop.
function _spawnAsync(cmd, args, { cwd, timeout = 0 } = {}) {
    return new Promise((resolve) => {
        let proc;
        try {
            proc = spawn(cmd, args, { cwd, windowsHide: true, detached: !IS_WIN });
        } catch (e) {
            resolve({ status: -1, stdout: '', stderr: String(e && e.message || e) });
            return;
        }

        let stdout = '';
        let stderr = '';
        let done = false;
        let timer = null;

        const finish = (status, extraErr) => {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            if (extraErr) stderr += (stderr ? '\n' : '') + extraErr;
            resolve({ status, stdout, stderr });
        };

        if (proc.stdout) proc.stdout.on('data', (d) => { stdout += d.toString(); });
        if (proc.stderr) proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('error', (e) => finish(-1, String(e && e.message || e)));
        proc.on('close', (code) => finish(code == null ? -1 : code));

        if (timeout > 0) {
            timer = setTimeout(() => {
                // Kill the entire child process tree to prevent orphan processes.
                try {
                    if (IS_WIN) {
                        spawnSync('taskkill', ['/T', '/F', '/PID', String(proc.pid)], { windowsHide: true });
                    } else {
                        try { process.kill(-proc.pid, 'SIGKILL'); }
                        catch { try { proc.kill('SIGKILL'); } catch { } }
                    }
                } catch { }
                finish(-1, `timed out after ${timeout}ms`);
            }, timeout);
        }
    });
}

function getStatus() {
    return { ..._state };
}

function getReadyInterpreter() {
    const envDir = getManagedEnvDir();
    const py = venvPythonPath(envDir);
    if (!fs.existsSync(py)) return null;
    try {
        const r = spawnSync(py, ['-c', 'import proxima_agent'], { encoding: 'utf8', timeout: 2000 });
        if (r.status === 0) return py;
    } catch { }
    return null;
}

function ensureEnvironmentAsync(onProgress = () => { }) {
    if (_provisioningPromise) return _provisioningPromise;

    const log = (m) => { try { onProgress(m); } catch { } console.log('[PyEnv]', m); };

    _provisioningPromise = (async () => {
        const existing = getReadyInterpreter();
        if (existing) {
            _state = { status: 'ready', pythonPath: existing, message: 'Python environment ready' };
            return { ok: true, pythonPath: existing, status: 'ready' };
        }

        const agentDir = getAgentSourceDir();
        if (!agentDir) {
            _state = { status: 'error', pythonPath: null, message: 'Bundled agent source not found' };
            log(_state.message);
            return { ok: false, pythonPath: null, status: 'error' };
        }

        const sysPython = findBaseInterpreter();
        if (!sysPython) {
            _state = {
                status: 'missing-python',
                pythonPath: null,
                message: 'Python 3.10+ is required but was not found. Please install Python 3.10 or newer from https://www.python.org/downloads/ (on Windows, enable "Add Python to PATH" during install) and restart Proxima.',
            };
            log(_state.message);
            return { ok: false, pythonPath: null, status: 'missing-python' };
        }
        return _provisionWithBase(sysPython.exe, sysPython.bundled, agentDir, log);
    })();

    _provisioningPromise.finally(() => { _provisioningPromise = null; });

    return _provisioningPromise;
}

async function _provisionWithBase(basePython, bundled, agentDir, log) {
    if (bundled) log('Using bundled/standalone Python runtime (no system Python required)');

    const envDir = getManagedEnvDir();
    _state = { status: 'installing', pythonPath: null, message: 'Setting up Python environment…' };

    try {
        const py = venvPythonPath(envDir);
        if (!fs.existsSync(py)) {
            log(`Creating venv at ${envDir}`);
            fs.mkdirSync(path.dirname(envDir), { recursive: true });
            const venv = await _spawnAsync(basePython, ['-m', 'venv', envDir], { timeout: 120000 });
            if (venv.status !== 0) {
                throw new Error(`venv creation failed: ${(venv.stderr || venv.stdout || '').trim()}`);
            }
        }

        const wheelhouse = getWheelhouseDir();
        let install;
        if (wheelhouse) {
            log('Installing proxima-agent from bundled wheels (offline)…');
            install = await _spawnAsync(
                py,
                ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-index', '--find-links', wheelhouse, '.'],
                { cwd: agentDir, timeout: 600000 }
            );
        } else {
            log('Installing proxima-agent and dependencies from PyPI (first run)…');
            await _spawnAsync(
                py,
                ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', 'pip'],
                { timeout: 120000 }
            );
            install = await _spawnAsync(
                py,
                ['-m', 'pip', 'install', '--disable-pip-version-check', '--retries', '5', '.'],
                { cwd: agentDir, timeout: 600000 }
            );
        }
        if (install.status !== 0) {
            throw new Error(
                `pip install failed (${wheelhouse ? 'offline wheels may be incomplete for this OS/arch' : 'check your internet connection'}): ` +
                `${(install.stderr || install.stdout || '').trim().slice(-500)}`
            );
        }

        const verify = await _spawnAsync(py, ['-c', 'import proxima_agent'], { timeout: 15000 });
        if (verify.status !== 0) {
            throw new Error('agent installed but import failed');
        }

        _state = { status: 'ready', pythonPath: py, message: 'Python environment ready' };
        log('Python environment ready');
        return { ok: true, pythonPath: py, status: 'ready' };
    } catch (e) {
        _state = { status: 'error', pythonPath: null, message: String(e.message || e) };
        log(`Setup error: ${_state.message}`);
        return { ok: false, pythonPath: null, status: 'error' };
    }
}

function resolveInterpreter() {
    const ready = getReadyInterpreter();
    if (ready) return ready;

    const agentDir = getAgentSourceDir();
    if (agentDir) {
        const devVenv = IS_WIN
            ? path.join(agentDir, '.venv', 'Scripts', 'python.exe')
            : path.join(agentDir, '.venv', 'bin', 'python');
        if (fs.existsSync(devVenv)) return devVenv;
    }

    const base = findBaseInterpreter();
    return base ? base.exe : null;
}

module.exports = {
    getAgentSourceDir,
    getManagedEnvDir,
    getBundledPythonDir,
    bundledPythonExe,
    getWheelhouseDir,
    findSystemPython,
    findBaseInterpreter,
    getReadyInterpreter,
    ensureEnvironmentAsync,
    resolveInterpreter,
    getStatus,
    MIN_PY_MINOR,
};
