/**
 * Pi Agent config tests.
 *
 * The risk here is destroying a file that is not ours: `models.json` holds the
 * user's other providers. So the cases are about preserving them, refusing to
 * write over damage, and labelling models correctly.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    __setPiConfigPathForTests,
    applyPiConfig,
    buildPiProvider,
    readPiConfig,
    removePiProvider,
    PI_PROVIDER_KEY
} from '../src/config/pi-agent.js';

function isolate(contents) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-pi-'));
    const file = path.join(dir, 'models.json');
    if (contents !== undefined) fs.writeFileSync(file, contents);
    __setPiConfigPathForTests(file);
    return file;
}

const OPTIONS = { baseUrl: 'http://localhost:4985/v1', apiKey: 'dummy' };

test('the provider block declares the OpenAI transport', async () => {
    isolate();
    const provider = await buildPiProvider(OPTIONS);

    // Pi Agent would not understand the Anthropic route, so this must be the
    // OpenAI one or nothing works.
    assert.equal(provider.api, 'openai-completions');
    assert.equal(provider.baseUrl, 'http://localhost:4985/v1');
    assert.ok(provider.models.length > 0);

    for (const model of provider.models) {
        assert.equal(typeof model.id, 'string');
        assert.equal(model.name, model.id);
        // Text is always claimed; image only when proven, never guessed.
        assert.ok(model.input.includes('text'));
        assert.equal(typeof model.reasoning, 'boolean');
    }
});

test('a -thinking model is labelled as reasoning', async () => {
    isolate();
    const { models } = await buildPiProvider(OPTIONS);

    // Kiro publishes the reasoning variant as its own id rather than a flag, so
    // reading only a flag would mislabel every one of them.
    const thinking = models.filter((m) => m.id.endsWith('-thinking'));
    assert.ok(thinking.length > 0, 'expected some -thinking variants in the catalog');
    for (const model of thinking) {
        assert.equal(model.reasoning, true, `${model.id} should be reasoning`);
    }
});

test('other providers in the file are preserved', async () => {
    const file = isolate(
        JSON.stringify({
            providers: {
                '9Router': { api: 'openai-completions', baseUrl: 'http://localhost:20128/v1', models: [] }
            },
            somethingElse: { keep: true }
        })
    );

    const result = await applyPiConfig(OPTIONS);
    assert.equal(result.ok, true);

    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    // The whole point: this file is the user's, and we only own one key in it.
    assert.ok(written.providers['9Router'], 'expected the other provider to survive');
    assert.deepEqual(written.somethingElse, { keep: true });
    assert.ok(written.providers[PI_PROVIDER_KEY].models.length > 0);
    assert.deepEqual(result.otherProviders, ['9Router']);
});

test('an existing file is backed up before being rewritten', async () => {
    const file = isolate(JSON.stringify({ providers: {} }));
    const result = await applyPiConfig(OPTIONS);

    assert.ok(result.backup, 'expected a backup path');
    assert.ok(fs.existsSync(result.backup), 'expected the backup to exist');
    assert.notEqual(result.backup, file);
});

test('a damaged file is refused rather than overwritten', async () => {
    // Overwriting it would destroy the user's other providers, so this fails loudly.
    const file = isolate('{ this is not json');
    const result = await applyPiConfig(OPTIONS);

    assert.equal(result.ok, false);
    assert.match(result.error, /could not be parsed/);
    // Untouched.
    assert.equal(fs.readFileSync(file, 'utf8'), '{ this is not json');
});

test('a missing file is created', async () => {
    const file = isolate();
    assert.equal(readPiConfig().exists, false);

    const result = await applyPiConfig(OPTIONS);
    assert.equal(result.ok, true);
    // Nothing to back up when there was no file.
    assert.equal(result.backup, null);
    assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).providers[PI_PROVIDER_KEY]);
});

test('removing our block leaves the others alone', async () => {
    const file = isolate(
        JSON.stringify({ providers: { '9Router': { api: 'openai-completions', models: [] } } })
    );
    await applyPiConfig(OPTIONS);

    const result = removePiProvider();
    assert.equal(result.removed, true);

    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(written.providers[PI_PROVIDER_KEY], undefined);
    assert.ok(written.providers['9Router'], 'expected the other provider to survive removal');
});

test('a partial catalog is reported rather than written silently', async () => {
    isolate();
    const result = await applyPiConfig(OPTIONS);

    // An unreachable provider contributes no models. The field exists so a caller
    // can say the config is incomplete instead of the user finding models missing.
    assert.ok(Array.isArray(result.unavailable));
});
