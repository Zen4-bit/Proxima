"""Proxima — Network Operations.
Handles HTTP requests and file downloads safely with SSRF protection.
"""
import os
import json
import socket
import ipaddress
import http.client
import urllib.request
import urllib.error
from urllib.parse import urlparse
from pathlib import Path


_ALLOWED_SCHEMES = {"http", "https"}
_MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024
_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
_MAX_RESPONSE_CHARS = 50000


def _validate_url(url):
    try:
        parsed = urlparse(url)
    except Exception as e:
        return f"✗ Blocked: invalid URL ({e})"

    scheme = (parsed.scheme or "").lower()
    if scheme not in _ALLOWED_SCHEMES:
        return f"✗ Blocked: scheme '{scheme or '(none)'}' not allowed (only http/https)"

    host = parsed.hostname
    if not host:
        return "✗ Blocked: URL has no host"

    try:
        infos = socket.getaddrinfo(host, parsed.port, proto=socket.IPPROTO_TCP)
    except Exception as e:
        return f"✗ Blocked: cannot resolve host '{host}' ({e})"

    seen = set()
    for info in infos:
        addr = info[4][0]
        if addr in seen:
            continue
        seen.add(addr)
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            return f"✗ Blocked: unparseable address '{addr}' for host '{host}'"

        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            return (
                f"✗ Blocked: host '{host}' resolves to non-public address "
                f"{addr} (SSRF protection)"
            )

    return None


class _ValidatingRedirectHandler(urllib.request.HTTPRedirectHandler):

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        err = _validate_url(newurl)
        if err is not None:
            raise urllib.error.HTTPError(newurl, code, err, headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _resolve_safe_ip(host: str) -> str:
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except Exception as e:
        raise urllib.error.URLError(f"cannot resolve host '{host}' ({e})")

    safe_ip = None
    for info in infos:
        addr = info[4][0]
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            raise urllib.error.URLError(f"unparseable address '{addr}' for host '{host}'")
        if (
            ip.is_private or ip.is_loopback or ip.is_link_local
            or ip.is_reserved or ip.is_multicast or ip.is_unspecified
        ):
            raise urllib.error.URLError(
                f"host '{host}' resolves to non-public address {addr} (SSRF protection)"
            )
        if safe_ip is None:
            safe_ip = addr

    if safe_ip is None:
        raise urllib.error.URLError(f"no addresses for host '{host}'")
    return safe_ip


class _SafeHTTPConnection(http.client.HTTPConnection):

    def connect(self):
        ip = _resolve_safe_ip(self.host)
        self.sock = socket.create_connection(
            (ip, self.port), self.timeout, self.source_address
        )
        if getattr(self, "_tunnel_host", None):
            self._tunnel()


class _SafeHTTPSConnection(http.client.HTTPSConnection):

    def connect(self):
        ip = _resolve_safe_ip(self.host)
        sock = socket.create_connection(
            (ip, self.port), self.timeout, self.source_address
        )
        if getattr(self, "_tunnel_host", None):
            self.sock = sock
            self._tunnel()
            sock = self.sock
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


class _SafeHTTPHandler(urllib.request.HTTPHandler):
    def http_open(self, req):
        return self.do_open(_SafeHTTPConnection, req)


class _SafeHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req):
        kwargs = {"context": getattr(self, "_context", None)}
        ch = getattr(self, "_check_hostname", None)
        if ch is not None:
            kwargs["check_hostname"] = ch
        return self.do_open(_SafeHTTPSConnection, req, **kwargs)


def _build_opener():
    return urllib.request.build_opener(
        _SafeHTTPHandler(),
        _SafeHTTPSHandler(),
        _ValidatingRedirectHandler(),
    )


def _read_capped(resp) -> str:
    raw = resp.read(_MAX_RESPONSE_BYTES)
    return raw.decode("utf-8", errors="replace")


def http_get(url, headers=None):
    err = _validate_url(url)
    if err is not None:
        return err
    req = urllib.request.Request(url, headers=headers or {"User-Agent": "Proxima-Agent/2.0"})
    try:
        opener = _build_opener()
        with opener.open(req, timeout=30) as resp:
            return _read_capped(resp)[:_MAX_RESPONSE_CHARS]
    except Exception as e:
        return f"✗ HTTP Error: {e}"


def http_post(url, data=None, json_data=None, headers=None):
    err = _validate_url(url)
    if err is not None:
        return err
    hdrs = headers or {}
    hdrs["User-Agent"] = "Proxima-Agent/2.0"

    if json_data:
        body = json.dumps(json_data).encode("utf-8")
        hdrs["Content-Type"] = "application/json"
    elif data:
        body = data.encode("utf-8") if isinstance(data, str) else data
    else:
        body = None

    req = urllib.request.Request(url, data=body, headers=hdrs, method="POST")
    try:
        opener = _build_opener()
        with opener.open(req, timeout=30) as resp:
            return _read_capped(resp)[:_MAX_RESPONSE_CHARS]
    except Exception as e:
        return f"✗ HTTP Error: {e}"


def download(url, path, chunk_size=8192, timeout=30, max_bytes=_MAX_DOWNLOAD_BYTES):
    err = _validate_url(url)
    if err is not None:
        return err

    path = Path(path).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)

    req = urllib.request.Request(url, headers={"User-Agent": "Proxima-Agent/2.0"})
    try:
        opener = _build_opener()
        with opener.open(req, timeout=timeout) as resp:
            total = 0
            with open(str(path), "wb") as out:
                while True:
                    chunk = resp.read(chunk_size)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > max_bytes:
                        out.close()
                        try:
                            os.remove(str(path))
                        except OSError:
                            pass
                        return (
                            f"✗ Download failed: exceeded max size "
                            f"({max_bytes:,} bytes)"
                        )
                    out.write(chunk)
        size = os.path.getsize(str(path))
        return f"✓ Downloaded: {path} ({size:,} bytes)"
    except Exception as e:
        return f"✗ Download failed: {e}"
