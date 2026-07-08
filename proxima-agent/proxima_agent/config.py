"""Proxima Agent Configuration.
Defines network endpoints, paths, workspace directories, and BYOK configurations.
"""
import os
import json

LOCAL_HOST = os.environ.get("PROXIMA_HOST", "127.0.0.1")


def normalize_localhost(url: str) -> str:
    """Normalizes localhost URLs to 127.0.0.1."""
    if not url:
        return url
    return (
        url.replace("http://localhost:", f"http://{LOCAL_HOST}:")
           .replace("https://localhost:", f"https://{LOCAL_HOST}:")
           .replace("ws://localhost:", f"ws://{LOCAL_HOST}:")
     )


GATEWAY_PORT = int(os.environ.get("PROXIMA_GATEWAY_PORT", "3210"))
DEFAULT_API_URL = os.environ.get("PROXIMA_API_URL", f"http://{LOCAL_HOST}:{GATEWAY_PORT}/v1")

CDP_PORT = int(os.environ.get("PROXIMA_CDP_PORT", "9222"))
CDP_URL = f"http://{LOCAL_HOST}:{CDP_PORT}"

WEB_UI_HOST = os.environ.get("PROXIMA_WEB_HOST", LOCAL_HOST)
WEB_UI_PORT = int(os.environ.get("PROXIMA_WEB_PORT", "8500"))

WORKSPACE_DIR = os.environ.get(
    "PROXIMA_WORKSPACE",
    os.path.join(os.path.expanduser("~"), "Proxima"),
)


def get_workspace_dir() -> str:
    """Returns the agent workspace directory, creating it if needed."""
    try:
        os.makedirs(WORKSPACE_DIR, exist_ok=True)
        return WORKSPACE_DIR
    except Exception:
        return os.path.expanduser("~")


_DEFAULT_LOCAL_KEY = os.environ.get("PROXIMA_API_KEY", "sk-14e37c6d4cf2-proxima")

DEFAULT_CONFIG = {
    "api_url": DEFAULT_API_URL,
    "api_key": _DEFAULT_LOCAL_KEY,
    "model": "gemini",
    "max_tool_iterations": 50,
    "temperature": 0.7,
    "max_api_retries": 4,
    "max_exec_output_chars": 15000,
    "max_tool_result_chars": 10000,
    "agent_memory_enabled": True,
    "multi_agent": False,
    "vault_enabled": True,
    "compaction_threshold": 30,
    "compaction_hard_threshold": 50,
    "insights_enabled": True,
}

MEMORY_DB_PATH = os.path.join(os.path.expanduser("~"), ".proxima-agent", "memory.db")


def get_limit(key: str, default: int) -> int:
    """Reads an integer limit from configuration, falling back to a default value on error."""
    try:
        cfg = load_config()
        v = int(cfg.get(key, default))
        return v if v > 0 else default
    except Exception:
        return default

CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".proxima-agent", "config.json")


def load_config():
    """Loads configuration from file, falling back to defaults."""
    config = DEFAULT_CONFIG.copy()
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                user_config = json.load(f)
            config.update(user_config)
        except Exception:
            pass
    config["api_url"] = normalize_localhost(config.get("api_url", DEFAULT_API_URL))
    return config


def save_config(config):
    """Saves configuration to file."""
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)


BYOK_VALID_PROVIDERS = (
    "chatgpt", "claude", "gemini", "perplexity",
    "deepseek", "groq", "xai", "openrouter",
    "together", "fireworks", "mistral", "nvidia",
)


def get_agent_byok_key(provider: str) -> str | None:
    """Gets the agent-local BYOK key for a provider, or None."""
    config = load_config()
    keys = config.get("byok_keys", {})
    return keys.get(provider) or None


def save_agent_byok_key(provider: str, key: str) -> None:
    """Saves an agent-local BYOK key for a provider."""
    provider = provider.lower().strip()
    if provider not in BYOK_VALID_PROVIDERS:
        raise ValueError(f"Invalid provider: {provider}")
    if not key or not isinstance(key, str) or len(key.strip()) < 5:
        raise ValueError("API key must be at least 5 characters.")
    config = load_config()
    if "byok_keys" not in config:
        config["byok_keys"] = {}
    config["byok_keys"][provider] = key.strip()
    save_config(config)


def remove_agent_byok_key(provider: str) -> None:
    """Removes an agent-local BYOK key for a provider."""
    provider = provider.lower().strip()
    config = load_config()
    keys = config.get("byok_keys", {})
    if provider in keys:
        del keys[provider]
        config["byok_keys"] = keys
        models = config.get("byok_models", {})
        if provider in models:
            del models[provider]
            config["byok_models"] = models
        save_config(config)


def list_agent_byok_keys() -> dict:
    """Lists agent-local BYOK key configuration status without exposing values."""
    config = load_config()
    keys = config.get("byok_keys", {})
    return {p: bool(keys.get(p)) for p in BYOK_VALID_PROVIDERS}


def save_agent_byok_model(provider: str, model_id: str) -> None:
    """Saves the user-selected model for an agent-local BYOK provider."""
    provider = provider.lower().strip()
    config = load_config()
    if "byok_models" not in config:
        config["byok_models"] = {}
    if model_id and isinstance(model_id, str) and model_id.strip():
        config["byok_models"][provider] = model_id.strip()
    else:
        config["byok_models"].pop(provider, None)
    save_config(config)


def get_agent_byok_model(provider: str) -> str | None:
    """Gets the user-selected model for an agent-local BYOK provider."""
    config = load_config()
    models = config.get("byok_models", {})
    return models.get(provider) or None
