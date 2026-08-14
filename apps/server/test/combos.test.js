/**
 * Combos: validation, strategies, and resolution.
 *
 * The strategies are tested with stub providers rather than live upstreams,
 * because the behaviour that matters is what happens when a member *fails* — and
 * a real provider cannot be made to fail on demand.
 *
 * The most important assertion in this file is that a stream never switches
 * members after its first event. Getting that wrong would send the client two
 * overlapping messages, which is worse than a clean error.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
    COMBO_STRATEGIES,
    validateCombo,
    saveCombo,
    deleteCombo,
    listCombos,
    getCombo,
    __setStorePathForTests
} from '../src/combos/store.js';
import {
    isRetryable,
    classifyRequest,
    planAttempts,
    runOnce,
    runStream,
    resetState
} from '../src/combos/strategies.js';
import { resolveTarget, comboModelEntries } from '../src/combos/resolver.js';

/** Isolate the store so tests never touch the real config. */
const tempStore = path.join(os.tmpdir(), `kr-combos-${process.pid}.json`);
__setStorePathForTests(tempStore);

test.after(() => {
    fs.rmSync(tempStore, { force: true });
});

/** Stub target that succeeds. */
function ok(id, value = 'ok') {
    return {
        provider: { id, sendMessage: async () => value },
        modelId: `${id}-model`
    };
}

/** Stub target whose attempt rejects. */
function fails(id, message) {
    return { provider: { id }, modelId: `${id}-model` };
}

const combo = (strategy, count = 3) => ({
    name: `t-${strategy}`,
    strategy,
    members: Array.from({ length: count }, (_, i) => ({ model: `m${i}` }))
});

test('retryable failures are the ones a combo exists for', () => {
    for (const message of [
        'Google quota exhausted (HTTP 429): limit',
        'Kiro API error 503: unavailable',
        'request timeout',
        'Not signed in to Google.',
        'Google token refresh failed: revoked'
    ]) {
        assert.ok(isRetryable(new Error(message)), `should retry: ${message}`);
    }

    // A client mistake is final — every member would reject it identically, so
    // retrying only wastes quota and delays the real error.
    for (const message of [
        'invalid_request_error: messages is required',
        'Kiro API error 400: malformed',
        'Provider "kiro" does not serve model "x"'
    ]) {
        assert.equal(isRetryable(new Error(message)), false, `should not retry: ${message}`);
    }
});

test('request classification reads shape, not content', () => {
    assert.equal(classifyRequest({ messages: [{ role: 'user', content: 'hi' }] }), 'light');
    assert.equal(
        classifyRequest({ messages: [{ role: 'user', content: 'x'.repeat(5_000) }] }),
        'standard'
    );
    assert.equal(
        classifyRequest({ messages: [{ role: 'user', content: 'x'.repeat(30_000) }] }),
        'heavy'
    );
    // Tools imply agentic work regardless of size.
    assert.equal(
        classifyRequest({ messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 't' }] }),
        'heavy'
    );
});

test('failover keeps the listed order', () => {
    resetState();
    const plan = [ok('a'), ok('b'), ok('c')];
    const { order, concurrent } = planAttempts(combo('failover'), plan, {});
    assert.equal(concurrent, false);
    assert.deepEqual(order.map((t) => t.provider.id), ['a', 'b', 'c']);
});

test('load balance rotates on each request and keeps the rest as fallbacks', () => {
    resetState();
    const plan = [ok('a'), ok('b'), ok('c')];
    const definition = combo('load-balance');

    const firsts = [];
    for (let i = 0; i < 6; i += 1) {
        const { order } = planAttempts(definition, plan, {});
        firsts.push(order[0].provider.id);
        // Balancing must not mean giving up when the chosen member is down.
        assert.equal(order.length, 3, 'the others remain as fallbacks');
    }
    assert.deepEqual(firsts, ['a', 'b', 'c', 'a', 'b', 'c']);
});

test('router sends heavy work to the last member and light work to the first', () => {
    resetState();
    const plan = [ok('cheap'), ok('mid'), ok('strong')];
    const definition = combo('router');

    const light = planAttempts(definition, plan, { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(light.order[0].provider.id, 'cheap');

    const heavy = planAttempts(definition, plan, {
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 't' }]
    });
    assert.equal(heavy.order[0].provider.id, 'strong');

    // Whatever it picks, the others stay available as fallbacks.
    assert.equal(heavy.order.length, 3);
});

test('race runs members concurrently', () => {
    resetState();
    const { concurrent } = planAttempts(combo('race'), [ok('a'), ok('b')], {});
    assert.equal(concurrent, true);
});

test('runOnce falls through to a working member', async () => {
    resetState();
    const plan = [fails('down'), ok('up')];
    const attempted = [];

    const { result, target } = await runOnce(combo('failover', 2), plan, {}, async (t) => {
        attempted.push(t.provider.id);
        if (t.provider.id === 'down') throw new Error('HTTP 503 unavailable');
        return 'answered';
    });

    assert.deepEqual(attempted, ['down', 'up']);
    assert.equal(result, 'answered');
    assert.equal(target.provider.id, 'up');
});

test('runOnce surfaces a non-retryable failure immediately', async () => {
    resetState();
    const plan = [fails('first'), ok('second')];
    const attempted = [];

    await assert.rejects(
        runOnce(combo('failover', 2), plan, {}, async (t) => {
            attempted.push(t.provider.id);
            throw new Error('invalid_request_error: messages is required');
        }),
        /invalid_request_error/
    );
    // The second member is never tried: it would reject identically.
    assert.deepEqual(attempted, ['first']);
});

test('runOnce reports every member when all fail', async () => {
    resetState();
    const plan = [fails('a'), fails('b')];
    await assert.rejects(
        runOnce(combo('failover', 2), plan, {}, async (t) => {
            throw new Error(`HTTP 429 quota for ${t.provider.id}`);
        }),
        (error) => {
            assert.match(error.message, /exhausted every member/);
            // Naming each failure is what makes this debuggable.
            assert.match(error.message, /a-model/);
            assert.match(error.message, /b-model/);
            return true;
        }
    );
});

test('race keeps the fastest and aborts the losers', async () => {
    resetState();
    const plan = [ok('slow'), ok('fast')];
    const aborted = [];

    const { target } = await runOnce(combo('race', 2), plan, {}, (t, signal) => {
        signal?.addEventListener('abort', () => aborted.push(t.provider.id));
        const delay = t.provider.id === 'fast' ? 5 : 200;
        return new Promise((resolve) => setTimeout(() => resolve(t.provider.id), delay));
    });

    assert.equal(target.provider.id, 'fast');
    // Losers must be stopped so they do not keep spending quota.
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(aborted, ['slow']);
});

test('race survives a member failing before the winner answers', async () => {
    resetState();
    const plan = [fails('broken'), ok('good')];
    const { target } = await runOnce(combo('race', 2), plan, {}, async (t) => {
        if (t.provider.id === 'broken') throw new Error('HTTP 500');
        await new Promise((r) => setTimeout(r, 5));
        return 'value';
    });
    assert.equal(target.provider.id, 'good');
});

test('a stream switches members before its first event', async () => {
    resetState();
    const plan = [fails('down'), ok('up')];
    const events = [];

    for await (const { event, target } of runStream(combo('failover', 2), plan, {}, (t) =>
        (async function* attempt() {
            if (t.provider.id === 'down') throw new Error('HTTP 503 unavailable');
            yield { type: 'message_start' };
            yield { type: 'message_stop' };
        })()
    )) {
        events.push({ type: event.type, from: target.provider.id });
    }

    assert.deepEqual(events, [
        { type: 'message_start', from: 'up' },
        { type: 'message_stop', from: 'up' }
    ]);
});

test('a stream does NOT switch members after its first event', async () => {
    resetState();
    // This is the load-bearing guarantee. Once message_start is out, another
    // member taking over would give the client two overlapping messages, so the
    // failure has to surface instead.
    const plan = [fails('breaks-midway'), ok('never-reached')];
    const events = [];

    await assert.rejects(
        (async () => {
            for await (const { event } of runStream(combo('failover', 2), plan, {}, (t) =>
                (async function* attempt() {
                    if (t.provider.id === 'breaks-midway') {
                        yield { type: 'message_start' };
                        throw new Error('HTTP 503 unavailable');
                    }
                    yield { type: 'message_start' };
                })()
            )) {
                events.push(event.type);
            }
        })(),
        /failed mid-stream/
    );

    // The client got exactly what the first member produced, and nothing from
    // a replacement.
    assert.deepEqual(events, ['message_start']);
});

test('validation rejects names that would hijack something', () => {
    // Shadowing a real model would silently redirect it.
    assert.match(
        validateCombo({ name: 'claude-sonnet-4-5', strategy: 'failover', members: [{ model: 'auto' }] }).join(' '),
        /already a model on kiro/
    );
    // Shadowing a provider slug would make `provider/model` ambiguous.
    assert.match(
        validateCombo({ name: 'kiro', strategy: 'failover', members: [{ model: 'auto' }] }).join(' '),
        /is a provider name/
    );
    assert.match(
        validateCombo({ name: 'combo', strategy: 'failover', members: [{ model: 'auto' }] }).join(' '),
        /reserved/
    );
    for (const bad of ['-leading', 'trailing-', 'has space', '', 'under_score']) {
        assert.ok(
            validateCombo({ name: bad, strategy: 'failover', members: [{ model: 'auto' }] }).length > 0,
            `"${bad}" should be rejected`
        );
    }

    // Case is normalised rather than rejected, matching how lookups work.
    assert.deepEqual(
        validateCombo({ name: 'MixedCase', strategy: 'failover', members: [{ model: 'auto' }] }),
        [],
        'mixed case is accepted and lowercased'
    );
});

test('validation checks strategy, members, and duplicates', () => {
    assert.match(
        validateCombo({ name: 'ok-name', strategy: 'nope', members: [{ model: 'auto' }] }).join(' '),
        /Strategy must be one of/
    );
    assert.match(
        validateCombo({ name: 'ok-name', strategy: 'failover', members: [] }).join(' '),
        /at least one member/
    );
    assert.match(
        validateCombo({ name: 'ok-name', strategy: 'failover', members: [{ model: 'nope-model' }] }).join(' '),
        /not a model this proxy serves/
    );
    assert.match(
        validateCombo({
            name: 'ok-name', strategy: 'failover',
            members: [{ model: 'auto' }, { model: 'auto' }]
        }).join(' '),
        /listed twice/
    );
    // race and load-balance are meaningless with one member; say so rather than
    // silently behaving like failover.
    for (const strategy of ['race', 'load-balance']) {
        assert.match(
            validateCombo({ name: 'ok-name', strategy, members: [{ model: 'auto' }] }).join(' '),
            /at least two members/
        );
    }
    // All problems are collected, not just the first.
    assert.ok(validateCombo({ name: '', strategy: 'nope', members: [] }).length >= 3);
});

test('combos cannot nest', () => {
    saveCombo({ name: 'inner', strategy: 'failover', members: [{ model: 'auto' }] });
    const problems = validateCombo({
        name: 'outer', strategy: 'failover', members: [{ model: 'inner' }]
    });
    assert.match(problems.join(' '), /combos cannot contain other combos/);
    // Also via the explicit namespace.
    assert.match(
        validateCombo({ name: 'outer', strategy: 'failover', members: [{ model: 'combo/inner' }] }).join(' '),
        /combos cannot contain other combos/
    );
    deleteCombo('inner');
});

test('save, read, and delete round-trip', () => {
    const saved = saveCombo({
        name: 'mix', strategy: 'failover',
        members: [{ model: 'auto' }, { model: 'google/gemini-3-flash' }]
    });
    assert.equal(saved.name, 'mix');
    assert.equal(saved.members.length, 2);
    assert.ok(saved.created_at && saved.updated_at);

    assert.equal(getCombo('mix')?.strategy, 'failover');
    // Names are case-insensitive.
    assert.equal(getCombo('MIX')?.name, 'mix');

    // Replacing keeps the original creation time.
    const updated = saveCombo(
        { name: 'mix', strategy: 'race', members: [{ model: 'auto' }, { model: 'google/gemini-3-flash' }] },
        { existingName: 'mix' }
    );
    assert.equal(updated.strategy, 'race');
    assert.equal(updated.created_at, saved.created_at);
    assert.equal(listCombos().filter((c) => c.name === 'mix').length, 1, 'no duplicate');

    assert.equal(deleteCombo('mix'), true);
    assert.equal(deleteCombo('mix'), false, 'deleting twice is not an error');
    assert.equal(getCombo('mix'), null);
});

test('resolveTarget tells a combo from a single model', () => {
    saveCombo({
        name: 'pair', strategy: 'failover',
        members: [{ model: 'google/gemini-3-flash' }, { model: 'kiro/claude-haiku-4-5' }]
    });

    const single = resolveTarget('claude-opus-4-8');
    assert.equal(single.kind, 'single');
    assert.equal(single.provider.id, 'kiro');

    for (const id of ['pair', 'combo/pair', 'PAIR']) {
        const target = resolveTarget(id);
        assert.equal(target.kind, 'combo', `${id} should resolve to a combo`);
        assert.equal(target.plan.length, 2);
        // Members are resolved to real providers, in listed order.
        assert.deepEqual(target.plan.map((t) => t.provider.id), ['google', 'kiro']);
    }

    // A named-but-missing combo must not fall through to model resolution.
    assert.throws(() => resolveTarget('combo/absent'), /Unknown combo "absent"/);
    assert.throws(() => resolveTarget(''), /model id is required/);

    deleteCombo('pair');
});

test('combos are listed as models, and degradation is visible', () => {
    saveCombo({ name: 'listed', strategy: 'router', members: [{ model: 'auto' }, { model: 'google/gemini-3-flash' }] });
    const [entry] = comboModelEntries(listCombos().filter((c) => c.name === 'listed'));

    assert.equal(entry.id, 'listed');
    assert.equal(entry.provider, 'combo');
    assert.equal(entry.namespaced_id, 'combo/listed');
    assert.equal(entry.status, 'active');
    // Cost depends on which member answers, so no single figure would be honest.
    assert.equal(entry.cost_multiplier, null);
    assert.deepEqual(entry.combo.members, ['auto', 'google/gemini-3-flash']);
    assert.match(entry.description, /router/);

    deleteCombo('listed');
});

test('every strategy is reachable by name', () => {
    assert.deepEqual(COMBO_STRATEGIES, ['failover', 'load-balance', 'router', 'race']);
    for (const strategy of COMBO_STRATEGIES) {
        const { order } = planAttempts(combo(strategy), [ok('a'), ok('b')], { messages: [] });
        assert.ok(order.length >= 1, `${strategy} must produce an order`);
    }
});

test('a combo name may carry a dotted version', () => {
    // Model ids use dots (minimax-m2.5, deepseek-3.2, and every Kiro upstream id
    // such as claude-sonnet-4.6), so the naming rule has to allow them or it
    // contradicts the catalog it is validated against.
    assert.deepEqual(
        validateCombo({
            name: 'sonnet-pool-4.6',
            strategy: 'failover',
            members: [{ model: 'auto' }]
        }),
        []
    );
});

test('a dotted name that is a Kiro upstream alias is refused as a combo name', () => {
    // claude-sonnet-4.6 is the upstream id behind claude-sonnet-4-6, so it already
    // resolves to a model. Letting a combo take it would shadow that model.
    assert.match(
        validateCombo({
            name: 'claude-sonnet-4.6',
            strategy: 'failover',
            members: [{ model: 'auto' }]
        }).join(' '),
        /already a model/
    );
});

test('a combo name still cannot start or end with a separator', () => {
    // Guards the path-ish shapes: a bare traversal, and dangling separators.
    for (const bad of ['..', '.combo', 'combo.', '-combo', 'combo-', 'a/b']) {
        assert.ok(
            validateCombo({ name: bad, strategy: 'failover', members: [{ model: 'auto' }] }).length > 0,
            `expected "${bad}" to be rejected`
        );
    }
});

test('a dotted combo name that matches a real model is still refused', () => {
    // Widening the pattern must not open a way to shadow a catalog entry.
    assert.match(
        validateCombo({ name: 'minimax-m2.5', strategy: 'failover', members: [{ model: 'auto' }] }).join(' '),
        /already a model/
    );
});

test('the selectable model list carries combos alongside provider models', async () => {
    // The Configure page and /v1/models both read this one list. They used to
    // merge combos separately and the Configure page was missed, so a combo could
    // be created but never chosen. One source means they cannot disagree again.
    const { listSelectableModels } = await import('../src/combos/resolver.js');

    const before = await listSelectableModels();
    const beforeIds = before.data.map((m) => m.id);
    assert.ok(before.object === 'list', 'expected the list envelope to survive');

    saveCombo({
        name: 'selectable-check',
        strategy: 'failover',
        members: [{ model: 'auto' }, { model: 'claude-sonnet-5' }]
    });

    try {
        const after = await listSelectableModels();
        const entry = after.data.find((m) => m.id === 'selectable-check');
        assert.ok(entry, 'expected the combo to appear as a selectable model');
        // Tagged so a caller can group or filter combos without guessing.
        assert.equal(entry.provider, 'combo');
        // Provider models are still all there.
        for (const id of beforeIds) {
            assert.ok(after.data.some((m) => m.id === id), `lost provider model ${id}`);
        }
    } finally {
        deleteCombo('selectable-check');
    }
});

test('a combo target exposes its members as `plan`', () => {
    // The route reads target.plan to log and dispatch. Writing target.members
    // instead crashed every combo request through the OpenAI endpoint, and the
    // translator tests could not catch it because they never touch the route.
    saveCombo({
        name: 'shape-check',
        strategy: 'failover',
        members: [{ model: 'auto' }, { model: 'claude-sonnet-5' }]
    });

    try {
        const target = resolveTarget('shape-check');
        assert.equal(target.kind, 'combo');
        assert.ok(Array.isArray(target.plan), 'members live on `plan`');
        assert.equal(target.plan.length, 2);
        assert.equal(target.combo.strategy, 'failover');
        // Named explicitly: anything reading target.members gets undefined and
        // throws on .length.
        assert.equal(target.members, undefined);
    } finally {
        deleteCombo('shape-check');
    }
});

test('a provider 400 lets the combo try the next member', () => {
    // This cost a working combo. `gemini-3.1-pro-high` was retired upstream and
    // answers a bare 400; the old rule treated any 400 as final on the assumption
    // that every member would reject it identically. Members span providers, so
    // that assumption does not hold — four healthy members were thrown away.
    assert.equal(isRetryable(new Error('Google API error 400: Request contains an invalid argument.')), true);
    assert.equal(isRetryable(new Error('Google API error 400: Invalid value at ...Schema, "array"')), true);
});

test('a mapping mistake is still final', () => {
    // No other member can do better with these, so retrying only wastes quota.
    assert.equal(isRetryable(new Error('kiro does not serve model nope')), false);
    assert.equal(isRetryable(new Error('malformed request body')), false);
});

test('quota errors remain retryable', () => {
    // Guards the original purpose of the list while the 400 rule changed around it.
    assert.equal(isRetryable(new Error('Kiro API error 402: You have reached the limit.')), true);
    assert.equal(isRetryable(new Error('Google quota exhausted (HTTP 429)')), true);
    assert.equal(isRetryable(new Error('Token refresh failed: HTTP 401')), true);
});
