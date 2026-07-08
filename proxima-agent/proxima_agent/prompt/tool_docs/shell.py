"""Shell & System — Granular help topics."""

SHELL_TOPICS = {
    "run": (
        "from proxima_agent.tools.code_env import shell\n"
        "result = shell('ls -la')             # run any shell command\n"
        "result = shell('npm test', cwd='./project')  # with working dir\n"
        "result = shell('python script.py', timeout=120)  # custom timeout (default 60s)"
    ),
    "background": (
        "from proxima_agent.tools.code_env import shell_bg\n"
        "pid = shell_bg('npm run dev', cwd='./app')  # start background process\n"
        "# Returns PID. Process runs in background, output not captured.\n"
        "# Useful for dev servers, watchers, long-running tasks"
    ),
    "native": (
        "from proxima_agent.tools.system.shell_ops import native_shell\n"
        "result = native_shell('Get-Process')  # Windows: PowerShell\n"
        "result = native_shell('ps aux')       # Mac/Linux: bash\n"
        "# Auto-detects OS and uses the right native shell"
    ),
    "powershell": (
        "from proxima_agent.tools.code_env import powershell\n"
        "result = powershell('Get-Process | Select -First 5')\n"
        "# Windows only. On Mac/Linux: tries pwsh if installed, else returns error.\n"
        "# Prefer native_shell() for cross-platform code"
    ),
    "subprocess": (
        "import subprocess\n"
        "result = subprocess.run(['git', 'status'], capture_output=True, text=True)\n"
        "print(result.stdout)\n"
        "# Use when shell() doesn't work or you need more control\n"
        "# Always use capture_output=True, text=True"
    ),
    "install": (
        "# Install Python packages:\n"
        "shell('pip install requests')\n"
        "# Install system packages (OS-specific):\n"
        "# Windows: shell('winget install Git.Git')\n"
        "# Mac: shell('brew install git')\n"
        "# Linux: shell('sudo apt install git')"
    ),
    "environment": (
        "import os\n"
        "os.environ['MY_VAR'] = 'value'      # set env var (current process only)\n"
        "val = os.environ.get('PATH')         # read env var\n"
        "# For persistent env vars, use OS-specific commands"
    ),
}
