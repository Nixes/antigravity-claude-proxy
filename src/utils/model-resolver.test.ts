import { describe, it, expect } from 'vitest';
import { resolveModelId } from './model-resolver.js';

describe('resolveModelId', () => {
    it('prefers user-configured modelMapping over built-in mappings', () => {
        const result = resolveModelId('claude-opus-5-5', {
            'claude-opus-5-5': { mapping: 'gemini-3.8-flash-tiered' }
        });
        expect(result).toBe('gemini-3.8-flash-tiered');
    });

    it('resolves built-in legacy aliases when no user mapping matches', () => {
        expect(resolveModelId('claude-opus-5-5')).toBe('claude-opus-4-6-thinking');
        expect(resolveModelId('claude-sonnet-5-5', {})).toBe('claude-sonnet-4-6');
    });

    it('returns unmapped model IDs unchanged', () => {
        expect(resolveModelId('gemini-3-flash')).toBe('gemini-3-flash');
    });

    it('does not resolve Object.prototype properties on modelMapping or built-in map', () => {
        for (const protoKey of ['constructor', 'toString', '__proto__', 'valueOf']) {
            expect(resolveModelId(protoKey, {})).toBe(protoKey);
            expect(resolveModelId(protoKey)).toBe(protoKey);
        }
    });
});
