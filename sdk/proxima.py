"""Proxima SDK - Python client"""

import requests


class ProximaResponse:


    def __init__(self, data: dict):
        self._data = data
        first_choice = (data.get("choices") or [{}])[0]
        message = first_choice.get("message", {})
        proxima = data.get("proxima", {})

        self.text = message.get("content", "")
        self.model = data.get("model", first_choice.get("model", ""))
        self.id = data.get("id", "")
        self.finish_reason = first_choice.get("finish_reason", "")
        self.response_time_ms = proxima.get("responseTimeMs", 0)
        self.provider = proxima.get("provider", self.model)
        self.function = data.get("function", "")

    def __str__(self):
        return self.text

    def __repr__(self):
        return f"ProximaResponse(model='{self.model}', text='{self.text[:50]}...')"

    def to_dict(self):
        return self._data


def _discover_rest_port() -> int:
    import os, json, sys
    env_port = os.environ.get("PROXIMA_REST_PORT") or os.environ.get("PROXIMA_PORT")
    if env_port:
        try:
            p = int(env_port)
            if 0 < p <= 65535:
                return p
        except ValueError:
            pass
    try:
        candidates = []
        if os.environ.get("PROXIMA_DATA_DIR"):
            candidates.append(os.path.join(os.environ["PROXIMA_DATA_DIR"], "rest-port.json"))
        else:
            home = os.environ.get("HOME", "")
            if sys.platform == "win32":
                base = os.environ.get("APPDATA") or os.path.join(os.environ.get("USERPROFILE", home), "AppData", "Roaming")
                candidates.extend([os.path.join(base, "Proxima", "rest-port.json"), os.path.join(base, "proxima", "rest-port.json")])
            elif sys.platform == "darwin":
                base = os.path.join(home, "Library", "Application Support")
                candidates.extend([os.path.join(base, "Proxima", "rest-port.json"), os.path.join(base, "proxima", "rest-port.json")])
            else:
                xdg = os.environ.get("XDG_CONFIG_HOME") or os.path.join(home, ".config")
                candidates.extend([os.path.join(xdg, "Proxima", "rest-port.json"), os.path.join(xdg, "proxima", "rest-port.json")])
        existing = [c for c in candidates if os.path.exists(c)]
        if len(existing) > 1:
            existing.sort(key=lambda x: os.path.getmtime(x) if os.path.exists(x) else 0, reverse=True)
        for port_file in existing:
            try:
                with open(port_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    p = int(data.get("port", 0))
                    if 0 < p <= 65535:
                        return p
            except Exception:
                pass
    except Exception:
        pass
    return 3210


class Proxima:


    def __init__(self, base_url=None, api_key=None, default_model="auto"):
        port = _discover_rest_port()
        self.base_url = (base_url or f"http://localhost:{port}").rstrip("/")
        self.default_model = default_model
        self.session = requests.Session()
        self.session.headers.update({"Content-Type": "application/json"})
        if api_key:
            self.session.headers.update({"Authorization": f"Bearer {api_key}"})

    def chat(self, message="", *, model=None, function=None, thinking_level=None, reasoning_effort=None, **kwargs):

        body = {
            "model": model or self.default_model,
        }

        if message:
            body["message"] = message

        if function:
            body["function"] = function

        if thinking_level:
            body["thinking_level"] = thinking_level

        if reasoning_effort:
            body["reasoning_effort"] = reasoning_effort

        for key, value in kwargs.items():
            if value is not None:

                api_key_name = "from" if key == "from_lang" else key
                body[api_key_name] = value

        return self._post("/v1/chat/completions", body)



    def get_models(self):

        return self._get("/v1/models").get("data", [])

    def get_functions(self):

        return self._get("/v1/functions")

    def get_stats(self):

        return self._get("/v1/stats")

    def new_conversation(self, provider):

        return self._post_raw("/v1/conversations/new", {"provider": provider})



    def _endpoint_url(self, endpoint: str) -> str:
        base = self.base_url.rstrip("/")
        ep = endpoint if endpoint.startswith("/") else f"/{endpoint}"
        if base.endswith("/v1") and ep.startswith("/v1/"):
            return f"{base}{ep[3:]}"
        return f"{base}{ep}"

    def _request(self, method, endpoint, body=None, timeout=120, max_retries=3):

        url = self._endpoint_url(endpoint)
        last_error = None

        for attempt in range(max_retries):
            try:
                if method == "GET":
                    resp = self.session.get(url, timeout=timeout)
                else:
                    resp = self.session.post(url, json=body, timeout=timeout)
                return resp
            except requests.exceptions.ConnectionError:
                last_error = ConnectionError(
                    f"Cannot connect to Proxima at {self.base_url}. "
                    f"Is the Proxima app running? (attempt {attempt + 1}/{max_retries})"
                )
            except requests.exceptions.Timeout:
                last_error = TimeoutError(
                    f"Request to {endpoint} timed out after {timeout}s. "
                    f"The AI provider may be slow. (attempt {attempt + 1}/{max_retries})"
                )
            except requests.exceptions.RequestException as e:
                last_error = Exception(f"Request failed: {e}")
                break


            if attempt < max_retries - 1:
                import time
                time.sleep(1 * (attempt + 1))

        if last_error is not None:
            raise last_error
        raise RuntimeError(f"Request to {endpoint} failed after {max_retries} attempts")

    def _post(self, endpoint, body):
        resp = self._request("POST", endpoint, body=body, timeout=120)
        if resp.status_code >= 400:
            error_msg = f"API error: {resp.status_code}"
            try:
                if resp.headers.get("content-type", "").startswith("application/json"):
                    error_data = resp.json()
                    err = error_data.get("error") if isinstance(error_data, dict) else None
                    if isinstance(err, dict):
                        error_msg = err.get("message") or error_msg
                    elif isinstance(err, str) and err.strip():
                        error_msg = err
            except Exception:
                pass
            raise Exception(error_msg)
        return ProximaResponse(resp.json())

    def _post_raw(self, endpoint, body):
        resp = self._request("POST", endpoint, body=body, timeout=30)
        self._raise_for_status(resp)
        return resp.json()

    def _get(self, endpoint):
        resp = self._request("GET", endpoint, timeout=30)
        self._raise_for_status(resp)
        return resp.json()

    @staticmethod
    def _raise_for_status(resp):
        if resp.status_code < 400:
            return
        msg = f"API error: {resp.status_code}"
        if resp.headers.get("content-type", "").startswith("application/json"):
            try:
                msg = resp.json().get("error", {}).get("message", msg)
            except ValueError:
                pass
        raise Exception(msg)

