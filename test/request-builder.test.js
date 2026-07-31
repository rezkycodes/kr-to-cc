import test from 'node:test';
import assert from 'node:assert/strict';

import { buildKiroRequest } from '../src/kiro/request-builder.js';

const tools = [
    {
        name: 'read_file',
        description: 'Read a file',
        input_schema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path']
        }
    }
];

test('maps Anthropic tools and tool results to native Kiro fields', () => {
    const request = buildKiroRequest({
        model: 'claude-sonnet-4-5',
        system: [{ type: 'text', text: 'You are a coding agent.' }],
        tools,
        messages: [
            { role: 'user', content: 'Inspect package.json' },
            {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'I will inspect it.' },
                    {
                        type: 'tool_use',
                        id: 'toolu_read_1',
                        name: 'read_file',
                        input: { path: 'package.json' }
                    }
                ]
            },
            {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 'toolu_read_1',
                        content: [{ type: 'text', text: '{"name":"demo"}' }]
                    }
                ]
            }
        ]
    }, { profileArn: 'arn:example' });

    const current = request.conversationState.currentMessage.userInputMessage;
    assert.equal(current.content, 'continue');
    assert.deepEqual(current.userInputMessageContext.tools, [
        {
            toolSpecification: {
                name: 'read_file',
                description: 'Read a file',
                inputSchema: { json: tools[0].input_schema }
            }
        }
    ]);
    assert.deepEqual(current.userInputMessageContext.toolResults, [
        {
            toolUseId: 'toolu_read_1',
            status: 'success',
            content: [{ text: '{"name":"demo"}' }]
        }
    ]);

    assert.deepEqual(request.conversationState.history, [
        {
            userInputMessage: {
                content: 'You are a coding agent.\n\nInspect package.json',
                modelId: 'claude-sonnet-4.5'
            }
        },
        {
            assistantResponseMessage: {
                content: 'I will inspect it.',
                toolUses: [
                    {
                        toolUseId: 'toolu_read_1',
                        name: 'read_file',
                        input: { path: 'package.json' }
                    }
                ]
            }
        }
    ]);
});

test('maps failed tool results and preserves user text', () => {
    const request = buildKiroRequest({
        model: 'claude-sonnet-4-5',
        tools,
        messages: [
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'The command failed.' },
                    {
                        type: 'tool_result',
                        tool_use_id: 'toolu_bash_1',
                        is_error: true,
                        content: 'permission denied'
                    }
                ]
            }
        ]
    });

    const current = request.conversationState.currentMessage.userInputMessage;
    assert.equal(current.content, 'The command failed.');
    assert.deepEqual(current.userInputMessageContext.toolResults, [
        {
            toolUseId: 'toolu_bash_1',
            status: 'error',
            content: [{ text: 'permission denied' }]
        }
    ]);
});

test('omits tools when Anthropic tool_choice is none', () => {
    const request = buildKiroRequest({
        model: 'claude-sonnet-4-5',
        tools,
        tool_choice: { type: 'none' },
        messages: [{ role: 'user', content: 'Answer without tools.' }]
    });

    const context = request.conversationState.currentMessage.userInputMessage.userInputMessageContext;
    assert.equal(context.tools, undefined);
});

test('merges adjacent roles without losing native tool metadata', () => {
    const request = buildKiroRequest({
        model: 'claude-sonnet-4-5',
        messages: [
            { role: 'user', content: 'first' },
            { role: 'user', content: 'second' },
            {
                role: 'assistant',
                content: [{
                    type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a' }
                }]
            },
            {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }]
            }
        ],
        tools
    });

    assert.equal(request.conversationState.history[0].userInputMessage.content, 'first\nsecond');
    assert.equal(
        request.conversationState.history[1].assistantResponseMessage.toolUses[0].toolUseId,
        'toolu_1'
    );
});

test('preserves the system prompt for an assistant-only request', () => {
    const request = buildKiroRequest({
        model: 'claude-sonnet-4-5',
        system: 'system instruction',
        messages: [{ role: 'assistant', content: 'prefill' }]
    });

    assert.equal(
        request.conversationState.currentMessage.userInputMessage.content,
        'system instruction\n\nprefill'
    );
});
