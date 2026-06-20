import { describe, it, expect } from 'vitest';
import { streamSSEResponse } from './sse-streamer.js';

describe('streamSSEResponse grounding', () => {
    it('yields footnotes blocks when groundingMetadata is present', async () => {
        // Mock a response object with a stream reader
        const chunks = [
            {
                candidates: [{
                    content: { parts: [{ text: 'Hello' }] }
                }]
            },
            {
                candidates: [{
                    finishReason: 'STOP',
                    groundingMetadata: {
                        groundingChunks: [{ web: { uri: 'https://example.com', title: 'Example' } }]
                    }
                }]
            }
        ];

        let chunkIndex = 0;
        const reader = {
            read: async () => {
                if (chunkIndex < chunks.length) {
                    const data = `data: ${JSON.stringify(chunks[chunkIndex])}\n\n`;
                    chunkIndex++;
                    return { done: false, value: new TextEncoder().encode(data) };
                }
                return { done: true, value: undefined };
            }
        };

        const mockResponse = { body: { getReader: () => reader } };

        const generator = streamSSEResponse(mockResponse, 'gemini-2.5-pro');
        const events = [];
        for await (const event of generator) {
            events.push(event);
        }

        // message_start, content_block_start(text), content_block_delta(text), content_block_stop
        // content_block_start(text for footnotes), content_block_delta, content_block_stop
        // message_delta, message_stop
        
        const footnoteDeltas = events.filter(e => 
            e.type === 'content_block_delta' && 
            e.delta.text && 
            e.delta.text.includes('Search Sources:')
        );

        expect(footnoteDeltas).toHaveLength(1);
        expect(footnoteDeltas[0].delta.text).toContain('[Example](https://example.com)');
    });
});
