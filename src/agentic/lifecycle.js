// Proxima — Lifecycle Hooks.
// Provides an EventEmitter-based event system to hook into key points of the agentic pipeline.

import { EventEmitter } from 'events';
import { createLogger } from '../utils/logger.js';

const log = createLogger('lifecycle');

const LIFECYCLE_EVENTS = {
    AGENT_START: 'agent_start',
    AGENT_END: 'agent_end',
    AGENT_ERROR: 'agent_error',
    GUARDRAIL_INPUT: 'guardrail_input',
    GUARDRAIL_OUTPUT: 'guardrail_output',
    HANDOFF: 'handoff',
    TOOL_START: 'tool_start',
    TOOL_END: 'tool_end',
    MEMORY_SAVE: 'memory_save',
    WORKFLOW_STEP: 'workflow_step',
    LOOP_ITERATION: 'loop_iteration',
};

class LifecycleHooks extends EventEmitter {
    constructor() {
        super();
        this.setMaxListeners(50);

        this.stats = {
            eventsEmitted: 0,
            eventCounts: {},
            subscriberCount: 0,
        };

        this._registerDefaultSubscribers();
    }

    fire(eventName, data = {}) {
        this.stats.eventsEmitted++;
        this.stats.eventCounts[eventName] = (this.stats.eventCounts[eventName] || 0) + 1;

        const eventData = {
            event: eventName,
            timestamp: Date.now(),
            ...data,
        };

        try {
            this.emit(eventName, eventData);
        } catch (e) {

            log.warn('Lifecycle subscriber error', { event: eventName, error: e.message });
        }
    }

    subscribe(eventName, handler) {
        this.on(eventName, handler);
        this.stats.subscriberCount++;
        return () => {
            this.off(eventName, handler);
            this.stats.subscriberCount--;
        };
    }

    subscribeOnce(eventName, handler) {
        this.once(eventName, handler);
    }

    _registerDefaultSubscribers() {
        this.on(LIFECYCLE_EVENTS.AGENT_ERROR, (data) => {
            log.error('Agent error', {
                provider: data.provider,
                error: data.error,
            });
        });

        this.on(LIFECYCLE_EVENTS.GUARDRAIL_INPUT, (data) => {
            if (!data.passed) {
                log.warn('Input blocked by guardrail', { blocked: data.blocked });
            }
        });
    }

    getStatusReport() {
        const lines = [];
        lines.push(`Lifecycle Hooks: ${this.stats.eventsEmitted} events fired, ${this.stats.subscriberCount} subscribers`);

        const eventTypes = Object.entries(this.stats.eventCounts);
        if (eventTypes.length > 0) {
            const top = eventTypes.sort((a, b) => b[1] - a[1]).slice(0, 5);
            const summary = top.map(([name, count]) => `${name}:${count}`).join(', ');
            lines.push(`  Top Events: ${summary}`);
        }

        return lines.join('\n');
    }

    reset() {
        this.stats = {
            eventsEmitted: 0,
            eventCounts: {},
            subscriberCount: 0,
        };
    }
}

export { LifecycleHooks, LIFECYCLE_EVENTS };
