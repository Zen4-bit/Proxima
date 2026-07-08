"""Repository Intelligence — Granular help topics."""

REPO_INTEL_TOPICS = {
    "status_health": (
        "from proxima_agent.tools.coding.repo_intel import repo_status, repo_health, analyze_project\n"
        "status = repo_status()                     # returns {'indexed': bool, 'files': int, 'symbols': int, 'is_indexing': bool}\n"
        "health = repo_health()                     # returns database integrity diagnostics, error counts, generation, and broken files\n"
        "proj_info = analyze_project()               # auto-detects language, build framework, pytest configuration, and entrypoints"
    ),
    "navigation": (
        "from proxima_agent.tools.coding.repo_intel import find_definition, find_references, find_callers, find_implementations\n"
        "defn = find_definition('UserService')      # find matching class/function declarations, FQNs, file paths, and line signatures\n"
        "refs = find_references('process_payment') # find semantic references (checks local files and import usage modules)\n"
        "callers = find_callers('send_email')       # find all caller sites of the symbol with line, column, context, and usage kind\n"
        "impls = find_implementations('BaseClass')  # find recursively nested subclasses inheriting from the base class (with cycle protection)"
    ),
    "rename": (
        "from proxima_agent.tools.coding.repo_intel import rename_symbol\n"
        "# Perform transactional rename on a symbol and all its callers/references safely:\n"
        "res = rename_symbol('old_name', 'new_name', dry_run=True)   # Dry run: check affected files and verify AST syntax correctness\n"
        "res = rename_symbol('old_name', 'new_name', dry_run=False)  # Commit: atomic swap write, automatically rolls back on failure"
    ),
    "context_compress": (
        "from proxima_agent.tools.coding.repo_intel import compress_context\n"
        "context = compress_context(['main.py'], max_tokens=20000)  # Compress repository context starting from seed files\n"
        "# Automatically uses hybrid scoring (distance + recency + reference count) and versioned caches for fast packing."
    ),
    "repair": (
        "from proxima_agent.tools.coding.repo_intel import autonomous_repair_loop\n"
        "# Execute code editing and repair loops transactionally with AST check and rollback support:\n"
        "res = autonomous_repair_loop(\n"
        "    file_path='auth.py',\n"
        "    edit_instruction='replace lines with...',  # instructions or old-new diff block\n"
        "    test_command='pytest tests/test_auth.py',   # test command to execute and calculate score\n"
        "    max_iterations=3\n"
        ")\n"
        "# Imposes a severe penalty on syntax errors, restoring baseline backups on score regressions."
    ),
}
