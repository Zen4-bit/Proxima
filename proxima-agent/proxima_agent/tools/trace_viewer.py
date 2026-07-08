"""Proxima — Trace Viewer.
Generates an interactive HTML timeline from execution replay logs.
"""
from __future__ import annotations

import html
import os
import time
import webbrowser
from pathlib import Path
from typing import Optional

from proxima_agent.tools.replay import ExecutionRecorder, ReplayEntry, recorder


def generate_trace(
    source: Optional[ExecutionRecorder] = None,
    output_path: Optional[str] = None,
    open_browser: bool = True,
) -> str:
    """Generates an HTML trace viewer file from replay data."""
    rec = source or recorder
    entries = rec.last(10000)
    summary = rec.summary()

    if output_path is None:
        base = os.environ.get("PROXIMA_DATA_DIR") or os.path.join(
            os.path.expanduser("~"), ".proxima-agent"
        )
        os.makedirs(base, exist_ok=True)
        ts = time.strftime("%Y%m%d_%H%M%S")
        output_path = os.path.join(base, f"trace_{ts}.html")

    turns: dict[int, list[ReplayEntry]] = {}
    for entry in entries:
        turn = entry.turn_index
        if turn not in turns:
            turns[turn] = []
        turns[turn].append(entry)

    max_dur = max((e.duration_ms for e in entries), default=1) or 1

    html_content = _build_html(turns, summary, max_dur)

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(html_content)

    if open_browser:
        try:
            webbrowser.open(Path(output_path).resolve().as_uri())
        except Exception:
            pass

    return output_path


def _build_html(turns: dict[int, list[ReplayEntry]],
                summary: dict, max_dur: float) -> str:
    """Generates the HTML content string for the trace viewer."""
    total = summary.get("total", 0)
    failures = summary.get("failures", 0)
    total_ms = summary.get("total_ms", 0)
    fail_rate = (failures / total * 100) if total > 0 else 0

    turns_html = []
    for turn_idx in sorted(turns.keys()):
        entries = turns[turn_idx]
        turn_fails = sum(1 for e in entries if not e.succeeded)
        turn_total_ms = sum(e.duration_ms for e in entries)

        entries_html = []
        for e in entries:
            bar_width = min(100, (e.duration_ms / max_dur) * 100) if max_dur > 0 else 0
            status_class = "success" if e.succeeded else "failure"
            error_html = ""
            if not e.succeeded:
                error_html = f"""
                <div class="error-detail">
                    <span class="error-label">Error:</span> {html.escape(e.error[:150])}
                </div>"""

            result_html = ""
            if e.result_preview and e.succeeded:
                result_html = f"""
                <div class="result-preview">{html.escape(e.result_preview[:100])}</div>"""

            entries_html.append(f"""
            <div class="entry {status_class}">
                <div class="entry-header">
                    <span class="tool-name">{html.escape(e.tool)}</span>
                    <span class="args">{html.escape(e.args_summary[:80])}</span>
                    <span class="duration">{e.duration_ms:.0f}ms</span>
                </div>
                <div class="duration-bar">
                    <div class="bar-fill {status_class}" style="width: {bar_width:.1f}%"></div>
                </div>
                {error_html}
                {result_html}
            </div>""")

        turn_status = "turn-clean" if turn_fails == 0 else "turn-dirty"
        turns_html.append(f"""
        <div class="turn {turn_status}">
            <div class="turn-header" onclick="this.parentElement.classList.toggle('collapsed')">
                <span class="turn-label">Turn {turn_idx}</span>
                <span class="turn-stats">
                    {len(entries)} calls &middot;
                    {turn_fails} failures &middot;
                    {turn_total_ms:.0f}ms
                </span>
                <span class="chevron">&#9660;</span>
            </div>
            <div class="turn-body">
                {"".join(entries_html)}
            </div>
        </div>""")

    timestamp = time.strftime("%Y-%m-%d %H:%M:%S")

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Proxima Execution Trace</title>
<style>
:root {{
    --bg: #0d1117;
    --surface: #161b22;
    --border: #30363d;
    --text: #e6edf3;
    --text-dim: #8b949e;
    --accent: #58a6ff;
    --success: #3fb950;
    --danger: #f85149;
    --warning: #d29922;
    --bar-bg: #21262d;
}}
* {{ margin: 0; padding: 0; box-sizing: border-box; }}
body {{
    font-family: 'Segoe UI', -apple-system, sans-serif;
    background: var(--bg);
    color: var(--text);
    padding: 24px;
    line-height: 1.5;
}}
.header {{
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 24px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border);
}}
.header h1 {{
    font-size: 22px;
    font-weight: 600;
    color: var(--accent);
}}
.header .timestamp {{
    color: var(--text-dim);
    font-size: 13px;
}}
.stats-bar {{
    display: flex;
    gap: 24px;
    margin-bottom: 24px;
    padding: 16px;
    background: var(--surface);
    border-radius: 8px;
    border: 1px solid var(--border);
}}
.stat {{
    text-align: center;
}}
.stat-value {{
    font-size: 28px;
    font-weight: 700;
    display: block;
}}
.stat-value.good {{ color: var(--success); }}
.stat-value.bad {{ color: var(--danger); }}
.stat-value.neutral {{ color: var(--accent); }}
.stat-label {{
    font-size: 12px;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.5px;
}}
.turn {{
    margin-bottom: 8px;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    transition: all 0.2s;
}}
.turn.collapsed .turn-body {{ display: none; }}
.turn.collapsed .chevron {{ transform: rotate(-90deg); }}
.turn-header {{
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    background: var(--surface);
    cursor: pointer;
    user-select: none;
}}
.turn-header:hover {{ background: #1c2128; }}
.turn-label {{
    font-weight: 600;
    font-size: 14px;
    color: var(--accent);
    min-width: 70px;
}}
.turn-stats {{
    font-size: 13px;
    color: var(--text-dim);
    flex: 1;
    text-align: right;
    margin-right: 12px;
}}
.chevron {{
    color: var(--text-dim);
    font-size: 12px;
    transition: transform 0.2s;
}}
.turn-dirty {{ border-color: var(--danger); }}
.turn-dirty .turn-label {{ color: var(--danger); }}
.turn-body {{ padding: 8px; }}
.entry {{
    padding: 10px 12px;
    margin: 4px 0;
    border-radius: 6px;
    background: var(--bg);
    border-left: 3px solid var(--success);
}}
.entry.failure {{
    border-left-color: var(--danger);
    background: #1a0f0f;
}}
.entry-header {{
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 6px;
}}
.tool-name {{
    font-weight: 600;
    color: var(--text);
    font-size: 13px;
    min-width: 100px;
}}
.args {{
    color: var(--text-dim);
    font-size: 12px;
    font-family: 'Cascadia Code', 'Consolas', monospace;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}}
.duration {{
    font-size: 12px;
    color: var(--text-dim);
    font-weight: 600;
    min-width: 60px;
    text-align: right;
}}
.duration-bar {{
    height: 4px;
    background: var(--bar-bg);
    border-radius: 2px;
    overflow: hidden;
}}
.bar-fill {{
    height: 100%;
    border-radius: 2px;
    transition: width 0.3s ease;
}}
.bar-fill.success {{ background: var(--success); opacity: 0.6; }}
.bar-fill.failure {{ background: var(--danger); opacity: 0.6; }}
.error-detail {{
    margin-top: 8px;
    padding: 8px 10px;
    background: #2d1515;
    border-radius: 4px;
    font-size: 12px;
    font-family: 'Cascadia Code', 'Consolas', monospace;
    color: #f8a0a0;
}}
.error-label {{
    color: var(--danger);
    font-weight: 600;
}}
.result-preview {{
    margin-top: 6px;
    font-size: 11px;
    color: var(--text-dim);
    font-family: 'Cascadia Code', 'Consolas', monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}}
.empty-state {{
    text-align: center;
    padding: 64px 24px;
    color: var(--text-dim);
    font-size: 16px;
}}
</style>
</head>
<body>

<div class="header">
    <h1>Proxima Execution Trace</h1>
    <span class="timestamp">{timestamp}</span>
</div>

<div class="stats-bar">
    <div class="stat">
        <span class="stat-value neutral">{total}</span>
        <span class="stat-label">Total Calls</span>
    </div>
    <div class="stat">
        <span class="stat-value {'bad' if fail_rate > 30 else 'good'}">{failures}</span>
        <span class="stat-label">Failures</span>
    </div>
    <div class="stat">
        <span class="stat-value {'bad' if fail_rate > 30 else 'good'}">{fail_rate:.1f}%</span>
        <span class="stat-label">Failure Rate</span>
    </div>
    <div class="stat">
        <span class="stat-value neutral">{total_ms:.0f}ms</span>
        <span class="stat-label">Total Time</span>
    </div>
    <div class="stat">
        <span class="stat-value neutral">{len(turns)}</span>
        <span class="stat-label">Turns</span>
    </div>
</div>

{"".join(turns_html) if turns_html else '<div class="empty-state">No tool calls recorded yet.</div>'}

</body>
</html>"""
