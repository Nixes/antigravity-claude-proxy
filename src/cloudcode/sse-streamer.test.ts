import { describe, it, expect } from 'vitest';
import { streamSSEResponse } from './sse-streamer.js';

function sseResponse(chunks: unknown[]): Response {
    const encoder = new TextEncoder();
    const payload = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('');
    let sent = false;
    return {
        body: {
            getReader: () => ({
                read: async () => {
                    if (sent) return { done: true, value: undefined };
                    sent = true;
                    return { done: false, value: encoder.encode(payload) };
                }
            })
        }
    } as unknown as Response;
}

interface SseUsageEvent {
    type: string;
    usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
    };
    message?: {
        usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
        };
    };
}

describe('streamSSEResponse usage accounting (#406)', () => {
    it('emits authoritative uncached input_tokens in message_delta and includes thoughtsTokenCount in output_tokens', async () => {
        const response = sseResponse([
            {
                response: {
                    candidates: [{ content: { parts: [{ text: 'Thinking...', thought: true }] } }],
                    usageMetadata: { promptTokenCount: 136389, candidatesTokenCount: 50, thoughtsTokenCount: 200 }
                }
            },
            {
                response: {
                    candidates: [{ content: { parts: [{ text: 'Final answer.' }] }, finishReason: 'STOP' }],
                    usageMetadata: {
                        promptTokenCount: 136389,
                        cachedContentTokenCount: 130467,
                        candidatesTokenCount: 1411,
                        thoughtsTokenCount: 989
                    }
                }
            }
        ]);

        const events: SseUsageEvent[] = [];
        for await (const ev of streamSSEResponse(response, 'gemini-3.8-flash-tiered')) {
            events.push(ev as SseUsageEvent);
        }

        const msgStart = events.find(e => e.type === 'message_start');
        expect(msgStart?.message?.usage?.input_tokens).toBe(136389);

        const msgDelta = events.find(e => e.type === 'message_delta');
        expect(msgDelta?.usage?.input_tokens).toBe(136389 - 130467);
        expect(msgDelta?.usage?.cache_read_input_tokens).toBe(130467);
        expect(msgDelta?.usage?.output_tokens).toBe(1411 + 989);
    });

    it('clamps input_tokens at 0 when cachedContentTokenCount exceeds promptTokenCount', async () => {
        const response = sseResponse([
            {
                response: {
                    candidates: [{ content: { parts: [{ text: 'Ok' }] }, finishReason: 'STOP' }],
                    usageMetadata: {
                        promptTokenCount: 100,
                        cachedContentTokenCount: 150,
                        candidatesTokenCount: 5
                    }
                }
            }
        ]);

        const events: SseUsageEvent[] = [];
        for await (const ev of streamSSEResponse(response, 'claude-sonnet-4-6')) {
            events.push(ev as SseUsageEvent);
        }

        const msgDelta = events.find(e => e.type === 'message_delta');
        expect(msgDelta?.usage?.input_tokens).toBe(0);
        expect(msgDelta?.usage?.output_tokens).toBe(5);
    });
});
