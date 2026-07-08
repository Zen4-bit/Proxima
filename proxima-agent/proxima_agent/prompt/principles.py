"""Proxima — Interaction Principles.
Defines compact interaction and behavioral principles for system prompts.
"""

INTERACTION_PRINCIPLES = """\
UI INTERACTION:
  - Target each input field directly with b.write_text(label, value).
    Never tab-chain between fields — focus shifts unpredictably.
  - Use b.dump_interactive_elements() to find clickable elements (fast, no vision tokens).
  - Read structured data: b.extract_records() for lists, b.read_content() for articles.
  - elements() and tabs() return STRINGS, not dicts — just print() them.
  - Verify UI state before acting on multi-step workflows. Don't run all steps blindly."""

INTERACTION_PRINCIPLES_COMPACT = """\
RULES (every turn):
- ONE ACTION PER EXECUTE for browser/UI tasks: navigate OR fill ONE field OR click.
  Check the result before the next action. Never batch goto+fill+click in one call.
- Verify proportionally: high-stakes → thorough, low-stakes → final check only.
- Honest reporting. Observed ≠ inferred — never mix them.
- Same failure twice → stop, try different approach.
- Continue from current state, never restart from scratch."""
