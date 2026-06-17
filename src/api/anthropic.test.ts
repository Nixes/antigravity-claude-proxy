import { describe, it, expect, vi } from 'vitest';
import { parseAnthropicRequest, formatAnthropicResponse, formatAnthropicStreamChunk } from './anthropic.js';

vi.mock('../format/request-converter.js', () => ({
  convertAnthropicToGoogle: vi.fn((body) => ({ model: body.model, contents: [] }))
}));

vi.mock('../format/response-converter.js', () => ({
  convertGoogleToAnthropic: vi.fn((res, model) => ({ id: 'msg_1', role: 'assistant', model }))
}));

describe('parseAnthropicRequest', () => {
  it('calls convertAnthropicToGoogle with the validated body and returns its result', () => {
    const req = { model: 'test', messages: [] };
    const res = parseAnthropicRequest(req);
    expect(res).toEqual({ model: 'test', contents: [] });
  });

  it('throws a typed error if model is missing', () => {
    expect(() => parseAnthropicRequest({ messages: [] })).toThrow(/Missing model/);
  });

  it('throws a typed error if messages is missing', () => {
    expect(() => parseAnthropicRequest({ model: 'test' })).toThrow(/messages is required/);
  });

  it('throws a typed error if messages is not an array', () => {
    expect(() => parseAnthropicRequest({ model: 'test', messages: 'hello' })).toThrow(/must be an array/);
  });
});

describe('formatAnthropicResponse', () => {
  it('calls convertGoogleToAnthropic with (response, model) and returns result', () => {
    const res = formatAnthropicResponse({ candidates: [], usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 } }, 'test-model');
    expect(res).toEqual({ id: 'msg_1', role: 'assistant', model: 'test-model' });
  });
});

describe('formatAnthropicStreamChunk', () => {
  it('emits message_start with correct model on the first chunk', () => {
    const state = { model: 'test-model', hasEmittedStart: false, blockIndex: 0 };
    const chunk = { candidates: [{ content: { parts: [{ text: 'hi' }] } }] };
    const res = formatAnthropicStreamChunk(chunk, state);
    expect(res).toContain('event: message_start');
    expect(res).toContain('"model":"test-model"');
    expect(state.hasEmittedStart).toBe(true);
  });

  it('formats a text-delta chunk as event: content_block_delta\\ndata: ...\\n\\n', () => {
    const state = { model: 'test-model', hasEmittedStart: true, blockIndex: 0 };
    const chunk = { candidates: [{ content: { parts: [{ text: 'hi' }] } }] };
    const res = formatAnthropicStreamChunk(chunk, state);
    expect(res).toContain('event: content_block_delta');
    expect(res).toContain('"text":"hi"');
  });

  it('formats a message_stop chunk as event: message_stop\\ndata: ...\\n\\n', () => {
    const state = { model: 'test-model', hasEmittedStart: true, blockIndex: 0 };
    const chunk = { candidates: [{ finishReason: 'STOP' }] };
    const res = formatAnthropicStreamChunk(chunk, state);
    expect(res).toContain('event: message_stop');
  });

  it('returns null for chunks with no content to emit', () => {
    const state = { model: 'test-model', hasEmittedStart: true, blockIndex: 0 };
    const chunk = { candidates: [] };
    const res = formatAnthropicStreamChunk(chunk, state);
    expect(res).toBeNull();
  });
});
