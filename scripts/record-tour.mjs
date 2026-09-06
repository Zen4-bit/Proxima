#!/usr/bin/env node
// Record the Multi-AI guided tour as a GIF.
//
// The tour is the documentation; this is for putting a moving picture of it in
// a README or an issue. It records the real window rather than re-staging the
// UI, so the GIF cannot drift from the app the way a hand-made mock-up does,
// and the tour's own "auto" button supplies the timing — press it once and the
// pacing is identical on every re-record, which is what makes a GIF worth
// remaking after a change rather than leaving a stale one up.
//
//   node scripts/record-tour.mjs                     # ~60s, docs/tour/tour.gif
//   node scripts/record-tour.mjs --seconds 90 --fps 10
//   node scripts/record-tour.mjs --out docs/tour/routes.gif --seconds 20
//
// Needs ffmpeg. It is not a dependency of the app and is not installed for you.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = args.indexOf('--' + name);
    return i === -1 ? fallback : args[i + 1];
};

const SECONDS = Number(flag('seconds', 60));
const FPS = Number(flag('fps', 8));
const WIDTH = Number(flag('width', 1280));
const OUT = path.resolve(ROOT, flag('out', 'docs/tour/tour.gif'));
const TITLE = flag('title', 'Proxima');
const LEAD_IN = Number(flag('lead-in', 6));

// ---- ffmpeg ---------------------------------------------------------------
// Not on PATH is the normal case on Windows, where every installer drops it
// somewhere different, so look before giving up.
function findFfmpeg() {
    const candidates = ['ffmpeg'];
    if (process.platform === 'win32') {
        const local = process.env.LOCALAPPDATA || '';
        candidates.push(
            path.join(local, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
            'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe',
            path.join(os.homedir(), 'scoop', 'shims', 'ffmpeg.exe'),
            'C:\\ffmpeg\\bin\\ffmpeg.exe',
        );
    }
    for (const c of candidates) {
        const r = spawnSync(c, ['-version'], { stdio: 'ignore' });
        if (!r.error && r.status === 0) return c;
    }
    return null;
}

const FFMPEG = findFfmpeg();
if (!FFMPEG) {
    console.error(`ffmpeg not found.

  Windows   winget install Gyan.FFmpeg     (or: choco install ffmpeg / scoop install ffmpeg)
  macOS     brew install ffmpeg
  Linux     apt install ffmpeg

Then run this again. It is only needed to record; the tour itself needs nothing.`);
    process.exit(1);
}

// ---- what to capture ------------------------------------------------------
function captureInput() {
    if (process.platform === 'win32') return ['-f', 'gdigrab', '-framerate', String(FPS), '-i', `title=${TITLE}`];
    if (process.platform === 'darwin') return ['-f', 'avfoundation', '-framerate', String(FPS), '-i', '1'];   // whole screen
    return ['-f', 'x11grab', '-framerate', String(FPS), '-i', process.env.DISPLAY || ':0.0'];
}

function run(bin, argv) {
    return new Promise((resolve, reject) => {
        const p = spawn(bin, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        p.stderr.on('data', d => { err += d; });
        p.on('error', reject);
        p.on('close', code => (code === 0 ? resolve() : reject(new Error(err.split('\n').slice(-12).join('\n')))));
    });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- go -------------------------------------------------------------------
console.log(`
Recording the Proxima window for ${SECONDS}s at ${FPS} fps.

  1. Bring Proxima to the front and open a chat that has some agents in it.
  2. Help (next to Settings) -> Take the tour.
  3. Press "auto" on the tour card.

${process.platform === 'darwin' ? 'macOS captures the whole screen; crop afterwards if you need only the window.\n' : ''}Starting in ${LEAD_IN}s.`);

for (let i = LEAD_IN; i > 0; i--) {
    process.stdout.write(`\r  ${i}... `);
    await sleep(1000);
}
process.stdout.write('\r  recording\n');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const raw = path.join(os.tmpdir(), `proxima-tour-${Date.now()}.mp4`);
const palette = path.join(os.tmpdir(), `proxima-tour-${Date.now()}.png`);

try {
    await run(FFMPEG, [...captureInput(), '-t', String(SECONDS), '-pix_fmt', 'yuv420p', '-y', raw]);
    console.log('  captured, converting');

    // Two passes: a palette from the whole clip, then the GIF against it.
    // One pass gives a 256-colour guess per frame and the dark UI bands badly.
    const scale = `fps=${FPS},scale=${WIDTH}:-1:flags=lanczos`;
    await run(FFMPEG, ['-i', raw, '-vf', `${scale},palettegen=stats_mode=diff`, '-y', palette]);
    await run(FFMPEG, ['-i', raw, '-i', palette, '-lavfi', `${scale}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`, '-y', OUT]);

    const mb = (fs.statSync(OUT).size / 1e6).toFixed(1);
    console.log(`\n  ${path.relative(ROOT, OUT)}  ${mb} MB`);
    if (Number(mb) > 8) console.log('  (large for a README — try --fps 6 --width 1000, or record fewer steps with --seconds)');
} catch (e) {
    console.error('\nffmpeg failed:\n' + e.message);
    if (process.platform === 'win32') {
        console.error(`\nOn Windows gdigrab matches the window title exactly. If Proxima's title bar
reads something else, pass it: --title "<what the title bar says>".`);
    }
    process.exit(1);
} finally {
    for (const f of [raw, palette]) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
}
