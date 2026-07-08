"""Proxima — Verifier.
Handles evidence-based task verification, validation prompts, and failure recovery routing.
"""
from .tracker import Tracker

EVIDENCE_COST = """Evidence cost ranking (try cheapest first):
  CHEAP (instant, no navigation):
    - URL changed (verify url_match)
    - Toast/banner visible (verify content_contains)
    - Element appeared/disappeared (verify element_exists)
    - Window title changed
    - File exists on disk (verify file_exists)

  MEDIUM (one navigation or read):
    - Check a folder/page for result (e.g., Sent folder, Downloads)
    - Re-read file content (verify file_contains)
    - Check page content after refresh

  EXPENSIVE (multiple steps, avoid if cheaper evidence exists):
    - Search for item in another section
    - Open separate app/page to confirm
    - API call to external service"""


def build_verification_prompt(tracker: Tracker) -> str:
    """Builds Evidence Planner prompt for the agent."""
    parts = [
        "[BRAIN — EVIDENCE-BASED VERIFICATION]",
        "",
        "All execution steps are done. Before reporting to the user,",
        "you must PROVE the task was completed — not claim it.",
        "",
        "─── Step 1: What was done ───",
    ]

    if tracker.plan:
        for step in tracker.plan.steps:
            status = "[+]" if step.status.value == "done" else "[X]"
            parts.append(f"  {status} {step.action}")
        if tracker.plan.verification:
            parts.append(f"\nExpected outcome: {tracker.plan.verification}")
    else:
        for record in tracker.executions[-5:]:
            icon = "[+]" if record.success else "[X]"
            parts.append(f"  {icon} {record.description}")

    parts.extend([
        "",
        "─── Step 2: What evidence proves success? ───",
        "",
        "Think: What would convince a HUMAN watching your screen",
        "that the task is truly done? List 1-3 observable proofs.",
        "",
        "Examples of good evidence:",
        "  Email sent → 'Message sent' toast visible, or email in Sent folder",
        "  File saved → file exists on disk with expected content",
        "  Form submitted → success page loaded, or confirmation ID visible",
        "  Navigation done → URL matches expected destination",
        "  Click performed → DOM changed, new element appeared",
        "",
        "Examples of BAD evidence (never use these):",
        "  'I believe it worked' → not evidence, just a claim",
        "  'The code ran without errors' → code success ≠ task success",
        "  'I clicked the button' → action ≠ outcome",
        "",
        "─── Step 3: Pick cheapest evidence ───",
        "",
        EVIDENCE_COST,
        "",
        "─── Step 4: Write verification code ───",
        "",
        "Use verify() with the cheapest reliable evidence:",
        "",
        "  # URL check (CHEAP):",
        "  verify(type='url_match', expected='https://...')",
        "",
        "  # Content visible (CHEAP):",
        "  verify(type='content_contains', text='Message sent')",
        "",
        "  # Element check (CHEAP):",
        "  verify(type='element_exists', text='Confirmation')",
        "",
        "  # File on disk (CHEAP):",
        "  verify(type='file_exists', path='report.pdf')",
        "  verify(type='file_contains', path='output.txt', text='expected')",
        "",
        "  # Custom with evidence (only when no auto-check possible):",
        "  verify(type='custom', passed=True, reason='Saw confirmation ID #12345')",
        "",
        "  # Cannot verify (honest fallback):",
        "  verify(type='custom', reason='External API — no observable proof')",
        "",
        "RULES:",
        "  - verify(type='custom', passed=True) WITHOUT a reason is BLOCKED",
        "  - Try cheapest evidence first. Only escalate if cheap fails.",
        "  - If you truly cannot verify → UNKNOWN. Never fake a PASS.",
        "",
        "Write verification CODE now.",
    ])

    return "\n".join(parts)


def build_fix_prompt(tracker: Tracker, issue: str) -> str:
    """Builds prompt to fix a verification failure."""
    parts = [
        "[BRAIN — FIX REQUIRED]",
        f"Verification FAILED: {issue}",
        "",
        "What was already done successfully:",
    ]

    if tracker.plan:
        for step in tracker.plan.steps:
            if step.status.value == "done":
                parts.append(f"  [+] {step.action}")
    else:
        for record in tracker.executions:
            if record.success:
                parts.append(f"  [+] {record.description}")

    parts.extend([
        "",
        "DO NOT restart from scratch. Fix ONLY the failed part.",
        "Then verify again using verify() with observable evidence.",
    ])

    return "\n".join(parts)


def should_verify(tracker: Tracker) -> bool:
    """Returns True if verification is needed."""
    return tracker.needs_verification


def process_verification_result(execution_result: str) -> dict:
    """Processes verification outcome from raw execution result."""
    from proxima_agent.tools.verification import parse_verify_output

    result = parse_verify_output(execution_result)
    issues = [result["reason"]] if result["reason"] else []

    return {
        "verified": result["verified"],
        "status": result["status"],
        "reason": result["reason"],
        "issues": issues,
    }
