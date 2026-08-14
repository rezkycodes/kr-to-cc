import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveTarget, comboModelEntries, listSelectableModels } from '../src/combos/resolver.js';

// --- resolveTarget: single provider path ---

test('resolveTarget resolves a known bare model as a single target', () => {
    const result = resolveTarget('claude-sonnet-4-6');
    assert.equal(result.kind, 'single');
    assert.ok(result.provider);
    assert.equal(result.modelId, 'claude-sonnet-4-6');
    assert.equal(result.requestedId, 'claude-sonnet-4-6');
});

test('resolveTarget throws for empty model id', () => {
    assert.throws(() => resolveTarget(''), /required/);
});

test('resolveTarget throws for non-string input', () => {
    assert.throws(() => resolveTarget(null), /required/);
    assert.throws(() => resolveTarget(undefined), /required/);
});

test('resolveTarget throws for completely unknown model', () => {
    assert.throws(() => resolveTarget('no-such-model-xyz'), /Unknown model/);
});

test('resolveTarget throws for explicit combo/ prefix when combo does not exist', () => {
    assert.throws(() => resolveTarget('combo/this-combo-does-not-exist'), /Unknown combo/);
});

// --- comboModelEntries ---

test('comboModelEntries returns empty array for empty input', () => {
    const result = comboModelEntries([]);
    assert.deepEqual(result, []);
});

test('comboModelEntries maps a combo with all-resolvable members to an active model entry', () => {
    const combo = {
        name: 'my-combo',
        strategy: 'failover',
        members: [{ model: 'claude-sonnet-4-6' }]
    };
    const [entry] = comboModelEntries([combo]);
    assert.equal(entry.id, 'my-combo');
    assert.equal(entry.object, 'model');
    assert.equal(entry.owned_by, 'combo');
    assert.equal(entry.status, 'active');
    assert.equal(entry.combo.strategy, 'failover');
    assert.deepEqual(entry.combo.members, ['claude-sonnet-4-6']);
    assert.equal(entry.combo.unresolved, 0);
});

test('comboModelEntries marks entry as degraded when a member cannot be resolved', () => {
    const combo = {
        name: 'broken-combo',
        strategy: 'failover',
        members: [
            { model: 'claude-sonnet-4-6' },     // resolvable
            { model: 'totally-fake-model-xyz' }  // NOT resolvable — triggers catch block
        ]
    };
    const [entry] = comboModelEntries([combo]);
    assert.equal(entry.status, 'degraded');
    assert.equal(entry.combo.unresolved, 1);
});

test('comboModelEntries entry has required shape fields', () => {
    const combo = {
        name: 'shape-test',
        strategy: 'race',
        members: [{ model: 'claude-sonnet-4-6' }]
    };
    const [entry] = comboModelEntries([combo]);
    assert.ok(typeof entry.created === 'number');
    assert.ok(typeof entry.description === 'string');
    assert.equal(entry.cost_multiplier, null);
    assert.equal(entry.context_window, null);
    assert.equal(entry.thinking, false);
    assert.ok(entry.namespaced_id.includes(entry.id));
});

test('comboModelEntries handles multiple combos', () => {
    const combos = [
        { name: 'c1', strategy: 'failover', members: [{ model: 'claude-sonnet-4-6' }] },
        { name: 'c2', strategy: 'race', members: [{ model: 'claude-sonnet-4-6' }] }
    ];
    const entries = comboModelEntries(combos);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].id, 'c1');
    assert.equal(entries[1].id, 'c2');
});

// --- listSelectableModels ---

test('listSelectableModels returns a models listing with data array', async () => {
    const result = await listSelectableModels();
    assert.ok(result);
    assert.ok(Array.isArray(result.data));
    assert.ok(result.data.length > 0);
});

test('listSelectableModels includes known model in listing', async () => {
    const result = await listSelectableModels();
    const ids = result.data.map((m) => m.id);
    assert.ok(ids.includes('claude-sonnet-4-6'), `claude-sonnet-4-6 not in ${ids.join(', ')}`);
});
