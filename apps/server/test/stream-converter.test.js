import test from 'node:test';
import assert from 'node:assert/strict';

import { AnthropicStreamState } from '../src/providers/kiro/stream-converter.js';
import { buildKiroToolNameMap, toKiroToolName } from '../src/providers/kiro/request-builder.js';

function eventTypes(events) {
    return events.map((event) => event.type);
}

test('emits multiple tool calls with unique block indexes and tool_use stop reason', () => {
    const state = new AnthropicStreamState('claude-sonnet-4-5', 'msg_test');

    const first = state.push({
        toolUse: {
            toolUseId: 'toolu_1',
            name: 'read_file',
            input: { path: 'a.txt' }
        }
    });
    const second = state.push({
        toolUseEvent: {
            toolUseId: 'toolu_2',
            name: 'read_file',
            input: { path: 'b.txt' }
        }
    });
    const final = state.finish();

    assert.deepEqual(eventTypes(first), [
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_stop'
    ]);
    assert.equal(first[1].index, 0);
    assert.deepEqual(first[1].content_block, {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'read_file',
        input: {}
    });
    assert.equal(first[2].delta.type, 'input_json_delta');
    assert.equal(first[2].delta.partial_json, '{"path":"a.txt"}');

    assert.equal(second[0].index, 1);
    assert.equal(second[0].content_block.id, 'toolu_2');
    assert.equal(final[0].delta.stop_reason, 'tool_use');
    assert.deepEqual(eventTypes(final), ['message_delta', 'message_stop']);
});

test('lazily opens text blocks and closes them before a tool block', () => {
    const state = new AnthropicStreamState('claude-sonnet-4-5', 'msg_test');

    const text = state.push({ content: 'Checking' });
    const tool = state.push({
        toolUse: {
            toolUseId: 'toolu_1',
            name: 'read_file',
            input: { path: 'package.json' }
        }
    });
    const afterTool = state.push({ content: 'Done' });
    const final = state.finish();

    assert.deepEqual(eventTypes(text), [
        'message_start',
        'content_block_start',
        'content_block_delta'
    ]);
    assert.equal(text[1].index, 0);
    assert.equal(tool[0].type, 'content_block_stop');
    assert.equal(tool[1].index, 1);
    assert.equal(afterTool[0].index, 2);
    assert.equal(afterTool[0].content_block.type, 'text');
    assert.equal(final[0].type, 'content_block_stop');
    assert.equal(final[1].delta.stop_reason, 'tool_use');
});

test('uses end_turn and final token usage for text-only responses', () => {
    const state = new AnthropicStreamState('claude-sonnet-4-5', 'msg_test');

    state.push({ content: 'Hello' });
    state.push({ tokenUsage: { inputTokens: 12, outputTokens: 4 } });
    const final = state.finish();

    assert.equal(final[1].delta.stop_reason, 'end_turn');
    assert.deepEqual(final[1].usage, { output_tokens: 4 });
    assert.equal(state.inputTokens, 12);
});

test('streams fragmented top-level Kiro tool events as one Anthropic block', () => {
    const state = new AnthropicStreamState('claude-sonnet-4-5', 'msg_test');
    const events = [
        ...state.push({ name: 'echo_value', toolUseId: 'toolu_fragmented' }),
        ...state.push({ input: '{"value":"', name: 'echo_value', toolUseId: 'toolu_fragmented' }),
        ...state.push({ input: 'OK"}', name: 'echo_value', toolUseId: 'toolu_fragmented' }),
        ...state.push({ name: 'echo_value', stop: true, toolUseId: 'toolu_fragmented' }),
        ...state.finish()
    ];

    const starts = events.filter((event) => event.type === 'content_block_start');
    const deltas = events.filter((event) => event.delta?.type === 'input_json_delta');
    const stops = events.filter((event) => event.type === 'content_block_stop');

    assert.equal(starts.length, 1);
    assert.equal(starts[0].content_block.id, 'toolu_fragmented');
    assert.equal(deltas.map((event) => event.delta.partial_json).join(''), '{"value":"OK"}');
    assert.equal(stops.length, 1);
    assert.equal(events.at(-2).delta.stop_reason, 'tool_use');
});

test('restores an aliased Kiro tool name in streaming output', () => {
    const longName = 'mcp__plugin_chrome-devtools-mcp_chrome-devtools__performance_analyze_insight';
    const lookup = buildKiroToolNameMap([{ name: longName }]);
    const state = new AnthropicStreamState('claude-opus-4-8', 'msg_test', lookup);

    const events = state.push({
        toolUseId: 'toolu_long_1',
        name: toKiroToolName(longName),
        input: '{}',
        stop: true
    });
    const start = events.find((event) => event.type === 'content_block_start');

    assert.equal(start.content_block.name, longName);
});
