// Proxima — Brain Security Scanner.
// Audits dynamically loaded prompt contents against injection, exfiltration, and evasion regex patterns.

'use strict';

const fs = require('fs');

const THREAT_PATTERNS = [
    {
        name: 'role-hijack',
        pattern: /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions|rules|guidelines|directives)/i,
        severity: 'critical',
    },
    {
        name: 'role-hijack',
        pattern: /you\s+are\s+now\s+(?:a\s+|an\s+)?(?:different|new|my)/i,
        severity: 'critical',
    },
    {
        name: 'role-hijack',
        pattern: /forget\s+(?:all\s+)?(?:your\s+|the\s+)?(?:previous|prior|original|current)\s+(?:instructions|identity|role|persona)/i,
        severity: 'critical',
    },
    {
        name: 'role-hijack',
        pattern: /(?:act|behave|respond)\s+as\s+(?:if\s+)?(?:you\s+(?:are|were)\s+)?(?:a\s+|an\s+)?(?:different|new)/i,
        severity: 'high',
    },
    {
        name: 'prompt-extract',
        pattern: /(?:reveal|show|print|output|display|repeat|echo)\s+(?:your\s+|the\s+)?(?:full\s+)?system\s+(?:prompt|instructions|message)/i,
        severity: 'critical',
    },
    {
        name: 'prompt-extract',
        pattern: /what\s+(?:are|is|were)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions|initial\s+instructions)/i,
        severity: 'high',
    },
    {
        name: 'instruction-override',
        pattern: /(?:new|updated|revised|replacement)\s+(?:system\s+)?instructions?\s*:/i,
        severity: 'critical',
    },
    {
        name: 'instruction-override',
        pattern: /from\s+now\s+on,?\s+(?:you\s+(?:will|must|should)|ignore|forget|disregard)/i,
        severity: 'high',
    },
    {
        name: 'instruction-override',
        pattern: /(?:override|replace|supersede)\s+(?:all\s+)?(?:previous|prior|existing)\s+(?:instructions|rules)/i,
        severity: 'critical',
    },
    {
        name: 'data-exfil',
        pattern: /(?:send|post|fetch|curl|wget|http)\s+.*(?:webhook\.site|requestbin|pipedream|ngrok|hookbin|burpcollaborator)/i,
        severity: 'critical',
    },
    {
        name: 'data-exfil',
        pattern: /(?:exfiltrate|extract|leak|steal)\s+.*(?:api\s*key|secret|token|password|credential)/i,
        severity: 'high',
    },
    {
        name: 'hidden-marker',
        pattern: /\[(?:SYSTEM|ADMIN|OVERRIDE|ROOT|SUDO)\]/i,
        severity: 'high',
    },
    {
        name: 'hidden-marker',
        pattern: /<\/?(?:system|admin|override|inject|instruction)>/i,
        severity: 'high',
    },
    {
        name: 'hidden-marker',
        pattern: /```system\b/i,
        severity: 'high',
    },
    {
        name: 'encoding-evasion',
        pattern: /(?:decode|base64|atob)\s*\(\s*["'][A-Za-z0-9+/=]{20,}["']\s*\)/i,
        severity: 'medium',
    },
];

function scan(content, filename = 'unknown', options = {}) {
    if (!content || typeof content !== 'string') {
        return { safe: true, threats: [] };
    }

    const blockSeverities = Array.isArray(options.blockSeverities) && options.blockSeverities.length
        ? options.blockSeverities
        : ['critical', 'high', 'medium'];

    const threats = [];

    for (const { name, pattern, severity } of THREAT_PATTERNS) {
        const match = content.match(pattern);
        if (match) {
            threats.push({
                name,
                severity,
                match: match[0].substring(0, 100),
            });
        }
    }

    if (threats.length > 0) {
        const critical = threats.filter(t => t.severity === 'critical').length;
        const high = threats.filter(t => t.severity === 'high').length;
        console.warn(
            `[Brain/Scanner] ⚠ ${filename}: ${threats.length} threat(s) detected` +
            ` (${critical} critical, ${high} high)`
        );
    }

    return {
        safe: !threats.some(t => blockSeverities.includes(t.severity)),
        threats,
    };
}

function scanFile(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const filename = require('path').basename(filePath);
        return scan(content, filename);
    } catch (err) {
        console.error(`[Brain/Scanner] Failed to read ${filePath}:`, err.message);
        return {
            safe: false,
            threats: [{ name: 'read-error', severity: 'high', match: err.message }],
        };
    }
}

function sanitize(content, filename = 'unknown') {
    const result = scan(content, filename);

    if (result.safe) {
        return { content, blocked: false, threats: [] };
    }

    const threatNames = [...new Set(result.threats.map(t => t.name))];

    return {
        content: `[BLOCKED: ${filename} contained potential prompt injection (${threatNames.join(', ')}). Content not loaded.]`,
        blocked: true,
        threats: threatNames,
    };
}

module.exports = {
    scan,
    scanFile,
    sanitize,
    THREAT_PATTERNS,
};
