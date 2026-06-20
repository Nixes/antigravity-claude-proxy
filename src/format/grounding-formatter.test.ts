import { formatGroundingFootnotes, GroundingMetadata } from './grounding-formatter.js';
import { describe, it, expect } from 'vitest';

describe('formatGroundingFootnotes', () => {
  it('returns empty string if metadata is undefined', () => {
    expect(formatGroundingFootnotes(undefined)).toBe('');
  });

  it('returns empty string if groundingChunks is empty', () => {
    const metadata: GroundingMetadata = { groundingChunks: [] };
    expect(formatGroundingFootnotes(metadata)).toBe('');
  });

  it('returns empty string if no valid web chunks exist', () => {
    const metadata: GroundingMetadata = {
      groundingChunks: [{ web: { uri: '', title: '' } }]
    };
    expect(formatGroundingFootnotes(metadata)).toBe('');
  });

  it('formats valid web chunks correctly', () => {
    const metadata: GroundingMetadata = {
      groundingChunks: [
        { web: { uri: 'https://example.com/1', title: 'Example 1' } },
        { web: { uri: 'https://example.com/2', title: '' } }
      ]
    };
    const expected = '\n\n---\n**Search Sources:**\n1. [Example 1](https://example.com/1)\n2. [https://example.com/2](https://example.com/2)';
    expect(formatGroundingFootnotes(metadata)).toBe(expected);
  });
});
