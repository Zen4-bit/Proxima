"""Proxima — Screen & OCR Help Topics.
Documentation topics mapping screen capture, window tracking, and OCR APIs.
"""

SCREEN_TOPICS = {
    "screenshot": (
        "from proxima_agent.tools.code_env import screenshot\n"
        "screenshot()                        # capture the WHOLE screen — no setup needed\n"
        "screenshot('home.png')              # save to a name you choose\n"
        "# AUTO-ATTACHES: the image is fed to the model on your NEXT message (you'll SEE it).\n"
        "# One app window → desktop.connect('App') then desktop.screenshot()\n"
        "# Browser page   → browser.screenshot('page.png')"
    ),
    "active_window": (
        "from proxima_agent.tools.computer import computer\n"
        "print(computer.active_window())     # title, handle, position, size\n"
        "# Cross-platform: Windows=Win32, Mac=AppleScript, Linux=xdotool"
    ),
    "ui_elements": (
        "from proxima_agent.tools.desktop import Desktop\n"
        "d = Desktop()\n"
        "d.connect('Notepad')                # connect to a window first\n"
        "print(d.elements())                 # list interactive elements (name, type, state)\n"
        "# Accessibility API — no mouse movement, elements addressed by name/type"
    ),
    "find_element": (
        "from proxima_agent.tools.computer import computer\n"
        "ref = computer.find_element('Submit')      # 4-step fallback chain\n"
        "ref = computer.find_element('Save', context='desktop')\n"
        "# Returns ElementRef(found, x, y, handle, description). Fails clearly if not found.\n"
        "# Act on it: computer.smart_click('Submit') / computer.smart_write('Email', 'a@b.com')"
    ),
    "list_windows": (
        "from proxima_agent.tools.computer import computer\n"
        "print(computer.windows())           # all visible windows + handles + positions\n"
        "# Or raw data: from proxima_agent.tools.computer.window_manager import enumerate_windows"
    ),
    "context": (
        "from proxima_agent.tools.computer import computer\n"
        "print(computer.context())           # quick snapshot: focused window + open windows\n"
        "# Good FIRST call to understand the current screen state before acting."
    ),
    "ocr_screen": (
        "from proxima_agent.tools.ocr import read_screen\n"
        "result = read_screen()              # OCR entire screen\n"
        "print(result['text'])               # extracted text\n"
        "print(result['blocks'])             # text + bounding boxes"
    ),
    "ocr_region": (
        "from proxima_agent.tools.ocr import read_region\n"
        "result = read_region(100, 200, 500, 300)  # OCR specific area\n"
        "# Args: x, y, width, height\n"
        "# Returns: {text, blocks, engine}"
    ),
    "ocr_image": (
        "from proxima_agent.tools.ocr import read_image\n"
        "result = read_image('screenshot.png')  # OCR from image file\n"
        "# Engines: tesseract (cross-platform), Windows OCR, macOS Vision"
    ),
    "find_text": (
        "from proxima_agent.tools.ocr import find_text_on_screen\n"
        "matches = find_text_on_screen('Submit')  # find text on screen\n"
        "# Returns: [{text, x, y, width, height, center_x, center_y, confidence}]\n"
        "# Useful for clicking elements by visible text"
    ),
    "click_text": (
        "from proxima_agent.tools.ocr import click_text\n"
        "click_text('Submit')                # find text and click its center\n"
        "# Uses OCR to locate text, then clicks at coordinates\n"
        "# Prefer computer.smart_click() or desktop.click() instead when possible"
    ),
}
