// Proxima — BYOK Subsystem Entry.
// Aggregates and re-exports BYOK API keys, router, memory, context, and brain interfaces.

'use strict';

const keys = require('./keys.cjs');
const { callProvider } = require('./router.cjs');
const models = require('./models.cjs');
const modelFetcher = require('./model-fetcher.cjs');
const memory = require('./memory/index.cjs');
const context = require('./context/index.cjs');
const brain = require('./brain/index.cjs');
const discovery = require('./discovery/index.cjs');

module.exports = {
    keys,
    callProvider,
    models,
    modelFetcher,
    memory,
    context,
    brain,
    discovery,
};
