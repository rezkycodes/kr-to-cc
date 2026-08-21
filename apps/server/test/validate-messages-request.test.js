import test from 'node:test';
import assert from 'node:assert/strict';

import { validateMessagesRequest } from '../src/routes/api.routes.js';

// --- body shape ---

test('returns null for a minimal valid request', () => {
    assert.equal(
        validateMessagesRequest({ messages: [{ role: 'user', content: 'hi' }] }),
        null
    );
});

test('rejects null body', () => {
    assert.ok(validateMessagesRequest(null));
});

test('rejects array body', () => {
    assert.ok(validateMessagesRequest([]));
});

test('rejects non-object body', () => {
    assert.ok(validateMessagesRequest('string'));
    assert.ok(validateMessagesRequest(42));
});

// --- messages field ---

test('rejects missing messages', () => {
    const err = validateMessagesRequest({});
    assert.match(err, /messages/);
});

test('rejects empty messages array', () => {
    const err = validateMessagesRequest({ messages: [] });
    assert.match(err, /messages/);
});

test('rejects non-array messages', () => {
    const err = validateMessagesRequest({ messages: 'text' });
    assert.match(err, /messages/);
});

// --- max_tokens ---

test('accepts valid max_tokens', () => {
    assert.equal(
        validateMessagesRequest({ messages: [{ role: 'user', content: 'x' }], max_tokens: 1024 }),
        null
    );
});

test('rejects zero max_tokens', () => {
    const err = validateMessagesRequest({
        messages: [{ role: 'user', content: 'x' }],
        max_tokens: 0
    });
    assert.match(err, /max_tokens/);
});

test('rejects negative max_tokens', () => {
    const err = validateMessagesRequest({
        messages: [{ role: 'user', content: 'x' }],
        max_tokens: -5
    });
    assert.match(err, /max_tokens/);
});

test('rejects non-integer max_tokens', () => {
    const err = validateMessagesRequest({
        messages: [{ role: 'user', content: 'x' }],
        max_tokens: 1.5
    });
    assert.match(err, /max_tokens/);
});

// --- stream ---

test('accepts stream: true', () => {
    assert.equal(
        validateMessagesRequest({ messages: [{ role: 'user', content: 'x' }], stream: true }),
        null
    );
});

test('accepts stream: false', () => {
    assert.equal(
        validateMessagesRequest({ messages: [{ role: 'user', content: 'x' }], stream: false }),
        null
    );
});

test('rejects non-boolean stream', () => {
    const err = validateMessagesRequest({
        messages: [{ role: 'user', content: 'x' }],
        stream: 1
    });
    assert.match(err, /stream/);
});

// --- tools ---

test('accepts a valid tools array', () => {
    assert.equal(
        validateMessagesRequest({
            messages: [{ role: 'user', content: 'x' }],
            tools: [{ name: 'grep', input_schema: { type: 'object' } }]
        }),
        null
    );
});

test('rejects non-array tools', () => {
    const err = validateMessagesRequest({
        messages: [{ role: 'user', content: 'x' }],
        tools: 'not-array'
    });
    assert.match(err, /tools/);
});

test('rejects tools array over 1024 entries', () => {
    const tools = Array.from({ length: 1025 }, (_, i) => ({
        name: `tool_${i}`,
        input_schema: { type: 'object' }
    }));
    const err = validateMessagesRequest({ messages: [{ role: 'user', content: 'x' }], tools });
    assert.match(err, /1024/);
});

test('rejects tool with missing name', () => {
    const err = validateMessagesRequest({
        messages: [{ role: 'user', content: 'x' }],
        tools: [{ input_schema: { type: 'object' } }]
    });
    assert.match(err, /tool/);
});

test('rejects tool with name exceeding 256 chars', () => {
    const err = validateMessagesRequest({
        messages: [{ role: 'user', content: 'x' }],
        tools: [{ name: 'a'.repeat(257), input_schema: { type: 'object' } }]
    });
    assert.match(err, /tool/);
});

test('rejects tool with missing input_schema', () => {
    const err = validateMessagesRequest({
        messages: [{ role: 'user', content: 'x' }],
        tools: [{ name: 'grep' }]
    });
    assert.match(err, /input_schema/);
});

test('rejects tool with array input_schema', () => {
    const err = validateMessagesRequest({
        messages: [{ role: 'user', content: 'x' }],
        tools: [{ name: 'grep', input_schema: [] }]
    });
    assert.match(err, /input_schema/);
});
