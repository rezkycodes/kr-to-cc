/**
 * OpenAI translation tests.
 *
 * Pure translation, so these run without a network or an account. The cases are
 * the places the two formats disagree — everything else is a straight copy.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    anthropicToOpenai,
    createOpenaiStreamTranslator,
    openaiToAnthropic
} from '../src/openai/translate.js';

test('system messages become the top-level system prompt', () => {
    // OpenAI carries them inside `messages`; Anthropic takes one string.
    const { request } = openaiToAnthropic({
        model: 'm',
        messages: [
            { role: 'system', content: 'Be terse.' },
            { role: 'developer', content: 'Prefer bullet points.' },
            { role: 'user', content: 'hi' }
        ]
    });

    assert.equal(request.system, 'Be terse.\n\nPrefer bullet points.');
    // They must not remain as turns, or the model sees them twice.
    assert.deepEqual(request.messages, [{ role: 'user', content: 'hi' }]);
});

test('a tool result becomes a tool_result block on a user turn', () => {
    // Anthropic has no `tool` role, and rejects the block on an assistant turn.
    const { request } = openaiToAnthropic({
        model: 'm',
        messages: [
            { role: 'user', content: 'time?' },
            {
                role: 'assistant',
                tool_calls: [
                    { id: 'call_1', type: 'function', function: { name: 'get_time', arguments: '{"tz":"UTC"}' } }
                ]
            },
            { role: 'tool', tool_call_id: 'call_1', content: '06:40' }
        ]
    });

    const assistant = request.messages[1];
    assert.equal(assistant.role, 'assistant');
    assert.deepEqual(assistant.content[0], {
        type: 'tool_use',
        id: 'call_1',
        name: 'get_time',
        // The JSON string is parsed into an object.
        input: { tz: 'UTC' }
    });

    const result = request.messages[2];
    assert.equal(result.role, 'user');
    assert.equal(result.content[0].type, 'tool_result');
    assert.equal(result.content[0].tool_use_id, 'call_1');
});

test('malformed tool arguments are preserved rather than dropped', () => {
    // The model produced them, so it should be able to see what it produced.
    const { request } = openaiToAnthropic({
        model: 'm',
        messages: [
            { role: 'user', content: 'x' },
            {
                role: 'assistant',
                tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{not json' } }]
            }
        ]
    });

    assert.equal(request.messages[1].content[0].input._raw_arguments, '{not json');
});

test('tool declarations and tool_choice are translated', () => {
    const { request } = openaiToAnthropic({
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
        tools: [
            {
                type: 'function',
                function: { name: 'f', description: 'd', parameters: { type: 'object', properties: {} } }
            }
        ],
        tool_choice: 'required'
    });

    assert.deepEqual(request.tools, [
        { name: 'f', description: 'd', input_schema: { type: 'object', properties: {} } }
    ]);
    // OpenAI's "required" is Anthropic's "any".
    assert.deepEqual(request.tool_choice, { type: 'any' });
});

test('max_tokens is supplied because Anthropic requires it', () => {
    // OpenAI treats it as optional; without a default the upstream would reject.
    const { request } = openaiToAnthropic({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(request.max_tokens, 4096);

    const newer = openaiToAnthropic({
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
        max_completion_tokens: 64
    });
    assert.equal(newer.request.max_tokens, 64);
});

test('a data-url image is forwarded and a remote one is not', () => {
    // Anthropic takes base64 bytes; it will not fetch a link on our behalf, so
    // passing a URL through would fail upstream instead of here.
    const { request } = openaiToAnthropic({
        model: 'm',
        messages: [
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'look' },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
                    { type: 'image_url', image_url: { url: 'https://example.com/a.png' } }
                ]
            }
        ]
    });

    const blocks = request.messages[0].content;
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks[1].source, { type: 'base64', media_type: 'image/png', data: 'AAA' });
});

test('an empty or malformed request is reported, not passed on', () => {
    assert.ok(openaiToAnthropic(null).problems.length > 0);
    assert.ok(openaiToAnthropic({ model: 'm' }).problems.length > 0);
    assert.ok(openaiToAnthropic({ model: 'm', messages: [] }).problems.length > 0);
});

test('a response with tool calls reports finish_reason tool_calls', () => {
    const completion = anthropicToOpenai(
        {
            id: 'msg_1',
            content: [{ type: 'tool_use', id: 'tu_1', name: 'f', input: { a: 1 } }],
            stop_reason: 'tool_use',
            usage: { input_tokens: 10, output_tokens: 5 }
        },
        'my-model'
    );

    assert.equal(completion.object, 'chat.completion');
    assert.equal(completion.model, 'my-model');
    assert.equal(completion.choices[0].finish_reason, 'tool_calls');
    // Null, not '', when the turn is only tool calls — matching OpenAI itself.
    assert.equal(completion.choices[0].message.content, null);
    assert.equal(completion.choices[0].message.tool_calls[0].function.arguments, '{"a":1}');
    assert.deepEqual(completion.usage, {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15
    });
});

test('stop reasons map to OpenAI finish reasons', () => {
    const reason = (stop) =>
        anthropicToOpenai({ content: [{ type: 'text', text: 'x' }], stop_reason: stop }, 'm')
            .choices[0].finish_reason;

    assert.equal(reason('end_turn'), 'stop');
    assert.equal(reason('max_tokens'), 'length');
    assert.equal(reason('tool_use'), 'tool_calls');
    // An unknown reason falls back rather than leaking an Anthropic-only value.
    assert.equal(reason('something_new'), 'stop');
});

test('the stream translator emits a role chunk, deltas, then a finish reason', () => {
    const translator = createOpenaiStreamTranslator('m');

    const start = translator.translate({ type: 'message_start' });
    assert.equal(start[0].choices[0].delta.role, 'assistant');

    const text = translator.translate({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hi' }
    });
    assert.equal(text[0].choices[0].delta.content, 'hi');
    assert.equal(text[0].object, 'chat.completion.chunk');

    const done = translator.translate({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });
    assert.equal(done[0].choices[0].finish_reason, 'stop');
});

test('a streamed tool call sends its name first, then its arguments', () => {
    // OpenAI expects the name on the first chunk of a call; Anthropic announces it
    // in content_block_start and streams the arguments separately.
    const translator = createOpenaiStreamTranslator('m');
    translator.translate({ type: 'message_start' });

    const started = translator.translate({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'tu_1', name: 'f' }
    });
    const call = started[0].choices[0].delta.tool_calls[0];
    assert.equal(call.index, 0);
    assert.equal(call.id, 'tu_1');
    assert.equal(call.function.name, 'f');
    assert.equal(call.function.arguments, '');

    const args = translator.translate({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"a":' }
    });
    assert.equal(args[0].choices[0].delta.tool_calls[0].function.arguments, '{"a":');
    // The index has to match the opening chunk so the client appends correctly.
    assert.equal(args[0].choices[0].delta.tool_calls[0].index, 0);
});

test('thinking deltas produce no chunk', () => {
    // OpenAI has no field for them; inventing one would confuse a strict client.
    const translator = createOpenaiStreamTranslator('m');
    const out = translator.translate({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'hmm' }
    });
    assert.deepEqual(out, []);
});
