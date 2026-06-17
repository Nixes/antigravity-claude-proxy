import { describe, it, expect, vi } from 'vitest';
import { parseAnthropicRequest, formatAnthropicResponse } from './anthropic.js';

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

