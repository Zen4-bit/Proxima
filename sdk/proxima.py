"""
Proxima SDK - Python client

Usage:
    from proxima import Proxima
    client = Proxima()
    response = client.chat("Hello", model="claude")
    print(response.text)
"""

import requests


class ProximaResponse:
    """Standardized response from any Proxima API call."""

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


class Proxima:
    """
    Proxima API Client — ONE function for everything.

    Usage:
        client = Proxima()
        response = client.chat("Hello", model="claude")
        print(response.text)

    Args:
        base_url:      API server URL (default: http://localhost:3210)
        api_key:       Optional API key
        default_model: Default model for all calls (default: auto)
    """

    def __init__(self, base_url="http://localhost:3210", api_key=None, default_model="auto"):
        self.base_url = base_url.rstrip("/")
        self.default_model = default_model
        self.session = requests.Session()
        self.session.headers.update({"Content-Type": "application/json"})
        if api_key:
            self.session.headers.update({"Authorization": f"Bearer {api_key}"})

    def chat(self, message="", *, model=None, function=None, **kwargs):
        """
        ONE function for everything. Model aur function change karo, behavior change hoga.

        Args:
            message:  Your message/prompt
            model:    "chatgpt", "claude", "gemini", "perplexity", or "auto"
            function: None="chat", "search", "translate", "brainstorm", "code", "analyze"

        Extra kwargs based on function:
            function="translate": to="Hindi", from_lang="English"
            function="code":     action="generate|review|debug|explain", language="Python", code="...", error="..."
            function="analyze":  url="https://...", question="...", focus="..."
            function="brainstorm": topic="..." (or use message)
            function="search":   query="..." (or use message)

        Returns:
            ProximaResponse with .text, .model, .response_time_ms

        Examples:
            # Chat
            client.chat("Hello", model="claude")
            client.chat("Hello", model="chatgpt")
            client.chat("Hello")  # auto picks best

            # Search
            client.chat("AI news 2026", model="perplexity", function="search")

            # Translate
            client.chat("Hello world", model="gemini", function="translate", to="Hindi")

            # Code generate
            client.chat("Sort algo", model="claude", function="code", action="generate", language="Python")

            # Code review
            client.chat(function="code", model="claude", action="review", code="def add(a,b): return a+b")

            # Brainstorm
            client.chat("Startup ideas", function="brainstorm")

            # Analyze URL
            client.chat(function="analyze", url="https://example.com", question="What is this?")
        """
        body = {
            "model": model or self.default_model,
        }

        # Set message
        if message:
            body["message"] = message

        # Set function if specified
        if function:
            body["function"] = function

        # Pass through all extra kwargs
        # Supports: to, from_lang→from, action, language, code, error, url, question, focus, topic, query, etc.
        for key, value in kwargs.items():
            if value is not None:
                # Rename from_lang to from (since 'from' is Python keyword)
                api_key_name = "from" if key == "from_lang" else key
                body[api_key_name] = value

        return self._post("/v1/chat/completions", body)

    # System functions

    def get_models(self):
        """List all available models and their status."""
        return self._get("/v1/models").get("data", [])

    def get_functions(self):
        """Get the API function catalog — shows how to use the ONE endpoint."""
        return self._get("/v1/functions")

    def get_stats(self):
        """Get response time statistics per provider."""
        return self._get("/v1/stats")

    def new_conversation(self):
        """Start fresh conversations for all providers."""
        return self._post_raw("/v1/conversations/new", {})

    # Internals

    def _request(self, method, endpoint, body=None, timeout=120, max_retries=3):
        """Internal request handler with retry logic and connection error handling."""
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
                break  # Don't retry on unknown errors

            # Wait before retry (exponential backoff: 1s, 2s)
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
        return ProximaResponse(resp.json())

    def _post_raw(self, endpoint, body):
        resp = self._request("POST", endpoint, body=body, timeout=30)
        return resp.json()

    def _get(self, endpoint):
        resp = self._request("GET", endpoint, timeout=30)
        return resp.json()

