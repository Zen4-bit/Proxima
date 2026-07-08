"""Proxima — CDP Browser Controller.
Gives the agent full control over a dedicated Chrome instance via Chrome DevTools Protocol.
"""
import json
import os
import socket
import struct
import subprocess
import time
import base64
import urllib.request
from collections import deque
from pathlib import Path
import platform

_OS = platform.system()

def _get_chrome_paths() -> list:
    """Get Chrome executable paths for the current OS."""
    if _OS == "Windows":
        return [
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
            os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
        ]
    elif _OS == "Darwin":
        return [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            os.path.expanduser("~/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
    else:  # Linux
        return [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium-browser",
            "/usr/bin/chromium",
            "/snap/bin/chromium",
            "/usr/lib/chromium-browser/chromium-browser",
            os.path.expanduser("~/.local/bin/google-chrome"),
        ]

CHROME_PATHS = _get_chrome_paths()
PROFILE_DIR = os.path.join(os.path.expanduser("~"), ".proxima-agent", "chrome-profile")

# CDP endpoint — centralized in config so port/host stay consistent everywhere
# (and overridable via PROXIMA_CDP_PORT). Falls back to local defaults if the
# config module can't be imported for any reason.
try:
    from ..config import CDP_PORT, CDP_URL
except Exception:
    CDP_PORT = 9222
    CDP_URL = f"http://127.0.0.1:{CDP_PORT}"


def _find_chrome() -> str:
    """Find Chrome executable — cross-platform."""
    for p in CHROME_PATHS:
        if os.path.exists(p):
            return p

    if _OS == "Windows":
        try:
            import winreg
            key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                                 r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe")
            path = winreg.QueryValue(key, None)
            if os.path.exists(path):
                return path
        except Exception:
            pass

    if _OS == "Darwin":
        try:
            result = subprocess.run(
                ["mdfind", "kMDItemCFBundleIdentifier == 'com.google.Chrome'"],
                capture_output=True, text=True, timeout=5
            )
            for line in result.stdout.strip().split("\n"):
                chrome_path = os.path.join(line.strip(), "Contents", "MacOS", "Google Chrome")
                if os.path.exists(chrome_path):
                    return chrome_path
        except Exception:
            pass

    import shutil
    for name in ["google-chrome", "google-chrome-stable", "chromium-browser", "chromium", "chrome"]:
        found = shutil.which(name)
        if found:
            return found

    raise FileNotFoundError("Chrome not found. Install Google Chrome.")


def _is_cdp_alive() -> bool:
    """Check if CDP is responding."""
    try:
        r = urllib.request.urlopen(f"{CDP_URL}/json/version", timeout=2)
        return r.status == 200
    except Exception:
        return False


def _pid_is_proxima_chrome(pid: str) -> bool:
    """Return True only if the PID is a Chrome launched with OUR dedicated agent
    profile dir. This is what prevents us from ever killing the user's own
    Chrome (or any unrelated process) that merely happens to hold the CDP port.
    Fails SAFE: returns False whenever ownership cannot be positively confirmed.
    """
    if not pid or not pid.isdigit():
        return False
    try:
        if _OS == "Windows":
            # Full command line for this PID. Prefer PowerShell/CIM: `wmic` is
            # DEPRECATED and absent by default on Windows 11 24H2+, where the old
            # call silently failed → cmdline stayed empty → stale agent-Chrome on
            # the CDP port was never reclaimed → relaunch TimeoutError. CIM
            # (Get-CimInstance) ships with every supported Windows. `pid` is
            # validated as digits at the top of this function, so embedding it in
            # the filter is injection-safe. Decode UTF-8 with replacement so a
            # non-ASCII profile path (e.g. C:\Users\José\...) can't raise
            # UnicodeDecodeError and abort the ownership check.
            cmdline = ""
            ps_cmd = (
                "$ErrorActionPreference='SilentlyContinue';"
                f"(Get-CimInstance Win32_Process -Filter 'ProcessId={pid}')"
                ".CommandLine"
            )
            try:
                result = subprocess.run(
                    ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_cmd],
                    capture_output=True, text=True, encoding="utf-8",
                    errors="replace", timeout=5,
                )
                cmdline = result.stdout or ""
            except Exception:
                cmdline = ""
            # Legacy fallback for systems without CIM/PowerShell (very old Windows).
            if not cmdline.strip():
                try:
                    result = subprocess.run(
                        ["wmic", "process", "where", f"ProcessId={pid}",
                         "get", "CommandLine", "/format:list"],
                        capture_output=True, text=True, encoding="utf-8",
                        errors="replace", timeout=5,
                    )
                    cmdline = result.stdout or ""
                except Exception:
                    cmdline = ""
        else:
            # Full command/args for this PID.
            result = subprocess.run(
                ["ps", "-p", pid, "-o", "args="],
                capture_output=True, text=True, encoding="utf-8",
                errors="replace", timeout=5,
            )
            cmdline = result.stdout or ""
    except Exception:
        return False

    # Our launcher always passes BOTH the dedicated profile dir AND the CDP port.
    # The profile dir is the decisive discriminator: the user's normal Chrome
    # never runs with PROFILE_DIR.
    return (PROFILE_DIR in cmdline) and (f"--remote-debugging-port={CDP_PORT}" in cmdline)


def _pids_on_cdp_port() -> list:
    """Best-effort list of PIDs currently bound to the CDP port (validated digits)."""
    pids = []
    try:
        if _OS == "Windows":
            result = subprocess.run(
                ["netstat", "-ano"], capture_output=True, text=True, timeout=5
            )
            for line in result.stdout.splitlines():
                if f":{CDP_PORT}" in line and "LISTENING" in line:
                    parts = line.split()
                    if parts and parts[-1].isdigit():
                        pids.append(parts[-1])
        else:
            # -t = terse (one PID per line); arg list, no shell.
            result = subprocess.run(
                ["lsof", "-ti", f"tcp:{CDP_PORT}"],
                capture_output=True, text=True, timeout=5,
            )
            for tok in result.stdout.split():
                tok = tok.strip()
                if tok.isdigit():
                    pids.append(tok)
    except Exception:
        pass
    # De-duplicate, preserve order.
    return list(dict.fromkeys(pids))


def _kill_pid(pid: str) -> None:
    """Force-kill a PID using OS-native tools via argument lists (never a shell)."""
    try:
        if _OS == "Windows":
            subprocess.run(["taskkill", "/F", "/PID", pid], capture_output=True, timeout=5)
        else:
            subprocess.run(["kill", "-9", pid], capture_output=True, timeout=5)
    except Exception:
        pass


def _kill_stale_cdp_chrome():
    """Kill ONLY our own stale agent Chrome on the CDP port — never the user's
    browser. Ownership is confirmed via the dedicated --user-data-dir profile in
    the process command line; anything not positively confirmed as ours is left
    untouched. Uses argument lists everywhere (the old `bash -c` f-string was a
    shell-injection surface and the old netstat path killed ANY PID on the port).
    """
    try:
        killed_any = False
        for pid in _pids_on_cdp_port():
            if _pid_is_proxima_chrome(pid):
                _kill_pid(pid)
                killed_any = True
        if killed_any:
            time.sleep(0.5)
    except Exception:
        pass


def _launch_chrome(headless=False) -> subprocess.Popen:
    """Launch Chrome with dedicated agent profile + CDP enabled."""
    # Kill any stale Chrome on CDP port — ensures fresh visible window
    _kill_stale_cdp_chrome()

    chrome = _find_chrome()
    Path(PROFILE_DIR).mkdir(parents=True, exist_ok=True)

    args = [
        chrome,
        f"--remote-debugging-port={CDP_PORT}",
        f"--user-data-dir={PROFILE_DIR}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-mode",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
    ]
    if headless:
        args.append("--headless=new")

    proc = subprocess.Popen(
        args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )

    # Wait for CDP to be ready
    for _ in range(30):
        if _is_cdp_alive():
            return proc
        time.sleep(0.5)

    raise TimeoutError(f"Chrome started but CDP not responding on port {CDP_PORT}")


class _WS:
    """Minimal WebSocket client for CDP."""


    # Opcodes
    _OP_CONT = 0x0
    _OP_TEXT = 0x1
    _OP_BIN = 0x2
    _OP_CLOSE = 0x8
    _OP_PING = 0x9
    _OP_PONG = 0xA

    def __init__(self, url: str):
        url = url.replace("ws://", "")
        host_port, self._path = url.split("/", 1)
        self._path = "/" + self._path
        self._host, port = host_port.split(":")
        self._port = int(port)
        # Persistent decode state — must survive across recv() calls.
        self._buf = b""                 # raw bytes read but not yet framed
        self._messages = deque()        # fully-parsed JSON messages, FIFO
        self._frag = bytearray()        # reassembly buffer for FIN=0 fragments
        self._fragmenting = False       # are we mid-way through a fragmented msg?
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.settimeout(15)
        try:
            self._sock.connect((self._host, self._port))
            self._handshake()
        except Exception:
            # Don't leak the OS socket if connect/handshake fails — there is no
            # __del__ on the half-built _WS, so every failed attempt would leak
            # a file descriptor.
            try:
                self._sock.close()
            except Exception:
                pass
            raise

    def _handshake(self):
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET {self._path} HTTP/1.1\r\n"
            f"Host: {self._host}:{self._port}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self._sock.sendall(req.encode())
        resp = self._sock.recv(4096).decode("latin-1")
        if "101" not in resp:
            raise ConnectionError(f"WebSocket handshake failed: {resp[:200]}")

    def settimeout(self, timeout: float):
        """Adjust the underlying socket timeout (used to honor _cdp deadlines)."""
        try:
            self._sock.settimeout(timeout)
        except Exception:
            pass

    def _send_frame(self, opcode: int, payload: bytes):
        """Build a masked client frame (FIN=1) and write it with sendall().

        sendall() is mandatory: a large frame (>64KB long insertText, big
        run_js, the ~12KB EXTRACTOR_JS) can exceed the socket send buffer, and
        send() would transmit only part of it → a malformed frame → Chrome drops
        the connection.
        """
        frame = bytearray([0x80 | (opcode & 0x0F)])  # FIN + opcode
        mask = os.urandom(4)
        length = len(payload)
        if length < 126:
            frame.append(0x80 | length)
        elif length < 65536:
            frame.append(0x80 | 126)
            frame.extend(struct.pack(">H", length))
        else:
            frame.append(0x80 | 127)
            frame.extend(struct.pack(">Q", length))
        frame.extend(mask)
        frame.extend(bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))
        self._sock.sendall(bytes(frame))

    def send(self, data: dict):
        """Send a CDP command as a single masked text frame."""
        self._send_frame(self._OP_TEXT, json.dumps(data).encode("utf-8"))

    @staticmethod
    def _parse_one_frame(buf: bytes):
        """Parse a single WebSocket frame from the front of ``buf``.

        Pure function — no socket access — so it can be unit-tested by feeding
        crafted byte buffers.

        Returns ``(fin, opcode, payload, consumed)`` where ``payload`` is the
        unmasked bytes and ``consumed`` is the number of bytes this frame
        occupied in ``buf``. Returns ``None`` if ``buf`` does not yet hold a
        complete frame (caller should read more bytes).
        """
        if len(buf) < 2:
            return None
        b0 = buf[0]
        b1 = buf[1]
        fin = bool(b0 & 0x80)
        opcode = b0 & 0x0F
        masked = bool(b1 & 0x80)
        length = b1 & 0x7F
        idx = 2
        if length == 126:
            if len(buf) < idx + 2:
                return None
            length = struct.unpack(">H", buf[idx:idx + 2])[0]
            idx += 2
        elif length == 127:
            if len(buf) < idx + 8:
                return None
            length = struct.unpack(">Q", buf[idx:idx + 8])[0]
            idx += 8
        mask_key = b""
        if masked:
            if len(buf) < idx + 4:
                return None
            mask_key = buf[idx:idx + 4]
            idx += 4
        if len(buf) < idx + length:
            return None
        payload = buf[idx:idx + length]
        if masked:
            payload = bytes(p ^ mask_key[i % 4] for i, p in enumerate(payload))
        else:
            payload = bytes(payload)
        return (fin, opcode, payload, idx + length)

    def _emit(self, payload: bytes):
        """Decode a completed text/binary payload as JSON and queue it."""
        try:
            self._messages.append(json.loads(payload.decode("utf-8")))
        except Exception:
            # Non-JSON or malformed payload — drop it rather than crash the loop.
            pass

    def _handle_frame(self, fin: bool, opcode: int, payload: bytes):
        """Dispatch a single decoded frame (control / data / continuation)."""
        if opcode == self._OP_CLOSE:
            raise ConnectionError("WebSocket closed by server")
        if opcode == self._OP_PING:
            # Reply with a pong carrying the same application data; this does NOT
            # touch the fragmentation buffer, so an interleaved ping cannot
            # corrupt a fragmented data message.
            try:
                self._send_frame(self._OP_PONG, payload)
            except Exception:
                pass
            return
        if opcode == self._OP_PONG:
            return  # unsolicited/heartbeat pong — ignore
        if opcode == self._OP_CONT:
            # Continuation of a fragmented message.
            self._frag.extend(payload)
            if fin:
                self._emit(bytes(self._frag))
                self._frag = bytearray()
                self._fragmenting = False
            return
        if opcode in (self._OP_TEXT, self._OP_BIN):
            if fin:
                self._emit(payload)
            else:
                # First frame of a fragmented message.
                self._frag = bytearray(payload)
                self._fragmenting = True
            return
        # Unknown opcode — ignore defensively.

    def _drain_buffer(self):
        """Frame everything currently buffered, queueing complete messages.

        Stops when the buffer holds only a partial frame (waits for more bytes).
        """
        while True:
            parsed = self._parse_one_frame(self._buf)
            if parsed is None:
                return
            fin, opcode, payload, consumed = parsed
            self._buf = self._buf[consumed:]
            self._handle_frame(fin, opcode, payload)

    def recv(self) -> dict | None:
        """Return the next fully-parsed JSON message, or None on timeout/EOF.

        Already-decoded messages are served from the queue first (so multiple
        frames packed into one read are all returned, one per call). Only when
        the queue is empty do we block on the socket.
        """
        if self._messages:
            return self._messages.popleft()
        try:
            while not self._messages:
                chunk = self._sock.recv(65536)
                if not chunk:
                    return None  # peer closed the TCP connection
                self._buf += chunk
                self._drain_buffer()
            return self._messages.popleft()
        except socket.timeout:
            return None

    def close(self):
        try:
            self._sock.close()
        except Exception:
            pass


class ChromeBrowser:
    """Full browser control via Chrome DevTools Protocol."""


    def __init__(self, headless=False, connect_only=False):
        self._proc = None
        self._ws = None
        self._cmd_id = 0
        # Bounded queue of stashed CDP events (and stray responses) so messages
        # interleaved between a request and its response are never lost. Capped
        # so a long-lived browser session can't grow this without bound.
        self._events = deque(maxlen=1000)

        if _is_cdp_alive():
            # CDP port is active — try to connect to existing Chrome
            try:
                self._connect_tab()
                # Verify it's actually responsive
                self._js("1+1")
                return  # Healthy Chrome, reuse it
            except Exception:
                pass  # Stale/dead — fall through to kill + relaunch

        if connect_only:
            # Passive callers (e.g. verification.py) must NEVER spawn a browser.
            # A verification that launches Chrome is a side effect, not a check.
            raise ConnectionError(
                "Chrome is not running and connect_only=True (passive mode)"
            )

        # Kill stale Chrome (if any) and launch fresh
        self._proc = _launch_chrome(headless)

        self._connect_tab()

    def _is_webpage_tab(self, target: dict) -> bool:
        """Dynamically check if a target is a genuine webpage tab."""
        if target.get("type") != "page":
            return False
        if not target.get("webSocketDebuggerUrl"):
            return False

        url = target.get("url", "")
        title = target.get("title", "")

        # Exclude Omnibox suggestions popup
        if title == "Omnibox Popup":
            return False

        # Parse scheme and exclude internal Chrome/Extension pages
        try:
            import urllib.parse
            parsed = urllib.parse.urlparse(url)
            scheme = parsed.scheme.lower()
            netloc = parsed.netloc.lower()
            
            if scheme in ("chrome-extension", "devtools", "chrome-untrusted"):
                return False
                
            # For chrome:// scheme, only allow newtab pages
            if scheme == "chrome":
                if netloc not in ("newtab", "new-tab-page"):
                    return False
        except Exception:
            pass

        return True

    def _connect_tab(self, index=0):
        """Connect WebSocket to a tab."""
        tabs = self._get_tabs()
        page_tabs = [t for t in tabs if self._is_webpage_tab(t)]
        if not page_tabs:
            # Open a blank tab using POST to avoid 405 Method Not Allowed on newer Chrome versions
            req = urllib.request.Request(f"{CDP_URL}/json/new?about:blank", data=b"")
            urllib.request.urlopen(req, timeout=5)
            time.sleep(1)
            tabs = self._get_tabs()
            page_tabs = [t for t in tabs if self._is_webpage_tab(t)]

        # Guard against an empty/out-of-range tab list — page_tabs can still be
        # empty after the blank-tab recovery (tab not yet registered, or filtered
        # out), and new_tab()/close_tab() pass index=-1/0. Raise a clear error
        # instead of a raw IndexError.
        if not page_tabs:
            raise RuntimeError("No connectable page tab available in Chrome.")
        if index >= len(page_tabs) or index < -len(page_tabs):
            index = 0
        ws_url = page_tabs[index]["webSocketDebuggerUrl"]
        if self._ws:
            self._ws.close()
        self._ws = _WS(ws_url)

    def _get_tabs(self) -> list:
        r = urllib.request.urlopen(f"{CDP_URL}/json", timeout=5)
        return json.loads(r.read())

    def _cdp(self, method: str, params: dict = None, timeout: float = 10) -> dict:
        """Send CDP command and wait for the response with the matching id.

        Events (messages with a "method" key, or any message whose id does not
        match the one we're awaiting) are stashed on a queue instead of being
        discarded, so nothing that arrives between our request and its response
        is lost. The loop keeps reading until it finds the matching id or the
        deadline passes; each blocking recv is bounded to the *remaining*
        deadline so a single recv can never overrun the command budget.

        Public behavior is preserved: returns the response dict, or {} on
        timeout.
        """
        self._cmd_id += 1
        mid = self._cmd_id
        self._ws.send({"id": mid, "method": method, "params": params or {}})

        deadline = time.time() + timeout
        while True:
            now = time.time()
            if now >= deadline:
                return {}
            # Bound this recv to whatever time is left (never below 0.1s so a
            # near-zero remainder still gives the socket a chance to deliver a
            # response that's already in flight).
            self._ws.settimeout(max(0.1, deadline - now))
            try:
                r = self._ws.recv()
            except (ConnectionError, OSError):
                return {}
            if r is None:
                continue  # timeout/no data this iteration — re-check deadline
            if r.get("id") == mid:
                return r
            # Event or response to a different/earlier command — stash it so a
            # later caller can still observe it, then keep waiting for our id.
            self._events.append(r)

    def _js(self, expression: str) -> str:
        """Run JavaScript and return result value."""
        r = self._cdp("Runtime.evaluate", {
            "expression": expression,
            "returnByValue": True,
        })
        result = r.get("result", {}).get("result", {})
        return result.get("value", "")

    def goto(self, url: str):
        """Navigate to URL."""
        self._cdp("Page.navigate", {"url": url})
        time.sleep(2)  # wait for load
        return self._js("document.title")

    def back(self):
        self._js("history.back()")
        time.sleep(1)

    def forward(self):
        self._js("history.forward()")
        time.sleep(1)

    def reload(self):
        self._cdp("Page.reload")
        time.sleep(2)

    def url(self) -> str:
        return self._js("location.href")

    def title(self) -> str:
        return self._js("document.title")

    def _click_found_node(self) -> bool:
        """Actuate the most-recently-resolved element directly in JS (node-level).

        Used when the element's centre point is occluded, so a coordinate click
        would land on the covering element. Returns True if it clicked the node.
        """
        try:
            r = self._js(
                '(function(){var e=window.__proximaFoundEl;'
                'if(!e)return false;'
                'try{e.scrollIntoView({block:"center",inline:"center"});}catch(_){}'
                'try{e.click();return true;}catch(_){return false;}})()'
            )
            return bool(r)
        except Exception:
            return False

    def click(self, x: int | str, y: int = None, button="left", click_count=1):
        """Click at coordinates (x, y), or click an element by text/selector query if y is None."""
        if isinstance(x, str) or y is None:
            el = self._find_element(str(x), kind="any")
            if not el:
                raise RuntimeError(f"click('{x}') failed: element not found")
            # Occluded target → actuate the node directly instead of a blind
            # coordinate click that would hit the covering element. Only for a
            # plain left single-click (node .click() can't express right/double).
            if (not el.get("hittable", True)
                    and click_count == 1 and button == "left"
                    and self._click_found_node()):
                return
            x, y = el["x"], el["y"]
        btn = {"left": "left", "right": "right", "middle": "middle"}.get(button, "left")
        self._cdp("Input.dispatchMouseEvent", {
            "type": "mousePressed", "x": x, "y": y,
            "button": btn, "clickCount": click_count
        })
        self._cdp("Input.dispatchMouseEvent", {
            "type": "mouseReleased", "x": x, "y": y,
            "button": btn, "clickCount": click_count
        })

    def double_click(self, x: int | str, y: int = None):
        """Double click at coordinates (x, y), or on element by text/selector query if y is None."""
        if isinstance(x, str) or y is None:
            el = self._find_element(str(x), kind="any")
            if not el:
                raise RuntimeError(f"double_click('{x}') failed: element not found")
            x, y = el["x"], el["y"]
        self.click(x, y, click_count=2)

    def right_click(self, x: int | str, y: int = None):
        """Right click at coordinates (x, y), or on element by text/selector query if y is None."""
        if isinstance(x, str) or y is None:
            el = self._find_element(str(x), kind="any")
            if not el:
                raise RuntimeError(f"right_click('{x}') failed: element not found")
            x, y = el["x"], el["y"]
        self.click(x, y, button="right")

    def hover(self, x: int | str, y: int = None):
        """Hover at coordinates (x, y), or over element by text/selector query if y is None."""
        if isinstance(x, str) or y is None:
            el = self._find_element(str(x), kind="any")
            if not el:
                raise RuntimeError(f"hover('{x}') failed: element not found")
            x, y = el["x"], el["y"]
        self._cdp("Input.dispatchMouseEvent", {
            "type": "mouseMoved", "x": x, "y": y
        })

    def scroll(self, x: int, y: int, delta_x=0, delta_y=-300):
        """Low-level wheel scroll at position (x, y). delta_y NEGATIVE = scroll DOWN,
        positive = scroll UP. NOTE: the first two args are the POINTER position, not
        the scroll amount — prefer scroll_down()/scroll_up() below for clarity."""
        self._cdp("Input.dispatchMouseEvent", {
            "type": "mouseWheel", "x": x, "y": y,
            "deltaX": delta_x, "deltaY": delta_y
        })

    def scroll_down(self, amount: int = 600):
        """Scroll the page DOWN by `amount` pixels (clear, unambiguous)."""
        self._cdp("Input.dispatchMouseEvent", {
            "type": "mouseWheel", "x": 0, "y": 0, "deltaX": 0, "deltaY": -abs(amount)
        })
        return f"Scrolled down {abs(amount)}px"

    def scroll_up(self, amount: int = 600):
        """Scroll the page UP by `amount` pixels (clear, unambiguous)."""
        self._cdp("Input.dispatchMouseEvent", {
            "type": "mouseWheel", "x": 0, "y": 0, "deltaX": 0, "deltaY": abs(amount)
        })
        return f"Scrolled up {abs(amount)}px"

    def drag(self, x1, y1, x2, y2, steps=10):
        """Drag from (x1,y1) to (x2,y2)."""
        self._cdp("Input.dispatchMouseEvent", {
            "type": "mousePressed", "x": x1, "y": y1, "button": "left"
        })
        for i in range(1, steps + 1):
            mx = x1 + (x2 - x1) * i // steps
            my = y1 + (y2 - y1) * i // steps
            self._cdp("Input.dispatchMouseEvent", {
                "type": "mouseMoved", "x": mx, "y": my, "button": "left"
            })
            time.sleep(0.02)
        self._cdp("Input.dispatchMouseEvent", {
            "type": "mouseReleased", "x": x2, "y": y2, "button": "left"
        })

    def type_text(self, text: str, delay=0.03):
        """Type text character by character."""
        for ch in text:
            self._cdp("Input.dispatchKeyEvent", {
                "type": "char", "text": ch
            })
            if delay:
                time.sleep(delay)

    def press(self, key: str):
        """Press a key (Enter, Tab, Escape, ArrowDown, etc.)."""
        key_map = {
            "enter": ("Enter", "\r", 13),
            "tab": ("Tab", "\t", 9),
            "escape": ("Escape", "\x1b", 27),
            "backspace": ("Backspace", "\b", 8),
            "delete": ("Delete", "", 46),
            "arrowup": ("ArrowUp", "", 38),
            "arrowdown": ("ArrowDown", "", 40),
            "arrowleft": ("ArrowLeft", "", 37),
            "arrowright": ("ArrowRight", "", 39),
            "space": (" ", " ", 32),
        }
        k = key_map.get(key.lower(), (key, "", 0))
        self._cdp("Input.dispatchKeyEvent", {
            "type": "keyDown", "key": k[0], "text": k[1],
            "windowsVirtualKeyCode": k[2], "nativeVirtualKeyCode": k[2]
        })
        self._cdp("Input.dispatchKeyEvent", {"type": "keyUp", "key": k[0]})

    def hotkey(self, *keys):
        """Press key combo (e.g., hotkey('ctrl', 'a'))."""
        modifiers = 0
        mod_map = {"ctrl": 2, "alt": 1, "shift": 8, "meta": 4}
        actual_key = keys[-1]
        for k in keys[:-1]:
            modifiers |= mod_map.get(k.lower(), 0)

        vk_map = {
            "a": 65, "c": 67, "v": 86, "x": 88, "z": 90,
            "s": 83, "f": 70, "l": 76, "t": 84, "w": 87,
        }
        vk = vk_map.get(actual_key.lower(), ord(actual_key.upper()) if len(actual_key) == 1 else 0)

        self._cdp("Input.dispatchKeyEvent", {
            "type": "keyDown", "key": actual_key, "modifiers": modifiers,
            "windowsVirtualKeyCode": vk
        })
        self._cdp("Input.dispatchKeyEvent", {
            "type": "keyUp", "key": actual_key, "modifiers": modifiers
        })

    def tap(self, x: int, y: int):
        """Touch tap at coordinates."""
        self._cdp("Input.dispatchTouchEvent", {
            "type": "touchStart",
            "touchPoints": [{"x": x, "y": y}]
        })
        time.sleep(0.05)
        self._cdp("Input.dispatchTouchEvent", {
            "type": "touchEnd", "touchPoints": []
        })

    def swipe(self, x1, y1, x2, y2, duration=0.3):
        """Touch swipe from (x1,y1) to (x2,y2)."""
        steps = 10
        self._cdp("Input.dispatchTouchEvent", {
            "type": "touchStart",
            "touchPoints": [{"x": x1, "y": y1}]
        })
        for i in range(1, steps + 1):
            mx = x1 + (x2 - x1) * i // steps
            my = y1 + (y2 - y1) * i // steps
            self._cdp("Input.dispatchTouchEvent", {
                "type": "touchMove",
                "touchPoints": [{"x": mx, "y": my}]
            })
            time.sleep(duration / steps)
        self._cdp("Input.dispatchTouchEvent", {
            "type": "touchEnd", "touchPoints": []
        })

    def long_press(self, x: int, y: int, duration=1.0):
        """Long press / touch hold."""
        self._cdp("Input.dispatchTouchEvent", {
            "type": "touchStart",
            "touchPoints": [{"x": x, "y": y}]
        })
        time.sleep(duration)
        self._cdp("Input.dispatchTouchEvent", {
            "type": "touchEnd", "touchPoints": []
        })

    def pinch(self, cx, cy, start_dist=100, end_dist=50):
        """Pinch zoom. start_dist > end_dist = zoom out."""
        steps = 10
        self._cdp("Input.dispatchTouchEvent", {
            "type": "touchStart",
            "touchPoints": [
                {"x": cx - start_dist, "y": cy},
                {"x": cx + start_dist, "y": cy}
            ]
        })
        for i in range(1, steps + 1):
            d = start_dist + (end_dist - start_dist) * i // steps
            self._cdp("Input.dispatchTouchEvent", {
                "type": "touchMove",
                "touchPoints": [
                    {"x": cx - d, "y": cy},
                    {"x": cx + d, "y": cy}
                ]
            })
            time.sleep(0.03)
        self._cdp("Input.dispatchTouchEvent", {
            "type": "touchEnd", "touchPoints": []
        })

    # Universal element finder. Uses 6 strategies: CSS selectors, XPath, aria attributes,
    # placeholder/label text, Shadow DOM traversal, iframe search.
    # Returns {x, y, tag, mode, frame} or None.

    def _find_element(self, query: str, kind: str = "any", timeout: float = 5.0) -> dict | None:
        """Universal element finder. Tries multiple strategies with timeout.

        Args:
            query: text, placeholder, label, aria-label, CSS selector, or XPath
            kind: 'input' (fillable), 'clickable', or 'any'
            timeout: max seconds to wait for element to appear

        Returns dict with {x, y, tag, mode, found} or None
        """
        q = query.replace("\\", "\\\\").replace("'", "\\'").replace('"', '\\"').replace("\n", " ").replace("\r", " ")
        q_lower = q.lower()

        input_selectors = (
            'input[type="text"], input[type="search"], input[type="email"], '
            'input[type="url"], input[type="password"], input[type="number"], '
            'input[type="tel"], input:not([type]), textarea, '
            '[contenteditable="true"], [contenteditable=""], [role="textbox"], '
            '[role="combobox"], [role="searchbox"]'
        )
        click_selectors = (
            'a, button, [role="button"], [role="link"], [role="menuitem"], '
            'input[type="submit"], input[type="button"], input[type="checkbox"], '
            'input[type="radio"], [onclick], [tabindex], label, summary, '
            'details, [data-testid], [role="tab"], [role="option"]'
        )

        find_js = f'''
        (function() {{
            var q = "{q}";
            var qLow = "{q_lower}";
            var kind = "{kind}";

            var SEMANTIC_MAP = {{
                "subject": ["subject", "subjectbox", "subject-line"],
                "to": ["to", "recipient", "recipients"],
                "body": ["body", "message body", "email body", "content", "editor"],
                "cc": ["cc"],
                "bcc": ["bcc"],
                "search": ["search", "query", "find"],
                "password": ["password", "passcode"]
            }};

            var searchTerms = [qLow];
            for (var key in SEMANTIC_MAP) {{
                if (key === qLow || SEMANTIC_MAP[key].includes(qLow)) {{
                    searchTerms = SEMANTIC_MAP[key];
                    break;
                }}
            }}

            function matchValue(val) {{
                if (!val) return false;
                var valLow = val.toLowerCase();
                return searchTerms.some(function(term) {{
                    return valLow.includes(term);
                }});
            }}

            // ── Helper: visibility check (skip hidden / zero-opacity / unrendered) ──
            function isVisible(el) {{
                try {{
                    var s = window.getComputedStyle(el);
                    if (s) {{
                        if (s.visibility === "hidden" || s.display === "none") return false;
                        if (parseFloat(s.opacity) === 0) return false;
                        if (el.offsetParent === null && s.position !== "fixed") return false;
                    }}
                }} catch(e) {{}}
                return true;
            }}

            // ── Helper: get center coords (visible + occlusion-aware) ──
            function coords(el) {{
                if (!isVisible(el)) return null;
                try {{ el.scrollIntoView({{block: "center", inline: "center", behavior: "instant"}}); }} catch(e) {{}}
                var r = el.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0) return null;
                var cx = Math.round(r.x + r.width/2);
                var cy = Math.round(r.y + r.height/2);
                // Occlusion: is THIS element the topmost hittable node at its centre?
                // If something covers it (sticky header / modal / overlay) a blind
                // coordinate click would hit the WRONG element — flag it so the
                // caller can actuate the node directly instead.
                var hittable = true;
                try {{
                    var topEl = document.elementFromPoint(cx, cy);
                    if (topEl) hittable = (topEl === el || el.contains(topEl) || topEl.contains(el));
                }} catch(e) {{}}
                // Stash the resolved node so the caller can do a node-level
                // .click()/.focus() fallback when the centre point is occluded.
                try {{ window.__proximaFoundEl = el; }} catch(e) {{}}
                return {{x: cx, y: cy, tag: el.tagName, hittable: hittable}};
            }}

            // ── Helper: relevance score for an ambiguous match ──
            // EVERY element-targeting action (click, write_text, select,
            // toggle_check, hover, ...) funnels through _find_element. When
            // several elements match the same query, DOM order is meaningless —
            // returning the first match picked the wrong control. This scores
            // candidates so the RIGHT one wins, with criteria that depend on the
            // action ("click" vs "input"). Pure read (no scrollIntoView side
            // effect) so it is safe on every candidate; -1 = "not a usable target".
            function elementScore(el, mode) {{
                if (!isVisible(el)) return -1;
                var r = el.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0) return -1;
                var score = 0;
                var tag = el.tagName;
                var role = (el.getAttribute('role') || '').toLowerCase();
                var testid = (el.getAttribute('data-testid') || '').toLowerCase();
                // On-screen elements beat off-screen ones for every action.
                var vh = window.innerHeight || 0, vw = window.innerWidth || 0;
                if (r.top >= 0 && r.left >= 0 && r.bottom <= vh && r.right <= vw) score += 15;
                var area = r.width * r.height;
                if (mode === 'input') {{
                    // Fillable target: must be editable; never a disabled/readonly one.
                    var editable = el.isContentEditable || role === 'textbox' || role === 'searchbox' ||
                                   tag === 'TEXTAREA' || tag === 'INPUT';
                    if (editable) score += 30;
                    if (el.disabled || el.readOnly) score -= 60;  // never type into a locked field
                    if (area >= 1500) score += 5;                 // prefer real fields over tiny ones
                }} else {{
                    // Action control: a real button beats a same-labelled nav link.
                    if (tag === 'BUTTON' || role === 'button' || el.type === 'submit') score += 30;
                    if (testid.indexOf('button') !== -1 || testid.indexOf('submit') !== -1 ||
                        testid.indexOf('tweet') !== -1 || testid.indexOf('send') !== -1) score += 25;
                    if (tag === 'A') score -= 10;
                    if (el.disabled || el.getAttribute('aria-disabled') === 'true') score -= 60;
                    // De-prioritize page chrome: nav bars, sidebars, headers, banners.
                    try {{
                        if (el.closest && el.closest('nav, [role="navigation"], aside, header, [role="banner"]')) score -= 40;
                    }} catch(e) {{}}
                    if (area > 0 && area < 40000) score += 10;  // compact controls
                }}
                return score;
            }}

            // ── Helper: pick the best-scoring candidate from a list ──
            function bestByScore(cands, mode) {{
                var best = null, bestScore = -1;
                for (var i = 0; i < cands.length; i++) {{
                    var sc = elementScore(cands[i], mode);
                    if (sc > bestScore) {{ bestScore = sc; best = cands[i]; }}
                }}
                return best;
            }}

            // ── Helper: get semantic role ──
            function getSemanticRole(el) {{
                var checks = [
                    el.placeholder || '',
                    el.getAttribute('aria-label') || '',
                    el.getAttribute('aria-placeholder') || '',
                    el.getAttribute('data-placeholder') || '',
                    el.name || '',
                    el.id || '',
                    el.title || ''
                ];
                if (el.id) {{
                    var lbl = document.querySelector('label[for="' + el.id + '"]');
                    if (lbl) checks.push(lbl.textContent.trim());
                }}
                var combined = checks.join(' ').toLowerCase();
                for (var key in SEMANTIC_MAP) {{
                    var aliases = SEMANTIC_MAP[key];
                    for (var a of aliases) {{
                        if (combined.includes(a)) return key;
                    }}
                }}
                return null;
            }}

            // ── Helper: match by attrs ──
            function matchAttrs(el) {{
                var checks = [
                    el.placeholder || '',
                    el.getAttribute('aria-label') || '',
                    el.getAttribute('aria-placeholder') || '',
                    el.getAttribute('data-placeholder') || '',
                    el.getAttribute('data-testid') || '',
                    el.name || '',
                    el.id || '',
                    el.title || ''
                ];
                // Associated <label>
                if (el.id) {{
                    var lbl = document.querySelector('label[for="' + el.id + '"]');
                    if (lbl) checks.push(lbl.textContent.trim());
                }}
                // Labels via aria-labelledby
                var lblBy = el.getAttribute('aria-labelledby');
                if (lblBy) {{
                    var lblEl = document.getElementById(lblBy);
                    if (lblEl) checks.push(lblEl.textContent.trim());
                }}
                for (var c of checks) {{
                    if (c && matchValue(c)) return true;
                }}
                return false;
            }}

            // ── Helper: match text content (for clickable) ──
            function matchText(el) {{
                var t = (el.textContent || el.value || el.ariaLabel || '').trim();
                return matchValue(t);
            }}

            // ── Helper: search in a document/shadow root ──
            function searchIn(root) {{
                // Strategy 1: CSS selector (if query looks like one)
                if (/^[#.\\[a-zA-Z]/.test(q) && (q.includes('.') || q.includes('#') || q.includes('[') || q.includes(' > '))) {{
                    try {{
                        var el = root.querySelector(q);
                        if (el) {{
                            var c = coords(el);
                            if (c) return {{...c, mode: 'css', found: q}};
                        }}
                    }} catch(e) {{}}
                }}

                // Strategy 0: Semantic Role Match (if query matches a semantic role)
                var targetSemanticKey = null;
                for (var key in SEMANTIC_MAP) {{
                    if (key === qLow || SEMANTIC_MAP[key].includes(qLow)) {{
                        targetSemanticKey = key;
                        break;
                    }}
                }}
                if (targetSemanticKey && (kind === 'input' || kind === 'any')) {{
                    var inputs;
                    try {{ inputs = root.querySelectorAll('{input_selectors}'); }} catch(e) {{ inputs = []; }}
                    var semCands = [];
                    for (var el of inputs) {{
                        if (getSemanticRole(el) === targetSemanticKey) semCands.push(el);
                    }}
                    var semBest = bestByScore(semCands, 'input');
                    if (semBest) {{
                        var c = coords(semBest);
                        if (c) {{
                            var isEditable = semBest.contentEditable === 'true' || semBest.getAttribute('role') === 'textbox';
                            return {{...c, mode: isEditable ? 'contenteditable' : 'input', found: 'semantic:' + targetSemanticKey}};
                        }}
                    }}
                }}

                // Strategy 2: Input elements by attributes (for fill)
                if (kind === 'input' || kind === 'any') {{
                    var inputs;
                    try {{ inputs = root.querySelectorAll('{input_selectors}'); }} catch(e) {{ inputs = []; }}
                    var attrCands = [];
                    for (var el of inputs) {{
                        if (matchAttrs(el)) attrCands.push(el);
                    }}
                    var attrBest = bestByScore(attrCands, 'input');
                    if (attrBest) {{
                        var c = coords(attrBest);
                        if (c) {{
                            var isEditable = attrBest.contentEditable === 'true' || attrBest.getAttribute('role') === 'textbox';
                            return {{...c, mode: isEditable ? 'contenteditable' : 'input', found: (attrBest.placeholder || attrBest.getAttribute('aria-label') || attrBest.name || '').substring(0,50)}};
                        }}
                    }}
                }}

                // Strategy 3: Clickable elements by text (for click)
                if (kind === 'clickable' || kind === 'any') {{
                    var clicks;
                    try {{ clicks = root.querySelectorAll('{click_selectors}'); }} catch(e) {{ clicks = []; }}
                    // Exact match pass — collect ALL exact-text matches and pick
                    // the most action-like one (a real submit BUTTON beats a
                    // same-labelled nav link / sidebar entry). Returning the first
                    // DOM match clicked the wrong "Post" on sites like X.
                    var exactCands = [];
                    for (var el of clicks) {{
                        var t = (el.textContent || el.value || el.ariaLabel || '').trim();
                        if (t === q || el.value === q || el.ariaLabel === q) exactCands.push(el);
                    }}
                    var exactBest = bestByScore(exactCands, 'click');
                    if (exactBest) {{
                        var c = coords(exactBest);
                        if (c) return {{...c, mode: 'clickable', found: (exactBest.textContent||exactBest.value||'').trim().substring(0,50)}};
                    }}
                    // Partial match pass — same relevance scoring.
                    var partCands = [];
                    for (var el of clicks) {{
                        if (matchText(el)) partCands.push(el);
                    }}
                    var partBest = bestByScore(partCands, 'click');
                    if (partBest) {{
                        var c = coords(partBest);
                        if (c) return {{...c, mode: 'clickable', found: (partBest.textContent||'').trim().substring(0,50)}};
                    }}
                }}

                // Strategy 4: Any element with matching placeholder/aria
                var allPlaceholder;
                try {{ allPlaceholder = root.querySelectorAll('[placeholder], [data-placeholder], [aria-placeholder], [aria-label]'); }} catch(e) {{ allPlaceholder = []; }}
                var phCands = [];
                for (var el of allPlaceholder) {{
                    if (!matchAttrs(el)) continue;
                    var isEd = el.contentEditable === 'true' || el.getAttribute('role') === 'textbox' || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
                    if (kind === 'input' && !isEd) continue;
                    if (kind === 'clickable' && isEd) continue;
                    phCands.push(el);
                }}
                var phBest = bestByScore(phCands, kind === 'clickable' ? 'click' : 'input');
                if (phBest) {{
                    var c = coords(phBest);
                    if (c) {{
                        var isEditable = phBest.contentEditable === 'true' || phBest.getAttribute('role') === 'textbox' || phBest.tagName === 'INPUT' || phBest.tagName === 'TEXTAREA';
                        return {{...c, mode: isEditable ? (phBest.contentEditable === 'true' ? 'contenteditable' : 'input') : 'clickable', found: (phBest.placeholder || phBest.getAttribute('aria-label') || '').substring(0,50)}};
                    }}
                }}

                // Strategy 5: XPath text search
                try {{
                    var xpath = document.evaluate('//*[contains(text(),"' + q.replace('"', '') + '")]',
                        root === document ? document : root, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                    if (xpath.singleNodeValue) {{
                        var el = xpath.singleNodeValue;
                        var c = coords(el);
                        if (c) {{
                            var tag = el.tagName.toLowerCase();
                            var isEditable = el.contentEditable === 'true' || el.getAttribute('role') === 'textbox' || tag === 'input' || tag === 'textarea';
                            if (kind === 'input' && !isEditable) {{
                                // Skip to fall through to Strategy 6 (Nearby Input)
                            }} else {{
                                return {{...c, mode: 'xpath', found: el.textContent.trim().substring(0,50)}};
                            }}
                        }}
                    }}
                }} catch(e) {{}}

                // Strategy 6: Nearby input - find label text, then sibling/child input (restricted to text inputs only)
                if (kind === 'input' || kind === 'any') {{
                    try {{
                        var allEls = root.querySelectorAll('*');
                        for (var i = allEls.length - 1; i >= 0; i--) {{
                            var el = allEls[i];
                            var t = el.textContent.trim().toLowerCase();
                            var ch = el.children.length;
                            if (ch < 5 && matchValue(t) && t.length < 150) {{
                                // Check parent tree for nearby input
                                var p = el.parentElement;
                                for (var up = 0; up < 4 && p; up++) {{
                                    var nearby = p.querySelector(
                                        'input[type="text"], input[type="search"], input[type="email"], ' +
                                        'input[type="url"], input[type="password"], input:not([type]), textarea, ' +
                                        '[contenteditable="true"], [contenteditable=""]'
                                    );
                                    if (nearby && nearby !== el) {{
                                        var c = coords(nearby);
                                        if (c) {{
                                            var isEditable = nearby.contentEditable === 'true' || nearby.getAttribute('role') === 'textbox';
                                            return {{...c, mode: isEditable ? 'contenteditable' : 'input', found: 'nearby:' + t.substring(0,30)}};
                                        }}
                                    }}
                                    p = p.parentElement;
                                }}
                            }}
                        }}
                    }} catch(e) {{}}
                }}

                return null;
            }}

            // ── Search main document ──
            var found = searchIn(document);
            if (found) return JSON.stringify(found);

            // ── Search Shadow DOMs ──
            try {{
                var allEls = document.querySelectorAll('*');
                for (var el of allEls) {{
                    if (el.shadowRoot) {{
                        found = searchIn(el.shadowRoot);
                        if (found) {{ found.shadow = true; return JSON.stringify(found); }}
                    }}
                }}
            }} catch(e) {{}}

            // ── Search iframes (same-origin only) ──
            try {{
                var frames = document.querySelectorAll('iframe');
                for (var f of frames) {{
                    try {{
                        var fdoc = f.contentDocument || f.contentWindow.document;
                        if (fdoc) {{
                            found = searchIn(fdoc);
                            if (found) {{
                                // Translate iframe-local coords to main-document viewport
                                var fr = f.getBoundingClientRect();
                                found.x += Math.round(fr.x);
                                found.y += Math.round(fr.y);
                                found.iframe = true;
                                return JSON.stringify(found);
                            }}
                        }}
                    }} catch(e) {{}}
                }}
            }} catch(e) {{}}

            return null;
        }})()
        '''

        deadline = time.time() + timeout
        while time.time() < deadline:
            result = self._js(find_js)
            if result and result != "null":
                try:
                    parsed = json.loads(result)
                except (json.JSONDecodeError, ValueError):
                    # Malformed JS return — treat as a miss and keep polling
                    # rather than raising out of the locator.
                    time.sleep(0.3)
                    continue
                # Brief settle delay — lets browser finish any pending layout
                # reflows (ad injection, lazy-load, SPA transitions) so the
                # coordinates we captured are final, not mid-shift.
                time.sleep(0.05)
                # Re-query to catch layout shifts during the settle. The recheck
                # is the freshest COMPLETE snapshot, so adopt it wholesale: copy
                # x/y AND occlusion/hittable together, so a real layout shift
                # can't leave stale first-pass values that pick the wrong click path.
                recheck = self._js(find_js)
                if recheck and recheck != "null":
                    try:
                        parsed = json.loads(recheck)
                    except (json.JSONDecodeError, ValueError):
                        pass  # keep the first valid parse
                return parsed
            time.sleep(0.3)

        return None

    def dump_interactive_elements(self) -> str:
        """Dump a list of visible, interactive elements on the screen as a JSON string.

        Extracts inputs, textareas, buttons, links, and elements with ARIA roles/click handlers,
        including their coordinates, roles, labels, and CSS selectors.
        """
        dump_js = '''
        (function() {
            var SEMANTIC_MAP = {
                "subject": ["subject", "subjectbox", "subject-line"],
                "to": ["to", "recipient", "recipients"],
                "body": ["body", "message body", "email body", "content", "editor"],
                "cc": ["cc"],
                "bcc": ["bcc"],
                "search": ["search", "query", "find"],
                "password": ["password", "passcode"]
            };

            function getSemanticRole(el) {
                var checks = [
                    el.placeholder || '',
                    el.getAttribute('aria-label') || '',
                    el.getAttribute('aria-placeholder') || '',
                    el.getAttribute('data-placeholder') || '',
                    el.name || '',
                    el.id || '',
                    el.title || ''
                ];
                var combined = checks.join(' ').toLowerCase();
                for (var key in SEMANTIC_MAP) {
                    var aliases = SEMANTIC_MAP[key];
                    for (var a of aliases) {
                        if (combined.includes(a)) return key;
                    }
                }
                return null;
            }

            var items = [];
            var selectors = [
                'a', 'button', 'input', 'textarea', 'select',
                '[role="button"]', '[role="link"]', '[role="textbox"]',
                '[role="checkbox"]', '[role="combobox"]', '[role="searchbox"]',
                '[onclick]', '[tabindex]'
            ];
            
            function coords(el) {
                var r = el.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0) return null;
                // Check if element is visible on screen
                var style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return null;
                return {
                    x: Math.round(r.x + r.width/2),
                    y: Math.round(r.y + r.height/2),
                    width: Math.round(r.width),
                    height: Math.round(r.height)
                };
            }

            function getCleanSelector(el) {
                if (el.id) return "#" + el.id;
                var name = el.getAttribute('name');
                if (name) return el.tagName.toLowerCase() + "[name='" + name + "']";
                var testId = el.getAttribute('data-testid');
                if (testId) return "[data-testid='" + testId + "']";
                var classes = Array.from(el.classList).filter(c => !c.includes('active') && !c.includes('focus')).join('.');
                if (classes) return el.tagName.toLowerCase() + "." + classes;
                return el.tagName.toLowerCase();
            }

            function getLabel(el) {
                var label = (el.placeholder || el.getAttribute('aria-label') || el.name || el.title || '').trim();
                if (!label && el.id) {
                    var lbl = document.querySelector('label[for="' + el.id + '"]');
                    if (lbl) label = lbl.textContent.trim();
                }
                if (!label) {
                    label = (el.textContent || '').trim().replace(/\\s+/g, ' ');
                }
                return label.substring(0, 100);
            }

            function process(root) {
                var els = root.querySelectorAll(selectors.join(','));
                for (var el of els) {
                    var c = coords(el);
                    if (!c) continue;
                    
                    var role = el.getAttribute('role') || el.tagName.toLowerCase();
                    if (el.tagName === 'INPUT') {
                        role = el.getAttribute('type') ? 'input-' + el.getAttribute('type') : 'input';
                    }
                    
                    var label = getLabel(el);
                    var sel = getCleanSelector(el);
                    var sem = getSemanticRole(el);
                    
                    items.push({
                        role: role,
                        label: label,
                        selector: sel,
                        semantic_role: sem || undefined,
                        x: c.x,
                        y: c.y,
                        w: c.width,
                        h: c.height
                    });
                }
            }

            process(document);
            
            // Search same-origin iframes
            try {
                var frames = document.querySelectorAll('iframe');
                for (var f of frames) {
                    try {
                        var fdoc = f.contentDocument || f.contentWindow.document;
                        if (fdoc) {
                            var beforeLen = items.length;
                            process(fdoc);
                            // Offset iframe-local coords to main-document viewport
                            var fr = f.getBoundingClientRect();
                            for (var i = beforeLen; i < items.length; i++) {
                                items[i].x += Math.round(fr.x);
                                items[i].y += Math.round(fr.y);
                            }
                        }
                    } catch(e) {}
                }
            } catch(e) {}

            return JSON.stringify(items.slice(0, 50)); // cap to 50 elements to prevent context bloating
        })()
        '''
        return self._js(dump_js)

    def wait_for(self, query: str, timeout: float = 10.0) -> dict:
        """Wait for an element to appear on the page. Returns element info or raises.

        Args:
            query: text, placeholder, CSS selector, etc.
            timeout: max seconds to wait

        Returns: {x, y, tag, mode, found}
        """
        el = self._find_element(query, kind="any", timeout=timeout)
        if not el:
            raise RuntimeError(f"wait_for('{query}') timed out after {timeout}s — element not found")
        return el

    def click_text(self, text: str, timeout: float = 5.0):
        """Find element by visible text and click it. Works on any website.

        Searches: buttons, links, roles, labels, spans, XPath text, Shadow DOM, iframes.
        Auto scrolls element into view. Raises RuntimeError if not found.
        """
        el = self._find_element(text, kind="clickable", timeout=timeout)
        if not el:
            raise RuntimeError(
                f"click_text('{text}') failed: element not found after {timeout}s. "
                f"Use b.elements() to list visible elements."
            )
        # Hittable centre → trusted CDP coordinate click (most reliable). Occluded
        # (sticky header / overlay / layout shift since resolve) → actuate the
        # resolved node directly so we never click the WRONG element.
        method = "coordinate"
        if el.get("hittable", True):
            self.click(int(el["x"]), int(el["y"]))
        elif self._click_found_node():
            method = "node"
        else:
            self.click(int(el["x"]), int(el["y"]))  # last resort
        time.sleep(0.2)
        tag = (el.get("tag") or "").lower()
        return f"[✓] Clicked '{el.get('found', text)}' <{tag}> via {method} at ({el['x']}, {el['y']})"

    def write_text(self, label: str, value: str, timeout: float = 5.0, verify: bool = True):
        """Write text into an input field by label/placeholder. Works on ANY website.

        Universal approach:
        - Finds element via 6 strategies (CSS, attrs, aria, XPath, Shadow DOM, iframes)
        - Waits up to `timeout` seconds for element to appear
        - Uses CDP Input.insertText (browser-engine level — works with React/Vue/Angular/Svelte/vanilla)
        - Verifies value was set (for standard inputs)
        - Raises RuntimeError on failure with debug hints

        Args:
            label: placeholder text, aria-label, label text, name, CSS selector, etc.
            value: text to fill
            timeout: max seconds to wait for element
            verify: if True, verify the value was set after filling
        """
        el = self._find_element(label, kind="input", timeout=timeout)
        if not el:
            raise RuntimeError(
                f"fill('{label}') failed: no input found after {timeout}s. "
                f"Debug: use b.elements() to see all inputs, or b.eval_js('document.querySelectorAll(\"input, textarea, [contenteditable]\").length')"
            )

        mode = el.get("mode", "input")

        # Occluded field → fill the resolved node directly in JS.
        # If the field's centre is covered (sticky header / overlay), the
        # coordinate click+type sequence below would target the COVERING element.
        # Fill the resolved node directly instead (focus + native value set +
        # input/change events). Gated on occlusion, so the trusted-event path
        # below is unchanged for the normal case. Falls through if the JS fails.
        if not el.get("hittable", True):
            esc = value.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n").replace("\r", "")
            ok = self._js(f'''
            (function() {{
                var el = window.__proximaFoundEl;
                if (!el) return false;
                try {{ el.scrollIntoView({{block:"center"}}); }} catch(_e) {{}}
                try {{ el.focus(); }} catch(_e) {{}}
                var isCE = el.isContentEditable || el.getAttribute('role') === 'textbox';
                if (isCE) {{
                    el.textContent = '{esc}';
                }} else {{
                    var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                    var setter = Object.getOwnPropertyDescriptor(proto, 'value');
                    if (setter && setter.set) {{ setter.set.call(el, '{esc}'); }} else {{ el.value = '{esc}'; }}
                }}
                try {{ el.dispatchEvent(new Event('input', {{bubbles:true}})); }} catch(_e) {{}}
                try {{ el.dispatchEvent(new Event('change', {{bubbles:true}})); }} catch(_e) {{}}
                return true;
            }})()
            ''')
            if ok:
                short = f"'{value[:40]}...'" if len(value) > 40 else f"'{value}'"
                return f"[✓] Filled '{label}' ({mode}, occluded→JS) with {short}"
            # else fall through to the trusted coordinate path below

        # Click to focus (trusted CDP event = works everywhere)
        self.click(int(el["x"]), int(el["y"]))
        time.sleep(0.15)

        # Focus verification & enforcement
        check_focus_js = f'''
        (function() {{
            var active = document.activeElement;
            if (!active) return {{ success: false, reason: "No active element" }};
            
            var tag = active.tagName.toLowerCase();
            var isContentEditable = active.contentEditable === 'true' || active.contentEditable === '' || active.isContentEditable;
            var isTextboxRole = active.getAttribute('role') === 'textbox' || active.getAttribute('role') === 'searchbox';
            var isEditableInput = tag === 'input' && !['checkbox', 'radio', 'button', 'submit', 'image', 'reset', 'file', 'range', 'color', 'hidden'].includes(active.type);
            var isTextArea = tag === 'textarea';
            var isEditable = isContentEditable || isTextboxRole || isEditableInput || isTextArea;
            
            if (!isEditable) {{
                return {{ success: false, reason: "Active element <" + tag + "> is not editable" }};
            }}
            
            var target = document.elementFromPoint({el["x"]}, {el["y"]});
            if (!target) return {{ success: true }}; // Target not resolvable, assume ok
            
            var curr = target;
            for (var i = 0; i < 5 && curr; i++) {{
                if (curr === active || active.contains(curr) || curr.contains(active)) {{
                    return {{ success: true }};
                }}
                curr = curr.parentElement;
            }}
            
            if (target.tagName.toLowerCase() === 'label') {{
                if (target.htmlFor && document.getElementById(target.htmlFor) === active) return {{ success: true }};
                if (target.contains(active)) return {{ success: true }};
            }}
            if (active.id) {{
                var lbl = document.querySelector('label[for="' + active.id + '"]');
                if (lbl && (lbl === target || lbl.contains(target) || target.contains(lbl))) return {{ success: true }};
            }}
            
            var activeRoot = active.getRootNode();
            if (activeRoot && activeRoot.host) {{
                var host = activeRoot.host;
                var curr = target;
                for (var i = 0; i < 5 && curr; i++) {{
                    if (curr === host || host.contains(curr) || curr.contains(host)) {{
                        return {{ success: true }};
                    }}
                    curr = curr.parentElement;
                }}
            }}
            
            return {{ success: false, reason: "Active element <" + tag + "> is not related to clicked target <" + target.tagName.toLowerCase() + ">" }};
        }})()
        '''

        raw_status = self._js(f"JSON.stringify({check_focus_js})")
        status = {}
        if raw_status:
            try:
                status = json.loads(raw_status)
            except Exception:
                pass

        if not status.get("success"):
            # Try to force focus the target element directly via JS
            focused_via_js = self._js(f'''
            (function() {{
                var target = document.elementFromPoint({el["x"]}, {el["y"]});
                if (!target) return false;
                
                var curr = target;
                for (var i = 0; i < 5 && curr; i++) {{
                    var tag = curr.tagName.toLowerCase();
                    var isEditable = curr.contentEditable === 'true' || curr.contentEditable === '' || curr.getAttribute('role') === 'textbox' ||
                                     tag === 'textarea' || (tag === 'input' && !['checkbox', 'radio', 'button', 'submit', 'image', 'reset', 'file', 'range', 'color', 'hidden'].includes(curr.type));
                    if (isEditable) {{
                        curr.focus();
                        return true;
                    }}
                    curr = curr.parentElement;
                }}
                return false;
            }})()
            ''')
            if focused_via_js:
                time.sleep(0.1)
                raw_status = self._js(f"JSON.stringify({check_focus_js})")
                if raw_status:
                    try:
                        status = json.loads(raw_status)
                    except Exception:
                        pass
            
            if not status.get("success"):
                raise RuntimeError(
                    f"write_text('{label}') failed: focus validation failed. "
                    f"Reason: {status.get('reason', 'unknown')}. "
                    f"Active element remains <{self._js('document.activeElement.tagName')}>."
                )

        # Triple-click to select all (more reliable than Ctrl+A on some sites)
        self.click(int(el["x"]), int(el["y"]), click_count=3)
        time.sleep(0.1)

        self.press("Backspace")
        time.sleep(0.1)

        # Type using Input.insertText (browser-engine level)
        self._cdp("Input.insertText", {"text": value})
        time.sleep(0.2)

        # Dispatch extra events for edge-case frameworks that need them
        self._js('''
        (function() {
            var el = document.activeElement;
            if (!el) return;
            try { el.dispatchEvent(new Event('input', {bubbles: true})); } catch(e) {}
            try { el.dispatchEvent(new Event('change', {bubbles: true})); } catch(e) {}
            try { el.dispatchEvent(new InputEvent('input', {bubbles: true, data: null, inputType: 'insertText'})); } catch(e) {}
        })()
        ''')

        # Universal verification + escalation. Works for <input>/<textarea> AND
        # contenteditable / role=textbox rich editors (X composer, Gmail body,
        # Notion, etc.). Re-setting a field value is IDEMPOTENT, so escalating is
        # safe here (unlike click retries, which could double-submit). If the
        # value still can't be verified, we return an honest "[!]" instead of a
        # false "[✓]" so the agent re-checks instead of trusting a silent fail.
        verified = True
        if verify:
            time.sleep(0.1)

            # Read back the current value across every editable mode. "__SKIP__"
            # means an editor we cannot reliably read (treated as best-effort OK).
            read_js = '''
            (function() {
                var el = window.__proximaFoundEl || document.activeElement;
                if (!el) return "__NONE__";
                if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return el.value || '';
                if (el.isContentEditable || el.getAttribute('role') === 'textbox')
                    return (el.innerText || el.textContent || '');
                return "__SKIP__";
            })()
            '''

            def _landed(actual: str) -> bool:
                # Substring (not equality): editors may add a trailing newline,
                # zero-width chars, or formatting around the inserted text.
                return actual not in ("__NONE__", "__SKIP__") and value in actual

            actual = self._js(read_js) or ""
            if actual != "__SKIP__" and not _landed(actual):
                # Escalate: robustly set the resolved node directly for BOTH
                # modes, then fire the events frameworks listen for.
                esc = (value.replace("\\", "\\\\").replace("'", "\\'")
                            .replace("\n", "\\n").replace("\r", "")
                            .replace("\u2028", " ").replace("\u2029", " "))
                self._js(f'''
                (function() {{
                    var el = window.__proximaFoundEl || document.activeElement;
                    if (!el) return;
                    try {{ el.focus(); }} catch(_e) {{}}
                    var v = '{esc}';
                    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {{
                        var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                        var setter = Object.getOwnPropertyDescriptor(proto, 'value');
                        if (setter && setter.set) {{ setter.set.call(el, v); }} else {{ el.value = v; }}
                    }} else if (el.isContentEditable || el.getAttribute('role') === 'textbox') {{
                        try {{
                            var s = window.getSelection(), rg = document.createRange();
                            rg.selectNodeContents(el); s.removeAllRanges(); s.addRange(rg);
                        }} catch(_e) {{}}
                        var inserted = false;
                        try {{ inserted = document.execCommand('insertText', false, v); }} catch(_e) {{}}
                        if (!inserted) {{ el.textContent = v; }}
                    }}
                    try {{ el.dispatchEvent(new InputEvent('input', {{bubbles: true, inputType: 'insertText', data: v}})); }}
                    catch(_e) {{ try {{ el.dispatchEvent(new Event('input', {{bubbles: true}})); }} catch(__e) {{}} }}
                    try {{ el.dispatchEvent(new Event('change', {{bubbles: true}})); }} catch(_e) {{}}
                }})()
                ''')
                time.sleep(0.12)
                actual = self._js(read_js) or ""

            verified = actual == "__SKIP__" or _landed(actual)

        short = f"'{value[:40]}...'" if len(value) > 40 else f"'{value}'"
        if verify and not verified:
            return (
                f"[!] Filled '{label}' ({mode}) with {short} but could NOT verify the value "
                f"landed in the field. It may use a custom editor or the wrong field was "
                f"targeted. Re-check with b.read_content() / b.elements() before assuming "
                f"success — do NOT proceed as if this worked."
            )
        return f"[✓] Filled '{label}' ({mode}) with {short}"

    def select(self, label: str, option: str, timeout: float = 5.0):
        """Select option from a <select> dropdown. Works on any website.

        Args:
            label: placeholder, aria-label, name, id, or visible label text
            option: the option text or value to select (case-insensitive substring)
        """
        el = self._find_element(label, kind="input", timeout=timeout)
        if not el:
            raise RuntimeError(f"select('{label}') failed: dropdown not found")

        x = int(el["x"])
        y = int(el["y"])

        def _esc(s: str) -> str:
            # Escape for a single-quoted JS string literal. U+2028/U+2029 are
            # valid line terminators inside JS string literals and would break
            # the script, so neutralize them too.
            return (s.replace("\\", "\\\\").replace("'", "\\'")
                     .replace("\n", " ").replace("\r", " ")
                     .replace("\u2028", " ").replace("\u2029", " "))

        opt_escaped = _esc(option).lower()
        lbl_escaped = _esc(label).lower()
        result = self._js(f'''
        (function() {{
            var want = '{opt_escaped}';
            var label = '{lbl_escaped}';

            function applyOption(sel) {{
                if (!sel || sel.tagName !== 'SELECT') return false;
                for (var i = 0; i < sel.options.length; i++) {{
                    var opt = sel.options[i];
                    if (opt.text.trim().toLowerCase().indexOf(want) !== -1 ||
                        (opt.value || '').toLowerCase().indexOf(want) !== -1) {{
                        sel.value = opt.value;
                        sel.selectedIndex = i;
                        sel.dispatchEvent(new Event('input', {{bubbles: true}}));
                        sel.dispatchEvent(new Event('change', {{bubbles: true}}));
                        return opt.text.trim();
                    }}
                }}
                return false;
            }}

            // 1) Use the element _find_element located (by coordinates): walk up
            //    from that point to the nearest <select>. This is the reliable
            //    path — the OLD code read document.activeElement (nothing focuses
            //    the dropdown, so it was almost always wrong → 'no_select').
            var sel = null;
            var node = document.elementFromPoint({x}, {y});
            while (node && node.tagName !== 'SELECT' && node !== document.body) {{
                node = node.parentElement;
            }}
            if (node && node.tagName === 'SELECT') sel = node;
            if (!sel) {{
                var pt = document.elementFromPoint({x}, {y});
                if (pt && pt.querySelector) sel = pt.querySelector('select');
            }}

            var picked = applyOption(sel);
            if (picked) return 'selected:' + picked;

            // 2) Fallback: match a <select> by label across the document.
            var selects = document.querySelectorAll('select');
            for (var s of selects) {{
                var meta = ((s.getAttribute('aria-label')||'') + ' ' +
                            (s.getAttribute('name')||'') + ' ' +
                            (s.id||'') + ' ' +
                            (s.getAttribute('placeholder')||'')).toLowerCase();
                var assoc = '';
                if (s.id) {{
                    var lbl = document.querySelector("label[for='" + s.id + "']");
                    if (lbl) assoc = (lbl.textContent || '').toLowerCase();
                }}
                if (label && (meta.indexOf(label) !== -1 || assoc.indexOf(label) !== -1)) {{
                    var pk = applyOption(s);
                    if (pk) return 'selected:' + pk;
                }}
            }}

            // 3) Last resort: if there is exactly ONE <select> on the page, use
            //    it. (Never guess among multiple — that risks the wrong field.)
            if (selects.length === 1) {{
                var pk2 = applyOption(selects[0]);
                if (pk2) return 'selected:' + pk2;
            }}

            return selects.length === 0 ? 'no_select' : 'option_not_found';
        }})()
        ''')
        if result and result.startswith('selected:'):
            return f"[✓] Selected '{result[9:]}' in '{label}'"
        if result == 'option_not_found':
            raise RuntimeError(
                f"select('{label}', '{option}') failed: option '{option}' "
                f"not found in the matched dropdown"
            )
        raise RuntimeError(
            f"select('{label}', '{option}') failed: no <select> dropdown found "
            f"({result or 'no result'})"
        )

    def toggle_check(self, label: str, checked: bool = True, timeout: float = 5.0):
        """Toggle a checkbox/radio on/off. Works on any website."""
        el = self._find_element(label, kind="any", timeout=timeout)
        if not el:
            raise RuntimeError(f"check('{label}') failed: element not found")
        self.click(int(el["x"]), int(el["y"]))
        time.sleep(0.1)
        return f"[✓] {'Checked' if checked else 'Unchecked'} '{label}'"

    def read_text(self) -> str:
        """Read all visible text from page (raw innerText).

        For STRUCTURED extraction prefer read_content() (clean article/page
        text, no nav/ads) or extract_records() (repeated items as a list).
        """
        return self._js("document.body.innerText")

    def _ensure_extractor(self):
        """Inject the universal structured-extraction JS once per page."""
        try:
            has = self._js("(window.__proximaExtract && window.__proximaExtract.__v >= 1) ? '1' : ''")
        except Exception:
            has = ""
        if has != "1":
            from .web_extract import EXTRACTOR_JS
            self._js(EXTRACTOR_JS)

    def read_content(self, max_chars: int = 20000) -> str:
        """Read the page's MAIN content as clean Markdown — universal.

        Strips nav, ads, cookie banners, headers/footers and other chrome, and
        returns just the real article/page content with headings, lists, links
        and tables preserved. Works on ANY site (readability-style heuristic,
        no site-specific selectors). Use this instead of read_text() when you
        want the actual content, not the whole noisy page.

        Returns a Markdown string (title + url header + content).
        """
        self._ensure_extractor()
        raw = self._js(f"JSON.stringify(window.__proximaExtract.content({int(max_chars)}))")
        try:
            data = json.loads(raw) if raw else {}
        except Exception:
            data = {}
        if not data or not data.get("content"):
            # Graceful fallback — never return nothing.
            return (self.read_text() or "")[:max_chars]
        header = f"# {data.get('title','')}\n{data.get('url','')}\n\n"
        return header + data.get("content", "")

    def extract_records(self, limit: int = 60) -> list:
        """Extract repeated items (any listing, results, rows, feed) as a LIST.

        Auto-detects the dominant repeated structure on the page — a table, a
        grid of cards, a list of results — and returns a list of generic dicts,
        e.g. [{'title':..., 'text':..., 'url':..., 'image':...}, ...]. Site-agnostic:
        reasons about DOM repetition/semantics, not any specific website, and stays
        purely structural (no domain concepts baked in).

        Returns:
            list[dict]. Empty list if no repeated structure is found (in which
            case use read_content() for the page's main text instead).

        Tip: feed THIS to your logic instead of regex-parsing read_text() — it's
        already structured. Derive whatever you need (a number, a date, a status)
        from each record's 'text'/'title' yourself.
        """
        self._ensure_extractor()
        raw = self._js(f"JSON.stringify(window.__proximaExtract.records({int(limit)}))")
        try:
            data = json.loads(raw) if raw else {}
        except Exception:
            data = {}
        return data.get("records", []) if isinstance(data, dict) else []

    def extract(self, limit: int = 60) -> dict:
        """Smart read: returns {kind, records, content} — universal.

        kind='table'/'list' → 'records' has structured items.
        kind='text'         → 'content' has clean main-content Markdown.
        Lets you (or the model) pick structured data when present, text otherwise.
        """
        self._ensure_extractor()
        raw = self._js(f"JSON.stringify(window.__proximaExtract.records({int(limit)}))")
        try:
            data = json.loads(raw) if raw else {}
        except Exception:
            data = {}
        if not isinstance(data, dict):
            return {"kind": "text", "records": [], "content": (self.read_text() or "")[:20000]}
        if data.get("kind") == "text" and not data.get("content"):
            data["content"] = self.read_content()
        data.setdefault("records", [])
        data.setdefault("content", "")
        return data

    def read_html(self) -> str:
        """Read page HTML source."""
        return self._js("document.documentElement.outerHTML")

    def elements(self, selector=None) -> str:
        """List ALL interactive elements with positions.

        Includes: inputs, textareas, buttons, links, contenteditable, role=textbox,
        dropdowns, checkboxes — everything an agent might interact with.
        """
        sel = selector or (
            "a, button, input, textarea, select, "
            "[role='button'], [role='textbox'], [role='combobox'], [role='searchbox'], "
            "[role='link'], [role='menuitem'], [role='option'], [role='tab'], "
            "[contenteditable='true'], [contenteditable=''], "
            "[tabindex], [onclick]"
        )
        js = f'''
        (function() {{
            var SEMANTIC_MAP = {{
                "subject": ["subject", "subjectbox", "subject-line"],
                "to": ["to", "recipient", "recipients"],
                "body": ["body", "message body", "email body", "content", "editor"],
                "cc": ["cc"],
                "bcc": ["bcc"],
                "search": ["search", "query", "find"],
                "password": ["password", "passcode"]
            }};

            function getSemanticRole(el) {{
                var checks = [
                    el.placeholder || '',
                    el.getAttribute('aria-label') || '',
                    el.getAttribute('aria-placeholder') || '',
                    el.getAttribute('data-placeholder') || '',
                    el.name || '',
                    el.id || '',
                    el.title || ''
                ];
                var combined = checks.join(' ').toLowerCase();
                for (var key in SEMANTIC_MAP) {{
                    var aliases = SEMANTIC_MAP[key];
                    for (var a of aliases) {{
                        if (combined.includes(a)) return key;
                    }}
                }}
                return null;
            }}

            var allElements = [];
            function collect(root, isShadow) {{
                var els = root.querySelectorAll("{sel}");
                els.forEach(function(el) {{
                    allElements.push({{ el: el, isShadow: isShadow }});
                }});
                
                // Find nested shadow roots
                var all = root.querySelectorAll("*");
                all.forEach(function(el) {{
                    if (el.shadowRoot) {{
                        collect(el.shadowRoot, true);
                    }}
                }});
            }}
            collect(document, false);

            var temp = [];
            allElements.forEach(function(item) {{
                var el = item.el;
                var r = el.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0) return;
                
                var tag = el.tagName.toLowerCase();
                var isInput = tag === 'input' || tag === 'textarea' || tag === 'select' || el.contentEditable === 'true' || el.contentEditable === '';
                
                var x = Math.round(r.x + r.width/2);
                var y = Math.round(r.y + r.height/2);
                
                temp.push({{
                    el: el,
                    tag: tag + (item.isShadow ? '(shadow)' : ''),
                    isInput: isInput,
                    x: x,
                    y: y
                }});
            }});
            
            var coordMap = {{}};
            temp.forEach(function(item) {{
                var key = item.x + ',' + item.y;
                if (!coordMap[key]) {{
                    coordMap[key] = [];
                }}
                coordMap[key].push(item);
            }});
            
            var filtered = [];
            for (var key in coordMap) {{
                var group = coordMap[key];
                var inputs = group.filter(function(item) {{ return item.isInput; }});
                if (inputs.length > 0) {{
                    inputs.forEach(function(item) {{
                        filtered.push(item);
                    }});
                }} else {{
                    filtered.push(group[0]);
                }}
            }}
            
            var result = [];
            filtered.forEach(function(item) {{
                var el = item.el;
                var text = (el.placeholder || el.getAttribute('aria-label') || el.value || el.textContent || '').trim().substring(0, 60);
                var type = el.type || el.getAttribute('role') || '';
                if (el.contentEditable === 'true' || el.contentEditable === '') type = 'editable';
                
                var sem = getSemanticRole(el);
                
                result.push({{
                    i: result.length,
                    tag: item.tag,
                    type: type,
                    text: text,
                    semantic: sem || '',
                    x: item.x,
                    y: item.y
                }});
            }});
            return JSON.stringify(result);
        }})()
        '''
        raw = self._js(js)
        if not raw:
            return "No elements found"
        items = json.loads(raw)
        lines = []
        for el in items:
            sem_part = f" [semantic: {el['semantic']}]" if el.get('semantic') else ""
            lines.append(f"  [{el['i']}] <{el['tag']}>{sem_part} {el['type']} \"{el['text']}\" @ ({el['x']}, {el['y']})")
        return f"Found {len(items)} elements:\n" + "\n".join(lines)

    def find_element(self, text: str, timeout: float = 3.0) -> dict | None:
        """Find any element by text. Returns {tag, text, x, y} or None."""
        return self._find_element(text, kind="any", timeout=timeout)

    def run_js(self, code: str) -> str:
        """Run arbitrary JavaScript on the page."""
        return self._js(code)

    def screenshot(self, path: str = "screenshot.png"):
        """Take screenshot and save to file."""
        r = self._cdp("Page.captureScreenshot", {"format": "png"})
        data = r.get("result", {}).get("data", "")
        if data:
            img_bytes = base64.b64decode(data)
            Path(path).parent.mkdir(parents=True, exist_ok=True)
            with open(path, "wb") as f:
                f.write(img_bytes)
            result = f"Screenshot saved: {path} ({len(img_bytes):,} bytes)"
            # Auto-queue this image so the model sees it on the next message.
            try:
                from proxima_agent.tools.attach import note_screenshot
                result += note_screenshot(path)
            except Exception:
                pass
            return result
        return "Screenshot failed"

    def new_tab(self, url="about:blank"):
        """Open new tab."""
        req = urllib.request.Request(f"{CDP_URL}/json/new?{url}", data=b"")
        urllib.request.urlopen(req, timeout=5)
        time.sleep(1)
        self._connect_tab(-1)  # connect to newest tab

    def close_tab(self):
        """Close current tab."""
        tabs = self._get_tabs()
        page_tabs = [t for t in tabs if self._is_webpage_tab(t)]
        if len(page_tabs) > 1:
            tab_id = page_tabs[-1]["id"]
            req = urllib.request.Request(f"{CDP_URL}/json/close/{tab_id}", data=b"")
            urllib.request.urlopen(req, timeout=5)
            time.sleep(0.5)
            self._connect_tab(0)

    def tabs(self) -> str:
        """List all open tabs."""
        tabs = self._get_tabs()
        page_tabs = [t for t in tabs if self._is_webpage_tab(t)]
        lines = []
        # Enumerate the FILTERED page list so the displayed [i] matches the index
        # _connect_tab(index) expects (it indexes into page_tabs, not all targets).
        for i, t in enumerate(page_tabs):
            lines.append(f"  [{i}] {t.get('title', '?')[:50]} — {t.get('url', '?')[:60]}")
        return f"{len(lines)} tabs:\n" + "\n".join(lines)

    def close(self):
        """Close WebSocket connection (Chrome stays running for session persistence)."""
        if self._ws:
            self._ws.close()
            self._ws = None

    def quit(self):
        """Close Chrome completely."""
        self.close()
        if self._proc:
            self._proc.terminate()
            self._proc = None
        else:
            try:
                urllib.request.urlopen(f"{CDP_URL}/json/close", timeout=2)
            except Exception:
                pass

    def __del__(self):
        self.close()

    def __repr__(self):
        return f"ChromeBrowser(port={CDP_PORT}, profile={PROFILE_DIR})"

    # Backward-compatible aliases (old names still work).
    fill = write_text
    text = read_text
    html = read_html
    check = toggle_check
    find = find_element
    eval_js = run_js

    # Forgiving synonym aliases: LLMs frequently guess method names from other automation libraries
    # (Playwright/Selenium/Puppeteer). Instead of failing on a reasonable guess
    # and wasting a retry turn, accept the common synonyms and route them to the
    # real method. This generalizes across every task — not any one site.
    navigate = goto          # Playwright/Selenium-style
    open = goto              # generic
    open_url = goto
    go_to = goto
    visit = goto
    load = goto
    get = goto               # Selenium driver.get()
    type = type_text         # generic "type"
    type_keys = type_text    # pywinauto-style name
    input_text = write_text
    set_text = write_text
    enter_text = write_text
    fill_text = write_text
    click_element = click_text
    click_button = click_text
    tap_text = click_text
    get_text = read_text
    page_text = read_text
    content = read_content   # clean Markdown — matches what "content" implies (NOT raw innerText)
    list_elements = elements
    get_elements = elements
    execute_js = run_js
    evaluate = run_js
    js = run_js
    screen_shot = screenshot
    capture = screenshot
    refresh = reload
    open_tab = new_tab
    list_tabs = tabs
