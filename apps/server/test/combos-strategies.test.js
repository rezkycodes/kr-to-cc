import test from 'node:test';
import assert from 'node:assert/strict';

import { planAttempts, runOnce, runStream } from '../src/combos/strategies.js';

// --- helpers ---

function makeProvider(id) {
    return { id, ownsModel: () => true };
}

function makePlan(...ids) {
    return ids.map((id) => ({ provider: makeProvider(id), modelId: `model-${id}` }));
}

function makeCombo(strategy, name = 'test-combo') {
    return { name, strategy };
}

// --- planAttempts: failover ---

test('failover returns plan in original order, not concurrent', () => {
    const plan = makePlan('a', 'b', 'c');
    const { order, concurrent } = planAttempts(makeCombo('failover'), plan, {});
    assert.deepEqual(order, plan);
    assert.equal(concurrent, false);
});

// --- planAttempts: race ---

test('race returns all members as concurrent', () => {
    const plan = makePlan('a', 'b');
    const { order, concurrent } = planAttempts(makeCombo('race'), plan, {});
    assert.equal(order.length, 2);
    assert.equal(concurrent, true);
});

// --- planAttempts: load-balance ---

test('load-balance rotates starting member across calls', () => {
    const plan = makePlan('a', 'b', 'c');
    const combo = makeCombo('load-balance', 'lb-rotate-test');

    const first = planAttempts(combo, plan, {});
    const second = planAttempts(combo, plan, {});
    const third = planAttempts(combo, plan, {});

    // All members appear in each order
    assert.equal(first.order.length, 3);
    assert.equal(second.order.length, 3);
    // Rotation means the leading member changes
    const leaders = [first.order[0].modelId, second.order[0].modelId, third.order[0].modelId];
    // At least two distinct leaders over three calls (round-robin)
    const unique = new Set(leaders);
    assert.ok(unique.size >= 2, `expected rotation, got: ${leaders.join(', ')}`);
});

test('load-balance is not concurrent', () => {
    const { concurrent } = planAttempts(makeCombo('load-balance', 'lb-conc-test'), makePlan('a', 'b'), {});
    assert.equal(concurrent, false);
});

// --- planAttempts: router ---

test('router picks first member for a light request', () => {
    const plan = makePlan('cheap', 'mid', 'heavy');
    const combo = makeCombo('router');
    // Short message, no tools => light
    const { order } = planAttempts(combo, plan, { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(order[0].provider.id, 'cheap');
});

test('router picks last member for a heavy request with tools', () => {
    const plan = makePlan('cheap', 'mid', 'expensive');
    const combo = makeCombo('router');
    const { order } = planAttempts(combo, plan, {
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'bash' }]
    });
    assert.equal(order[0].provider.id, 'expensive');
});

test('router picks last member for a large message without tools', () => {
    const plan = makePlan('cheap', 'mid', 'expensive');
    const combo = makeCombo('router');
    const { order } = planAttempts(combo, plan, {
        messages: [{ role: 'user', content: 'x'.repeat(25_000) }]
    });
    assert.equal(order[0].provider.id, 'expensive');
});

// --- planAttempts: unknown strategy falls back to sequential ---

test('unknown strategy returns plan in order and not concurrent', () => {
    const plan = makePlan('a', 'b');
    const { order, concurrent } = planAttempts(makeCombo('unknown-strat'), plan, {});
    assert.deepEqual(order, plan);
    assert.equal(concurrent, false);
});

// --- runOnce: failover ---

test('runOnce returns first member result when it succeeds', async () => {
    const plan = makePlan('a', 'b');
    const combo = makeCombo('failover', 'fo-success');
    const attempt = async (target) => ({ answer: target.provider.id });

    const { result, target } = await runOnce(combo, plan, {}, attempt);
    assert.equal(result.answer, 'a');
    assert.equal(target.provider.id, 'a');
});

test('runOnce falls through to second member on retryable error', async () => {
    const plan = makePlan('a', 'b');
    const combo = makeCombo('failover', 'fo-fallthrough');
    let calls = 0;
    const attempt = async (target) => {
        calls++;
        if (target.provider.id === 'a') throw new Error('429 rate limit');
        return { answer: target.provider.id };
    };

    const { result } = await runOnce(combo, plan, {}, attempt);
    assert.equal(result.answer, 'b');
    assert.equal(calls, 2);
});

test('runOnce throws immediately on non-retryable error', async () => {
    // Only a mapping mistake or an unparseable body is final now. A bare provider
    // 400 used to be treated as final too, on the assumption that every member
    // would reject it identically — wrong once members span providers, where a
    // retired id or a backend-specific schema rule surfaces the same way.
    const plan = makePlan('a', 'b');
    const combo = makeCombo('failover', 'fo-nonretryable');
    let calls = 0;
    const attempt = async () => {
        calls++;
        throw new Error('kiro does not serve model nope');
    };

    await assert.rejects(() => runOnce(combo, plan, {}, attempt), /does not serve model/);
    assert.equal(calls, 1, 'should not retry on non-retryable error');
});

test('runOnce moves past a provider 400 to the next member', async () => {
    // The case that cost a working combo: member one was retired upstream and
    // answered a plain 400, so the whole request failed with four healthy members
    // left untried.
    const plan = makePlan('retired', 'healthy');
    const combo = makeCombo('failover', 'fo-provider-400');
    const tried = [];
    const attempt = async (member) => {
        tried.push(member.modelId);
        if (member.modelId === 'model-retired') {
            throw new Error('Google API error 400: Request contains an invalid argument.');
        }
        return { ok: true };
    };

    const outcome = await runOnce(combo, plan, {}, attempt);
    assert.deepEqual(outcome.result, { ok: true });
    // Both were tried, in order, and the healthy one answered.
    assert.deepEqual(tried, ['model-retired', 'model-healthy']);
});

test('runOnce throws after exhausting all members', async () => {
    const plan = makePlan('a', 'b');
    const combo = makeCombo('failover', 'fo-exhaust');
    const attempt = async () => { throw new Error('quota exhausted'); };

    await assert.rejects(
        () => runOnce(combo, plan, {}, attempt),
        /exhausted every member/
    );
});

// --- runOnce: race ---

test('runOnce race returns fastest successful result', async () => {
    const plan = makePlan('slow', 'fast');
    const combo = makeCombo('race', 'race-test');

    const attempt = async (target) => {
        if (target.provider.id === 'slow') {
            await new Promise((r) => setTimeout(r, 50));
        }
        return { winner: target.provider.id };
    };

    const { result } = await runOnce(combo, plan, {}, attempt);
    assert.equal(result.winner, 'fast');
});

// --- runStream: failover ---

test('runStream yields events from first working member', async () => {
    const plan = makePlan('a', 'b');
    const combo = makeCombo('failover', 'stream-ok');

    // attempt must return an async iterable directly (not a Promise<AsyncIterable>)
    async function* attempt() {
        yield { type: 'message_start' };
        yield { type: 'message_stop' };
    }

    const events = [];
    // runStream yields {event, target} pairs
    for await (const { event } of runStream(combo, plan, {}, attempt)) {
        events.push(event);
    }

    assert.equal(events[0].type, 'message_start');
    assert.equal(events[events.length - 1].type, 'message_stop');
});

test('runStream falls through to next member on pre-first-event error', async () => {
    const plan = makePlan('a', 'b');
    const combo = makeCombo('failover', 'stream-fallthrough2');

    async function* attempt(target) {
        if (target.provider.id === 'a') throw new Error('502 unavailable');
        yield { type: 'message_start' };
        yield { type: 'message_stop' };
    }

    const events = [];
    for await (const { event } of runStream(combo, plan, {}, attempt)) {
        events.push(event);
    }

    assert.ok(events.length > 0);
    assert.equal(events[0].type, 'message_start');
});
