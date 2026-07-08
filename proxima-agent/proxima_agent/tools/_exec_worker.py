"""Proxima — Persistent Execution Worker.
Provides a long-lived runtime process that maintains state across agent turns.
"""

import sys
import os
import io
import json
import traceback
import threading


def _set_dpi_aware():
    """Configures process to be DPI-aware on Windows."""
    import platform as _pf
    if _pf.system() != "Windows":
        return
    try:
        import ctypes
        try:
            ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
            return
        except Exception:
            pass
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
            return
        except Exception:
            pass
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass


def bootstrap_runtime(ns=None):
    """Sets up shared execution environment components."""
    _set_dpi_aware()
    try:
        from proxima_agent.tools.attach import install_screenshot_hook
        install_screenshot_hook()
    except Exception:
        pass
    try:
        from proxima_agent.tools._web_scrape_patch import install_web_scrape_patch
        install_web_scrape_patch()
    except Exception:
        pass
    list_tools = describe_tool = None
    try:
        from proxima_agent.prompt.dynamic_session_prompt import (
            list_tools as _lt, describe_tool as _dt,
        )
        list_tools, describe_tool = _lt, _dt
    except Exception:
        pass
    if ns is not None and list_tools is not None:
        ns["list_tools"] = list_tools
        ns["describe_tool"] = describe_tool
    return list_tools, describe_tool


def main():
    _set_dpi_aware()

    try:
        protocol_fd = os.dup(1)
        proto_out = os.fdopen(protocol_fd, "w", encoding="utf-8")
        os.dup2(2, 1)
        sys.stdout = os.fdopen(os.dup(1), "w", encoding="utf-8")
    except Exception:
        proto_out = sys.__stdout__
    proto_in = sys.stdin

    sys.stdin = io.StringIO("")

    cwd = os.environ.get("PROXIMA_EXEC_CWD")
    if cwd and os.path.isdir(cwd):
        os.chdir(cwd)

    import builtins as _builtins_mod
    _safe_builtins = {k: v for k, v in vars(_builtins_mod).items()
                      if k not in ('quit', 'exit', 'breakpoint', 'help')}
    ns = {"__builtins__": _safe_builtins}
    bootstrap_runtime(ns)

    proto_out.write(json.dumps({"id": 0, "ready": True}) + "\n")
    proto_out.flush()

    while True:
        try:
            line = proto_in.readline()
            if not line:
                break

            cmd = json.loads(line.strip())
            cmd_id = cmd.get("id", 0)
            code = cmd.get("code", "")

            _exec_timeout_sec = 60
            _timed_out = False

            def _timeout_handler():
                nonlocal _timed_out
                _timed_out = True
                import _thread
                _thread.interrupt_main()

            _timer = threading.Timer(_exec_timeout_sec, _timeout_handler)
            _timer.daemon = True
            _timer.start()

            out_buf = io.StringIO()
            err_buf = io.StringIO()
            old_stdout, old_stderr = sys.stdout, sys.stderr
            sys.stdout = out_buf
            sys.stderr = err_buf

            success = True
            exc_type = None
            try:
                exec(compile(code, "<agent>", "exec"), ns)
            except SystemExit:
                pass
            except KeyboardInterrupt:
                if _timed_out:
                    success = False
                    exc_type = "TimeoutError"
                    err_buf.write(f"\n[WORKER] Code block exceeded {_exec_timeout_sec}s timeout and was interrupted.\n")
                else:
                    success = False
                    exc_type = "KeyboardInterrupt"
                    traceback.print_exc(file=err_buf)
            except Exception as e:
                success = False
                exc_type = type(e).__name__
                traceback.print_exc(file=err_buf)
                
                try:
                    active_browser = None
                    for val in ns.values():
                        if type(val).__name__ == "ChromeBrowser":
                            active_browser = val
                            break
                    if active_browser:
                        url = active_browser.url()
                        title = active_browser.title()
                        err_buf.write(f"\n[BROWSER STATE]: URL={url} | Title={title}\n")
                        
                        if hasattr(active_browser, "dump_interactive_elements"):
                            elements_json = active_browser.dump_interactive_elements()
                            elements = json.loads(elements_json)
                            if elements:
                                err_buf.write("[VISUAL LAYOUT SNAPSHOT (Text-based - 0 vision tokens used)]:\n")
                                for el in elements[:10]:
                                    role = el.get("role", "element")
                                    label = el.get("label") or el.get("text", "")
                                    sel = el.get("selector", "")
                                    x, y = el.get("x", 0), el.get("y", 0)
                                    label_str = f" | Text: '{label}'" if label else ""
                                    err_buf.write(f"  - (x: {x}, y: {y}) | Role: {role} | Selector: '{sel}'{label_str}\n")
                except Exception:
                    pass
            finally:
                _timer.cancel()
                sys.stdout = old_stdout
                sys.stderr = old_stderr

            MAX_OUTPUT_BYTES = 1_048_576
            stdout_val = out_buf.getvalue()
            stderr_val = err_buf.getvalue()
            if len(stdout_val) > MAX_OUTPUT_BYTES:
                stdout_val = stdout_val[:MAX_OUTPUT_BYTES] + "\n... [TRUNCATED — output exceeded 1 MB]"
            if len(stderr_val) > MAX_OUTPUT_BYTES:
                stderr_val = stderr_val[:MAX_OUTPUT_BYTES] + "\n... [TRUNCATED — stderr exceeded 1 MB]"

            response = json.dumps({
                "id": cmd_id,
                "stdout": stdout_val,
                "stderr": stderr_val,
                "success": success,
                "exception_type": exc_type,
            })
            proto_out.write(response + "\n")
            proto_out.flush()

        except json.JSONDecodeError:
            continue
        except Exception as e:
            try:
                proto_out.write(json.dumps({
                    "id": 0,
                    "stdout": "",
                    "stderr": f"Worker internal error: {e}",
                    "success": False,
                }) + "\n")
                proto_out.flush()
            except Exception:
                break


if __name__ == "__main__":
    main()
