"""Desktop Automation — Granular help topics.

Each topic = 2-5 lines max. Agent fetches only what it needs.
Cross-platform: auto-detects Windows/Mac/Linux backend.
Same methods on ALL platforms — only backend differs.
"""

DESKTOP_TOPICS = {
    "setup": (
        "from proxima_agent.tools.desktop import Desktop\n"
        "d = Desktop()  # auto-detects OS backend:\n"
        "#   Windows → pywinauto (UIAutomation)\n"
        "#   macOS   → AppleScript (Accessibility API)\n"
        "#   Linux   → xdotool + AT-SPI\n"
        "# NO mouse movement — uses accessibility APIs directly"
    ),
    "windows": (
        "d.windows()                        # list all open windows with titles\n"
        "# Returns: window title, class/type, PID\n"
        "# Works on: Windows (EnumWindows), Mac (AppleScript), Linux (wmctrl)"
    ),
    "connect": (
        "d.connect('Notepad')               # Windows: connect by partial title\n"
        "d.connect('TextEdit')              # macOS: connect to app\n"
        "d.connect('gedit')                 # Linux: connect to app\n"
        "d.connect(pid=1234)                # all OS: connect by process ID\n"
        "d.connect(path='notepad.exe')       # launch and connect\n"
        "# REQUIRED before click/write_text/read_text/elements/select/check/menu/keys —\n"
        "# they RAISE if no window is connected. Only d.windows() and d.connect() work\n"
        "# without it. (d.screenshot() falls back to full screen if not connected.)"
    ),
    "click": (
        "d.click('Save')                    # click button by name (NO mouse movement)\n"
        "d.click('OK')                      # finds by name, accessibility label\n"
        "d.click('Submit')                  # partial match supported\n"
        "# Windows: UIAutomation Invoke | Mac: AXPress | Linux: AT-SPI doAction\n"
        "# If not found: use d.elements() to see available element names"
    ),
    "fill": (
        "d.write_text('filename', 'test.txt')  # write text into ONE field by name (direct value set)\n"
        "d.write_text('Search', 'hello')        # call once PER field — target each field directly\n"
        "# RULE: don't fill a field then type_keys('{TAB}') to reach the next one — focus can land\n"
        "#       wrong and input shifts into the wrong field. Use a separate write_text per field.\n"
        "# Use d.elements() to get exact field names first; verify a critical value after filling.\n"
        "# Windows: SetValue → set_edit_text → type_keys (auto-fallback) | Mac: AXValue | Linux: AT-SPI"
    ),
    "text": (
        "d.read_text()                       # read all text from connected window\n"
        "d.read_text('Edit')                 # read text from specific element\n"
        "# Returns string content of the element or window"
    ),
    "elements": (
        "d.elements()                        # list all interactive elements\n"
        "d.elements(depth=5)                 # deeper search (default depth=3)\n"
        "# Shows: type, name, auto_id/label, enabled status\n"
        "# Use this when click/fill fails — see exact element names\n"
        "# Works on all OS — output format is normalized"
    ),
    "menu": (
        "d.click_menu('File -> Save As')      # click menu item by path\n"
        "d.click_menu('Edit -> Find -> Find Next') # nested menus supported\n"
        "# Separator: -> (arrow)\n"
        "# Windows: pywinauto menu select | Mac: AppleScript menu click | Linux: AT-SPI"
    ),
    "keys": (
        "# Windows (pywinauto syntax):\n"
        "d.type_keys('{ENTER}')   d.type_keys('^s')   d.type_keys('%{F4}')  # ^ Ctrl, % Alt, + Shift\n"
        "# macOS:\n"
        "d.type_keys('{RETURN}')  d.type_keys('^s')   # ^ = Cmd on Mac\n"
        "# Linux:\n"
        "d.type_keys('{Return}')  d.type_keys('^s')   # uses xdotool key\n"
        "# Common: {ENTER}/{RETURN}, {TAB}, {ESCAPE}, {DELETE}, {BACKSPACE}"
    ),
    "select": (
        "d.select('dropdown_name', 'Option Text')  # select from dropdown/combobox\n"
        "# Finds ComboBox by name, selects option by text\n"
        "# Works on all OS via accessibility API"
    ),
    "check": (
        "d.toggle_check('Remember me')        # toggle checkbox on\n"
        "d.toggle_check('Remember me', False) # toggle checkbox off\n"
        "# Uses Toggle/CheckBox pattern — no mouse needed"
    ),
    "tree": (
        "d.ui_tree()                         # print full UI element tree\n"
        "d.ui_tree(depth=6)                  # deeper tree (default 4)\n"
        "# Debug tool — shows entire DOM-like structure of the app\n"
        "# Useful for finding exact element names/types"
    ),
    "screenshot": (
        "d.screenshot('window.png')          # screenshot the CONNECTED app window\n"
        "# If you have NOT connected a window, this falls back to the FULL screen.\n"
        "# For the whole screen directly: from proxima_agent.tools.code_env import screenshot;\n"
        "#   screenshot()  → captures the whole screen, no connect needed (auto-attaches).\n"
        "# For the browser page: browser.screenshot('page.png').\n"
        "# Windows: pywinauto capture | Mac: screencapture | Linux: xdotool+import"
    ),
    "focus": (
        "d.focus()                           # bring connected window to front\n"
        "# Use before interaction if window might be behind other windows\n"
        "# Windows: SetForegroundWindow | Mac: activate | Linux: wmctrl -a"
    ),
    "close": (
        "d.close()                           # close connected window\n"
        "# Disconnects after closing — need d.connect() again for another window"
    ),
    "platform": (
        "# Desktop() auto-detects and uses the right backend:\n"
        "#\n"
        "# Windows: pywinauto (UIAutomation backend)\n"
        "#   - Install: pip install pywinauto\n"
        "#   - Uses Invoke/Value/Toggle patterns — no mouse needed\n"
        "#   - Key syntax: {ENTER}, ^c (Ctrl+C), %{F4} (Alt+F4), +a (Shift+A)\n"
        "#\n"
        "# macOS: AppleScript + Accessibility API\n"
        "#   - No extra install — uses built-in osascript\n"
        "#   - Requires Accessibility permissions in System Preferences\n"
        "#   - Key syntax: {RETURN}, ^c (Cmd+C), %c (Option+C)\n"
        "#\n"
        "# Linux: xdotool + AT-SPI (pyatspi2)\n"
        "#   - Install: sudo apt install xdotool wmctrl python3-pyatspi\n"
        "#   - AT-SPI for element interaction, xdotool for keys/focus\n"
        "#   - Key syntax: {Return}, ^c (Ctrl+C)\n"
        "#\n"
        "# ALL methods (click, fill, text, elements, etc.) need a CONNECTED window first\n"
        "# (call d.connect()), and the API is identical on every OS. Note: on Linux,\n"
        "# click/select are weaker without AT-SPI installed and may raise — prefer\n"
        "# computer.find_element()/smart_click() as a fallback there."
    ),
}
