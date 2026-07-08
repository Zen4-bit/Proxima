// Proxima — ONNX Embedding Engine.
// Performs local WordPiece tokenization and MiniLM inference for semantic vector generation.

'use strict';

const fs = require('fs');
const path = require('path');
const { getBrainDir } = require('./paths.cjs');

const MODEL_DIR = 'models';
const MODEL_NAME = 'minilm';
const MODEL_FILES = ['model.onnx', 'tokenizer.json', 'config.json'];
const EMBEDDING_DIM = 384;
const MAX_TOKENS = 256;

let _session = null;
let _tokenizer = null;
let _initialized = false;
let _initPromise = null;

function _getModelDir() {
    return path.join(getBrainDir(), MODEL_DIR, MODEL_NAME);
}

function isModelReady() {
    const modelDir = _getModelDir();
    return MODEL_FILES.every(f => fs.existsSync(path.join(modelDir, f)));
}

function _loadTokenizer() {
    const tokenizerPath = path.join(_getModelDir(), 'tokenizer.json');
    const raw = JSON.parse(fs.readFileSync(tokenizerPath, 'utf8'));

    const vocab = {};
    if (raw.model && raw.model.vocab) {
        for (const [token, id] of Object.entries(raw.model.vocab)) {
            vocab[token] = id;
        }
    }

    const clsId = vocab['[CLS]'] || 101;
    const sepId = vocab['[SEP]'] || 102;
    const unkId = vocab['[UNK]'] || 100;
    const padId = vocab['[PAD]'] || 0;

    return {
        encode(text, maxLength = MAX_TOKENS) {
            const words = text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
            const tokenIds = [clsId];

            for (const word of words) {
                if (tokenIds.length >= maxLength - 1) break;

                const id = vocab[word];
                if (id !== undefined) {
                    tokenIds.push(id);
                } else {
                    let remaining = word;
                    let isFirst = true;
                    while (remaining.length > 0 && tokenIds.length < maxLength - 1) {
                        let found = false;
                        for (let end = remaining.length; end > 0; end--) {
                            const sub = isFirst ? remaining.substring(0, end) : `##${remaining.substring(0, end)}`;
                            if (vocab[sub] !== undefined) {
                                tokenIds.push(vocab[sub]);
                                remaining = remaining.substring(end);
                                isFirst = false;
                                found = true;
                                break;
                            }
                        }
                        if (!found) {
                            tokenIds.push(unkId);
                            break;
                        }
                    }
                }
            }

            tokenIds.push(sepId);

            const attentionMask = tokenIds.map(() => 1);
            while (tokenIds.length < maxLength) {
                tokenIds.push(padId);
                attentionMask.push(0);
            }

            return { inputIds: tokenIds, attentionMask };
        },

        padId,
    };
}

async function init() {
    if (_initialized) return;
    if (_initPromise) return _initPromise;

    _initPromise = (async () => {
        if (!isModelReady()) {
            throw new Error(
                'Embedding model not installed — semantic session memory is disabled. ' +
                'No automatic download is performed; place the MiniLM ONNX model ' +
                `(${MODEL_FILES.join(', ')}) under ${_getModelDir()} to enable it.`
            );
        }

        let ort;
        try {
            ort = require('onnxruntime-node');
        } catch {
            throw new Error(
                'onnxruntime-node not installed. Run: npm install onnxruntime-node'
            );
        }

        const modelPath = path.join(_getModelDir(), 'model.onnx');
        _session = await ort.InferenceSession.create(modelPath, {
            executionProviders: ['cpu'],
            graphOptimizationLevel: 'all',
        });

        _tokenizer = _loadTokenizer();
        _initialized = true;

        console.log('[Brain/Embeddings] ONNX session initialized (MiniLM-L6-v2, 384-dim)');
    })();

    _initPromise.catch(() => { _initPromise = null; });

    return _initPromise;
}

function _meanPool(embeddings, attentionMask, dim) {
    const result = new Float32Array(dim);
    let tokenCount = 0;

    for (let t = 0; t < attentionMask.length; t++) {
        if (attentionMask[t] === 0) continue;
        tokenCount++;
        for (let d = 0; d < dim; d++) {
            result[d] += embeddings[t * dim + d];
        }
    }

    if (tokenCount > 0) {
        for (let d = 0; d < dim; d++) {
            result[d] /= tokenCount;
        }
    }

    let norm = 0;
    for (let d = 0; d < dim; d++) {
        norm += result[d] * result[d];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
        for (let d = 0; d < dim; d++) {
            result[d] /= norm;
        }
    }

    return result;
}

async function embed(text) {
    await init();

    if (!text || typeof text !== 'string') {
        return new Float32Array(EMBEDDING_DIM);
    }

    const truncated = text.substring(0, 1000);
    const { inputIds, attentionMask } = _tokenizer.encode(truncated);

    const ort = require('onnxruntime-node');

    const inputIdsTensor = new ort.Tensor('int64',
        BigInt64Array.from(inputIds.map(BigInt)),
        [1, inputIds.length]
    );
    const attentionMaskTensor = new ort.Tensor('int64',
        BigInt64Array.from(attentionMask.map(BigInt)),
        [1, attentionMask.length]
    );
    const tokenTypeIds = new ort.Tensor('int64',
        new BigInt64Array(inputIds.length),
        [1, inputIds.length]
    );

    const results = await _session.run({
        input_ids: inputIdsTensor,
        attention_mask: attentionMaskTensor,
        token_type_ids: tokenTypeIds,
    });

    const output = results['last_hidden_state'] || results[Object.keys(results)[0]];
    return _meanPool(output.data, attentionMask, EMBEDDING_DIM);
}

async function embedBatch(texts) {
    const results = [];
    for (const text of texts) {
        results.push(await embed(text));
    }
    return results;
}

function similarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;

    let dot = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
    }
    return dot;
}

function findSimilar(query, candidates, topN = 5) {
    const scored = candidates.map((candidate, index) => ({
        ...candidate,
        score: similarity(query, candidate.embedding),
        index,
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topN);
}

module.exports = {
    init,
    embed,
    embedBatch,
    similarity,
    findSimilar,
    isModelReady,
    EMBEDDING_DIM,
};
