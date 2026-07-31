import test from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizeModelCheckOptions,
    validateMessagesRequest
} from '../src/routes/api.routes.js';

test('accepts a Claude Code style request with tools', () => {
    assert.equal(validateMessagesRequest({
        model: 'claude-sonnet-4-5',
        max_tokens: 4096,
        messages: [{ role: 'user', content: 'Inspect this project' }],
        tools: [{
            name: 'Read',
            description: 'Read a file',
            input_schema: { type: 'object', properties: {} }
        }]
    }), null);
});

test('rejects empty messages and malformed tool schemas', () => {
    assert.match(validateMessagesRequest({ messages: [] }), /non-empty array/);
    assert.match(validateMessagesRequest({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: '', input_schema: null }]
    }), /valid name/);
});

test('rejects invalid max_tokens and excessive tools', () => {
    assert.match(validateMessagesRequest({
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: -1
    }), /positive integer/);

    assert.match(validateMessagesRequest({
        messages: [{ role: 'user', content: 'hi' }],
        tools: Array.from({ length: 129 }, (_, index) => ({
            name: `tool_${index}`,
            input_schema: { type: 'object' }
        }))
    }), /at most 128/);
});

test('bounds model check concurrency, timeout, and candidate count', () => {
    assert.deepEqual(normalizeModelCheckOptions({
        models: 'a,b', concurrency: '999', timeout: '999999'
    }), {
        models: ['a', 'b'],
        concurrency: 10,
        timeoutMs: 120000
    });

    assert.throws(() => normalizeModelCheckOptions({
        models: Array.from({ length: 51 }, (_, index) => `model-${index}`)
    }), /at most 50/);
});
