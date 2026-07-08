"""Browser CDP — Granular help topics.

Each topic = 2-5 lines max. Agent fetches only what it needs.
"""

BROWSER_TOPICS = {
    "setup": (
        "from proxima_agent.tools.browser_cdp import ChromeBrowser\n"
        "b = ChromeBrowser()  # auto-launches dedicated Chrome (user's Chrome untouched)\n"
        "# Uses CDP port 9222, separate profile at ~/.proxima-agent/chrome-profile\n"
        "# Persistent logins — login once, stays logged in across sessions"
    ),
    "navigate": (
        "b.goto('https://example.com')     # navigate to URL\n"
        "b.goto('https://google.com')      # waits for page load automatically\n"
        "b.back()  b.forward()  b.reload()  # history navigation / refresh\n"
        "b.wait_for('Sign in', timeout=10) # wait until an element/text appears (raises on timeout)\n"
        "# Current URL: b.run_js('location.href')   Page title: b.run_js('document.title')"
    ),
    "click": (
        "b.click_text('Submit')             # click element containing text (PREFERRED)\n"
        "b.click(x, y)                      # click at pixel coords (only if you know them)\n"
        "# ALWAYS confirm the target first: b.elements() lists clickable items with exact text.\n"
        "# Use specific text ('Send email') not vague ('Send') so you hit the right element."
    ),
    "fill": (
        "b.write_text('Email', 'user@mail.com')  # fills ONE input found by label/placeholder/aria\n"
        "b.write_text('Subject', 'Hello')         # call it once PER field, targeting each directly\n"
        "# RULE: one field = one write_text. Do NOT fill a field then press Tab/Enter to reach the\n"
        "#       next one — focus can jump to a dropdown/suggestion and your text lands in the WRONG\n"
        "#       field, shifting everything. Re-target each field explicitly.\n"
        "# Find exact field names first with b.elements(); avoid 1-2 char labels (too ambiguous).\n"
        "# After filling a critical field, read it back to confirm it landed correctly.\n"
        "# Dropdowns/checkboxes: b.select('label','Option')  |  b.toggle_check('label', True)\n"
        "# NOTE: write_text/click_text/select RAISE if the target isn't found — check b.elements()."
    ),
    "keys": (
        "b.press('enter')                   # submits / confirms the CURRENTLY focused element\n"
        "b.hotkey('ctrl', 'a')              # select-all in focused field   b.hotkey('ctrl','c')\n"
        "# These act on whatever has focus RIGHT NOW — they do not pick an element for you.\n"
        "# Don't use press('tab') to move between form fields (unreliable — see 'fill').\n"
        "# To put text in a specific field, use b.write_text('<field>', value) instead."
    ),
    "read": (
        "b.read_content()                   # MAIN content as clean Markdown (nav/ads stripped) — PREFERRED for articles\n"
        "b.extract_records()                # repeated items (cards/results/rows/feed) → list of generic dicts\n"
        "b.extract()                        # {kind:'table'|'list'|'text', records:[...], content:'...'} auto-pick\n"
        "b.read_text()                      # raw full-page innerText (noisy — use only if no structure)\n"
        "b.elements()                       # list interactive elements (returns a STRING, not list)\n"
        "b.run_js('...')                     # run JS\n"
        "# RETURN TYPES: elements() and tabs() return formatted STRINGS for display.\n"
        "#   Do NOT call .get() or iterate them as dicts — they are human-readable text.\n"
        "#   extract_records() returns list[dict]. read_content() returns str (Markdown).\n"
        "# For big data: use extract_records() then derive/filter in Python from\n"
        "# each item's text — do NOT regex-parse read_text() by line numbers (brittle, layout-dependent)."
    ),
    "extract": (
        "items = b.extract_records()        # universal: auto-detects any repeated structure\n"
        "# each item is a generic dict: {'title':..., 'text':..., 'url':..., 'image':...}\n"
        "# derive whatever you need from the text yourself, e.g. parse a number/date out of item['text']\n"
        "# articles/blogs: b.read_content() gives clean Markdown of just the main content\n"
        "# mixed/unknown: b.extract() returns {kind, records, content} so you pick the right one"
    ),
    "tabs": (
        "b.new_tab()                        # open new tab\n"
        "b.tabs()                           # list all open tabs — returns a STRING, not list\n"
        "b.close_tab()                      # close current tab\n"
        "# tabs() returns formatted text like '2 tabs:\n  [0] Title — URL'. It is a STRING.\n"
        "# Do NOT call .get() or iterate it as a list/dict."
    ),
    "scroll": (
        "b.scroll_down(600)                 # scroll DOWN 600px (clear, preferred)\n"
        "b.scroll_up(600)                   # scroll UP 600px\n"
        "# Low-level: b.scroll(x, y, delta_y=-300) — first two args are POINTER position,\n"
        "# delta_y NEGATIVE = down. Prefer scroll_down()/scroll_up() to avoid confusion.\n"
        "# For mobile: b.swipe(x1, y1, x2, y2)"
    ),
    "screenshot": (
        "b.screenshot('page.png')           # saves screenshot to file, returns a status string\n"
        "b.screenshot()                     # saves to default 'screenshot.png', returns status string\n"
        "# Always writes a PNG file (optional path arg); use the returned string to confirm it saved."
    ),
    "javascript": (
        "b.run_js('document.title')                     # get page title\n"
        "b.run_js('location.href')                      # get current URL\n"
        "b.run_js('document.querySelector(\"#btn\").click()')  # click by selector\n"
        "b.run_js('document.body.innerText.substring(0, 500)')  # get page text"
    ),
    "touch": (
        "b.tap(x, y)                        # touch tap (mobile emulation)\n"
        "b.swipe(x1, y1, x2, y2)            # swipe gesture\n"
        "# Useful for mobile-responsive pages"
    ),
    "state": (
        "# Confirm REAL state before AND after acting — don't assume:\n"
        "url = b.run_js('location.href')    # current URL\n"
        "title = b.run_js('document.title')  # page title\n"
        "text = b.read_text()                # page content\n"
        "# After an action, verify the REAL end-state actually changed (confirmation text\n"
        "# appeared, URL navigated, value present). 'script finished' is NOT proof it worked,\n"
        "# and a check that's always true (matching permanent page text) proves nothing."
    ),
}
