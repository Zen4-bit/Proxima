// Proxima — Multi-AI Chat guided tour.
//
// Nine steps over the real screen: dim everything, cut a hole around one
// control, and say what it is for. The alternative was a set of recorded
// videos, and a video of a UI is stale the first time a label changes — this
// points at the live element, so it is either correct or visibly broken.
//
// Nothing here mutates a chat. The only state it touches is which options tab
// is open and whether the panel is expanded, both of which the user can see
// happening, and both restored when the tour ends.

const MULTIAI_TOUR_STEPS = [
    {
        title: 'The roster',
        text: 'Everyone who takes part in this chat, one row per seat. The same vendor can appear more than once on different models or efforts — that is how you run "Opus vs Sonnet" as a panel. The checkbox benches a seat without losing how it is set up.',
        target: () => document.querySelector('#multiai-participants table.multiai-roster'),
    },
    {
        title: 'Provider — who answers',
        text: 'The vendor, and only the vendor. Claude Code is not a provider here; it is Claude reached a different way, which is the next column.',
        target: () => multiaiTourCell(2),
    },
    {
        title: 'Route — how they are reached',
        text: 'Your subscription through the browser tab you are already signed in to, your subscription through that vendor’s CLI on this machine, or its API with the key in Settings. Only routes this machine can actually take are listed: a CLI that is not installed is greyed out, and the API route appears only when API mode is on. The CLI route is the only one that can hold workspace tools.',
        target: () => multiaiTourCell(3),
    },
    {
        title: 'Model — and how much to trust the list',
        text: 'Grouped by where each entry came from. <i>answered on this machine</i> has been proved by a real turn; <i>aliases the CLI lists</i> is what the CLI says about itself; <i>full ids · not tried here</i> is a public catalogue and only a candidate. ▷ runs one short turn to settle it, and a model that answers moves to the top group for good. A browser seat has no picker: it answers on whatever its tab is set to.',
        target: () => multiaiTourCell(4),
    },
    {
        title: 'Tools — the one column that touches your disk',
        text: 'CLI seats only, and only once the Workspace tab has a folder attached. <b>read</b> verifies claims against real files; <b>write</b> edits them on the chat’s own branch, committing every turn as a reviewable diff; <b>full</b> also runs any shell command there, with no sandbox. An armed seat is outlined in red on purpose.',
        target: () => multiaiTourCell(6),
    },
    {
        title: 'Building the roster',
        text: '<b>+ add agent…</b> picks who answers — the route is chosen on the row. <b>setups…</b> swaps the whole panel, who is in it and how they talk, and <b>save setup</b> keeps yours. <b>all</b> / <b>none</b> bench everyone; <b>clear all</b> empties the roster. <b>↻</b> re-reads Settings, re-probes the CLIs and refreshes the model lists.',
        target: () => document.querySelector('.multiai-roster-foot'),
    },
    {
        title: 'Independent rounds',
        text: 'A blind round runs everyone at once and shows none of them what the others are saying <i>in that round</i>. Completed rounds stay visible, so round 2 answers round 1. This is on for every round by default: taking turns makes a round lopsided — the first seat answers you, the last answers five peers — and later seats drift toward whoever spoke first.',
        before: () => multiaiSelectOptab('discussion'),
        target: () => document.getElementById('multiai-independent'),
    },
    {
        title: 'Asking',
        text: 'Type and Send: every enabled seat answers. <code>@claude kick off, others react</code> sets the order for that round; <code>only @gemini and @chatgpt</code> restricts it to those two. Naming an order turns round 1 back into turn-taking, because a blind round has no order to set.',
        before: () => multiaiSelectOptab('agents'),
        target: () => document.getElementById('multiai-topic'),
    },
    {
        title: 'After the discussion',
        text: '<b>⚖ Judge</b> asks one provider to read the transcript and rule on it. <b>📝 Summarize</b> pins a state summary that later turns start from instead of the whole history. <b>⬇ .md</b> exports it. Everything here is explained in full under <b>Help</b>, next to Settings.',
        target: () => document.querySelector('button[onclick="multiaiJudge()"]'),
    },
];

// Auto-advance exists for recording: a hands-off run gives every capture the
// same timing, so a GIF can be remade after a UI change without anyone having
// to click through it at the same pace as last time. scripts/record-tour.mjs
// drives the screen recorder around it.
const MULTIAI_TOUR_AUTO_MS = 6000;
let multiaiTourTimer = null;

let multiaiTourAt = 0;
let multiaiTourPrev = null;      // options-panel state to put back
let multiaiTourKeys = null;

function multiaiTourCell(col) {
    // The first row's cell says more than the header, but a chat with no agents
    // has no rows — fall back to the column heading, which is always there.
    const row = document.querySelector('#multiai-participants tbody tr');
    const cell = row && row.children[col];
    if (cell && cell.getBoundingClientRect().width > 0) return cell;
    return document.querySelectorAll('#multiai-participants thead th')[col] || null;
}

function multiaiTourEls() {
    let root = document.getElementById('multiai-tour');
    if (root) return root;
    root = document.createElement('div');
    root.id = 'multiai-tour';
    root.style.cssText = 'position: fixed; inset: 0; z-index: 200; display: none;';
    root.innerHTML = `
        <div id="multiai-tour-hole" style="position: fixed; border-radius: 8px; box-shadow: 0 0 0 9999px rgba(0,0,0,0.66); border: 2px solid #a855f7; pointer-events: none; transition: all .18s ease;"></div>
        <div id="multiai-tour-card" role="dialog" aria-modal="true" aria-labelledby="multiai-tour-title" style="position: fixed; width: min(420px, 90vw); background: #12121c; border: 1px solid rgba(255,255,255,0.14); border-radius: 10px; box-shadow: 0 18px 50px rgba(0,0,0,0.55); padding: 14px 16px; color: #d1d5db; font-size: 0.82rem; line-height: 1.55;">
            <div id="multiai-tour-title" style="font-weight: 700; color: #fff; font-size: 0.92rem; margin-bottom: 6px;"></div>
            <div id="multiai-tour-text"></div>
            <div id="multiai-tour-bar" style="display: none; height: 2px; margin-top: 10px; background: rgba(255,255,255,0.12); border-radius: 2px; overflow: hidden;"><div id="multiai-tour-bar-fill" style="height: 100%; width: 0; background: #a855f7;"></div></div>
            <div style="display: flex; align-items: center; gap: 8px; margin-top: 12px;">
                <span id="multiai-tour-count" style="font-size: 0.72rem; color: #8b8ba0;"></span>
                <span style="flex: 1;"></span>
                <button class="multiai-btn ghost" id="multiai-tour-auto" onclick="multiaiTourAuto()" title="Advance on its own, about six seconds a step — hands-off, so a screen recorder gets the same timing every run">⏵ auto</button>
                <button class="multiai-btn ghost" onclick="multiaiTourEnd()">Close</button>
                <button class="multiai-btn ghost" id="multiai-tour-back" onclick="multiaiTourGo(-1)">Back</button>
                <button class="multiai-btn primary" id="multiai-tour-next" onclick="multiaiTourGo(1)">Next</button>
            </div>
        </div>`;
    // Clicking the dimmed area leaves; the hole itself is pointer-events: none,
    // so the control being described is never swallowed by the overlay.
    root.addEventListener('click', (e) => { if (e.target === root) multiaiTourEnd(); });
    document.body.appendChild(root);
    return root;
}

function multiaiStartTour() {
    if (typeof multiaiCurrentChat === 'function' && !multiaiCurrentChat()) {
        if (typeof showToast === 'function') showToast('Open a chat first — the tour points at the real screen.');
        return;
    }
    const prefs = multiaiUiPrefs();
    multiaiTourPrev = { optab: prefs.optab, expanded: !!prefs.optionsExpanded };
    prefs.optionsExpanded = true;
    multiaiSelectOptab('agents');
    multiaiTourAt = 0;
    multiaiTourEls().style.display = 'block';
    multiaiTourKeys = (e) => {
        if (e.key === 'Escape') multiaiTourEnd();
        else if (e.key === 'ArrowRight' || e.key === 'Enter') multiaiTourGo(1);
        else if (e.key === 'ArrowLeft') multiaiTourGo(-1);
        else return;
        e.preventDefault();
    };
    document.addEventListener('keydown', multiaiTourKeys);
    multiaiTourShow();
}

function multiaiTourAuto() {
    if (multiaiTourTimer) { multiaiTourStopAuto(); return; }
    const btn = document.getElementById('multiai-tour-auto');
    if (btn) btn.textContent = '⏸ stop';
    document.getElementById('multiai-tour-bar').style.display = 'block';
    let t0 = Date.now();
    multiaiTourTimer = setInterval(() => {
        const frac = Math.min(1, (Date.now() - t0) / MULTIAI_TOUR_AUTO_MS);
        const fill = document.getElementById('multiai-tour-bar-fill');
        if (fill) fill.style.width = (frac * 100) + '%';
        if (frac < 1) return;
        t0 = Date.now();
        if (multiaiTourAt === MULTIAI_TOUR_STEPS.length - 1) { multiaiTourEnd(); return; }
        multiaiTourGo(1);
    }, 80);
}

function multiaiTourStopAuto() {
    if (multiaiTourTimer) clearInterval(multiaiTourTimer);
    multiaiTourTimer = null;
    const btn = document.getElementById('multiai-tour-auto');
    if (btn) btn.textContent = '⏵ auto';
    const bar = document.getElementById('multiai-tour-bar');
    if (bar) bar.style.display = 'none';
}

function multiaiTourGo(delta) {
    const next = multiaiTourAt + delta;
    if (next < 0) return;
    if (next >= MULTIAI_TOUR_STEPS.length) { multiaiTourEnd(); return; }
    multiaiTourAt = next;
    multiaiTourShow();
}

function multiaiTourShow() {
    const step = MULTIAI_TOUR_STEPS[multiaiTourAt];
    if (step.before) { try { step.before(); } catch { /* a tab that isn't there in this mode */ } }
    // before() re-renders, so read the target on the next frame.
    requestAnimationFrame(() => {
        const el = (() => { try { return step.target(); } catch { return null; } })();
        if (!el) { multiaiTourGo(1); return; }          // nothing to point at: skip
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        requestAnimationFrame(() => multiaiTourPlace(el, step));
    });
}

function multiaiTourPlace(el, step) {
    const r = el.getBoundingClientRect();
    const pad = 6;
    const hole = document.getElementById('multiai-tour-hole');
    hole.style.left = (r.left - pad) + 'px';
    hole.style.top = (r.top - pad) + 'px';
    hole.style.width = (r.width + pad * 2) + 'px';
    hole.style.height = (r.height + pad * 2) + 'px';

    document.getElementById('multiai-tour-title').textContent = step.title;
    document.getElementById('multiai-tour-text').innerHTML = step.text;
    document.getElementById('multiai-tour-count').textContent = `${multiaiTourAt + 1} / ${MULTIAI_TOUR_STEPS.length}`;
    document.getElementById('multiai-tour-back').disabled = multiaiTourAt === 0;
    document.getElementById('multiai-tour-next').textContent =
        multiaiTourAt === MULTIAI_TOUR_STEPS.length - 1 ? 'Done' : 'Next';

    // Below the target if it fits, above if not, and always inside the window.
    const card = document.getElementById('multiai-tour-card');
    const cr = card.getBoundingClientRect();
    const below = r.bottom + 12;
    const top = (below + cr.height < window.innerHeight - 8) ? below : Math.max(8, r.top - cr.height - 12);
    const left = Math.min(Math.max(8, r.left), window.innerWidth - cr.width - 8);
    card.style.top = top + 'px';
    card.style.left = left + 'px';
}

function multiaiTourEnd() {
    multiaiTourStopAuto();
    const root = document.getElementById('multiai-tour');
    if (root) root.style.display = 'none';
    if (multiaiTourKeys) { document.removeEventListener('keydown', multiaiTourKeys); multiaiTourKeys = null; }
    if (multiaiTourPrev) {
        const prefs = multiaiUiPrefs();
        prefs.optionsExpanded = multiaiTourPrev.expanded;
        if (multiaiTourPrev.optab) prefs.optab = multiaiTourPrev.optab;
        multiaiTourPrev = null;
        multiaiPersist();
        multiaiApplyOptionsState();
    }
}

// Keep the cut-out on the control when the window changes shape under it.
window.addEventListener('resize', () => {
    const root = document.getElementById('multiai-tour');
    if (root && root.style.display === 'block') multiaiTourShow();
});
