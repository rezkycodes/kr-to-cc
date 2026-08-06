import test from 'node:test';
import assert from 'node:assert/strict';

import { getKiroEndpoint, KIRO_MODEL_MAPPING } from '../src/constants.js';
import { KIRO_MODEL_CATALOG, listKiroModels } from '../src/providers/kiro/model-api.js';

test('builds CodeWhisperer endpoints for valid regions not in the static catalog', () => {
    assert.equal(
        getKiroEndpoint('eu-central-1'),
        'https://codewhisperer.eu-central-1.amazonaws.com'
    );
});

test('rejects invalid region values', () => {
    assert.throws(() => getKiroEndpoint('example.com/path'), /Invalid region/);
});

test('maps and lists Claude Opus 5 with the verified Kiro metadata', async () => {
    assert.equal(KIRO_MODEL_MAPPING['claude-opus-5'], 'claude-opus-5');
    assert.equal(KIRO_MODEL_MAPPING['claude-opus-5-thinking'], 'claude-opus-5');

    const catalogEntry = KIRO_MODEL_CATALOG.find((model) => model.id === 'claude-opus-5');
    assert.deepEqual(catalogEntry, {
        id: 'claude-opus-5',
        kiro_id: 'claude-opus-5',
        owned_by: 'anthropic',
        description: 'Claude Opus 5 - Strongest Opus for long-running agentic tasks and parallel coordination',
        context_window: 1000000,
        cost_multiplier: 2.2,
        regions: ['us-east-1', 'eu-central-1'],
        status: 'experimental',
        thinking: true
    });

    const { data } = await listKiroModels();
    assert.ok(data.some((model) => model.id === 'claude-opus-5'));
    assert.ok(data.some((model) => model.id === 'claude-opus-5-thinking'));
});
