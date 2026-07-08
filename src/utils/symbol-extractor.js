// Proxima — Symbol Extractor.
// Extracts function, class, and method signatures and line ranges across multiple programming languages.

import path from 'path';


const JS_KEYWORDS = new Set([
    'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
    'return', 'throw', 'try', 'catch', 'finally', 'new', 'delete', 'typeof',
    'instanceof', 'in', 'of', 'with', 'void', 'yield', 'await',
]);

const SYMBOL_PATTERNS = {
    js: [
        { type: 'function', pattern: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/gm },
        { type: 'function', pattern: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>/gm },
        { type: 'class', pattern: /^(?:export\s+)?(?:default\s+)?class\s+(\w+)/gm },
        { type: 'method', pattern: /^\s+(?:async\s+)?(?:static\s+)?(?:get\s+|set\s+)?(\w+)\s*\([^)]*\)\s*\{/gm,
          filter: name => !JS_KEYWORDS.has(name) },
        { type: 'export', pattern: /^export\s+\{([^}]+)\}/gm },

        { type: 'tool', pattern: /server\.(?:registerTool|tool)\(\s*['"](\w+)['"]/gm },
    ],
    py: [
        { type: 'function', pattern: /^(?:async\s+)?def\s+(\w+)\s*\(/gm },
        { type: 'class', pattern: /^class\s+(\w+)/gm },
        { type: 'method', pattern: /^\s+(?:async\s+)?def\s+(\w+)\s*\(self/gm },
    ],
    go: [
        { type: 'function', pattern: /^func\s+(\w+)\s*\(/gm },
        { type: 'method', pattern: /^func\s+\(\w+\s+\*?\w+\)\s+(\w+)\s*\(/gm },
        { type: 'struct', pattern: /^type\s+(\w+)\s+struct/gm },
        { type: 'interface', pattern: /^type\s+(\w+)\s+interface/gm },
    ],
    java: [
        { type: 'class', pattern: /^(?:public\s+|private\s+|protected\s+)?(?:abstract\s+)?(?:static\s+)?class\s+(\w+)/gm },
        { type: 'method', pattern: /^\s+(?:public|private|protected)\s+(?:static\s+)?(?:async\s+)?\w+\s+(\w+)\s*\(/gm },
        { type: 'interface', pattern: /^(?:public\s+)?interface\s+(\w+)/gm },
    ],
    rb: [
        { type: 'function', pattern: /^def\s+(\w+)/gm },
        { type: 'class', pattern: /^class\s+(\w+)/gm },
        { type: 'module', pattern: /^module\s+(\w+)/gm },
    ],
    rs: [
        { type: 'function', pattern: /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/gm },
        { type: 'struct', pattern: /^(?:pub\s+)?struct\s+(\w+)/gm },
        { type: 'impl', pattern: /^impl(?:<[^>]+>)?\s+(\w+)/gm },
        { type: 'trait', pattern: /^(?:pub\s+)?trait\s+(\w+)/gm },
    ],
    php: [
        { type: 'function', pattern: /^(?:public|private|protected|static|\s)*function\s+(\w+)\s*\(/gm },
        { type: 'class', pattern: /^(?:abstract\s+)?class\s+(\w+)/gm },
    ],
};

const EXT_TO_LANG = {
    '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js',
    '.ts': 'js', '.tsx': 'js', '.mts': 'js',
    '.py': 'py', '.pyw': 'py',
    '.go': 'go',
    '.java': 'java', '.cs': 'java', '.cpp': 'java', '.c': 'java', '.h': 'java',
    '.rb': 'rb',
    '.rs': 'rs',
    '.php': 'php',
};

export function extractSymbols(content, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const lang = EXT_TO_LANG[ext];
    if (!lang) return [];

    const patterns = SYMBOL_PATTERNS[lang];
    if (!patterns) return [];

    const lines = content.split('\n');
    const symbols = [];

    for (const { type, pattern, filter } of patterns) {
        pattern.lastIndex = 0;
        let match;

        while ((match = pattern.exec(content)) !== null) {
            const name = match[1];
            if (!name) continue;
            if (filter && !filter(name.trim())) continue;

            const beforeMatch = content.substring(0, match.index);
            const startLine = beforeMatch.split('\n').length;
            const endLine = findBlockEnd(lines, startLine - 1, ext);

            symbols.push({
                name: name.trim(), type, startLine, endLine,
                lineCount: endLine - startLine + 1,
                signature: lines[startLine - 1]?.trim() || '',
            });
        }
    }

    symbols.sort((a, b) => a.startLine - b.startLine);
    return deduplicateSymbols(symbols);
}

function findBlockEnd(lines, startIdx, ext) {
    if (ext === '.py' || ext === '.pyw') return findPythonBlockEnd(lines, startIdx);
    return findBraceBlockEnd(lines, startIdx);
}

function findBraceBlockEnd(lines, startIdx) {
    let braceCount = 0;
    let foundOpen = false;

    for (let i = startIdx; i < lines.length; i++) {
        for (const ch of lines[i]) {
            if (ch === '{') { braceCount++; foundOpen = true; }
            if (ch === '}') braceCount--;
        }
        if (foundOpen && braceCount <= 0) return i + 1;
    }
    return Math.min(startIdx + 1, lines.length);
}

function findPythonBlockEnd(lines, startIdx) {
    if (startIdx >= lines.length) return startIdx + 1;
    const baseIndent = lines[startIdx].match(/^(\s*)/)?.[1]?.length || 0;
    let lastContentLine = startIdx;

    for (let i = startIdx + 1; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed) continue;
        const indent = lines[i].match(/^(\s*)/)?.[1]?.length || 0;
        if (indent <= baseIndent) break;
        lastContentLine = i;
    }
    return lastContentLine + 1;
}

function deduplicateSymbols(symbols) {
    const seen = new Set();
    return symbols.filter(s => {
        const key = `${s.name}:${s.startLine}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}


export function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function mergeRanges(ranges) {
    if (ranges.length <= 1) return ranges;
    const merged = [ranges[0]];
    for (let i = 1; i < ranges.length; i++) {
        const last = merged[merged.length - 1];
        const curr = ranges[i];
        if (curr.start <= last.end + 5) {
            last.end = Math.max(last.end, curr.end);
            if (curr.symbol) {
                last.symbols = last.symbols || [last.symbol];
                last.symbols.push(curr.symbol);
            }
        } else {
            merged.push(curr);
        }
    }
    return merged;
}

export { EXT_TO_LANG, SYMBOL_PATTERNS, JS_KEYWORDS };
