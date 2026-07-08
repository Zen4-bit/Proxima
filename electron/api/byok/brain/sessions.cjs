// Proxima — Brain Sessions.
// Performs semantic vector indexing and search over past conversation transcripts using SQLite.

'use strict';

const path = require('path');
const { getBrainDir, ensureDir } = require('./paths.cjs');
const embeddings = require('./embeddings.cjs');

const DB_FILENAME = 'sessions.db';
const MAX_CHUNK_CHARS = 1000;
const DEFAULT_MAX_RESULTS = 5;
const MIN_SIMILARITY = 0.30;
const MAX_SEARCH_SCAN_CHUNKS = 20000;
const CONTEXT_WINDOW = 1;

let _db = null;

function _getDb() {
    if (_db) return _db;

    let Database;
    try {
        Database = require('better-sqlite3');
    } catch {
        throw new Error(
            'better-sqlite3 not installed. Run: npm install better-sqlite3'
        );
    }

    const dbPath = path.join(getBrainDir(), DB_FILENAME);
    ensureDir(path.dirname(dbPath));

    _db = new Database(dbPath);

    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');

    _db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            first_message TEXT,
            summary TEXT,
            turn_count INTEGER DEFAULT 0,
            created_at INTEGER,
            updated_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            embedding BLOB,
            turn_index INTEGER,
            created_at INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_chunks_session
            ON chunks(session_id);

        CREATE INDEX IF NOT EXISTS idx_sessions_updated
            ON sessions(updated_at DESC);
    `);

    return _db;
}

function _vecToBuffer(vec) {
    return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

function _bufferToVec(buf) {
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

async function index(conversationId, messages) {
    if (!conversationId || !Array.isArray(messages) || messages.length === 0) {
        return { indexed: 0, skipped: 0 };
    }

    const db = _getDb();
    const now = Date.now();

    const existingSession = db.prepare('SELECT id, turn_count FROM sessions WHERE id = ?').get(conversationId);

    if (!existingSession) {
        const firstUserMsg = messages.find(m => m.role === 'user');
        db.prepare(`
            INSERT INTO sessions (id, first_message, turn_count, created_at, updated_at)
            VALUES (?, ?, 0, ?, ?)
        `).run(
            conversationId,
            firstUserMsg ? firstUserMsg.content.substring(0, 200) : '',
            now,
            now
        );
    }

    const maxIndexed = db.prepare(
        'SELECT MAX(turn_index) as max_turn FROM chunks WHERE session_id = ?'
    ).get(conversationId);

    const startFrom = (maxIndexed?.max_turn ?? -1) + 1;
    let indexed = 0;
    let skipped = 0;

    const insertChunk = db.prepare(`
        INSERT INTO chunks (session_id, role, content, embedding, turn_index, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (let i = startFrom; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg || !msg.content || typeof msg.content !== 'string') {
            skipped++;
            continue;
        }

        const content = msg.content.trim();
        if (content.length < 10) {
            skipped++;
            continue;
        }

        const truncated = content.substring(0, MAX_CHUNK_CHARS);

        try {
            const vec = await embeddings.embed(truncated);
            const vecBuf = _vecToBuffer(vec);

            insertChunk.run(
                conversationId,
                msg.role || 'unknown',
                truncated,
                vecBuf,
                i,
                now
            );
            indexed++;
        } catch (err) {
            console.error(`[Brain/Sessions] Failed to embed chunk ${i}:`, err.message);
            skipped++;
        }
    }

    db.prepare(`
        UPDATE sessions SET turn_count = ?, updated_at = ? WHERE id = ?
    `).run(messages.length, now, conversationId);

    if (indexed > 0) {
        console.log(`[Brain/Sessions] Indexed ${indexed} chunks for session ${conversationId.substring(0, 8)}...`);
    }

    return { indexed, skipped };
}

async function search(query, options = {}) {
    if (!query || typeof query !== 'string') return [];

    const maxResults = options.maxResults || DEFAULT_MAX_RESULTS;
    const minScore = options.minScore || MIN_SIMILARITY;

    let db;
    try {
        db = _getDb();
    } catch (err) {
        console.error('[Brain/Sessions] Search DB unavailable:', err.message);
        return [];
    }

    let queryVec;
    try {
        queryVec = await embeddings.embed(query);
    } catch (err) {
        console.error('[Brain/Sessions] Semantic search unavailable:', err.message);
        return [];
    }

    const chunks = db.prepare(`
        SELECT c.id, c.session_id, c.role, c.content, c.embedding, c.turn_index,
               s.first_message
        FROM chunks c
        JOIN sessions s ON s.id = c.session_id
        WHERE c.embedding IS NOT NULL
        ORDER BY c.created_at DESC
        LIMIT ${MAX_SEARCH_SCAN_CHUNKS}
    `).all();

    if (chunks.length === 0) return [];

    const scored = [];

    for (const chunk of chunks) {
        if (!chunk.embedding) continue;

        let chunkVec;
        try {
            chunkVec = _bufferToVec(chunk.embedding);
        } catch {
            continue;
        }
        const score = embeddings.similarity(queryVec, chunkVec);

        if (score >= minScore) {
            scored.push({
                id: chunk.id,
                sessionId: chunk.session_id,
                firstMessage: chunk.first_message,
                content: chunk.content,
                role: chunk.role,
                score,
                turnIndex: chunk.turn_index,
            });
        }
    }

    scored.sort((a, b) => b.score - a.score);

    const seenSessions = new Set();
    const deduped = [];

    for (const result of scored) {
        if (seenSessions.has(result.sessionId)) continue;
        seenSessions.add(result.sessionId);
        deduped.push(result);
        if (deduped.length >= maxResults) break;
    }

    for (const result of deduped) {
        result.context = _getContext(
            result.sessionId,
            result.turnIndex,
            CONTEXT_WINDOW
        );
    }

    return deduped;
}

function _getContext(sessionId, turnIndex, window) {
    const db = _getDb();

    return db.prepare(`
        SELECT role, content, turn_index
        FROM chunks
        WHERE session_id = ? AND turn_index BETWEEN ? AND ?
        ORDER BY turn_index ASC
    `).all(
        sessionId,
        Math.max(0, turnIndex - window),
        turnIndex + window
    ).map(row => ({
        role: row.role,
        content: row.content,
        turnIndex: row.turn_index,
    }));
}

function listSessions(options = {}) {
    const limit = options.limit || 20;
    const db = _getDb();

    return db.prepare(`
        SELECT id, first_message, turn_count, created_at, updated_at
        FROM sessions
        ORDER BY updated_at DESC
        LIMIT ?
    `).all(limit).map(row => ({
        id: row.id,
        firstMessage: row.first_message,
        turnCount: row.turn_count,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    }));
}

function stats() {
    const db = _getDb();

    const sessionCount = db.prepare('SELECT COUNT(*) as count FROM sessions').get().count;
    const chunkCount = db.prepare('SELECT COUNT(*) as count FROM chunks').get().count;

    const dbPath = path.join(getBrainDir(), DB_FILENAME);
    let dbSizeKB = 0;
    try {
        const stat = require('fs').statSync(dbPath);
        dbSizeKB = Math.round(stat.size / 1024);
    } catch { }

    return { sessions: sessionCount, chunks: chunkCount, dbSizeKB };
}

function removeSession(sessionId) {
    if (!sessionId) return { success: false };

    const db = _getDb();

    db.prepare('DELETE FROM chunks WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);

    return { success: true };
}

function close() {
    if (_db) {
        _db.close();
        _db = null;
    }
}

module.exports = {
    index,
    search,
    listSessions,
    stats,
    removeSession,
    close,
    MAX_CHUNK_CHARS,
    MIN_SIMILARITY,
};
