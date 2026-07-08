// Proxima — Smart Slicer.
// Slices relevant code symbols from large files for target questions with optional dependency resolution.

import path from 'path';
import {
    extractSymbols, escapeRegex, mergeRanges,
} from './symbol-extractor.js';


export { extractSymbols } from './symbol-extractor.js';


export function buildSymbolMap(content, filePath) {
    const symbols = extractSymbols(content, filePath);
    if (symbols.length === 0) {
        return `No symbols found in ${path.basename(filePath)} (unsupported language or no definitions)`;
    }

    const lines = [];
    lines.push(`📋 Symbol Map: ${path.basename(filePath)} (${content.split('\n').length} lines)`);
    lines.push('');

    const groups = {};
    for (const sym of symbols) {
        if (!groups[sym.type]) groups[sym.type] = [];
        groups[sym.type].push(sym);
    }

    const typeLabels = {
        class: '📦 Classes', struct: '📦 Structs', interface: '📐 Interfaces',
        function: '⚡ Functions', method: '  🔧 Methods', tool: '🛠️ Tools',
        export: '📤 Exports', module: '📦 Modules', impl: '🔨 Implementations',
        trait: '📐 Traits',
    };

    for (const [type, syms] of Object.entries(groups)) {
        lines.push(typeLabels[type] || `📌 ${type}`);
        for (const sym of syms) {
            lines.push(`  L${sym.startLine}-${sym.endLine} (${sym.lineCount} lines) → ${sym.signature}`);
        }
        lines.push('');
    }

    return lines.join('\n').trim();
}

export function smartSlice(content, filePath, question, options = {}) {
    const {
        maxLines = 500,
        contextLines = 3,
        includeImports = true,
        includeMap = true,
    } = options;

    const lines = content.split('\n');
    const totalLines = lines.length;
    const symbols = extractSymbols(content, filePath);

    if (totalLines <= maxLines) {
        return { sliced: content, symbols, totalLines, sentLines: totalLines, savings: '0%', mode: 'full-file' };
    }

    if (symbols.length === 0) {
        const truncated = lines.slice(0, maxLines).join('\n');
        return {
            sliced: truncated + `\n\n// ... [${totalLines - maxLines} more lines truncated]`,
            symbols: [], totalLines, sentLines: maxLines,
            savings: `${Math.round((1 - maxLines / totalLines) * 100)}%`, mode: 'truncated',
        };
    }

    const keywords = question
        ? question.toLowerCase().replace(/[^a-z0-9_\s]/g, ' ').split(/\s+/).filter(w => w.length > 2)
        : [];

    const scoredSymbols = symbols.map(sym => {
        let score = 0;
        const nameLower = sym.name.toLowerCase();
        const sigLower = sym.signature.toLowerCase();
        for (const kw of keywords) {
            if (nameLower.includes(kw)) score += 10;
            if (sigLower.includes(kw)) score += 5;
        }
        if (sym.type === 'class') score += 3;
        if (sym.type === 'tool') score += 5;
        if (sym.lineCount > 20) score += 2;
        return { ...sym, score };
    });

    scoredSymbols.sort((a, b) => b.score - a.score || a.startLine - b.startLine);

    const selectedRanges = [];
    let linesBudget = maxLines;

    const relevantSymbols = keywords.length > 0 ? scoredSymbols.filter(s => s.score > 0) : scoredSymbols;
    const finalSelection = relevantSymbols.length > 0 ? relevantSymbols : scoredSymbols;

    for (const sym of finalSelection) {
        const rangeSize = sym.lineCount + contextLines * 2;
        if (linesBudget - rangeSize < 0 && selectedRanges.length > 0) break;
        selectedRanges.push({
            start: Math.max(0, sym.startLine - 1 - contextLines),
            end: Math.min(totalLines - 1, sym.endLine - 1 + contextLines),
            symbol: sym,
        });
        linesBudget -= rangeSize;
    }

    selectedRanges.sort((a, b) => a.start - b.start);

    const sections = [];
    if (includeImports) {
        const importLines = collectImportLines(lines);
        if (importLines.length > 0) { sections.push(importLines.join('\n')); sections.push(''); }
    }
    if (includeMap) {
        sections.push('// ── SYMBOL MAP (full file overview) ──');
        for (const sym of symbols) sections.push(`// L${sym.startLine}-${sym.endLine} [${sym.type}] ${sym.signature}`);
        sections.push('');
    }

    let lastEnd = -1;
    for (const range of selectedRanges) {
        if (range.start > lastEnd + 1) sections.push(`\n// ... [lines ${lastEnd + 2}-${range.start} omitted] ...\n`);
        sections.push(lines.slice(range.start, range.end + 1).join('\n'));
        lastEnd = range.end;
    }
    if (lastEnd < totalLines - 1) sections.push(`\n// ... [lines ${lastEnd + 2}-${totalLines} omitted] ...\n`);

    const sliced = sections.join('\n');
    const sentLines = sliced.split('\n').length;
    return {
        sliced, symbols, selectedSymbols: selectedRanges.map(r => r.symbol),
        totalLines, sentLines, savings: `${Math.round((1 - sentLines / totalLines) * 100)}%`, mode: 'smart-slice',
    };
}

export function getFileOverview(content, filePath) {
    const totalLines = content.split('\n').length;
    const ext = path.extname(filePath);
    const map = buildSymbolMap(content, filePath);
    return `File: ${path.basename(filePath)} | ${totalLines} lines | ${ext}\n\n${map}`;
}

export function sliceBySymbols(content, filePath, symbolNames, options = {}) {
    const {
        contextLines = 3,
        includeImports = true,
        includeMap = true,
        resolveDeps = true,
        maxDepth = 2,
    } = options;

    const lines = content.split('\n');
    const totalLines = lines.length;
    const allSymbols = extractSymbols(content, filePath);

    const requestedLower = symbolNames.map(n => n.toLowerCase().trim());
    const matched = [];
    const found = [];
    const notFound = [];

    for (const reqName of requestedLower) {
        const sym = allSymbols.find(s => s.name.toLowerCase() === reqName);
        if (sym) { matched.push(sym); found.push(sym.name); }
        else {
            const partial = allSymbols.find(s => s.name.toLowerCase().includes(reqName));
            if (partial) { matched.push(partial); found.push(partial.name); }
            else { notFound.push(reqName); }
        }
    }

    if (resolveDeps && matched.length > 0) {
        const allSymbolNames = allSymbols.map(s => s.name);
        const alreadyIncluded = new Set(matched.map(s => s.name));
        
        for (let depth = 0; depth < maxDepth; depth++) {
            const newDeps = [];
            for (const sym of matched) {
                const codeBlock = lines.slice(sym.startLine - 1, sym.endLine).join('\n');
                for (const otherName of allSymbolNames) {
                    if (alreadyIncluded.has(otherName)) continue;
                    const callPattern = new RegExp(`\\b${escapeRegex(otherName)}\\s*\\(`, 'g');
                    if (callPattern.test(codeBlock)) {
                        const depSym = allSymbols.find(s => s.name === otherName);
                        if (depSym) { newDeps.push(depSym); alreadyIncluded.add(otherName); }
                    }
                }
            }
            if (newDeps.length === 0) break;
            matched.push(...newDeps);
            found.push(...newDeps.map(s => `${s.name} (auto-dep)`));
        }
    }

    if (matched.length === 0) {
        const mapStr = buildSymbolMap(content, filePath);
        return { sliced: `No matching symbols found for: ${symbolNames.join(', ')}\n\nAvailable symbols:\n${mapStr}`, found: [], notFound: symbolNames, totalLines, sentLines: 0, savings: '0%', mode: 'not-found' };
    }

    let ranges = matched.map(sym => ({
        start: Math.max(0, sym.startLine - 1 - contextLines),
        end: Math.min(totalLines - 1, sym.endLine - 1 + contextLines),
        symbol: sym,
    }));
    ranges.sort((a, b) => a.start - b.start);
    ranges = mergeRanges(ranges);

    const sections = [];
    if (includeImports) {
        const importLines = collectImportLines(lines);
        if (importLines.length > 0) { sections.push(importLines.join('\n')); sections.push(''); }
    }
    if (includeMap) {
        sections.push('// ── SYMBOL MAP (all symbols in file) ──');
        for (const sym of allSymbols) {
            const marker = matched.some(m => m.name === sym.name) ? ' ◀ SELECTED' : '';
            sections.push(`// L${sym.startLine}-${sym.endLine} [${sym.type}] ${sym.signature}${marker}`);
        }
        sections.push('');
    }

    let lastEnd = -1;
    for (const range of ranges) {
        if (range.start > lastEnd + 1) sections.push(`\n// ... [lines ${lastEnd + 2}-${range.start} omitted] ...\n`);
        sections.push(lines.slice(range.start, range.end + 1).join('\n'));
        lastEnd = range.end;
    }
    if (lastEnd < totalLines - 1) sections.push(`\n// ... [lines ${lastEnd + 2}-${totalLines} omitted] ...\n`);

    const sliced = sections.join('\n');
    const sentLines = sliced.split('\n').length;
    return {
        sliced, found, notFound, selectedSymbols: matched,
        totalLines, sentLines, savings: `${Math.round((1 - sentLines / totalLines) * 100)}%`, mode: 'symbol-select',
    };
}

function collectImportLines(lines) {
    const importLines = [];
    for (let i = 0; i < Math.min(60, lines.length); i++) {
        const line = lines[i];
        if (/^\s*(import |const .* = require|from |export |\/\/ |\/\*|\*|#!)/.test(line) || line.trim() === '') {
            importLines.push(line);
        } else if (importLines.length > 0) {
            break;
        }
    }
    return importLines;
}
