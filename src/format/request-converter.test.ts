import { describe, it, expect } from 'vitest';
import { convertAnthropicToGoogle } from './request-converter.js';

describe('convertAnthropicToGoogle', () => {
    it('converts basic message', () => {
        const req = {
            model: 'claude-3-5-sonnet',
            messages: [{ role: 'user', content: 'hello' }]
        };

        const result = convertAnthropicToGoogle(req);

        expect(result.contents).toEqual([
            { role: 'user', parts: [{ text: 'hello' }] }
        ]);
    });

    it('preserves tool usage and results sequentially', () => {
        const req = {
            model: 'gemini-2.5-pro',
            messages: [
                { role: 'user', content: 'what is the weather?' },
                { 
                    role: 'assistant', 
                    content: [
                        { type: 'text', text: 'Let me check.' },
                        { type: 'tool_use', id: 'call_abc', name: 'get_weather', input: { loc: 'NY' } }
                    ]
                },
                {
                    role: 'user',
                    content: [
                        { type: 'tool_result', tool_use_id: 'call_abc', content: 'It is sunny.' }
                    ]
                }
            ]
        };

        const result = convertAnthropicToGoogle(req);

        expect(result.contents[1].parts).toEqual([
            { text: 'Let me check.' },
            { 
                functionCall: { name: 'get_weather', args: { loc: 'NY' } },
                thoughtSignature: 'skip_thought_signature_validator' // GEMINI_SKIP_SIGNATURE
            }
        ]);

        // Tool result MUST use the mapped name from the previous assistant message
        expect(result.contents[2].parts).toEqual([
            { functionResponse: { name: 'get_weather', response: { result: 'It is sunny.' } } }
        ]);
    });

    describe('Google Search Grounding', () => {
        it('injects googleSearch tool for Gemini models when requested', () => {
            const req = {
                model: 'gemini-2.5-pro',
                messages: [{ role: 'user', content: 'hello' }],
                google_search: true
            };
            const result = convertAnthropicToGoogle(req);
            expect(result.tools).toBeDefined();
            expect(result.tools).toContainEqual({ googleSearch: {} });
        });

        it('does not inject googleSearch tool for Claude models', () => {
            const req = {
                model: 'claude-3-5-sonnet',
                messages: [{ role: 'user', content: 'hello' }],
                google_search: true
            };
            const result = convertAnthropicToGoogle(req);
            expect(result.tools).toBeUndefined();
        });

        it('does not inject googleSearch tool if google_search is false or omitted', () => {
            const req = {
                model: 'gemini-2.5-pro',
                messages: [{ role: 'user', content: 'hello' }]
            };
            const result = convertAnthropicToGoogle(req);
            expect(result.tools).toBeUndefined();
        });

        it('appends googleSearch tool alongside existing functionDeclarations', () => {
            const req = {
                model: 'gemini-2.5-pro',
                messages: [{ role: 'user', content: 'hello' }],
                google_search: true,
                tools: [{ name: 'my_tool', description: 'desc', input_schema: { type: 'object' } }]
            };
            const result = convertAnthropicToGoogle(req);
            expect(result.tools).toHaveLength(2);
            expect(result.tools?.[0]).toHaveProperty('functionDeclarations');
            expect(result.tools?.[1]).toEqual({ googleSearch: {} });
        });
    });
});
