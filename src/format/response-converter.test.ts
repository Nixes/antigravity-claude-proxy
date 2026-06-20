import { describe, it, expect } from 'vitest';
import { convertGoogleToAnthropic } from './response-converter.js';

describe('convertGoogleToAnthropic', () => {
    it('converts basic text response', () => {
        const googleResponse = {
            candidates: [{
                content: { parts: [{ text: 'hello' }] },
                finishReason: 'STOP'
            }]
        };

        const result = convertGoogleToAnthropic(googleResponse, 'gemini-2.5-pro');

        expect(result.content).toEqual([{ type: 'text', text: 'hello' }]);
        expect(result.stop_reason).toBe('end_turn');
    });

    describe('Google Search Grounding', () => {
        it('appends footnotes to the last text block if groundingMetadata is present', () => {
            const googleResponse = {
                candidates: [{
                    content: { parts: [{ text: 'The capital is Paris.' }] },
                    finishReason: 'STOP',
                    groundingMetadata: {
                        groundingChunks: [
                            { web: { uri: 'https://example.com', title: 'Example' } }
                        ]
                    }
                }]
            };

            const result = convertGoogleToAnthropic(googleResponse, 'gemini-2.5-pro');

            expect(result.content).toHaveLength(1);
            expect(result.content[0]).toEqual({
                type: 'text',
                text: 'The capital is Paris.\n\n---\n**Search Sources:**\n1. [Example](https://example.com)'
            });
        });

        it('does not append footnotes if groundingChunks is empty', () => {
            const googleResponse = {
                candidates: [{
                    content: { parts: [{ text: 'Hello' }] },
                    finishReason: 'STOP',
                    groundingMetadata: { groundingChunks: [] }
                }]
            };

            const result = convertGoogleToAnthropic(googleResponse, 'gemini-2.5-pro');

            expect(result.content).toEqual([{ type: 'text', text: 'Hello' }]);
        });

        it('creates a new text block for footnotes if only tool_use blocks exist', () => {
            const googleResponse = {
                candidates: [{
                    content: { parts: [{ functionCall: { name: 'get_weather', args: {} } }] },
                    finishReason: 'TOOL_USE',
                    groundingMetadata: {
                        groundingChunks: [
                            { web: { uri: 'https://example.com', title: 'Example' } }
                        ]
                    }
                }]
            };

            const result = convertGoogleToAnthropic(googleResponse, 'gemini-2.5-pro');

            expect(result.content).toHaveLength(2);
            expect(result.content[0].type).toBe('tool_use');
            expect(result.content[1]).toEqual({
                type: 'text',
                text: '\n\n---\n**Search Sources:**\n1. [Example](https://example.com)'
            });
        });
    });
});
