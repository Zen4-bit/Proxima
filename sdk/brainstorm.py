"""
brAInstorm SDK - Python client
"""

import requests


class BrainstormResponse:
    """Standardized response from any brAInstorm API call."""

    def __init__(self, data: dict):
        self._data = data
        first_choice = (data.get("choices") or [{}])[0]
        message = first_choice.get("message", {})
        metadata = data.get("brainstorm") or data.get("proxima") or {}

        self.text = message.get("content", "")
        self.model = data.get("model", first_choice.get("model", ""))
        self.id = data.get("id", "")
        self.finish_reason = first_choice.get("finish_reason", "")
        self.response_time_ms = metadata.get("responseTimeMs", 0)
        self.provider = metadata.get("provider", self.model)
        self.function = data.get("function", "")

    def __str__(self):
        return self.text

    def __repr__(self):
        return f"BrainstormResponse(model='{self.model}', text='{self.text[:50]}...')"

    def to_dict(self):
        return self._data


class Brainstorm:
    """
    brAInstorm API client.
    """

    def __init__(self, base_url="http://localhost:3210", api_key=None, default_model="auto"):
        self.base_url = base_url.rstrip("/")
        self.default_model = default_model
        self.session = requests.Session()
        self.session.headers.update({"Content-Type": "application/json"})
        if api_key:
            self.session.headers.update({"Authorization": f"Bearer {api_key}"})

    def chat(self, message="", *, model=None, function=None, **kwargs):
        body = {
            "model": model or self.default_model,
        }

        if message:
            body["message"] = message

        if function:
            body["function"] = function

        for key, value in kwargs.items():
            if value is not None:
                api_key_name = "from" if key == "from_lang" else key
                body[api_key_name] = value

        return self._post("/v1/chat/completions", body)

    def get_models(self):
        return self._get("/v1/models").get("data", [])

    def get_functions(self):
        return self._get("/v1/functions")

    def get_skills(self):
        return self._get("/v1/skills")

    def get_stats(self):
        return self._get("/v1/stats")

    def new_conversation(self):
        return self._post_raw("/v1/conversations/new", {})

    def _request(self, method, endpoint, body=None, timeout=120, max_retries=3):
        url = f"{self.base_url}{endpoint}"
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
                    f"Cannot connect to brAInstorm at {self.base_url}. "
                    f"Is the brAInstorm app running? (attempt {attempt + 1}/{max_retries})"
                )
            except requests.exceptions.Timeout:
                last_error = TimeoutError(
                    f"Request to {endpoint} timed out after {timeout}s. "
                    f"The AI provider may be slow. (attempt {attempt + 1}/{max_retries})"
                )
            except requests.exceptions.RequestException as error:
                last_error = Exception(f"Request failed: {error}")
                break

            if attempt < max_retries - 1:
                import time
                time.sleep(1 * (attempt + 1))

        raise last_error

    def _post(self, endpoint, body):
        resp = self._request("POST", endpoint, body=body, timeout=120)
        if resp.status_code != 200:
            error_data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
            error_msg = error_data.get("error", {}).get("message", f"API error: {resp.status_code}")
            raise Exception(error_msg)
        return BrainstormResponse(resp.json())

    def _post_raw(self, endpoint, body):
        resp = self._request("POST", endpoint, body=body, timeout=30)
        return resp.json()

    def _get(self, endpoint):
        resp = self._request("GET", endpoint, timeout=30)
        return resp.json()
