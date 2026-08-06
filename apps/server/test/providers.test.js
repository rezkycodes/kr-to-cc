/**
 * Provider contract and model resolution.
 *
 * The load-bearing guarantee here is backward compatibility: every existing
 * Claude Code settings.json holds a bare model id like `claude-sonnet-4-5`, so
 * bare ids must keep resolving no matter how many providers get registered. The
 * namespaced form is the escape hatch for when two providers claim the same name.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { assertProvider } from '../src/providers/provider.js';
import {
    listProviders,
    getProvider,
    parseModelId,
    resolveModel,
    modelCostMultiplier,
    providerIdForModel
} from '../src/providers/index.js';
import { KIRO_MODEL_CATALOG } from '../src/providers/kiro/model-api.js';

/** Minimal object satisfying the contract, for validation tests. */
function stubProvider(overrides = {}) {
    return {
        id: 'stub',
        label: 'Stub Provider',
        ensureReady: async () => {},
        listModels: async () => ({ object: 'list', data: [] }),
        sendMessage: async () => ({}),
        sendMessageStream: async function* () {},
        ownsModel: () => false,
        costMultiplier: () => null,
        ...overrides
    };
}

test('every registered provider satisfies the contract', () => {
    const providers = listProviders();
    assert.ok(providers.length >= 1, 'expected at least one provider');
    for (const provider of providers) {
        assert.doesNotThrow(() => assertProvider(provider), `${provider.id} should be valid`);
    }
    // Slugs must be unique: they namespace model ids.
    const ids = providers.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, 'provider ids must be unique');
});

test('assertProvider rejects an incomplete provider and names what is missing', () => {
    assert.throws(() => assertProvider(null), /must be an object/);

    for (const method of ['ensureReady', 'listModels', 'sendMessage', 'sendMessageStream', 'ownsModel', 'costMultiplier']) {
        const broken = stubProvider();
        delete broken[method];
        assert.throws(
            () => assertProvider(broken),
            new RegExp(`${method}\\(\\) is missing`),
            `missing ${method} should be reported`
        );
    }

    assert.throws(() => assertProvider(stubProvider({ label: '' })), /label must be a non-empty string/);
    // The slug becomes a model-id prefix, so it has to stay prefix-safe.
    assert.throws(() => assertProvider(stubProvider({ id: 'Not/Valid' })), /lowercase letters, digits, and hyphens/);
    assert.throws(() => assertProvider(stubProvider({ checkActiveModels: 'nope' })), /checkActiveModels must be a function/);

    // A valid provider is returned unchanged so it can be used inline.
    const ok = stubProvider();
    assert.equal(assertProvider(ok), ok);
});

test('bare model ids keep resolving — the compatibility contract', () => {
    // Sample real ids across vendors rather than asserting the whole catalog,
    // so adding a model does not require touching this test.
    for (const id of ['claude-opus-4-8', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'auto', 'qwen3-coder-next']) {
        const resolved = resolveModel(id);
        assert.equal(resolved.provider.id, 'kiro', `${id} should resolve to kiro`);
        assert.equal(resolved.modelId, id, 'a bare id is passed through unchanged');
    }

    // Every catalog entry must resolve, both by alias and by upstream id.
    for (const model of KIRO_MODEL_CATALOG) {
        assert.equal(resolveModel(model.id).provider.id, 'kiro', `${model.id} must resolve`);
        assert.equal(resolveModel(model.kiro_id).provider.id, 'kiro', `${model.kiro_id} must resolve`);
    }
});

test('-thinking variants resolve to their base model', () => {
    const resolved = resolveModel('claude-opus-4-8-thinking');
    assert.equal(resolved.provider.id, 'kiro');
    // The suffix is preserved for the provider, which decides what it means.
    assert.equal(resolved.modelId, 'claude-opus-4-8-thinking');
});

test('namespaced ids pin a provider and strip the prefix', () => {
    const resolved = resolveModel('kiro/claude-sonnet-4-5');
    assert.equal(resolved.provider.id, 'kiro');
    assert.equal(resolved.modelId, 'claude-sonnet-4-5', 'provider receives the bare id');
    assert.equal(resolved.requestedId, 'kiro/claude-sonnet-4-5', 'the original spelling is retained');
});

test('unresolvable ids fail with a message that says what is wrong', () => {
    assert.throws(() => resolveModel(''), /model id is required/);
    assert.throws(() => resolveModel(null), /model id is required/);
    assert.throws(() => resolveModel('   '), /model id is required/);

    // Unknown model, no namespace.
    assert.throws(() => resolveModel('totally-unknown'), /Unknown model "totally-unknown"/);

    // Known provider, wrong model: blame the model.
    assert.throws(() => resolveModel('kiro/not-a-model'), /Provider "kiro" does not serve model "not-a-model"/);

    // Unknown namespace: blame the provider and list the real ones.
    assert.throws(() => resolveModel('nope/claude-sonnet-4-5'), /Unknown provider "nope"/);
    assert.throws(() => resolveModel('nope/claude-sonnet-4-5'), /Available providers: kiro/);
});

test('parseModelId distinguishes no namespace from an unknown one', () => {
    assert.deepEqual(parseModelId('claude-sonnet-4-5'), {
        providerId: null, bareId: 'claude-sonnet-4-5', prefix: null
    });
    assert.deepEqual(parseModelId('kiro/claude-sonnet-4-5'), {
        providerId: 'kiro', bareId: 'claude-sonnet-4-5', prefix: 'kiro'
    });

    // An unknown prefix is reported but not stripped — the id may legitimately
    // contain a slash, as Google's `models/gemini-...` form does.
    const unknown = parseModelId('models/gemini-3-pro');
    assert.equal(unknown.providerId, null);
    assert.equal(unknown.bareId, 'models/gemini-3-pro', 'id with a slash stays intact');
    assert.equal(unknown.prefix, 'models');
});

test('getProvider looks up by slug and is strict about misses', () => {
    assert.equal(getProvider('kiro')?.id, 'kiro');
    assert.equal(getProvider('nope'), null);
    assert.equal(getProvider(''), null);
    assert.equal(getProvider(undefined), null);
});

test('cost lookup spans providers and stays null for unknown models', () => {
    assert.equal(modelCostMultiplier('claude-opus-4-8'), 2.2);
    assert.equal(modelCostMultiplier('kiro/claude-opus-4-8'), 2.2, 'namespaced prices the same');
    assert.equal(modelCostMultiplier('claude-opus-4-8-thinking'), 2.2, 'thinking bills at the base rate');
    assert.equal(modelCostMultiplier('claude-haiku-4-5'), 0.4);
    assert.equal(modelCostMultiplier('unknown-model'), null);
    assert.equal(modelCostMultiplier(''), null);
});

test('providerIdForModel reports a provider without throwing', () => {
    assert.equal(providerIdForModel('claude-sonnet-4-5'), 'kiro');
    assert.equal(providerIdForModel('kiro/auto'), 'kiro');
    assert.equal(providerIdForModel('unknown-model'), null);
    assert.equal(providerIdForModel(''), null);
});

test('ownsModel agrees with resolution for every catalog entry', () => {
    const kiro = getProvider('kiro');
    assert.ok(kiro, 'kiro must be registered');
    for (const model of KIRO_MODEL_CATALOG) {
        assert.ok(kiro.ownsModel(model.id), `${model.id} should be owned`);
    }
    assert.equal(kiro.ownsModel('not-a-model'), false);
    assert.equal(kiro.ownsModel(''), false);
});
