"""Proxima — Tool Help.
Provides lazy-loaded, detailed API documentation for agent tools.
"""

_DOCS = {

"browser": """BROWSER — Full CDP API Reference

from proxima_agent.tools.browser_cdp import ChromeBrowser
b = ChromeBrowser()  # auto-launches Chrome if not running

NAVIGATION:
  b.goto('url')        Navigate to URL
  b.back()             Browser back
  b.forward()          Browser forward
  b.reload()           Reload page

READING:
  b.elements()         List all interactive elements (buttons, inputs, links)
  b.find_element('t')  Find element by text/label
  b.read_text()        Read all visible text (raw)
  b.read_content()     Read main content as clean Markdown
  b.extract_records()  Extract repeated items as list of dicts (tables, cards, feeds)
  b.extract()          Auto-pick: structured (records) or text (content)
  b.run_js('code')     Execute JavaScript and return result
  b.wait_for('text')   Wait for text to appear on page

INTERACTION:
  b.click_text('text')          Click element by visible text
  b.click(x, y)                 Click at coordinates
  b.write_text('label', 'val')  Fill input field by label/placeholder (PREFERRED for forms)
  b.select('label', 'option')   Select dropdown option
  b.toggle_check('label', True) Check/uncheck checkbox

TYPING (focus-dependent — use only when you've focused the right element):
  b.type_text('...')             Type text into focused element
  b.press('enter')               Press a key
  b.hotkey('ctrl', 'a')         Key combination

VISUAL:
  b.screenshot('file.png')       Screenshot of browser page
  b.scroll_down(600)             Scroll down by pixels
  b.scroll_up(600)               Scroll up by pixels

TABS:
  b.new_tab()                    Open new tab
  b.close_tab()                  Close current tab
  b.tabs()                       List all tabs

TOUCH:
  b.tap(x, y)                    Touch tap
  b.swipe(x1, y1, x2, y2)       Swipe gesture

KEY RULES:
  - b.write_text() targets ONE field directly — PREFERRED for all form inputs.
  - b.type_text()/press()/hotkey() type into WHATEVER has focus — only use when you
    have deliberately focused the right element.
  - NEVER tab-chain between fields. One field = one targeted write_text() call.
  - These RAISE if target not found — check b.elements() first when unsure.
  - Use extract_records() for structured data, read_content() for text.
  - Don't regex-parse raw read_text() output.
""",

"desktop": """DESKTOP APPS — Full API Reference

from proxima_agent.tools.desktop import Desktop
desktop = Desktop()

CONNECT (required before any action except windows()):
  desktop.windows()                     List all open windows (NO connect needed)
  desktop.connect('App Name')           Connect to a window by title (REQUIRED first)

READ UI:
  desktop.elements()                    List interactive elements in connected window
  desktop.ui_tree()                     Full UI tree (hierarchical)
  desktop.read_text('Edit')             Read text from a named element

INTERACT:
  desktop.click('Button Name')          Click a button/element by name
  desktop.write_text('field', 'value')  Fill input field by name
  desktop.select('dropdown', 'option')  Select dropdown option
  desktop.toggle_check('checkbox')      Toggle checkbox
  desktop.click_menu('File -> Save')    Click menu item by path

TYPING:
  desktop.type_keys('{ENTER}')          Send keystrokes

VISUAL:
  desktop.screenshot('win.png')         Screenshot of connected window
                                        (falls back to full screen if no window connected)

KEY RULES:
  - ALWAYS connect() before any action (except windows()).
  - Does NOT move the user's mouse — uses UIAutomation/Accessibility APIs.
  - write_text() fills a field by name (not by typing into focus).
  - type_keys() sends keystrokes to whatever has focus.

PLATFORM-SPECIFIC:
  Windows: UIAutomation Invoke/Value patterns
  macOS:   Accessibility API via AppleScript
  Linux:   AT-SPI accessibility + xdotool fallback
""",

"files": """FILE OPERATIONS — Full API Reference

from proxima_agent.tools.code_env import *

READING:
  read_file('path')           Read file with line numbers ('  1 | ...')
  read_file_raw('path')       Read exact bytes, NO line numbers (for JSON/config)

WRITING:
  write_file('path', content)             Write/overwrite file
  edit_file('path', old_text, new_text)   Replace text in file

SEARCHING:
  grep('pattern', 'dir')      Search text in files (like grep -rn)
  find_files('*.py', 'dir')   Find files matching glob pattern

WORKSPACE:
  workspace('out.txt')         Path inside agent workspace (keeps folders clean)
  Save to workspace by default. Use user's path when they name a location.
""",

"screenshots": """SCREENSHOTS — Full Reference

All screenshots auto-attach to your next message.

from proxima_agent.tools.code_env import screenshot

FULL SCREEN:
  screenshot()                         Whole screen — safest default, no setup needed

BROWSER:
  b.screenshot('page.png')            Just the browser page (ChromeBrowser instance)

DESKTOP APP:
  desktop.connect('App Name')         Connect first
  desktop.screenshot('win.png')       Just that app window
  # Without connect(), falls back to full screen

TIPS:
  - screenshot() is the safe go-to for "see the screen"
  - Use browser/desktop screenshots when you need just that context
  - All screenshots auto-attach — no need to read them from disk
""",

"python": """PYTHON EXECUTION — Full Reference

PERSISTENT ENVIRONMENT:
  Variables, imports, and objects SURVIVE across execute() calls within a conversation.
  You can set x = 42 in one turn and use x in the next.
  If you see '[SYSTEM: Execution environment was restarted]', state was lost — re-init.

OUTPUT:
  Always use print() — stdout is captured and returned.

IMPORTS:
  from proxima_agent.tools.code_env import *
  This gives you: file ops, search, lint, git, shell, network helpers

  from proxima_agent.tools.browser_cdp import ChromeBrowser
  from proxima_agent.tools.desktop import Desktop
  from proxima_agent.tools.code_env import screenshot

WORKSPACE:
  from proxima_agent.tools.code_env import workspace
  workspace('result.txt')   # Path inside agent workspace

SYSTEM ACCESS:
  Full Python + subprocess + system shell (PowerShell/bash/zsh)
  Can access files, folders, network, processes — everything on the machine.
""",

}


def tool_help(tool_name):
    """Returns detailed API documentation for a tool category."""
    name = tool_name.lower().strip()
    if name in _DOCS:
        return _DOCS[name]

    available = ", ".join(sorted(_DOCS.keys()))
    return f"Unknown tool '{tool_name}'. Available: {available}"
