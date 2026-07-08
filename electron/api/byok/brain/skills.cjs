// Proxima — Brain Skills.
// Manages reusable, multi-step agent workflows stored as markdown files with frontmatter.

'use strict';

const fs = require('fs');
const path = require('path');
const { getBrainDir, ensureDir } = require('./paths.cjs');
const scanner = require('./scanner.cjs');

const SKILLS_DIR = 'skills';
const MAX_SKILL_SIZE = 5000;
const MAX_SKILLS = 50;
const MAX_TAGS = 15;
const MATCH_THRESHOLD = 0.25;

function _getSkillsDir() {
    return path.join(getBrainDir(), SKILLS_DIR);
}

function _sanitizeName(name) {
    if (!name || typeof name !== 'string') return null;
    const clean = name.toLowerCase()
        .replace(/[^a-z0-9-_ ]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 80);
    return clean.length > 0 ? clean : null;
}

function _parseFrontmatter(content) {
    const meta = {};
    let body = content;

    if (content.startsWith('---')) {
        const endIndex = content.indexOf('\n---', 3);
        if (endIndex !== -1) {
            const yamlBlock = content.substring(3, endIndex).trim();
            body = content.substring(endIndex + 4).trimStart();

            for (const line of yamlBlock.split('\n')) {
                const colonIndex = line.indexOf(':');
                if (colonIndex <= 0) continue;

                const key = line.substring(0, colonIndex).trim();
                let value = line.substring(colonIndex + 1).trim();

                if (value.startsWith('[') && value.endsWith(']')) {
                    value = value.slice(1, -1).split(',').map(v => v.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
                }
                else if (/^\d+$/.test(value)) {
                    value = parseInt(value, 10);
                }

                meta[key] = value;
            }
        }
    }

    return { meta, body };
}

function _serializeFrontmatter(meta, body) {
    const lines = ['---'];

    for (const [key, value] of Object.entries(meta)) {
        if (Array.isArray(value)) {
            lines.push(`${key}: [${value.join(', ')}]`);
        } else {
            lines.push(`${key}: ${value}`);
        }
    }

    lines.push('---');
    lines.push('');
    lines.push(body);

    return lines.join('\n');
}

function save(name, description, tags, content, source = 'agent') {
    const safeName = _sanitizeName(name);
    if (!safeName) {
        return { success: false, error: 'Invalid skill name' };
    }

    if (!description || typeof description !== 'string') {
        return { success: false, error: 'Description is required' };
    }

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
        return { success: false, error: 'Skill content is required' };
    }

    const trimmedContent = content.trim().substring(0, MAX_SKILL_SIZE);
    const trimmedDesc = description.trim().substring(0, 200);

    const scanResult = scanner.scan(`${trimmedDesc}\n${trimmedContent}`, `skill:${safeName}`, { blockSeverities: ['critical'] });
    if (!scanResult.safe) {
        return { success: false, error: 'Content blocked — potential injection detected' };
    }

    const normalizedTags = _normalizeTags(tags);

    const skillsDir = _getSkillsDir();
    ensureDir(skillsDir);
    const filePath = path.join(skillsDir, `${safeName}.md`);

    let existingUsed = 0;
    let createdDate = new Date().toISOString().split('T')[0];

    if (fs.existsSync(filePath)) {
        try {
            const existing = fs.readFileSync(filePath, 'utf8');
            const { meta } = _parseFrontmatter(existing);
            existingUsed = parseInt(meta.used, 10) || 0;
            createdDate = meta.created || createdDate;
        } catch { }
    }

    _enforceMaxSkills(safeName);

    const validSource = ['agent', 'api', 'import'].includes(source) ? source : 'agent';

    const meta = {
        name: safeName,
        description: trimmedDesc,
        tags: normalizedTags,
        source: validSource,
        created: createdDate,
        updated: new Date().toISOString().split('T')[0],
        used: existingUsed,
    };

    const fileContent = _serializeFrontmatter(meta, trimmedContent);
    fs.writeFileSync(filePath, fileContent, 'utf8');

    return { success: true };
}

function remove(name) {
    const safeName = _sanitizeName(name);
    if (!safeName) return { success: false, error: 'Invalid skill name' };

    const filePath = path.join(_getSkillsDir(), `${safeName}.md`);

    if (!fs.existsSync(filePath)) {
        return { success: false, error: `Skill '${safeName}' not found` };
    }

    try {
        fs.unlinkSync(filePath);
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

function get(name) {
    const safeName = _sanitizeName(name);
    if (!safeName) return null;

    const filePath = path.join(_getSkillsDir(), `${safeName}.md`);
    if (!fs.existsSync(filePath)) return null;

    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const { meta, body } = _parseFrontmatter(content);
        return {
            name: meta.name || safeName,
            description: meta.description || '',
            tags: Array.isArray(meta.tags) ? meta.tags : [],
            body: body.trim(),
            used: parseInt(meta.used, 10) || 0,
            created: meta.created || null,
            updated: meta.updated || null,
        };
    } catch {
        return null;
    }
}

function list() {
    const skillsDir = _getSkillsDir();
    if (!fs.existsSync(skillsDir)) return [];

    const files = fs.readdirSync(skillsDir).filter(f => f.endsWith('.md'));
    const skills = [];

    for (const file of files) {
        try {
            const content = fs.readFileSync(path.join(skillsDir, file), 'utf8');
            const { meta } = _parseFrontmatter(content);
            skills.push({
                name: meta.name || file.replace('.md', ''),
                description: meta.description || '',
                tags: Array.isArray(meta.tags) ? meta.tags : [],
                source: meta.source || 'agent',
                used: parseInt(meta.used, 10) || 0,
                created: meta.created || null,
            });
        } catch {
            continue;
        }
    }

    return skills.sort((a, b) => (b.used || 0) - (a.used || 0));
}

function match(userMessage, options = {}) {
    if (!userMessage || typeof userMessage !== 'string') return [];

    const maxResults = options.maxResults || 3;
    const queryTokens = _tokenize(userMessage);

    if (queryTokens.length === 0) return [];

    const allSkills = list();
    const scored = [];

    for (const skill of allSkills) {
        let score = 0;

        if (Array.isArray(skill.tags)) {
            const tagHits = skill.tags.filter(tag =>
                queryTokens.some(qt => tag.includes(qt) || qt.includes(tag))
            ).length;
            score += tagHits * 0.25;
        }

        const descTokens = _tokenize(skill.description);
        if (descTokens.length > 0) {
            const descHits = queryTokens.filter(qt =>
                descTokens.some(dt => dt.includes(qt) || qt.includes(dt))
            ).length;
            score += (descHits / Math.max(queryTokens.length, descTokens.length)) * 0.5;
        }

        if (skill.used > 0) {
            score += Math.min(0.1, skill.used * 0.02);
        }

        if (skill.source && skill.source !== 'agent') {
            score *= 0.5;
        }

        if (score >= MATCH_THRESHOLD) {
            const fullSkill = get(skill.name);
            scored.push({
                name: skill.name,
                description: skill.description,
                source: skill.source || 'agent',
                body: fullSkill ? fullSkill.body : '',
                score,
                used: skill.used,
            });
        }
    }

    scored.sort((a, b) => b.score - a.score);
    const results = scored.slice(0, maxResults);

    for (const result of results) {
        _incrementUsage(result.name);
    }

    return results;
}

function formatMatched(matches) {
    if (!matches || matches.length === 0) return '';

    const blocks = matches.map(m =>
        `### ${m.name}\n${m.description}\n\n${m.body}`
    );

    return 'RELEVANT SKILLS (proven workflows from past sessions):\n\n' + blocks.join('\n\n---\n\n');
}

function _tokenize(text) {
    if (!text) return [];

    const NOISE = new Set([
        'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
        'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
        'and', 'or', 'but', 'not', 'this', 'that', 'it', 'how',
        'what', 'when', 'where', 'why', 'can', 'do', 'does', 'did',
        'will', 'would', 'should', 'could', 'me', 'my', 'i', 'you',
        'help', 'want', 'need', 'please', 'make', 'create',
    ]);

    return [...new Set(
        text.toLowerCase()
            .replace(/[^a-z0-9\s-_]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 2 && !NOISE.has(w))
    )];
}

function _normalizeTags(tags) {
    if (!Array.isArray(tags)) return [];
    return [...new Set(
        tags
            .filter(t => typeof t === 'string' && t.trim().length > 0)
            .map(t => t.toLowerCase().trim().replace(/[^a-z0-9-]/g, ''))
            .filter(t => t.length > 0)
    )].slice(0, MAX_TAGS);
}

function _incrementUsage(name) {
    const safeName = _sanitizeName(name);
    if (!safeName) return;

    const filePath = path.join(_getSkillsDir(), `${safeName}.md`);
    if (!fs.existsSync(filePath)) return;

    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const { meta, body } = _parseFrontmatter(content);
        meta.used = (parseInt(meta.used, 10) || 0) + 1;
        fs.writeFileSync(filePath, _serializeFrontmatter(meta, body), 'utf8');
    } catch { }
}

function _enforceMaxSkills(exceptName) {
    const skillsDir = _getSkillsDir();
    if (!fs.existsSync(skillsDir)) return;

    const files = fs.readdirSync(skillsDir).filter(f => f.endsWith('.md'));
    if (files.length < MAX_SKILLS) return;

    const others = files
        .filter(f => f.replace('.md', '') !== exceptName)
        .map(file => {
            try {
                const content = fs.readFileSync(path.join(skillsDir, file), 'utf8');
                const { meta } = _parseFrontmatter(content);
                return { file, used: parseInt(meta.used, 10) || 0 };
            } catch {
                return { file, used: 0 };
            }
        });

    others.sort((a, b) => a.used - b.used);

    while (others.length >= MAX_SKILLS) {
        const victim = others.shift();
        if (!victim) break;
        try {
            fs.unlinkSync(path.join(skillsDir, victim.file));
        } catch {
            break;
        }
    }
}

module.exports = {
    save,
    remove,
    get,
    list,
    match,
    formatMatched,
    MAX_SKILLS,
    MAX_TAGS,
};
