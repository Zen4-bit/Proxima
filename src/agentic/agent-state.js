// Proxima — Agent State Machine.
// Tracks agent execution states, transitions, and approval gates.

export const AGENT_STATE = {
    IDLE: 'idle',
    THINKING: 'thinking',
    ROUTING: 'routing',
    ACTING: 'acting',
    EVALUATING: 'evaluating',
    AWAITING_APPROVAL: 'awaiting_approval',
    DONE: 'done',
    ERROR: 'error',
    BLOCKED: 'blocked',
};

// Legal state transitions.
const TRANSITIONS = {
    [AGENT_STATE.IDLE]: [AGENT_STATE.THINKING],
    [AGENT_STATE.THINKING]: [AGENT_STATE.ROUTING, AGENT_STATE.BLOCKED, AGENT_STATE.ERROR],
    [AGENT_STATE.ROUTING]: [AGENT_STATE.ACTING, AGENT_STATE.ERROR],
    [AGENT_STATE.ACTING]: [AGENT_STATE.EVALUATING, AGENT_STATE.ERROR],
    [AGENT_STATE.EVALUATING]: [AGENT_STATE.DONE, AGENT_STATE.AWAITING_APPROVAL, AGENT_STATE.ERROR],
    [AGENT_STATE.AWAITING_APPROVAL]: [AGENT_STATE.DONE, AGENT_STATE.BLOCKED],
    [AGENT_STATE.DONE]: [AGENT_STATE.IDLE],
    [AGENT_STATE.ERROR]: [AGENT_STATE.IDLE],
    [AGENT_STATE.BLOCKED]: [AGENT_STATE.IDLE],
};

export class AgentStateMachine {
    constructor() {
        this.state = AGENT_STATE.IDLE;
        this.listeners = [];
        this.history = [];       // Last 50 transitions
        this.currentRun = null;  // Active run metadata (most-recent, for display)
        // Track active runs.
        this._activeRuns = new Map();  // runId → run
        this._runSeq = 0;
        this.stats = {
            totalRuns: 0,
            completed: 0,
            errors: 0,
            blocked: 0,
            avgDurationMs: 0,
            totalDurationMs: 0,
        };
    }


    transition(newState, metadata = {}) {
        const validNext = TRANSITIONS[this.state];
        if (!validNext || !validNext.includes(newState)) {
            if (newState === AGENT_STATE.IDLE) {
                this._doTransition(newState, metadata);
                return this;
            }
            return this;
        }

        this._doTransition(newState, metadata);
        return this;
    }

    _doTransition(newState, metadata) {
        const prevState = this.state;
        const timestamp = Date.now();

        this.state = newState;

        if (newState === AGENT_STATE.THINKING) {
            this.currentRun = {
                startedAt: timestamp,
                provider: null,
                states: [newState],
                metadata: {},
            };
            this.stats.totalRuns++;
        }

        if (this.currentRun) {
            this.currentRun.states.push(newState);
            Object.assign(this.currentRun.metadata, metadata);

            if (metadata.provider) {
                this.currentRun.provider = metadata.provider;
            }
        }

        if ([AGENT_STATE.DONE, AGENT_STATE.ERROR, AGENT_STATE.BLOCKED].includes(newState)) {
            if (this.currentRun) {
                const duration = timestamp - this.currentRun.startedAt;
                this.currentRun.duration = duration;
                this.currentRun.endState = newState;
                this._recordRunStats(newState, duration);
            }
        }

        this._recordTransition(prevState, newState, metadata, timestamp);
    }


    _recordRunStats(endState, duration) {
        this.stats.totalDurationMs += duration;
        this.stats.avgDurationMs = Math.round(this.stats.totalDurationMs / this.stats.totalRuns);
        if (endState === AGENT_STATE.DONE) this.stats.completed++;
        if (endState === AGENT_STATE.ERROR) this.stats.errors++;
        if (endState === AGENT_STATE.BLOCKED) this.stats.blocked++;
    }

    _recordTransition(prevState, newState, metadata, at) {
        this.history.push({ from: prevState, to: newState, at: at ?? Date.now(), ...metadata });
        if (this.history.length > 50) this.history.shift();
        for (const listener of this.listeners) {
            try { listener(newState, prevState, metadata); } catch (e) { }
        }
    }

    beginRun(metadata = {}) {
        const id = ++this._runSeq;
        const run = {
            id,
            startedAt: Date.now(),
            provider: metadata.provider || null,
            states: [AGENT_STATE.THINKING],
            metadata: { ...metadata },
            ended: false,
        };
        this._activeRuns.set(id, run);
        this.stats.totalRuns++;

        const prevState = this.state;
        this.state = AGENT_STATE.THINKING;      // best-effort "most recent" display
        this.currentRun = run;
        this._recordTransition(prevState, AGENT_STATE.THINKING, metadata);

        const self = this;
        const handle = {
            id,
            setState(newState, meta = {}) {
                if (run.ended) return handle;
                const prev = self.state;
                run.states.push(newState);
                Object.assign(run.metadata, meta);
                if (meta.provider) run.provider = meta.provider;
                self.state = newState;
                self.currentRun = run;
                self._recordTransition(prev, newState, meta);
                return handle;
            },
            end(endState = AGENT_STATE.DONE, meta = {}) {
                if (run.ended) return handle;
                run.ended = true;
                const duration = Date.now() - run.startedAt;
                run.duration = duration;
                run.endState = endState;
                run.states.push(endState);
                Object.assign(run.metadata, meta);
                self._activeRuns.delete(id);
                self._recordRunStats(endState, duration);

                const prev = self.state;
                self.currentRun = run;
                self._recordTransition(prev, endState, meta);

                if (self._activeRuns.size === 0) {
                    self.state = AGENT_STATE.IDLE;
                    self._recordTransition(endState, AGENT_STATE.IDLE, {});
                } else {
                    self.state = endState;
                }
                return handle;
            },
        };
        return handle;
    }


    onStateChange(fn) {
        this.listeners.push(fn);
        return () => { this.listeners = this.listeners.filter(l => l !== fn); };
    }

    getStatus() {
        return {
            currentState: this.state,
            activeRuns: this._activeRuns.size,
            currentRun: this.currentRun ? {
                provider: this.currentRun.provider,
                duration: Date.now() - this.currentRun.startedAt,
                states: this.currentRun.states,
            } : null,
            stats: this.stats,
            lastTransitions: this.history.slice(-5).map(h => ({
                from: h.from,
                to: h.to,
                ago: `${Math.round((Date.now() - h.at) / 1000)}s`,
            })),
        };
    }

    reset() {
        this.state = AGENT_STATE.IDLE;
        this.currentRun = null;
        this._activeRuns.clear();
    }
}
