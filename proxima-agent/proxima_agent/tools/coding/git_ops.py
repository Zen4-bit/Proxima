"""Proxima — Git Operations.
Provides git operations like status, diff, log, blame, commit, stash, and checkout.
"""
import os
import subprocess


def _git(args, cwd=None):
    """Runs a git command with arguments under a timeout limit."""
    env = {
        **os.environ,
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_PAGER": "cat",
        "GIT_OPTIONAL_LOCKS": "0",
    }
    try:
        result = subprocess.run(
            ["git", *args], shell=False, capture_output=True, text=True,
            cwd=cwd or os.getcwd(), env=env, timeout=30
        )
    except subprocess.TimeoutExpired:
        return f"git command timed out after 30s: git {' '.join(str(a) for a in args)}"

    out = (result.stdout or "")
    err = (result.stderr or "")
    if result.returncode != 0:
        combined = (out + ("\n" if out.strip() and err.strip() else "") + err).strip()
        return combined or f"git {args[0]} failed (exit {result.returncode})"
    if out.strip():
        return out.strip()
    return err.strip()


def git_status(cwd=None):
    """Returns git status summary."""
    return _git(["status", "--short"], cwd)


def git_diff(path=None, staged=False, cwd=None, stat=False):
    """Returns git diff patch or summary statistics."""
    args = ["diff"]
    if stat:
        args.append("--stat")
    if staged:
        args.append("--staged")
    if path:
        args += ["--", path]
    return _git(args, cwd)


def git_log(n=10, oneline=True, cwd=None):
    """Returns git commit logs."""
    args = ["log", "-n", str(n)]
    if oneline:
        args.append("--oneline")
    else:
        args.append("--pretty=format:%h %an %ar %s")
    return _git(args, cwd)


def git_blame(path, start=None, end=None, cwd=None):
    """Runs git blame on target path."""
    args = ["blame", path]
    if start and end:
        args += ["-L", f"{start},{end}"]
    return _git(args, cwd)


def git_commit(message, add_all=True, cwd=None):
    """Stages files and creates a commit."""
    if add_all:
        _git(["add", "-A"], cwd)
    return _git(["commit", "-m", message], cwd)


def git_stash(pop=False, cwd=None):
    """Stashes current changes or pops the latest stash."""
    return _git(["stash", "pop"] if pop else ["stash"], cwd)


def git_branch(name=None, cwd=None):
    """Lists local branches or checks out a new branch."""
    if name:
        return _git(["checkout", "-b", name], cwd)
    return _git(["branch", "-a"], cwd)
