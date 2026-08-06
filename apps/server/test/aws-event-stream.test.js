import test from 'node:test';
import assert from 'node:assert/strict';

import { extractContentFromEvents } from '../src/providers/kiro/aws-event-stream.js';

test('extracts native tool uses and parses JSON string input', () => {
    const extracted = extractContentFromEvents([
        { content: 'Let me inspect it.' },
        {
            toolUse: {
                toolUseId: 'toolu_1',
                name: 'read_file',
                input: '{"path":"package.json"}'
            }
        }
    ]);

    assert.equal(extracted.content, 'Let me inspect it.');
    assert.deepEqual(extracted.toolUses, [
        {
            id: 'toolu_1',
            name: 'read_file',
            input: { path: 'package.json' }
        }
    ]);
});

test('assembles fragmented native Kiro tool input events', () => {
    const extracted = extractContentFromEvents([
        { name: 'echo_value', toolUseId: 'toolu_2' },
        { input: '', name: 'echo_value', toolUseId: 'toolu_2' },
        { input: '{"value":"', name: 'echo_value', toolUseId: 'toolu_2' },
        { input: 'KIRO_TOOL_OK', name: 'echo_value', toolUseId: 'toolu_2' },
        { input: '"}', name: 'echo_value', toolUseId: 'toolu_2' },
        { name: 'echo_value', stop: true, toolUseId: 'toolu_2' }
    ]);

    assert.deepEqual(extracted.toolUses, [{
        id: 'toolu_2',
        name: 'echo_value',
        input: { value: 'KIRO_TOOL_OK' }
    }]);
});
