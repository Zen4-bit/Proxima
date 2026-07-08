// Proxima — Enhanced Memory.
// Manages cross-session message history, project contexts, and global facts backed by atomic disk writes.

import fs from 'fs';
import path from 'path';
import { getDataDir } from '../utils/paths.js';

const MEMORY_FILE = path.join(getDataDir(), 'enhanced-memory.json');
const MAX_MEMORY_ENTRIES = 500;
const MAX_SUMMARY_LENGTH = 200;

class EnhancedMemory {
    constructor() {
        this.sessions = {};
        this.projectContexts = {};
        this.globalFacts = [];
        this._saveTimer = null;
        this._saveDelayMs = 1000;
        this._load();
    }

    getOrCreateSession(sessionId) {
        if (!this.sessions[sessionId]) {
            this.sessions[sessionId] = {
                id: sessionId,
                messages: [],
                summary: '',
                createdAt: Date.now(),
                lastActive: Date.now(),
                metadata: {},
            };
        }
        this.sessions[sessionId].lastActive = Date.now();
        return this.sessions[sessionId];
    }

    addToSession(sessionId, role, content, provider = null) {
        const session = this.getOrCreateSession(sessionId);
        session.messages.push({
            role,
            content: content.substring(0, 2000),
            provider,
            timestamp: Date.now(),
        });

        if (session.messages.length > 20) {
            this._autoSummarize(session);
        }


        this._evictOldSessions();


        this._scheduleSave();
    }

    _evictOldSessions() {
        const ids = Object.keys(this.sessions);
        if (ids.length <= MAX_MEMORY_ENTRIES) return;
        ids
            .sort((a, b) => (this.sessions[a].lastActive || 0) - (this.sessions[b].lastActive || 0))
            .slice(0, ids.length - MAX_MEMORY_ENTRIES)
            .forEach(id => { delete this.sessions[id]; });
    }

    getSessionContext(sessionId, maxMessages = 5) {
        const session = this.sessions[sessionId];
        if (!session) return '';

        const recent = session.messages.slice(-maxMessages);
        let context = '';

        if (session.summary) {
            context += `CONVERSATION SUMMARY:\n${session.summary}\n\n`;
        }

        if (recent.length > 0) {
            context += 'RECENT MESSAGES:\n';
            for (const msg of recent) {
                const prefix = msg.role === 'user' ? 'User' : `AI (${msg.provider || 'unknown'})`;
                context += `${prefix}: ${msg.content.substring(0, 200)}\n`;
            }
        }

        return context;
    }

    setProjectContext(projectPath, context) {
        this.projectContexts[projectPath] = {
            ...this.projectContexts[projectPath],
            ...context,
            lastUpdated: Date.now(),
        };
        this._scheduleSave();
    }

    getProjectContext(projectPath) {
        return this.projectContexts[projectPath] || null;
    }

    addFact(content, category = 'general') {
        const exists = this.globalFacts.some(f =>
            f.content.toLowerCase() === content.toLowerCase()
        );
        if (exists) return;

        this.globalFacts.push({
            content,
            category,
            timestamp: Date.now(),
        });

        if (this.globalFacts.length > 100) {
            this.globalFacts = this.globalFacts.slice(-100);
        }

        this._scheduleSave();
    }

    searchFacts(query) {
        const queryWords = query.toLowerCase().split(/\s+/);
        return this.globalFacts
            .map(fact => {
                const factWords = fact.content.toLowerCase().split(/\s+/);
                const matchCount = queryWords.filter(w => factWords.some(fw => fw.includes(w))).length;
                const relevance = matchCount / queryWords.length;
                return { ...fact, relevance };
            })
            .filter(f => f.relevance > 0.3)
            .sort((a, b) => b.relevance - a.relevance)
            .slice(0, 5);
    }

    recall(query, maxResults = 3) {
        const queryWords = new Set(query.toLowerCase().split(/\s+/).filter(w => w.length > 3));
        const results = [];

        for (const [sessionId, session] of Object.entries(this.sessions)) {
            for (const msg of session.messages) {
                if (msg.role !== 'user') continue;
                const msgWords = new Set(msg.content.toLowerCase().split(/\s+/));
                const overlap = [...queryWords].filter(w => msgWords.has(w)).length;
                if (overlap >= 2) {
                    const msgIndex = session.messages.indexOf(msg);
                    const aiResponse = session.messages[msgIndex + 1];
                    results.push({
                        sessionId,
                        query: msg.content.substring(0, 150),
                        answer: aiResponse ? aiResponse.content.substring(0, 200) : null,
                        provider: aiResponse?.provider,
                        relevance: overlap / queryWords.size,
                        timestamp: msg.timestamp,
                    });
                }
            }
        }

        return results
            .sort((a, b) => b.relevance - a.relevance)
            .slice(0, maxResults);
    }

    _autoSummarize(session) {
        const toSummarize = session.messages.slice(0, -10);
        const topics = new Set();

        for (const msg of toSummarize) {
            const words = msg.content.split(/\s+/)
                .filter(w => w.length > 5)
                .slice(0, 5);
            words.forEach(w => topics.add(w.toLowerCase()));
        }

        const topicList = [...topics].slice(0, 10).join(', ');
        session.summary = `${session.summary ? session.summary + ' | ' : ''}Topics discussed: ${topicList} (${toSummarize.length} messages summarized)`;
        session.messages = session.messages.slice(-10);
    }

    getStats() {
        const totalSessions = Object.keys(this.sessions).length;
        const totalMessages = Object.values(this.sessions).reduce(
            (sum, s) => sum + s.messages.length, 0
        );

        return {
            totalSessions,
            totalMessages,
            totalFacts: this.globalFacts.length,
            totalProjects: Object.keys(this.projectContexts).length,
            oldestSession: totalSessions > 0
                ? new Date(Math.min(...Object.values(this.sessions).map(s => s.createdAt))).toISOString()
                : null,
        };
    }


    _scheduleSave() {
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
        }
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            this._save();
        }, this._saveDelayMs);
        if (typeof this._saveTimer.unref === 'function') {
            this._saveTimer.unref();
        }
    }


    _save() {
        try {
            if (this._saveTimer) {
                clearTimeout(this._saveTimer);
                this._saveTimer = null;
            }
            const dir = path.dirname(MEMORY_FILE);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            const data = {
                sessions: this.sessions,
                projectContexts: this.projectContexts,
                globalFacts: this.globalFacts,
                lastSaved: Date.now(),
            };


            const tmpFile = `${MEMORY_FILE}.tmp-${process.pid}-${Date.now()}`;
            try {
                fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
                fs.renameSync(tmpFile, MEMORY_FILE);
            } catch (writeErr) {

                try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch (_) { }
                throw writeErr;
            }
        } catch (e) {

            console.error('[EnhancedMemory] Save failed:', e.message);
        }
    }

    _load() {
        try {
            if (fs.existsSync(MEMORY_FILE)) {
                const data = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
                this.sessions = data.sessions || {};
                this.projectContexts = data.projectContexts || {};
                this.globalFacts = data.globalFacts || [];
            }
        } catch (e) {

            console.error('[EnhancedMemory] Load failed, starting fresh:', e.message);
            try {
                if (fs.existsSync(MEMORY_FILE)) {
                    fs.renameSync(MEMORY_FILE, `${MEMORY_FILE}.corrupt-${Date.now()}`);
                }
            } catch (_) {

            }
        }
    }
}

export { EnhancedMemory };
