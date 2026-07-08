"""Proxima Agent — Dynamic Execution CLI."""
import sys
import os
import traceback
import logging
import signal
import atexit
import re
import argparse

if sys.platform == "win32":
    # Configure Windows console encoding for UTF-8.
    try:
        os.system('chcp 65001 >nul 2>&1')
        for _stream in (sys.stdout, sys.stderr):
            if _stream is not None and hasattr(_stream, "reconfigure"):
                _stream.reconfigure(encoding="utf-8", errors="replace")
        os.environ["PYTHONIOENCODING"] = "utf-8"
        os.environ["PYTHONUTF8"] = "1"
    except Exception:
        pass

_LOG_DIR = os.path.join(os.path.expanduser("~"), ".proxima-agent", "logs")
_LOG_FILE = os.path.join(_LOG_DIR, "crash.log")

try:
    os.makedirs(_LOG_DIR, exist_ok=True)
    logging.basicConfig(
        filename=_LOG_FILE,
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        encoding="utf-8",
    )
except Exception:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )
_log = logging.getLogger("proxima-cli")


def _signal_handler(signum, frame):
    sig_name = signal.Signals(signum).name if hasattr(signal, 'Signals') else str(signum)
    _log.error(f"SIGNAL received: {sig_name} (signum={signum})")
    _log.error(f"  Stack at signal:\n{''.join(traceback.format_stack(frame))}")
    logging.shutdown()
    sys.exit(128 + signum)

signal.signal(signal.SIGTERM, _signal_handler)
if hasattr(signal, 'SIGBREAK'):
    signal.signal(signal.SIGBREAK, _signal_handler)

def _atexit_handler():
    _log.info("ATEXIT: Process is exiting (atexit handler called)")
    logging.shutdown()

atexit.register(_atexit_handler)


from rich.console import Console
from rich.panel import Panel

from .config import load_config, save_config

_history = []
_sessions_cache = []


def detect_and_verify_paths(text: str) -> str | None:
    """Scans user text for a valid existing file path."""
    pattern = r'([a-zA-Z]:[\\/][^:?"*<>|]+?\.[a-zA-Z0-9]+|(?:\.?\.[\\/])?[a-zA-Z0-9_\-\.\/]+?\.[a-zA-Z0-9]+)'
    matches = re.findall(pattern, text)
    for m in matches:
        clean_path = m.strip('"').strip("'")
        if os.path.isfile(clean_path):
            return os.path.abspath(clean_path)
    return None


def _format_session_time(ts) -> str:
    """Formats session start time safely."""
    try:
        import datetime
        return datetime.datetime.fromtimestamp(float(ts)).strftime("%Y-%m-%d %H:%M")
    except Exception:
        return "—"


def get_prompt_prefix(config: dict, active_file_path: str = None) -> str:
    model_name = config.get("model", "auto")
    if active_file_path:
        filename = os.path.basename(active_file_path)
        return f"[bold cyan][{model_name} 📎 {filename}][/bold cyan] [bold green]You:[/bold green] "
    return f"[bold cyan][{model_name}][/bold cyan] [bold green]You:[/bold green] "


def select_provider_model(console, config) -> str:
    """Shows core model selection UI at startup and returns selected model."""
    console.print()
    console.print("  [bold]Select Active Provider Model:[/bold]")
    console.print()
    console.print("    [green]1. Gemini[/green]      — Multimodal ingestion, file/doc upload support")
    console.print("    [yellow]2. Claude[/yellow]      — Premium coding & reasoning")
    console.print("    [cyan]3. Perplexity[/cyan]  — Live web research & exploration")
    console.print("    [purple]4. ChatGPT[/purple]     — General intelligence & code tasking")
    console.print()

    try:
        choice = console.input("  [bold]Model (1/2/3/4) [Default 1]: [/bold]").strip()
    except (KeyboardInterrupt, EOFError):
        choice = "1"

    if not choice:
        choice = "1"

    selected_model = "gemini"
    if choice == "2":
        selected_model = "claude"
        console.print("  [yellow]⚡ CLAUDE selected[/yellow]")
    elif choice == "3":
        selected_model = "perplexity"
        console.print("  [cyan]🔍 PERPLEXITY selected[/cyan]")
    elif choice == "4":
        selected_model = "chatgpt"
        console.print("  [purple]🤖 CHATGPT selected[/purple]")
    else:
        console.print()
        console.print("  [bold cyan]✨ Gemini Ingestion Upgrades Detected! Choose Sub-Engine:[/bold cyan]")
        console.print()
        console.print("    [green]1. auto[/green]                  — Gateway Smart Auto-Routing (Recommended)")
        console.print("    [green]2. gemini:3.1-pro[/green]       — Premium reasoning & deep coding")
        console.print("    [green]3. gemini:3.5-flash[/green]     — Super-fast speed & responses")
        console.print("    [green]4. gemini:3.1-flash-lite[/green] — Lightweight & highly efficient")
        console.print()
        try:
            sub_choice = console.input("  [bold]Sub-Engine (1/2/3/4) [Default 1]: [/bold]").strip()
        except (KeyboardInterrupt, EOFError):
            sub_choice = "1"

        if sub_choice == "2":
            selected_model = "gemini:3.1-pro"
        elif sub_choice == "3":
            selected_model = "gemini:3.5-flash"
        elif sub_choice == "4":
            selected_model = "gemini:3.1-flash-lite"
        else:
            selected_model = "gemini"
        console.print(f"  [green]✓ GEMINI Sub-Engine selected: {selected_model}[/green]")

    config["model"] = selected_model
    save_config(config)
    console.print()
    return selected_model


def _build_banner() -> str:
    """Builds the startup banner with the live version."""
    try:
        from . import __version__ as _ver
    except Exception:
        _ver = "?"

    return (
        "\n"
        f"  [bold cyan]PROXIMA AGENT[/bold cyan] [dim]| v{_ver}[/dim]\n"
        "  [dim]Beyond chat. Built to work.[/dim]\n"
    )


def custom_input(console, prompt_prefix: str) -> str:
    """Reads console input character-by-character on Windows."""
    global _history
    import msvcrt

    def _read_utf8_char(first_byte: bytes) -> str | None:
        b0 = first_byte[0]
        if b0 < 0x80:
            n_more = 0
        elif 0xC0 <= b0 <= 0xDF:
            n_more = 1
        elif 0xE0 <= b0 <= 0xEF:
            n_more = 2
        elif 0xF0 <= b0 <= 0xF7:
            n_more = 3
        else:
            return None
        seq = bytearray(first_byte)
        for _ in range(n_more):
            try:
                nb = msvcrt.getch()
            except Exception:
                return None
            if not nb:
                return None
            seq += nb
        try:
            return seq.decode("utf-8")
        except Exception:
            return None

    def _commit(line: str) -> str:
        """Finalizes a submitted line."""
        if line.strip() and (not _history or _history[-1] != line):
            _history.append(line)
        return line

    console.print(prompt_prefix, end="")
    sys.stdout.flush()

    buffer = []
    history_idx = len(_history)

    while True:
        try:
            ch = msvcrt.getch()
        except (KeyboardInterrupt, SystemExit):
            raise
        except Exception:
            ch = b''

        if ch == b'\x03':
            console.print()
            raise KeyboardInterrupt
        elif ch in (b'\r', b'\n'):
            if msvcrt.kbhit():
                buffer.append("\n")
                sys.stdout.write("\n")
                sys.stdout.flush()
                continue
            console.print()
            return _commit("".join(buffer))
        elif ch == b'\x08':
            if buffer:
                buffer.pop()
                sys.stdout.write("\b \b")
                sys.stdout.flush()
        elif ch == b'\\' and not buffer:
            sys.stdout.write('\\')
            sys.stdout.flush()

            res = show_interactive_action_menu(console)
            status = res.get("status")
            if status == "selected":
                action = res.get("action")
                if action == "file":
                    sys.stdout.write("\b \b")
                    sys.stdout.flush()
                    path = open_file_dialog_windows()
                    if path:
                        return f"/file {path}"
                    else:
                        console.print("  [yellow]No file selected.[/yellow]")
                        return ""
                elif action == "screenshot":
                    sys.stdout.write("\b \b")
                    sys.stdout.flush()
                    path = paste_screenshot_windows()
                    if path:
                        return f"/file {path}"
                    else:
                        console.print("  [red]✗ No image found in clipboard![/red]")
                        return ""
            elif status == "cancel":
                buffer.append('\\')
                sys.stdout.write("\r")
                console.print(prompt_prefix, end="")
                sys.stdout.write("".join(buffer))
                sys.stdout.flush()
            elif status == "backspace":
                sys.stdout.write("\r")
                console.print(prompt_prefix, end="")
                sys.stdout.write("".join(buffer))
                sys.stdout.flush()
            elif status == "continue":
                buffer.append('\\')
                for k in res.get("keys", []):
                    if len(k) == 1 and k[0] >= 32:
                        try:
                            char_str = k.decode('utf-8')
                            buffer.append(char_str)
                        except Exception:
                            pass
                sys.stdout.write("\r")
                console.print(prompt_prefix, end="")
                sys.stdout.write("".join(buffer))
                sys.stdout.flush()
        elif ch == b'\xe0':
            try:
                ch2 = msvcrt.getch()
            except Exception:
                ch2 = b''
            if ch2 == b'H':
                if _history and history_idx > 0:
                    sys.stdout.write("\b \b" * len(buffer))
                    history_idx -= 1
                    buffer = list(_history[history_idx])
                    sys.stdout.write("".join(buffer))
                    sys.stdout.flush()
            elif ch2 == b'P':
                if _history and history_idx < len(_history):
                    sys.stdout.write("\b \b" * len(buffer))
                    history_idx += 1
                    if history_idx < len(_history):
                        buffer = list(_history[history_idx])
                    else:
                        buffer = []
                    sys.stdout.write("".join(buffer))
                    sys.stdout.flush()
        elif len(ch) == 1 and ch[0] >= 32:
            char_str = _read_utf8_char(ch)
            if char_str:
                buffer.append(char_str)
                sys.stdout.write(char_str)
            
            while msvcrt.kbhit():
                try:
                    p_ch = msvcrt.getch()
                except Exception:
                    break
                if p_ch in (b'\r', b'\n'):
                    if msvcrt.kbhit():
                        buffer.append("\n")
                        sys.stdout.write("\n")
                        continue
                    console.print()
                    return _commit("".join(buffer))
                if p_ch in (b'\x00', b'\xe0', b'\x08', b'\x03'):
                    break
                if len(p_ch) == 1 and p_ch[0] >= 32:
                    cs = _read_utf8_char(p_ch)
                    if cs:
                        buffer.append(cs)
                        sys.stdout.write(cs)
            sys.stdout.flush()


def _read_input_with_paste_detection(console, prompt_prefix: str = "[bold green]You:[/bold green] ") -> str:
    """Reads user input with multi-line paste detection."""
    if sys.platform == "win32":
        first_line = custom_input(console, prompt_prefix)
        if first_line.startswith("/file"):
            return first_line
    else:
        first_line = console.input(prompt_prefix)

        if first_line.strip() in ("\\", "\\file", "\\attach"):
            res = show_interactive_action_menu(console)
            status = res.get("status")
            if status == "selected":
                action = res.get("action")
                if action == "file":
                    try:
                        path = console.input("  [bold]File path: [/bold]").strip().strip('"').strip("'")
                    except (KeyboardInterrupt, EOFError):
                        path = ""
                    if path and os.path.exists(path):
                        return f"/file {path}"
                    else:
                        console.print("  [yellow]No valid file selected.[/yellow]")
                        return ""
                elif action == "screenshot":
                    console.print("  [yellow]Clipboard screenshot paste is Windows-only. Use /file <path>.[/yellow]")
                    return ""
            return ""

    extra_lines = _drain_stdin_buffer()

    if extra_lines:
        all_lines = [first_line] + extra_lines
        full_input = "\n".join(all_lines).strip()
        line_count = len(all_lines)
        console.print(f"  [dim](captured {line_count} lines from paste)[/dim]")
        return full_input

    return first_line.strip()


def _drain_stdin_buffer() -> list[str]:
    """Drains remaining pasted data from stdin buffer."""
    import time

    lines = []
    deadline = time.monotonic() + 0.15

    if sys.platform == "win32":
        import msvcrt
        while time.monotonic() < deadline:
            if msvcrt.kbhit():
                try:
                    line = sys.stdin.readline()
                    if line:
                        lines.append(line.rstrip("\n\r"))
                        deadline = time.monotonic() + 0.15
                    else:
                        break
                except Exception:
                    break
            else:
                time.sleep(0.01)
    else:
        import select
        while time.monotonic() < deadline:
            ready, _, _ = select.select([sys.stdin], [], [], 0.01)
            if ready:
                try:
                    line = sys.stdin.readline()
                    if line:
                        lines.append(line.rstrip("\n\r"))
                        deadline = time.monotonic() + 0.15
                    else:
                        break
                except Exception:
                    break

    return lines


def open_file_dialog_windows() -> str | None:
    """Opens File Open dialog using PowerShell."""
    import subprocess
    cmd = (
        "Add-Type -AssemblyName System.Windows.Forms; "
        "$f = New-Object System.Windows.Forms.OpenFileDialog; "
        "$f.Filter = 'All Files (*.*)|*.*'; "
        "if($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){$f.FileName}"
    )
    try:
        res = subprocess.run(
            ["powershell", "-NoProfile", "-STA", "-Command", cmd],
            capture_output=True, text=True, encoding="utf-8",
            timeout=120,
        )
        path = res.stdout.strip()
        return path if path and os.path.exists(path) else None
    except Exception as e:
        _log.error(f"Error opening file dialog: {e}")
        return None


def paste_screenshot_windows() -> str | None:
    """Saves clipboard image to a temporary file using PowerShell."""
    import subprocess
    
    temp_dir = os.path.join(os.path.expanduser("~"), ".proxima-agent", "temp")
    os.makedirs(temp_dir, exist_ok=True)
    temp_path = os.path.join(temp_dir, "screenshot.png")

    # Pass temp_path via env var to prevent PowerShell command injection.
    cmd = (
        "Add-Type -AssemblyName System.Windows.Forms; "
        "Add-Type -AssemblyName System.Drawing; "
        "if ([System.Windows.Forms.Clipboard]::ContainsImage()) { "
        "    $img = [System.Windows.Forms.Clipboard]::GetImage(); "
        "    $img.Save($env:PROXIMA_SHOT_PATH, [System.Drawing.Imaging.ImageFormat]::Png); "
        "    Write-Output 'OK' "
        "} else { "
        "    Write-Output 'NO_IMAGE' "
        "}"
    )
    try:
        res = subprocess.run(
            ["powershell", "-NoProfile", "-STA", "-Command", cmd],
            capture_output=True, text=True, encoding="utf-8",
            timeout=30,
            env={**os.environ, "PROXIMA_SHOT_PATH": temp_path},
        )
        if "OK" in res.stdout:
            return temp_path
        return None
    except Exception as e:
        _log.error(f"Error pasting screenshot: {e}")
        return None


def show_interactive_action_menu(console) -> dict:
    """Displays interactive terminal menu to select attachment options."""
    options = [
        {"icon": "📄", "label": "Attach File (Opens Explorer)", "action": "file"},
        {"icon": "❌", "label": "Cancel (Esc)", "action": "cancel"}
    ]
    
    if sys.platform != "win32":
        console.print("\n  [bold cyan]Select Action:[/bold cyan]")
        for i, opt in enumerate(options):
            console.print(f"    {i+1}. {opt['icon']} {opt['label']}")
        try:
            choice = input("  Choice (1/2): ").strip()
            if choice == "1": return {"status": "selected", "action": "file"}
        except Exception:
            pass
        return {"status": "cancel", "action": "cancel"}

    import msvcrt
    current_idx = 0
    
    sys.stdout.write("\033[?25l")
    sys.stdout.flush()
    
    console.print("\n  [bold cyan]Select Action (Use Arrow Keys & Enter, or keep typing to cancel):[/bold cyan]")
    
    def render_menu():
        for i, opt in enumerate(options):
            if i == current_idx:
                console.print(f"    [bold green]➔  {opt['icon']} {opt['label']}[/bold green]")
            else:
                console.print(f"       [dim]{opt['icon']} {opt['label']}[/dim]")

    render_menu()
    
    result = {"status": "cancel", "action": "cancel"}
    try:
        while True:
            ch = msvcrt.getch()
            if ch in (b'\xe0', b'\x00'):
                ch2 = msvcrt.getch()
                if ch2 == b'H':
                    current_idx = (current_idx - 1) % len(options)
                elif ch2 == b'P':
                    current_idx = (current_idx + 1) % len(options)
                else:
                    result = {"status": "continue", "keys": [ch, ch2]}
                    break
                
                sys.stdout.write(f"\033[{len(options)}A")
                sys.stdout.write("\033[J")
                render_menu()
            elif ch in (b'\r', b'\n'):
                result = {"status": "selected", "action": options[current_idx]["action"]}
                break
            elif ch == b'\x1b':
                result = {"status": "cancel", "action": "cancel"}
                break
            elif ch == b'\x08':
                result = {"status": "backspace"}
                break
            elif ch == b'\x03':
                raise KeyboardInterrupt
            else:
                result = {"status": "continue", "keys": [ch]}
                break
    except KeyboardInterrupt:
        raise KeyboardInterrupt
    finally:
        sys.stdout.write("\033[?25h")
        sys.stdout.write(f"\033[{len(options) + 2}A")
        sys.stdout.write("\033[J")
        sys.stdout.flush()
        
    return result


def main():
    _log.info("=" * 60)
    _log.info("Proxima Agent CLI starting")

    parser = argparse.ArgumentParser(description="Proxima Agent CLI")
    parser.add_argument("prompt", nargs="?", default=None, help="Direct prompt to execute")
    parser.add_argument("--file", "-f", default=None, help="Local file path to attach")
    parser.add_argument("--model", "-m", default=None, help="Select model engine")
    parser.add_argument("--perm", "-p", choices=["auto", "smart", "suggest"], default=None, help="Override permission mode")
    
    args, unknown = parser.parse_known_args()

    console = Console(highlight=False)
    config = load_config()

    if unknown:
        console.print(f"  [yellow]⚠ Ignoring unrecognized arguments: {' '.join(unknown)}[/yellow]")

    if args.model:
        config["model"] = args.model
        save_config(config)

    _client = None
    def get_client():
        nonlocal _client
        if _client is None:
            from .agent import create_client
            _client = create_client(config)
        return _client

    if args.prompt:
        console.print(Panel(
            f"[bold green]Direct Execution Mode[/bold green]\n"
            f"[cyan]Prompt:[/cyan] {args.prompt}\n"
            f"[cyan]File:[/cyan] {args.file or 'None'}\n"
            f"[cyan]Model:[/cyan] {config['model']}",
            border_style="yellow"
        ))
        
        try:
            get_client().models.list()
        except Exception as e:
            console.print(f"  [red]✗ Cannot connect: {e}[/red]")
            return

        from .permissions import PermissionMode
        permission_mode = PermissionMode.SMART
        if args.perm:
            if args.perm == "auto":
                permission_mode = PermissionMode.FULL_AUTO
            elif args.perm == "smart":
                permission_mode = PermissionMode.SMART
            elif args.perm == "suggest":
                permission_mode = PermissionMode.SUGGEST

        messages = []
        try:
            from .agent import run_agent_loop
            run_agent_loop(get_client(), config, args.prompt, messages, console, permission_mode=permission_mode, file_path=args.file)
            _log.info("Direct execution completed successfully")
        except Exception as e:
            _log.error(f"Direct execution error: {e}\n{traceback.format_exc()}")
            console.print(f"[bold red]Execution error: {e}[/bold red]")
        return

    console.print(_build_banner())
    console.print(f"  [dim]API: {config['api_url']}[/dim]")
    console.print(f"  [dim]Model: {config['model']}[/dim]")
    console.print(f"  [dim]Mode: Dynamic Python execution (1 tool, unlimited capability)[/dim]")
    console.print(f"  [dim]Safety: Dangerous operations require your approval[/dim]")
    console.print(f"  [dim]Crash log: {_LOG_FILE}[/dim]")
    console.print()

    import importlib.util
    if importlib.util.find_spec("pywinauto") is not None:
        console.print("  [green]✓ Desktop + Browser automation ready (CDP + UIAutomation)[/green]")
    else:
        console.print("  [yellow]⚠ pywinauto not installed. Desktop automation limited. Run: pip install pywinauto[/yellow]")

    try:
        import urllib.request
        from .config import DEFAULT_API_URL
        api_url = config.get("api_url") or DEFAULT_API_URL
        req = urllib.request.Request(f"{api_url}/models")
        api_key = config.get("api_key")
        if api_key:
            req.add_header("Authorization", f"Bearer {api_key}")
        with urllib.request.urlopen(req, timeout=3.0) as response:
            if response.status == 200:
                console.print("  [green]✓ Connected to Proxima[/green]")
                _log.info("Connected to Proxima API")
            else:
                raise Exception(f"HTTP status {response.status}")
    except Exception as e:
        console.print(f"  [red]✗ Cannot connect: {e}[/red]")
        console.print(f"  [yellow]  Make sure Proxima is running (npm start)[/yellow]")
        _log.error(f"Connection failed: {e}")

    console.print()

    from .permissions import select_mode, PermissionMode
    if args.perm:
        if args.perm == "auto":
            permission_mode = PermissionMode.FULL_AUTO
        elif args.perm == "smart":
            permission_mode = PermissionMode.SMART
        else:
            permission_mode = PermissionMode.SUGGEST
        console.print(f"  [green]✓ Permission mode set from args: {permission_mode.name}[/green]")
    else:
        permission_mode = select_mode(console)

    if not args.model:
        select_provider_model(console, config)

    first_launch_done = config.get("first_launch_done", False)
    if not first_launch_done:
        console.print()
        console.print("  [bold yellow]Tip 1/5:[/bold yellow]")
        console.print("  Press \\ to attach files or screenshots.")
        try:
            console.input("  Press Enter to continue...")
        except (KeyboardInterrupt, EOFError):
            pass
        config["first_launch_done"] = True
        save_config(config)

    console.print()
    console.print("  [bold cyan]⚡ PROXIMA AGENT ⚡[/bold cyan]")
    console.print()
    console.print("  [bold]Quick Start[/bold]")
    console.print("  ────────────────────────────────")
    console.print("  Type normally to chat.")
    console.print()
    console.print("  \\           [dim]Open attach menu[/dim]")
    console.print("  /new        [dim]Start a new conversation[/dim]")
    console.print("  /chats      [dim]List previous conversations[/dim]")
    console.print("  /open N     [dim]Open conversation #N[/dim]")
    console.print("  /files      [dim]Show attached files[/dim]")
    console.print("  /model      [dim]Change model[/dim]")
    console.print("  /help       [dim]Show all commands[/dim]")
    console.print("  /exit       [dim]Quit Proxima[/dim]")
    console.print()
    console.print("  [dim]Tip: Press \\ anytime to attach files or screenshots.[/dim]")
    console.print("  [dim]Type /examples to see what you can ask.[/dim]")
    console.print("  ────────────────────────────────")
    console.print()

    active_file_path = args.file if args.file else None
    messages = []
    turn_count = 0
    global _sessions_cache

    while True:
        try:
            prompt_prefix = get_prompt_prefix(config, active_file_path)
            user_input = _read_input_with_paste_detection(console, prompt_prefix=prompt_prefix)
        except (KeyboardInterrupt, EOFError) as e:
            _log.info(f"User exit via {type(e).__name__}")
            console.print("\n[dim]Goodbye![/dim]")
            break
        except Exception as e:
            _log.error(f"Input error: {type(e).__name__}: {e}\n{traceback.format_exc()}")
            console.print(f"\n[red]Input error: {e}[/red]")
            continue

        if not user_input:
            continue

        if user_input.startswith("/"):
            try:
                cmd_parts = user_input.lower().split()
                cmd = cmd_parts[0]

                if cmd in ("/exit", "/quit", "/q"):
                    _log.info("User typed /exit")
                    console.print("[dim]Goodbye![/dim]")
                    break
                elif cmd in ("/new", "/reset"):
                    messages.clear()
                    from .agent import reset_session
                    reset_session()
                    turn_count = 0
                    active_file_path = None
                    _log.info("Session reset via /new")
                    console.print("[yellow]New conversation (all state & files reset)[/yellow]")
                    continue
                elif cmd in ("/file", "/attach"):
                    parts = user_input.split(maxsplit=1)
                    if len(parts) > 1:
                        target_path = parts[1].strip().strip('"').strip("'")
                        if os.path.exists(target_path):
                            active_file_path = os.path.abspath(target_path)
                            filename = os.path.basename(active_file_path)
                            console.print(f"  [bold green]📎 Attached file successfully:[/bold green] [yellow]{filename}[/yellow]")
                            current_model = config.get("model", "auto")
                            if "gemini" not in current_model.lower() and current_model.lower() != "auto":
                                console.print("  [bold yellow]⚠️  Note: File ingestion is optimized for Gemini engines.[/bold yellow]")
                        else:
                            console.print(f"  [bold red]✗ File not found:[/bold red] {target_path}")
                    else:
                        console.print("  [dim]Usage: /file <local_path_to_file_or_image>[/dim]")
                    continue
                elif cmd in ("/detach", "/clearfile"):
                    if active_file_path:
                        console.print(f"  [yellow]Detached file: {os.path.basename(active_file_path)}[/yellow]")
                        active_file_path = None
                    else:
                        console.print("  [dim]No file attached.[/dim]")
                    continue
                elif cmd == "/model":
                    parts = user_input.split(maxsplit=1)
                    if len(parts) > 1:
                        config["model"] = parts[1].strip()
                        save_config(config)
                        console.print(f"  [yellow]Model: {config['model']}[/yellow]")
                    else:
                        console.print("  [yellow]Discovering active engines from Proxima Gateway...[/yellow]")
                        try:
                            models_data = get_client().models.list()
                            from rich.table import Table
                            table = Table(title="Discovered Proxima Engines", border_style="cyan")
                            table.add_column("Engine ID", style="green")
                            table.add_column("Provider", style="yellow")
                            table.add_column("Capabilities", style="dim")

                            provider_meta = {
                                "gemini": ("Gemini AI", "Multimodal Ingestion"),
                                "claude": ("Anthropic", "Premium Coding & Reasoning"),
                                "chatgpt": ("OpenAI", "General Intelligence"),
                                "perplexity": ("Perplexity", "Web Research"),
                                "deepseek": ("DeepSeek", "Coding & Reasoning"),
                                "groq": ("Groq", "Fast Inference"),
                                "xai": ("xAI", "Grok Intelligence"),
                                "openrouter": ("OpenRouter", "Multi-Provider"),
                                "together": ("Together AI", "Open Models"),
                                "fireworks": ("Fireworks", "Fast Open Models"),
                                "mistral": ("Mistral", "European AI"),
                                "nvidia": ("NVIDIA NIM", "Enterprise AI"),
                                "auto": ("Proxima", "Smart Routing"),
                            }

                            found_any = False
                            for m in models_data:
                                model_id = getattr(m, "id", str(m))
                                if not model_id:
                                    continue
                                found_any = True

                                if "@" in model_id:
                                    base_provider = model_id.split("@")[0]
                                    actual_model = model_id.split("@", 1)[1]
                                    meta = provider_meta.get(base_provider, ("Unknown", "Text"))
                                    prov = meta[0]
                                    caps = f"{meta[1]} | {actual_model}"
                                  
                                elif ":" in model_id:
                                    base_provider = model_id.split(":")[0]
                                    meta = provider_meta.get(base_provider, ("Unknown", "Text"))
                                    prov, caps = meta
                                else:
                                    meta = provider_meta.get(model_id.lower(), ("Unknown", "Text"))
                                    prov, caps = meta

                                table.add_row(model_id, prov, caps)

                            if not found_any:
                                for k, val in provider_meta.items():
                                    if k != "auto":
                                        table.add_row(k, val[0], val[1])

                            console.print(table)
                        except Exception as e:
                            console.print(f"  [red]Failed to query models: {e}[/red]")
                            console.print("  [dim]Fallback model list:[/dim]")
                            for k in ["auto", "gemini", "claude", "perplexity", "chatgpt"]:
                                console.print(f"    - [green]{k}[/green]")
                        console.print(f"\n  [cyan]Current model: {config['model']}[/cyan]. Usage: [green]/model <name>[/green]")
                    continue
                elif cmd == "/config":
                    _SENSITIVE = ("key", "token", "secret", "password")
                    for k, v in config.items():
                        if v and any(s in k.lower() for s in _SENSITIVE):
                            sval = str(v)
                            val = f"***{sval[-4:]}" if len(sval) > 4 else "****"
                        else:
                            val = str(v)[:80] + "..." if len(str(v)) > 80 else str(v)
                        console.print(f"  [cyan]{k}[/cyan]: {val}")
                    continue
                elif cmd == "/help":
                    console.print(
                        "\n"
                        "[bold]Conversation[/bold]\n"
                        "------------\n"
                        "  [green]/new[/green]              New conversation\n"
                        "  [green]/chats[/green]            Show recent conversations\n"
                        "  [green]/open <id>[/green]        Open a conversation\n"
                        "  [green]/rename <name>[/green]    Rename current conversation\n"
                        "  [green]/delete <id>[/green]      Delete conversation\n"
                        "\n"
                        "[bold]Files[/bold]\n"
                        "-----\n"
                        "  [green]\\[/green]                 Open attach menu\n"
                        "  [green]/files[/green]            Show attached files\n"
                        "  [green]/clearfiles[/green]       Remove attachments\n"
                        "\n"
                        "[bold]Settings[/bold]\n"
                        "--------\n"
                        "  [green]/model[/green]            Change model\n"
                        "  [green]/status[/green]           Current configuration\n"
                        "  [green]/config[/green]           Open configuration\n"
                        "\n"
                        "[bold]General[/bold]\n"
                        "-------\n"
                        "  [green]/help[/green]             Show this page\n"
                        "  [green]/examples[/green]         Example prompts\n"
                        "  [green]/exit[/green]             Exit Proxima\n"
                    )
                    continue
                elif cmd == "/examples":
                    console.print(
                        "\n"
                        "[bold cyan]Example Prompts you can ask Proxima Agent:[/bold cyan]\n"
                        "──────────────────────────────────────────────────\n"
                        "  [green]•[/green] Find and fix all syntax errors in my src/ directory\n"
                        "  [green]•[/green] Refactor AuthController to use async/await\n"
                        "  [green]•[/green] Open chrome and search for the latest tech news, then summarize it\n"
                        "  [green]•[/green] Watch the active window and tell me if the build succeeded\n"
                        "  [green]•[/green] Run the test suite and email the report on failure\n"
                        "──────────────────────────────────────────────────\n"
                    )
                    continue
                elif cmd == "/chats":
                    from .agent import _get_recall
                    recall = _get_recall()
                    if not recall:
                        console.print("  [red]✗ Recall persistence is disabled or unavailable.[/red]")
                        continue
                    sessions = recall.vault.list_sessions(limit=20)
                    if not sessions:
                        console.print("  [dim]No previous conversations found in vault.[/dim]")
                        continue
                    _sessions_cache = sessions
                
                    console.print("\n  [bold cyan]Recent Conversations:[/bold cyan]\n")
                    for i, s in enumerate(sessions, 1):
                        title = s.get("title") or "(Untitled)"
                        model = s.get("model") or "auto"
                        started_str = _format_session_time(s.get("started_at"))
                        active_marker = " [bold green](Active)[/bold green]" if recall.session_id == s.get("id") else ""
                        console.print(f"    [green]{i}.[/green] [bold]{title}[/bold] [dim]({model} | {started_str})[/dim]{active_marker}")
                    console.print("\n  [dim]Type [bold cyan]/open <number>[/bold cyan] to load any chat.[/dim]\n")
                    continue
                elif cmd == "/open":
                    parts = user_input.split(maxsplit=1)
                    if len(parts) < 2:
                        console.print("  [dim]Usage: /open <number_or_id>[/dim]")
                        continue
                    target = parts[1].strip()
                    from .agent import _get_recall
                    recall = _get_recall()
                    if not recall:
                        console.print("  [red]✗ Recall persistence is disabled.[/red]")
                        continue
                
                    session_id = None
                    try:
                        idx = int(target) - 1
                        if _sessions_cache and 0 <= idx < len(_sessions_cache):
                            session_id = _sessions_cache[idx]["id"]
                        else:
                            session_id = target
                    except ValueError:
                        session_id = target
                
                    if not session_id:
                        console.print(f"  [red]✗ Invalid index or ID: {target}[/red]")
                        continue
                
                    sess_meta = recall.vault.get_session(session_id)
                    if not sess_meta:
                        console.print(f"  [red]✗ Conversation not found in vault: {session_id}[/red]")
                        continue
                
                    messages.clear()
                    loaded_msgs = recall.load_session(session_id)
                    messages.extend(loaded_msgs)
                    turn_count = len(messages)
                    config["model"] = sess_meta.get("model") or config.get("model", "auto")
                    save_config(config)
                    console.print(f"  [green]✓ Loaded conversation:[/green] [bold]{sess_meta.get('title') or '(Untitled)'}[/bold]")
                    console.print(f"  [dim]Loaded {len(loaded_msgs)} messages. Model switched to: {config['model']}[/dim]")
                    continue
                elif cmd == "/rename":
                    parts = user_input.split(maxsplit=1)
                    if len(parts) < 2:
                        console.print("  [dim]Usage: /rename <new_title>[/dim]")
                        continue
                    new_title = parts[1].strip()
                    from .agent import _get_recall
                    recall = _get_recall()
                    if not recall or not recall.session_id:
                        console.print("  [red]✗ No active conversation to rename.[/red]")
                        continue
                
                    success = recall.vault.update_title(recall.session_id, new_title)
                    if success:
                        console.print(f"  [green]✓ Conversation renamed to:[/green] [bold]{new_title}[/bold]")
                    else:
                        console.print("  [red]✗ Failed to update title in vault.[/red]")
                    continue
                elif cmd == "/delete":
                    parts = user_input.split(maxsplit=1)
                    if len(parts) < 2:
                        console.print("  [dim]Usage: /delete <number_or_id>[/dim]")
                        continue
                    target = parts[1].strip()
                    from .agent import _get_recall
                    recall = _get_recall()
                    if not recall:
                        console.print("  [red]✗ Recall persistence is disabled.[/red]")
                        continue
                
                    session_id = None
                    try:
                        idx = int(target) - 1
                        if _sessions_cache and 0 <= idx < len(_sessions_cache):
                            session_id = _sessions_cache[idx]["id"]
                        else:
                            session_id = target
                    except ValueError:
                        session_id = target
                
                    if not session_id:
                        console.print(f"  [red]✗ Invalid index or ID: {target}[/red]")
                        continue
                
                    sess_meta = recall.vault.get_session(session_id)
                    if not sess_meta:
                        console.print(f"  [red]✗ Conversation not found in vault.[/red]")
                        continue
                
                    success = recall.vault.delete_session(session_id)
                    if success:
                        console.print(f"  [green]✓ Deleted conversation:[/green] [bold]{sess_meta.get('title') or '(Untitled)'}[/bold]")
                        if recall.session_id == session_id:
                            messages.clear()
                            from .agent import reset_session
                            reset_session()
                            turn_count = 0
                            active_file_path = None
                            console.print("  [yellow]Current session deleted. Started a new clean conversation.[/yellow]")
                    else:
                        console.print("  [red]✗ Failed to delete conversation from database.[/red]")
                    continue
                elif cmd == "/files":
                    if active_file_path:
                        filename = os.path.basename(active_file_path)
                        console.print(f"  [bold green]📎 Attached file:[/bold green] [yellow]{filename}[/yellow] [dim]({active_file_path})[/dim]")
                    else:
                        console.print("  [dim]No files currently attached. Type [bold]\\[/bold] or [bold]/file <path>[/bold] to attach.[/dim]")
                    continue
                elif cmd == "/clearfiles":
                    if active_file_path:
                        console.print(f"  [yellow]Detached file: {os.path.basename(active_file_path)}[/yellow]")
                        active_file_path = None
                    else:
                        console.print("  [dim]No file attached.[/dim]")
                    continue
                elif cmd == "/status":
                    from .agent import _get_recall
                    recall = _get_recall()
                    console.print("\n  [bold cyan]Proxima Current Status:[/bold cyan]")
                    console.print(f"    [dim]Gateway URL:[/dim]  {config.get('api_url')}")
                    console.print(f"    [dim]Active Model:[/dim]  {config.get('model')}")
                    console.print(f"    [dim]Safety Mode:[/dim]   {permission_mode.name}")
                    active_sid = recall.session_id if recall else None
                    console.print(f"    [dim]Session ID:[/dim]    {active_sid or 'None (Stateless)'}")
                    console.print(f"    [dim]File Attached:[/dim] {active_file_path or 'None'}")
                    console.print()
                    continue
                elif cmd == "/crash":
                    try:
                        with open(_LOG_FILE, "r", encoding="utf-8") as f:
                            lines = f.readlines()
                        for line in lines[-30:]:
                            console.print(f"  [dim]{line.rstrip()}[/dim]")
                    except Exception:
                        console.print("[dim]No crash log found[/dim]")
                    continue
                elif cmd in ("/mode", "/perm"):
                    mode_labels = {
                        PermissionMode.FULL_AUTO: "[green]🚀 FULL AUTO[/green] — agent runs freely",
                        PermissionMode.SMART: "[yellow]⚡ SMART[/yellow] — critical actions need approval",
                        PermissionMode.SUGGEST: "[cyan]💡 SUGGEST[/cyan] — options before critical actions",
                    }
                    console.print(f"  Active mode: {mode_labels[permission_mode]}")
                    parts = user_input.split(maxsplit=1)
                    if len(parts) > 1:
                        new_mode = parts[1].strip().lower()
                        if new_mode in ("1", "auto", "full_auto"):
                            permission_mode = PermissionMode.FULL_AUTO
                            console.print(f"  [green]Switched to FULL AUTO[/green]")
                        elif new_mode in ("2", "smart"):
                            permission_mode = PermissionMode.SMART
                            console.print(f"  [yellow]Switched to SMART[/yellow]")
                        elif new_mode in ("3", "suggest"):
                            permission_mode = PermissionMode.SUGGEST
                            console.print(f"  [cyan]Switched to SUGGEST[/cyan]")
                    continue
                else:
                    _VALID_COMMANDS = [
                        "/new", "/reset", "/file", "/attach", "/detach", "/clearfile", "/clearfiles", 
                        "/model", "/config", "/help", "/crash", "/mode", "/perm", "/exit", "/quit", "/q",
                        "/chats", "/open", "/rename", "/delete", "/files", "/status", "/examples"
                    ]
                    import difflib
                    matches = difflib.get_close_matches(cmd, _VALID_COMMANDS, n=3, cutoff=0.5)
                    console.print(f"  [bold red]Unknown command: {cmd}[/bold red]")
                    if matches:
                        console.print("  [yellow]Did you mean:[/yellow]")
                        for m in matches:
                            console.print(f"    {m}")
                    continue

            except Exception as _cmd_err:
                _log.error("Slash-command failed: %s: %s", type(_cmd_err).__name__, _cmd_err)
                _log.error(traceback.format_exc())
                console.print(f"  [bold red]\u2717 Command failed: {type(_cmd_err).__name__}: {_cmd_err}[/bold red]")
                continue

        detected = detect_and_verify_paths(user_input) if not active_file_path else None
        if detected:
            active_file_path = detected
            filename = os.path.basename(detected)
            console.print(f"  [dim]📎 Auto-detected and attached local file: {filename}[/dim]")

        turn_count += 1
        _log.info(f"Turn {turn_count}: user={user_input[:100]!r}, messages={len(messages)}")

        console.print()
        try:
            from .agent import run_agent_loop
            run_agent_loop(get_client(), config, user_input, messages, console, permission_mode=permission_mode, file_path=active_file_path)
            _log.info(f"Turn {turn_count} completed OK, messages={len(messages)}")
            
            if active_file_path:
                active_file_path = None
        except KeyboardInterrupt:
            _log.info(f"Turn {turn_count} interrupted by user")
            console.print("\n[yellow]Interrupted[/yellow]")
        except Exception as e:
            tb = traceback.format_exc()
            _log.error(
                f"Turn {turn_count} CRASHED ({type(e).__name__}):\n"
                f"  Error: {type(e).__name__}: {e}\n"
                f"  Messages: {len(messages)}\n"
                f"  Last user: {user_input[:200]!r}\n"
                f"  Traceback:\n{tb}"
            )
            console.print(f"\n[bold red]Agent Error: {type(e).__name__}: {e}[/bold red]")
            console.print(f"[dim]{tb[-500:]}[/dim]")
            console.print("[yellow]Agent is still running — type your next message.[/yellow]")
        console.print()

    _log.info("CLI exiting normally")


def _safe_main():
    """Top-level crash handler."""
    try:
        main()
    except KeyboardInterrupt:
        _log.info("Top-level KeyboardInterrupt — exiting")
    except SystemExit as e:
        _log.error(f"Top-level SystemExit (code={e.code}):\n{traceback.format_exc()}")
        raise
    except BaseException as e:
        _log.error(f"Top-level CRASH: {type(e).__name__}: {e}\n{traceback.format_exc()}")
        print(f"\nFATAL: {type(e).__name__}: {e}", file=sys.stderr)
        print(f"Crash log: {_LOG_FILE}", file=sys.stderr)
        raise


if __name__ == "__main__":
    _safe_main()
