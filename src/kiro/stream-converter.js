import crypto from 'crypto';
import { normalizeToolInput, restoreAnthropicToolName } from './request-builder.js';

function completeToolInputJson(input) {
    return JSON.stringify(normalizeToolInput(input));
}

/** Stateful converter from Kiro event payloads to Anthropic Messages SSE. */
export class AnthropicStreamState {
    constructor(requestModel, messageId, toolNameMap) {
        this.requestModel = requestModel;
        this.messageId = messageId || `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
        this.toolNameMap = toolNameMap;
        this.started = false;
        this.openBlock = null;
        this.toolBlocks = new Map();
        this.nextBlockIndex = 0;
        this.sawToolUse = false;
        this.inputTokens = 0;
        this.outputTokens = 0;
        this.finished = false;
    }

    start() {
        if (this.started) return [];
        this.started = true;
        return [{
            type: 'message_start',
            message: {
                id: this.messageId,
                type: 'message',
                role: 'assistant',
                model: this.requestModel,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: this.inputTokens, output_tokens: 0 }
            }
        }];
    }

    closeOpenBlock() {
        if (!this.openBlock) return [];
        const event = { type: 'content_block_stop', index: this.openBlock.index };
        this.openBlock = null;
        return [event];
    }

    closeToolBlocks() {
        const events = [];
        for (const tool of this.toolBlocks.values()) {
            events.push({ type: 'content_block_stop', index: tool.index });
        }
        this.toolBlocks.clear();
        return events;
    }

    push(eventData) {
        if (this.finished || !eventData || typeof eventData !== 'object') return [];

        const usage = eventData.metadataEvent?.tokenUsage || eventData.tokenUsage;
        if (usage) {
            this.inputTokens = Number(usage.inputTokens) || this.inputTokens;
            this.outputTokens = Number(usage.outputTokens) || this.outputTokens;
            return [];
        }
        if (eventData.usage !== undefined && eventData.unit !== undefined) return [];

        // This is the shape emitted by the live Kiro endpoint. Input JSON arrives
        // over several events and the final event carries stop:true.
        if (eventData.toolUseId) return this.pushToolFragment(eventData);

        const nested = eventData.assistantResponseEvent;
        const toolUse = eventData.toolUseEvent || eventData.toolUse
            || nested?.toolUseEvent || nested?.toolUse;
        if (toolUse) return this.pushCompleteToolUse(toolUse);

        const content = typeof eventData.content === 'string'
            ? eventData.content
            : typeof nested?.content === 'string' ? nested.content : null;
        if (content !== null && content !== '') return this.pushText(content);
        return [];
    }

    pushText(text) {
        const events = this.start();
        events.push(...this.closeToolBlocks());
        if (!this.openBlock || this.openBlock.type !== 'text') {
            events.push(...this.closeOpenBlock());
            const index = this.nextBlockIndex++;
            this.openBlock = { type: 'text', index };
            events.push({
                type: 'content_block_start',
                index,
                content_block: { type: 'text', text: '' }
            });
        }
        events.push({
            type: 'content_block_delta',
            index: this.openBlock.index,
            delta: { type: 'text_delta', text }
        });
        return events;
    }

    startToolBlock(toolUse) {
        const events = this.start();
        events.push(...this.closeOpenBlock());
        const id = toolUse.toolUseId
            || `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
        const index = this.nextBlockIndex++;
        const tool = {
            id,
            index,
            name: restoreAnthropicToolName(toolUse.name || '', this.toolNameMap)
        };
        this.toolBlocks.set(id, tool);
        this.sawToolUse = true;
        events.push({
            type: 'content_block_start',
            index,
            content_block: { type: 'tool_use', id, name: tool.name, input: {} }
        });
        return { events, tool };
    }

    pushToolFragment(fragment) {
        let tool = this.toolBlocks.get(fragment.toolUseId);
        let events = [];
        if (!tool) {
            const started = this.startToolBlock(fragment);
            events = started.events;
            tool = started.tool;
        }

        if (fragment.input !== undefined && fragment.input !== '') {
            const partialJson = typeof fragment.input === 'string'
                ? fragment.input
                : JSON.stringify(fragment.input);
            events.push({
                type: 'content_block_delta',
                index: tool.index,
                delta: { type: 'input_json_delta', partial_json: partialJson }
            });
        }
        if (fragment.stop) {
            events.push({ type: 'content_block_stop', index: tool.index });
            this.toolBlocks.delete(tool.id);
        }
        return events;
    }

    pushCompleteToolUse(toolUse) {
        const { events, tool } = this.startToolBlock(toolUse);
        events.push({
            type: 'content_block_delta',
            index: tool.index,
            delta: {
                type: 'input_json_delta',
                partial_json: completeToolInputJson(toolUse.input)
            }
        });
        events.push({ type: 'content_block_stop', index: tool.index });
        this.toolBlocks.delete(tool.id);
        return events;
    }

    finish() {
        if (this.finished) return [];
        this.finished = true;
        const events = this.start();
        events.push(...this.closeOpenBlock());
        events.push(...this.closeToolBlocks());
        events.push({
            type: 'message_delta',
            delta: {
                stop_reason: this.sawToolUse ? 'tool_use' : 'end_turn',
                stop_sequence: null
            },
            usage: { output_tokens: this.outputTokens }
        });
        events.push({ type: 'message_stop' });
        return events;
    }
}

export default AnthropicStreamState;
