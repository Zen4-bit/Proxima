"""Proxima — Brain Operations Bridge.
Bridges Python tool calls to the Node.js brain REST API endpoint in BYOK mode.
"""

import json
import os
import urllib.request
import urllib.error

_GATEWAY_PORT = int(os.environ.get("PROXIMA_GATEWAY_PORT", "3210"))
_BASE = f"http://127.0.0.1:{_GATEWAY_PORT}/v1/brain"


def _post(endpoint, payload):
    """POSTs JSON to brain API and returns response."""
    url = f"{_BASE}/{endpoint}"
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        try:
            return json.loads(err_body)
        except Exception:
            return {"error": f"HTTP {e.code}: {err_body[:200]}"}
    except Exception as e:
        return {"error": str(e)}


def _get(endpoint):
    """GETs from brain API and returns response."""
    url = f"{_BASE}/{endpoint}"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        try:
            return json.loads(err_body)
        except Exception:
            return {"error": f"HTTP {e.code}: {err_body[:200]}"}
    except Exception as e:
        return {"error": str(e)}


def _delete(endpoint):
    """DELETEs from brain API and returns response."""
    url = f"{_BASE}/{endpoint}"
    req = urllib.request.Request(url, method="DELETE")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        try:
            return json.loads(err_body)
        except Exception:
            return {"error": f"HTTP {e.code}: {err_body[:200]}"}
    except Exception as e:
        return {"error": str(e)}


def remember(key, text, confidence=0.70, category="general"):
    """Saves a persistent fact to brain memory."""
    result = _post("recall", {
        "key": key,
        "text": text,
        "confidence": confidence,
        "category": category,
    })
    if result.get("success"):
        return f"✓ Remembered: '{key}'"
    return f"✗ Failed: {result.get('error', 'unknown error')}"


def forget(key):
    """Removes a fact from brain memory by key."""
    result = _delete(f"recall/{key}")
    if result.get("success"):
        return f"✓ Forgot: '{key}'"
    return f"✗ Failed: {result.get('error', 'unknown error')}"


def memories(category=None):
    """Returns formatted list of all persistent facts."""
    data = _get("recall")
    facts = data.get("facts", [])
    if not facts:
        return "No memories stored."

    if category:
        facts = [f for f in facts if f.get("category") == category]

    lines = []
    for f in facts:
        conf = f.get("confidence", 0)
        cat = f.get("category", "general")
        lines.append(f"  [{conf:.2f}] [{cat}] {f['key']}: {f['text']}")

    header = f"Brain Memory ({len(facts)} facts):"
    return header + "\n" + "\n".join(lines)


def learn_fix(trigger, fix, tags=None, context=None):
    """Saves a failure-fix correction pair to memory."""
    result = _post("experience", {
        "trigger": trigger,
        "fix": fix,
        "tags": tags or [],
        "context": context or "",
    })
    if result.get("success"):
        return f"✓ Learned fix for: '{trigger[:60]}...'"
    return f"✗ Failed: {result.get('error', 'unknown error')}"


def save_skill(name, description, tags, content):
    """Saves a reusable workflow skill to the brain."""
    result = _post("skills", {
        "name": name,
        "description": description,
        "tags": tags,
        "content": content,
    })
    if result.get("success"):
        return f"✓ Saved skill: '{name}'"
    return f"✗ Failed: {result.get('error', 'unknown error')}"


def list_skills():
    """Returns formatted list of saved workflow skills."""
    data = _get("skills")
    skills = data.get("skills", [])
    if not skills:
        return "No skills saved."

    lines = []
    for s in skills:
        tags = ", ".join(s.get("tags", []))
        lines.append(f"  • {s['name']}: {s.get('description', '')} [{tags}]")

    return f"Brain Skills ({len(skills)}):\n" + "\n".join(lines)


def brain_stats():
    """Returns brain stats dashboard."""
    data = _get("stats")
    r = data.get("recall", {})
    e = data.get("experience", {})
    s = data.get("skills", {})
    return (
        f"Brain Stats:\n"
        f"  Recall:     {r.get('active', 0)} facts, {r.get('pending', 0)} pending\n"
        f"  Experience: {e.get('total', 0)} entries, {e.get('candidates', 0)} promotion candidates\n"
        f"  Skills:     {s.get('total', 0)} saved"
    )
