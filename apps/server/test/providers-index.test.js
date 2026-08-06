import test from 'node:test';
import assert from 'node:assert/strict';

import {
    parseModelId,
    resolveModel,
    getProvider,
    listProviders,
    providerIdForModel,
    modelCostMultiplier
} from '../src/providers/index.js';

// --- parseModelId ---

test('parses a bare model id with no namespace', () => {
    const result = parseModelId('claude-sonnet-4-6');
    assert.equal(result.providerId, null);
    assert.equal(result.bareId, 'claude-sonnet-4-6');
    assert.equal(result.prefix, null);
});

test('parses a namespaced kiro model id', () => {
    const result = parseModelId('kiro/claude-sonnet-4-6');
    assert.equal(result.providerId, 'kiro');
    assert.equal(result.bareId, 'claude-sonnet-4-6');
});

test('parses a namespaced google model id', () => {
    const result = parseModelId('google/claude-sonnet-4-6');
    assert.equal(result.providerId, 'google');
    assert.equal(result.bareId, 'claude-sonnet-4-6');
});

test('returns no providerId when prefix is not a known provider', () => {
    const result = parseModelId('unknown/some-model');
    assert.equal(result.providerId, null);
    assert.equal(result.prefix, 'unknown');
});

test('handles empty string gracefully', () => {
    const result = parseModelId('');
    assert.equal(result.bareId, '');
    assert.equal(result.providerId, null);
});

test('handles non-string input gracefully', () => {
    const result = parseModelId(null);
    assert.equal(result.bareId, '');
});

// --- resolveModel ---

test('resolves a bare claude model id to kiro provider', () => {
    const { provider, modelId } = resolveModel('claude-sonnet-4-6');
    assert.equal(provider.id, 'kiro');
    assert.equal(modelId, 'claude-sonnet-4-6');
});

test('resolves a kiro-namespaced model id', () => {
    const { provider, modelId, requestedId } = resolveModel('kiro/claude-sonnet-4-6');
    assert.equal(provider.id, 'kiro');
    assert.equal(modelId, 'claude-sonnet-4-6');
    assert.equal(requestedId, 'kiro/claude-sonnet-4-6');
});

test('throws for an empty model id', () => {
    assert.throws(() => resolveModel(''), /required/);
});

test('throws for a completely unknown bare model id', () => {
    assert.throws(() => resolveModel('not-a-real-model'), /Unknown model/);
});

test('throws with helpful message when provider namespace is unknown', () => {
    assert.throws(
        () => resolveModel('bogus-provider/claude-sonnet-4-6'),
        /Unknown provider/
    );
});

test('throws when namespaced provider does not own the model', () => {
    // google provider does not serve claude-haiku-4-5 (kiro-only model)
    // We just verify that mismatches throw, regardless of which model
    assert.throws(
        () => resolveModel('kiro/definitely-not-a-real-model'),
        /does not serve model/
    );
});

// --- getProvider ---

test('returns kiro provider by id', () => {
    const p = getProvider('kiro');
    assert.equal(p.id, 'kiro');
    assert.ok(typeof p.sendMessage === 'function');
    assert.ok(typeof p.sendMessageStream === 'function');
    assert.ok(typeof p.ensureReady === 'function');
    assert.ok(typeof p.ownsModel === 'function');
});

test('returns google provider by id', () => {
    const p = getProvider('google');
    assert.equal(p.id, 'google');
});

test('returns null for an unknown provider id', () => {
    assert.equal(getProvider('nonexistent'), null);
});

test('returns null for non-string input', () => {
    assert.equal(getProvider(null), null);
    assert.equal(getProvider(undefined), null);
    assert.equal(getProvider(42), null);
});

// --- listProviders ---

test('returns at least kiro and google providers', () => {
    const providers = listProviders();
    assert.ok(Array.isArray(providers));
    const ids = providers.map((p) => p.id);
    assert.ok(ids.includes('kiro'));
    assert.ok(ids.includes('google'));
});

test('returned array is a copy — mutating it does not affect registry', () => {
    const a = listProviders();
    a.push({ id: 'fake' });
    const b = listProviders();
    assert.ok(!b.find((p) => p.id === 'fake'));
});

// --- providerIdForModel ---

test('returns kiro for a known kiro model', () => {
    assert.equal(providerIdForModel('claude-sonnet-4-6'), 'kiro');
});

test('returns null for an unknown model', () => {
    assert.equal(providerIdForModel('no-such-model'), null);
});

// --- modelCostMultiplier ---

test('returns a number for a known model', () => {
    const multiplier = modelCostMultiplier('claude-haiku-4-5');
    assert.ok(typeof multiplier === 'number');
    assert.ok(multiplier > 0);
});

test('returns null for an unknown model', () => {
    assert.equal(modelCostMultiplier('not-a-model'), null);
});

test('returns null for an empty string', () => {
    assert.equal(modelCostMultiplier(''), null);
});

test('opus costs more than haiku', () => {
    const haiku = modelCostMultiplier('claude-haiku-4-5');
    const opus = modelCostMultiplier('claude-opus-4-8');
    assert.ok(opus > haiku);
});
