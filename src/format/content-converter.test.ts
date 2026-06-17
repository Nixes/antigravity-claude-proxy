import { describe, it, expect } from 'vitest';
import { convertContentToParts, convertRole } from './content-converter.js';

describe('convertRole', () => {
    it('converts assistant to model', () => {
        expect(convertRole('assistant')).toBe('model');
    });
    
    it('converts user to user', () => {
        expect(convertRole('user')).toBe('user');
    });
    
    it('defaults to user', () => {
        expect(convertRole('system')).toBe('user');
    });
});

describe('convertContentToParts', () => {
    it('converts string to text part', () => {
        const parts = convertContentToParts('hello world');
        expect(parts).toEqual([{ text: 'hello world' }]);
    });

    it('converts text block', () => {
        const parts = convertContentToParts([{ type: 'text', text: 'hello' }]);
        expect(parts).toEqual([{ text: 'hello' }]);
    });

    it('handles tool_use and maps toolCallIdToName', () => {
        const toolMap = new Map<string, string>();
        const parts = convertContentToParts([
            { type: 'tool_use', id: 'call_123', name: 'get_weather', input: { loc: 'SF' } }
        ], false, true, toolMap);

        expect(parts).toEqual([{
            functionCall: { name: 'get_weather', args: { loc: 'SF' } },
            thoughtSignature: 'skip_thought_signature_validator' // GEMINI_SKIP_SIGNATURE
        }]);

        expect(toolMap.get('call_123')).toBe('get_weather');
    });

    it('handles tool_result and looks up name from map', () => {
        const toolMap = new Map<string, string>();
        toolMap.set('call_123', 'get_weather');

        const parts = convertContentToParts([
            { type: 'tool_result', tool_use_id: 'call_123', content: '75F' }
        ], false, true, toolMap);

        expect(parts).toEqual([{
            functionResponse: { name: 'get_weather', response: { result: '75F' } }
        }]);
    });

    it('falls back to tool_use_id if name not found in map', () => {
        const toolMap = new Map<string, string>();

        const parts = convertContentToParts([
            { type: 'tool_result', tool_use_id: 'call_456', content: '75F' }
        ], false, true, toolMap);

        expect(parts).toEqual([{
            functionResponse: { name: 'call_456', response: { result: '75F' } }
        }]);
    });

    it('includes id for Claude models in tool_result', () => {
        const toolMap = new Map<string, string>();
        toolMap.set('call_123', 'get_weather');

        const parts = convertContentToParts([
            { type: 'tool_result', tool_use_id: 'call_123', content: '75F' }
        ], true, false, toolMap);

        expect(parts).toEqual([{
            functionResponse: { id: 'call_123', name: 'get_weather', response: { result: '75F' } }
        }]);
    });
});
