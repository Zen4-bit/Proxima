// Proxima — Context Token Estimator.
// Performs fast token size estimation of messages based on character length heuristics.

'use strict';

const CHARS_PER_TOKEN = 4;
const MSG_OVERHEAD   = 4;
const IMAGE_TOKENS   = 1600;

function estimate(text) {
    if (!text) return 0;
    if (typeof text !== 'string') text = JSON.stringify(text);
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function forMessage(msg) {
    let tokens = MSG_OVERHEAD;

    if (typeof msg.content === 'string') {
        tokens += estimate(msg.content);
    } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
            if (typeof part === 'string') {
                tokens += estimate(part);
            } else if (part && part.type === 'text') {
                tokens += estimate(part.text);
            } else if (part && ['image_url', 'image', 'input_image'].includes(part.type)) {
                tokens += IMAGE_TOKENS;
            }
        }
    }

    if (msg.tool_calls) {
        tokens += estimate(JSON.stringify(msg.tool_calls));
    }

    return tokens;
}

function forAll(messages) {
    return messages.reduce((sum, msg) => sum + forMessage(msg), 0);
}

function perMessage(messages) {
    return messages.map(forMessage);
}

module.exports = { estimate, forMessage, forAll, perMessage, CHARS_PER_TOKEN, IMAGE_TOKENS };
