import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { convertAnthropicToGoogle } from './request-converter.js';
import { config } from '../config.js';

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
        it('injects googleSearch tool and includeServerSideToolInvocations for Gemini models when requested', () => {
            const req = {
                model: 'gemini-2.5-pro',
                messages: [{ role: 'user', content: 'hello' }],
                google_search: true
            };
            const result = convertAnthropicToGoogle(req);
            expect(result.tools).toBeDefined();
            expect(result.tools).toContainEqual({ googleSearch: {} });
            expect(result.toolConfig?.include_server_side_tool_invocations).toBe(true);
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
            expect(result.toolConfig?.include_server_side_tool_invocations).toBe(true);
        });

        it('injects googleSearch when config.forceGoogleSearch is true', () => {
            const originalForce = config.forceGoogleSearch;
            config.forceGoogleSearch = true;
            try {
                const req = {
                    model: 'gemini-2.5-pro',
                    messages: [{ role: 'user', content: 'hello' }]
                };
                const result = convertAnthropicToGoogle(req);
                expect(result.tools).toBeDefined();
                expect(result.tools).toContainEqual({ googleSearch: {} });
                expect(result.toolConfig?.include_server_side_tool_invocations).toBe(true);
            } finally {
                config.forceGoogleSearch = originalForce;
            }
        });
    });

    describe('Billing header stripping (#375)', () => {
        const HEADER = 'x-anthropic-billing-header: cc_version=2.1.274.834; cc_entrypoint=sdk-cli;';
        const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

        const systemTexts = (system: string | Array<{ type: string; text: string }>) => {
            const result = convertAnthropicToGoogle({
                model: 'gemini-3-flash',
                system,
                messages: [{ role: 'user', content: 'hi' }]
            });
            return result.systemInstruction ? result.systemInstruction.parts.map(p => p.text) : null;
        };

        it('drops a standalone billing header block and removes inline header lines', () => {
            expect(systemTexts([{ type: 'text', text: HEADER }, { type: 'text', text: IDENTITY }])).toEqual([IDENTITY]);
            expect(systemTexts([{ type: 'text', text: `${HEADER}\n${IDENTITY}\nMore.` }])).toEqual([`${IDENTITY}\nMore.`]);
            expect(systemTexts(`${HEADER}\n${IDENTITY}`)).toEqual([IDENTITY]);
        });

        it('omits systemInstruction when only the billing header is present', () => {
            expect(systemTexts(HEADER)).toBeNull();
            expect(systemTexts([{ type: 'text', text: HEADER }])).toBeNull();
        });

        it('matches case-insensitively while leaving other x-anthropic headers and prompt whitespace intact', () => {
            expect(systemTexts([{ type: 'text', text: 'X-Anthropic-Billing-Header: cc_version=1;' }, { type: 'text', text: IDENTITY }])).toEqual([IDENTITY]);
            const otherHeaders = `${IDENTITY}\nx-anthropic-beta: foo\nanthropic-version: 2023-06-01`;
            expect(systemTexts([{ type: 'text', text: otherHeaders }])).toEqual([otherHeaders]);
            const padded = `  ${IDENTITY}\n\n`;
            expect(systemTexts(padded)).toEqual([padded]);
        });
    });

    describe('Gemini 64K cap & small-request thinking budget (#393)', () => {
        it('uses minimal thinking budget (32) and expands maxOutputTokens headroom for small requests without explicit thinking', () => {
            const result = convertAnthropicToGoogle({
                model: 'gemini-3.8-flash-tiered',
                max_tokens: 16,
                messages: [{ role: 'user', content: 'hi' }]
            });
            expect(result.generationConfig.thinkingConfig?.thinkingBudget).toBe(32);
            expect(result.generationConfig.thinkingConfig?.includeThoughts).toBe(false);
            expect(result.generationConfig.maxOutputTokens).toBe(8224);
        });

        it('caps Gemini maxOutputTokens at 65536', () => {
            const result = convertAnthropicToGoogle({
                model: 'gemini-3.8-flash-tiered',
                max_tokens: 100000,
                messages: [{ role: 'user', content: 'hi' }]
            });
            expect(result.generationConfig.maxOutputTokens).toBe(65536);
        });
    });
});
