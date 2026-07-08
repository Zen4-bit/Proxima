"""Tests for proxima_agent.multi_agent.peers — peer AI communication wire.

Network (_http_call / urlopen) and the worker pool are mocked so no real HTTP
or threads run. configure/disable/drain_responses/has_pending are MODULE-level
functions (the _PeerProxy only exposes .available/.send/.reset/.delegate), so
they are called via peers_mod. Module globals are reset per test via disable().
"""
import json
import unittest
from unittest.mock import patch, MagicMock

import importlib
# multi_agent/__init__ rebinds the package attribute `peers` to the proxy, so a
# plain `import ...peers as peers_mod` yields the proxy. Pull the real submodule
# straight from sys.modules via importlib to reach the module-level functions.
peers_mod = importlib.import_module("proxima_agent.multi_agent.peers")
from proxima_agent.multi_agent.peers import peers    # the _PeerProxy singleton


class PeersBase(unittest.TestCase):
    def tearDown(self):
        peers_mod.disable()
        with peers_mod._queue_lock:
            peers_mod._response_queue.clear()


class TestConfigure(PeersBase):
    def test_configure_sets_available_and_strips_v1(self):
        peers_mod.configure("http://127.0.0.1:3210/v1", "sk-key", ["claude", "perplexity"])
        self.assertEqual(sorted(peers.available), ["claude", "perplexity"])
        self.assertEqual(peers_mod._API_URL, "http://127.0.0.1:3210")  # /v1 stripped

    def test_disable_clears_available_and_reconfig_flag(self):
        peers_mod.configure("http://x/v1", "k", ["claude"])
        peers_mod.disable()
        self.assertFalse(peers_mod._CONFIGURED)


class TestProxyRouting(PeersBase):
    def test_reserved_and_dunder_attrs_raise_attribute_error(self):
        with self.assertRaises(AttributeError):
            getattr(peers, "_secret")
        with self.assertRaises(AttributeError):
            getattr(peers, "configure")  # reserved name

    def test_sync_call_unknown_provider_raises(self):
        peers_mod.configure("http://x/v1", "k", ["claude"])
        with self.assertRaises(ValueError):
            peers.perplexity("hi")  # not in available

    def test_sync_call_available_provider_returns_text(self):
        peers_mod.configure("http://x/v1", "k", ["claude"])
        with patch.object(peers_mod, "_http_call", return_value="claude says hi") as hc:
            out = peers.claude("review this")
            self.assertEqual(out, "claude says hi")
            hc.assert_called_once()


class TestAsyncQueue(PeersBase):
    def test_drain_returns_and_clears(self):
        with peers_mod._queue_lock:
            peers_mod._response_queue.append(
                {"provider": "claude", "response": "r", "elapsed": "1s", "status": "completed"})
        self.assertTrue(peers_mod.has_pending())
        drained = peers_mod.drain_responses()
        self.assertEqual(len(drained), 1)
        self.assertFalse(peers_mod.has_pending())

    def test_send_unknown_provider_raises_before_enqueue(self):
        peers_mod.configure("http://x/v1", "k", ["claude"])
        with self.assertRaises(ValueError):
            peers.send("perplexity", "hi")

    def test_send_enqueues_for_available_provider(self):
        peers_mod.configure("http://x/v1", "k", ["claude"])
        fake_queue = MagicMock()
        with patch.object(peers_mod, "_ensure_workers"), \
             patch.object(peers_mod, "_send_queue", fake_queue):
            peers.send("claude", "do a review")
            fake_queue.put_nowait.assert_called_once()


class TestHttpCallParsing(PeersBase):
    def _resp(self, payload):
        class _Resp:
            def __enter__(self_): return self_
            def __exit__(self_, *a): return False
            def read(self_): return json.dumps(payload).encode()
        return _Resp()

    def test_parses_openai_shape(self):
        peers_mod.configure("http://x/v1", "k", ["claude"])
        payload = {"choices": [{"message": {"content": "parsed answer"}}]}
        with patch("urllib.request.urlopen", return_value=self._resp(payload)):
            self.assertEqual(peers_mod._http_call("claude", "hi"), "parsed answer")

    def test_falls_back_for_nonstandard_shape(self):
        peers_mod.configure("http://x/v1", "k", ["claude"])
        payload = {"response": "fallback text"}
        with patch("urllib.request.urlopen", return_value=self._resp(payload)):
            self.assertEqual(peers_mod._http_call("claude", "hi"), "fallback text")


if __name__ == "__main__":
    unittest.main()
