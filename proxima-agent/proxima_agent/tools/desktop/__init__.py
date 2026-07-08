"""Proxima — Desktop Automation.
Cross-platform mouse-free UI control factory returning OS-specific backends.
"""

import platform

_OS = platform.system()  # "Windows", "Darwin", "Linux"


def Desktop():
    """Returns the correct Desktop backend for the current OS."""
    if _OS == "Windows":
        from ._windows import WindowsDesktop
        return WindowsDesktop()
    elif _OS == "Darwin":
        from ._mac import MacDesktop
        return MacDesktop()
    else:
        from ._linux import LinuxDesktop
        return LinuxDesktop()
