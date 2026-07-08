"""File Operations — Granular help topics."""

FILE_TOPICS = {
    "read": (
        "from proxima_agent.tools.code_env import read_file, read_file_raw\n"
        "content = read_file('path/to/file.txt')    # line-numbered ('  1 | ...') for reading/editing\n"
        "raw = read_file_raw('data.json')           # EXACT content, NO line numbers — for JSON/config\n"
        "# read_file adds 'NNNN | ' prefixes; do NOT json.loads()/parse that — use read_file_raw\n"
        "# (or read_file(path, raw=True)). Alternative: open('file.txt','r',encoding='utf-8').read()"
    ),
    "write": (
        "from proxima_agent.tools.code_env import write_file\n"
        "write_file('output.txt', 'content here')   # write/overwrite file\n"
        "# Creates parent dirs if needed.\n"
        "# Alternative: open('file.txt', 'w', encoding='utf-8').write('content')"
    ),
    "append": (
        "# Append to existing file:\n"
        "with open('log.txt', 'a', encoding='utf-8') as f:\n"
        "    f.write('new line\\n')"
    ),
    "list": (
        "import os\n"
        "files = os.listdir('.')                     # list current directory\n"
        "files = os.listdir('/path/to/dir')           # list specific directory\n"
        "# For recursive: from proxima_agent.tools.code_env import find_files"
    ),
    "search": (
        "from proxima_agent.tools.code_env import grep, find_files\n"
        "results = grep('pattern', 'file.py')        # search in a file\n"
        "results = grep('TODO', '.')                 # search a whole dir (always recursive)\n"
        "results = grep('def .*init', '.', regex=True)  # regex search\n"
        "files = find_files('*.py', '.')              # find files by glob pattern\n"
        "# grep = search_text, find_files = glob_files (these names also work)."
    ),
    "exists": (
        "import os\n"
        "os.path.exists('file.txt')                  # True/False\n"
        "os.path.isfile('file.txt')                  # is it a file?\n"
        "os.path.isdir('folder/')                    # is it a directory?"
    ),
    "copy_move": (
        "import shutil\n"
        "shutil.copy2('src.txt', 'dst.txt')          # copy file (preserves metadata)\n"
        "shutil.move('old.txt', 'new.txt')           # move/rename\n"
        "shutil.copytree('src_dir', 'dst_dir')       # copy entire directory"
    ),
    "delete": (
        "import os\n"
        "os.remove('file.txt')                       # delete file\n"
        "# WARNING: os.remove is permanent. No recycle bin.\n"
        "# For directory: shutil.rmtree('dir_path')  # DANGEROUS — recursive delete"
    ),
    "path": (
        "from pathlib import Path\n"
        "p = Path('dir/file.txt')\n"
        "p.parent                                    # Path('dir')\n"
        "p.stem                                      # 'file'\n"
        "p.suffix                                    # '.txt'\n"
        "p.resolve()                                 # absolute path"
    ),
    "attach": (
        "from proxima_agent.tools.code_env import attach\n"
        "attach('report.pdf')                        # send a WHOLE file for the model to read natively\n"
        "attach('app.py', note='find the bug ~line 400')  # whole file + a focus note\n"
        "# Sends WITH YOUR NEXT message, exactly once (attach again to resend).\n"
        "# Use for big code/PDF/sheet/image or when you need the FULL content/layout —\n"
        "# instead of pasting text (which bloats context and loses formatting).\n"
        "# Small file / a few lines? Just read_file()/grep() the snippet into your prompt.\n"
        "# Screenshots auto-attach: b.screenshot('x.png') / d.screenshot(...) are fed to the\n"
        "# model on your next message automatically — no attach() call needed.\n"
        "# Limits: max 25 MB; if upload fails (e.g. provider limit) you'll be told — then\n"
        "# extract the text instead or try again later."
    ),
}
