"""Proxima — Web Server.
FastAPI server handling WebSocket communication and REST APIs for the Web UI.
"""
import asyncio
import json
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse, unquote
import httpx

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles

from . import db
from .agent_bridge import WebConsole, AgentRunner


_STATIC_DIR = Path(__file__).parent / "static"



_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1", "[::1]"}


def _is_loopback_origin(origin: str) -> bool:
    if not origin:
        return False
    try:
        host = urlparse(origin).hostname
    except Exception:
        return False
    return host in _LOOPBACK_HOSTS


def _origin_allowed(origin: str | None, expected_port: int | None = None) -> bool:
    if not origin:
        return True
    if not _is_loopback_origin(origin):
        return False
    if expected_port is not None:
        try:
            parsed = urlparse(origin)
            origin_port = parsed.port
            if origin_port is None:
                origin_port = 443 if parsed.scheme == "https" else 80
            if origin_port != expected_port:
                return False
        except Exception:
            return False
    return True


def _gateway_url() -> str:
    try:
        from ..config import DEFAULT_API_URL
        return DEFAULT_API_URL
    except Exception:
        return "http://127.0.0.1:3210/v1"



@asynccontextmanager
async def _lifespan(app: "FastAPI"):
    db.init_db()
    yield



app = FastAPI(title="Proxima Agent", docs_url=None, redoc_url=None, lifespan=_lifespan)



@app.middleware("http")
async def _origin_guard(request: Request, call_next):
    if not _origin_allowed(request.headers.get("origin"), request.url.port):
        return JSONResponse(
            status_code=403,
            content={"error": "Cross-origin requests are not allowed"},
        )
    return await call_next(request)


_active_ws: WebSocket | None = None
_active_console: WebConsole | None = None
_agent_runner = AgentRunner()
_ws_lock = asyncio.Lock()



async def check_gateway_health(api_url: str, api_key: str | None = None) -> bool:
    try:
        base = api_url.rstrip("/")
        headers = {}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        # Try /models endpoint (standard OpenAI-compat)
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.get(f"{base}/models", headers=headers)
            return r.status_code == 200
    except Exception:
        return False


try:
    _STATIC_DIR.mkdir(parents=True, exist_ok=True)
    app.mount("/static", StaticFiles(directory=str(_STATIC_DIR)), name="static")
except Exception as _static_err:
    print(f"[web] Static files unavailable: {_static_err}")



def _serve_index() -> HTMLResponse:
    index_path = _STATIC_DIR / "index.html"
    try:
        return HTMLResponse(content=index_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return HTMLResponse(
            content="<h1>Proxima Web UI not installed</h1>"
                    "<p><code>static/index.html</code> is missing from this build.</p>",
            status_code=500,
        )
    except OSError as e:
        return HTMLResponse(
            content=f"<h1>Proxima Web UI error</h1><p>Could not read index.html: {e}</p>",
            status_code=500,
        )


@app.get("/")
async def root():
    return _serve_index()


@app.get("/c/{conv_id}")
async def serve_chat(conv_id: str):
    return _serve_index()



@app.get("/api/status")
async def get_status():
    return {
        "connected": _active_ws is not None,
        "agent_running": _agent_runner.is_running,
    }


@app.get("/api/config")
async def get_config():
    from ..config import load_config
    return load_config()


@app.post("/api/config")
async def update_config(data: dict):
    from ..config import load_config, save_config
    config = load_config()
    config.update(data)
    save_config(config)
    
    # Check gateway health with new settings and push to active websocket if open
    global _active_ws
    if _active_ws is not None:
        gateway_ok = await check_gateway_health(
            config.get("api_url") or _gateway_url(),
            config.get("api_key")
        )
        try:
            await _active_ws.send_json({
                "type": "status",
                "connected": gateway_ok,
                "model": config.get("model", "auto"),
            })
        except Exception:
            pass
            
    return {"status": "ok"}


@app.get("/api/conversations")
async def list_conversations():
    return db.list_conversations()


@app.get("/api/conversations/{conv_id}")
async def get_conversation(conv_id: str):
    messages = db.get_messages(conv_id)
    executions = db.get_executions(conv_id)
    return {"messages": messages, "executions": executions}


@app.delete("/api/conversations/{conv_id}")
async def delete_conversation(conv_id: str):
    db.delete_conversation(conv_id)
    return {"status": "deleted"}


@app.post("/api/conversations/{conv_id}/pin")
async def pin_conversation(conv_id: str, data: dict):
    is_pinned = data.get("is_pinned", False)
    db.set_pinned(conv_id, is_pinned)
    return {"status": "ok", "is_pinned": is_pinned}


@app.post("/api/conversations/{conv_id}/folder")
async def folder_conversation(conv_id: str, data: dict):
    folder_name = data.get("folder_name")
    db.set_folder(conv_id, folder_name)
    return {"status": "ok", "folder_name": folder_name}


@app.post("/api/conversations/{conv_id}/title")
async def update_conversation_title(conv_id: str, data: dict):
    title = data.get("title")
    if not title:
        return JSONResponse(status_code=400, content={"detail": "Title is required"})
    db.update_conversation_title(conv_id, title)
    return {"status": "ok", "title": title}


@app.get("/api/history")
async def get_history():
    return db.list_conversations(limit=100)


@app.get("/api/file")
async def get_workspace_file(path: str):
    p = Path(path)
    if not p.is_absolute():
        p = (Path.cwd() / p).resolve()
    else:
        p = p.resolve()

    from .. import config as _config
    try:
        workspace = Path(_config.get_workspace_dir()).resolve()
    except Exception:
        workspace = Path.cwd().resolve()
    home_proxima = (Path.home() / ".proxima-agent").resolve()
    cwd = Path.cwd().resolve()

    def _within(base: Path) -> bool:
        return p == base or base in p.parents

    if not (_within(workspace) or _within(home_proxima) or _within(cwd)):
        return JSONResponse(status_code=403, content={"error": "Access denied"})

    name_l = p.name.lower()
    _BLOCKED_SUFFIXES = {".key", ".pem", ".env", ".sqlite", ".sqlite3"}
    _BLOCKED_NAMES = {"byok.json", "keys.json", ".env"}
    if (
        ".db" in name_l
        or ".sqlite" in name_l
        or p.suffix.lower() in _BLOCKED_SUFFIXES
        or name_l in _BLOCKED_NAMES
    ):
        return JSONResponse(status_code=403, content={"error": "Access denied"})

    if not p.exists() or not p.is_file():
        return JSONResponse(status_code=404, content={"error": "File not found"})
        
    return FileResponse(p)



_UPLOAD_DIR = Path.home() / ".proxima-agent" / "uploads"
_MAX_UPLOAD_SIZE = 25 * 1024 * 1024


@app.post("/api/upload")
async def upload_file(request: Request):
    _UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

    content = await request.body()
    if len(content) > _MAX_UPLOAD_SIZE:
        return JSONResponse(
            status_code=413,
            content={"error": f"File too large ({len(content) / 1024 / 1024:.1f} MB). Max is 25 MB."},
        )
    if len(content) == 0:
        return JSONResponse(status_code=400, content={"error": "File is empty."})

    filename = unquote(request.headers.get("x-filename", "file"))
    ext = Path(filename).suffix or ""
    dest = _UPLOAD_DIR / f"{uuid.uuid4().hex}{ext}"
    dest.write_bytes(content)

    return {"path": str(dest.resolve()), "name": filename, "size": len(content)}




@app.get("/api/byok/keys")
async def byok_list_keys():
    from ..config import list_agent_byok_keys, get_agent_byok_model
    keys = list_agent_byok_keys()
    result = {}
    for provider, configured in keys.items():
        entry = {"configured": configured}
        if configured:
            model = get_agent_byok_model(provider)
            if model:
                entry["model"] = model
        result[provider] = entry
    return result


@app.post("/api/byok/keys")
async def byok_save_key(data: dict):
    from ..config import save_agent_byok_key
    provider = data.get("provider", "").lower().strip()
    key = data.get("key", "").strip()
    if not provider or not key:
        return JSONResponse(status_code=400, content={"error": "provider and key required"})
    try:
        save_agent_byok_key(provider, key)
        return {"status": "ok", "provider": provider}
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})


@app.delete("/api/byok/keys/{provider}")
async def byok_remove_key(provider: str):
    from ..config import remove_agent_byok_key
    try:
        remove_agent_byok_key(provider.lower().strip())
        return {"status": "ok", "provider": provider}
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})


@app.get("/api/byok/models")
async def byok_get_models():
    from ..config import (
        list_agent_byok_keys, get_agent_byok_model,
        BYOK_VALID_PROVIDERS,
    )

    PROVIDER_NAMES = {
        "chatgpt": "OpenAI", "claude": "Anthropic", "gemini": "Gemini AI",
        "perplexity": "Perplexity", "deepseek": "DeepSeek", "groq": "Groq",
        "xai": "xAI (Grok)", "openrouter": "OpenRouter", "together": "Together AI",
        "fireworks": "Fireworks", "mistral": "Mistral", "nvidia": "NVIDIA NIM",
    }

    global_models = []
    global_enabled = False
    try:
        from ..config import load_config as _lc, DEFAULT_API_URL as _default_gw
        _cfg = _lc()
        gateway_url = (_cfg.get("api_url") or _default_gw).rstrip("/")
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{gateway_url}/byok/models")
            if r.status_code == 200:
                data = r.json()
                global_enabled = data.get("enabled", False)
                global_models = data.get("models", [])
    except Exception:
        pass

    local_keys = list_agent_byok_keys()
    local_models = []
    for provider in BYOK_VALID_PROVIDERS:
        if local_keys.get(provider):
            local_models.append({
                "id": provider,
                "name": PROVIDER_NAMES.get(provider, provider),
                "model": get_agent_byok_model(provider) or "auto",
                "source": "local",
            })

    seen = {m["id"] for m in local_models}
    for gm in global_models:
        if not isinstance(gm, dict):
            continue
        gid = gm.get("id")
        if not isinstance(gid, str) or not gid or gid in seen:
            continue
        gm["source"] = "global"
        seen.add(gid)
        local_models.append(gm)

    return {
        "global_enabled": global_enabled,
        "models": local_models,
        "has_local": any(local_keys.values()),
    }


@app.post("/api/byok/model")
async def byok_save_model(data: dict):
    from ..config import save_agent_byok_model
    provider = data.get("provider", "").lower().strip()
    model_id = data.get("model_id", "").strip()
    if not provider:
        return JSONResponse(status_code=400, content={"error": "provider required"})
    save_agent_byok_model(provider, model_id)
    return {"status": "ok", "provider": provider, "model": model_id or "auto"}



@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    global _active_ws, _active_console

    if not _origin_allowed(ws.headers.get("origin"), ws.url.port):
        await ws.close(code=1008)  # policy violation
        return

    async with _ws_lock:
        if _active_ws is not None:
            old_ws = _active_ws
            _active_ws = None
            _active_console = None
            try:
                await old_ws.close()
            except Exception:
                pass
            await asyncio.sleep(0.1)

        await ws.accept()
        _active_ws = ws

    loop = asyncio.get_event_loop()
    console = WebConsole(loop, ws)
    _active_console = console

    from ..config import load_config
    config = load_config()
    gateway_ok = await check_gateway_health(
        config.get("api_url") or _gateway_url(),
        config.get("api_key")
    )

    if _active_ws is not ws:
        console.disconnect()
        return

    try:
        await ws.send_json({
            "type": "status",
            "connected": gateway_ok,
            "model": config.get("model", "auto"),
            "mode": config.get("permission_mode", "smart"),
            "running": False,
        })
    except (RuntimeError, WebSocketDisconnect):
        console.disconnect()
        return

    conv_id = None

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except Exception:
                continue

            msg_type = msg.get("type", "")

            if msg_type == "message":
                content = msg.get("content", "").strip()
                if not content:
                    continue

                client_conv_id = msg.get("conversation_id")
                if client_conv_id:
                    conv_id = client_conv_id

                if conv_id is None:
                    conv_id = db.create_conversation(
                        model=msg.get("model", config.get("model", "auto")),
                        mode=msg.get("mode", config.get("permission_mode", "smart")),
                    )
                    await ws.send_json({
                        "type": "session_init",
                        "conversation_id": conv_id,
                    })

                db.save_message(conv_id, "user", content)

                if db.count_messages(conv_id) <= 1:
                    title = content[:80].replace("\n", " ")
                    db.update_conversation_title(conv_id, title)

                await ws.send_json({
                    "type": "user_message",
                    "content": content,
                })

                model = msg.get("model", config.get("model", "auto"))
                mode = msg.get("mode", config.get("permission_mode", "smart"))
                file_path = msg.get("file_path")
                _agent_runner.start(
                    console=console,
                    user_message=content,
                    model=model,
                    mode=mode,
                    conversation_id=conv_id,
                    file_path=file_path,
                )

            elif msg_type == "approve":
                approved = msg.get("approved", False)
                console.receive_input("y" if approved else "n")

            elif msg_type == "suggest_choice":
                value = msg.get("value")
                if value is None:
                    value = str(msg.get("choice", ""))
                console.receive_input(value)

            elif msg_type == "input_response":
                value = msg.get("value", "")
                console.receive_input(value)

            elif msg_type == "stop":
                _agent_runner.stop()

            elif msg_type == "new_session":
                _agent_runner.reset()
                conv_id = None
                await ws.send_json({
                    "type": "session_reset",
                })

            elif msg_type == "set_model":
                model = msg.get("model", "auto")
                config["model"] = model
                from ..config import load_config as _reload_cfg, save_config
                _fresh = _reload_cfg()
                _fresh["model"] = model
                save_config(_fresh)
                await ws.send_json({
                    "type": "status",
                    "model": model,
                })

            elif msg_type == "set_mode":
                mode = msg.get("mode", config.get("permission_mode", "smart"))
                config["permission_mode"] = mode
                from ..config import load_config as _reload_cfg, save_config
                _fresh = _reload_cfg()
                _fresh["permission_mode"] = mode
                save_config(_fresh)
                await ws.send_json({
                    "type": "status",
                    "mode": mode,
                })

            elif msg_type == "set_multi_agent":
                enabled = msg.get("enabled", False)
                config["multi_agent"] = bool(enabled)
                from ..config import load_config as _reload_cfg, save_config
                _fresh = _reload_cfg()
                _fresh["multi_agent"] = bool(enabled)
                save_config(_fresh)
                await ws.send_json({
                    "type": "status",
                    "multi_agent": bool(enabled),
                })

    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        console.disconnect()
        async with _ws_lock:
            if _active_ws is ws:
                _active_ws = None
                _active_console = None


def run_server(host: str = None, port: int = None):
    import uvicorn
    if host is None or port is None:
        try:
            from ..config import load_config, WEB_UI_HOST, WEB_UI_PORT
            cfg = load_config()
            host = host or WEB_UI_HOST
            port = port or cfg.get("port") or WEB_UI_PORT
        except Exception:
            host = host or "127.0.0.1"
            port = port or 8500
    print(f"\n  Proxima Agent Web UI")
    print(f"  > http://{host}:{port}")
    print(f"  > Press Ctrl+C to stop\n")
    uvicorn.run(app, host=host, port=port, log_level="warning")
