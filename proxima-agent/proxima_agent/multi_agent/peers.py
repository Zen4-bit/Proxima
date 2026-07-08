"""Proxima — Peer AI Communication.
Provides communication APIs for sync and async delegation between peer agents.
"""

import json
import urllib.request
import threading
import time
import queue

_API_URL = ""
_API_KEY = ""
_AVAILABLE: list[str] = []
_CONFIGURED = False

_config_lock = threading.Lock()
_response_queue: list[dict] = []
_queue_lock = threading.Lock()


def _auto_configure():
    """Reads config file and discovers peers from gateway."""
    global _API_URL, _API_KEY, _AVAILABLE, _CONFIGURED
    if _CONFIGURED:
        return

    with _config_lock:
        if _CONFIGURED:
            return

        try:
            from ..config import load_config
            config = load_config()
        except Exception:
            config = {}

        if not config.get("multi_agent", False):
            _AVAILABLE = []
            return

        api_url = config.get("api_url", "http://127.0.0.1:3210/v1")
        api_key = config.get("api_key", "")
        self_model = config.get("model", "auto")

        base = api_url.rstrip("/")
        if base.endswith("/v1"):
            base = base[:-3]

        _API_URL = base
        _API_KEY = api_key

        try:
            req = urllib.request.Request(
                f"{base}/api/status",
                headers={"Authorization": f"Bearer {api_key}"},
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read())

            all_providers = data.get("enabledProviders", [])

            if self_model == "auto" and all_providers:
                self_model = all_providers[0]

            self_base = self_model.split(":")[0] if ":" in self_model else self_model
            _AVAILABLE = [p for p in all_providers if p != self_base]
        except Exception:
            _AVAILABLE = []

        _CONFIGURED = True


def configure(api_url: str, api_key: str, available: list):
    """Configures peer connection parameters explicitly."""
    global _API_URL, _API_KEY, _AVAILABLE, _CONFIGURED
    base = api_url.rstrip("/")
    if base.endswith("/v1"):
        base = base[:-3]
    with _config_lock:
        _API_URL = base
        _API_KEY = api_key
        _AVAILABLE = list(available)
        _CONFIGURED = True


def disable():
    """Disables peer orchestration and resets active configuration."""
    global _AVAILABLE, _CONFIGURED
    with _config_lock:
        _AVAILABLE = []
        _CONFIGURED = False


def _ensure_configured():
    """Ensures config is loaded before operating."""
    if not _CONFIGURED:
        _auto_configure()


def _http_call(provider: str, message: str, timeout: int = 180) -> str:
    """Performs raw HTTP completion call to the gateway."""
    _ensure_configured()
    body = json.dumps({
        "model": provider,
        "messages": [{"role": "user", "content": message}],
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{_API_URL}/v1/chat/completions",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {_API_KEY}",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read())

    try:
        return data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        return data.get("response", data.get("text", str(data)))


def _async_call(provider: str, message: str, timeout: int = 180):
    """Performs background thread call and queues responses."""
    started = time.time()
    try:
        response = _http_call(provider, message, timeout)
        with _queue_lock:
            _response_queue.append({
                "provider": provider,
                "response": response,
                "elapsed": f"{time.time() - started:.1f}s",
                "status": "completed",
            })
    except Exception as e:
        with _queue_lock:
            _response_queue.append({
                "provider": provider,
                "response": f"[ERROR: {e}]",
                "elapsed": f"{time.time() - started:.1f}s",
                "status": "failed",
            })


def drain_responses() -> list[dict]:
    """Drains all completed background responses."""
    with _queue_lock:
        items = list(_response_queue)
        _response_queue.clear()
    return items


def has_pending() -> bool:
    """Returns True if there are undelivered async responses."""
    with _queue_lock:
        return len(_response_queue) > 0


_MAX_CONCURRENT_PEERS = 4
_send_queue: "queue.Queue" = queue.Queue(maxsize=64)
_workers_started = False
_workers_lock = threading.Lock()


def _send_worker():
    """Daemon worker for async call queue processing."""
    while True:
        provider, message, timeout = _send_queue.get()
        try:
            _async_call(provider, message, timeout)
        except Exception:
            pass
        finally:
            _send_queue.task_done()


def _ensure_workers():
    """Lazily starts fixed daemon worker pool."""
    global _workers_started
    if _workers_started:
        return
    with _workers_lock:
        if _workers_started:
            return
        for i in range(_MAX_CONCURRENT_PEERS):
            threading.Thread(
                target=_send_worker, daemon=True, name=f"peer-worker-{i}"
            ).start()
        _workers_started = True


class _PeerProxy:
    """Dynamic attribute proxy for peer call routing."""

    @property
    def available(self) -> list:
        """Lists available peer AI providers."""
        _ensure_configured()
        return list(_AVAILABLE)

    def __getattr__(self, provider: str):
        """Sync call attribute routing."""
        if provider.startswith("_") or provider in (
            "available", "send", "reset", "configure",
        ):
            raise AttributeError(provider)

        def _sync_call(message: str, timeout: int = 180) -> str:
            _ensure_configured()
            if provider not in _AVAILABLE:
                avail = ", ".join(_AVAILABLE) if _AVAILABLE else "none"
                raise ValueError(
                    f"'{provider}' is not available. Available peers: {avail}"
                )
            return _http_call(provider, message, timeout)

        _sync_call.__name__ = f"peers.{provider}"
        _sync_call.__qualname__ = f"_PeerProxy.{provider}"
        return _sync_call

    def send(self, provider: str, message: str, timeout: int = 180):
        """Queues an asynchronous request to a peer."""
        _ensure_configured()
        if provider not in _AVAILABLE:
            avail = ", ".join(_AVAILABLE) if _AVAILABLE else "none"
            raise ValueError(
                f"'{provider}' not available. Available peers: {avail}"
            )
        _ensure_workers()
        try:
            _send_queue.put_nowait((provider, message, timeout))
        except queue.Full:
            raise RuntimeError(
                f"Too many pending peer requests (>{_send_queue.maxsize} queued). "
                "Wait for some to complete (they auto-inject on your next turn) "
                "before delegating more."
            )
        print(f"[Delegated to {provider}] — response will auto-appear when ready")

    def reset(self, provider: str = None):
        """Resets conversation state for the specified peer."""
        _ensure_configured()
        target = provider or "all"
        body = json.dumps({"provider": target}).encode("utf-8")
        req = urllib.request.Request(
            f"{_API_URL}/v1/conversations/new",
            data=body,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {_API_KEY}",
            },
        )
        try:
            urllib.request.urlopen(req, timeout=10)
            label = provider or "all peers"
            print(f"[Reset] {label} — fresh conversation started")
        except Exception as e:
            print(f"[Reset] Warning: could not reset {target}: {e}")

    def delegate(
        self,
        provider: str,
        task: str,
        context: dict = None,
        max_iterations: int = 30,
    ) -> str:
        """Delegates a complex tool-use task to a peer sub-agent."""
        _ensure_configured()
        if provider not in _AVAILABLE:
            avail = ", ".join(_AVAILABLE) if _AVAILABLE else "none"
            raise ValueError(
                f"'{provider}' not available for delegation. Available peers: {avail}"
            )

        print(f"[Delegating to {provider}] Task: {task[:100]}...")
        print(f"[{provider}] Sub-agent starting with tool access...")

        from .subagent import run_subagent

        result = run_subagent(
            model=provider,
            task=task,
            context=context or {},
            max_iterations=max_iterations,
            on_progress=lambda i, desc: print(
                f"  [{provider} step {i}] {desc}"
            ),
        )

        status = result["status"]
        summary = result["summary"]
        elapsed = result["elapsed"]
        iterations = result["iterations"]

        status_icon = {"completed": "✅", "failed": "❌", "max_iterations": "⚠️"}.get(status, "?")

        print(f"\n{status_icon} [{provider}] {status} in {elapsed:.1f}s ({iterations} iterations)")

        if status == "completed":
            return summary
        elif status == "failed":
            return f"[DELEGATION FAILED — {provider}] {summary}"
        else:
            return f"[DELEGATION INCOMPLETE — {provider}] Hit max iterations. Last: {summary}"


peers = _PeerProxy()
