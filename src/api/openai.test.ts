// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseOpenAIRequest, formatOpenAIResponse, formatOpenAIStreamChunk, OpenAIStreamState } from './openai.js';
import * as signatureCache from '../format/signature-cache.js';

describe('parseOpenAIRequest', () => {
  describe('message mapping', () => {
    it('maps a simple string user message to a user content part', () => {
      const req = {
        model: 'test',
        messages: [{ role: 'user', content: 'hello' }]
      };
      const res = parseOpenAIRequest(req);
      expect(res.contents).toHaveLength(1);
      expect(res.contents[0]).toEqual({ role: 'user', parts: [{ text: 'hello' }] });
    });

    it('maps an assistant message to role "model"', () => {
      const req = {
        model: 'test',
        messages: [{ role: 'assistant', content: 'hi' }]
      };
      const res = parseOpenAIRequest(req);
      expect(res.contents[0].role).toBe('model');
      expect(res.contents[0].parts[0].text).toBe('hi');
    });

    it('extracts system messages into systemInstruction, removing them from contents', () => {
      const req = {
        model: 'test',
        messages: [
          { role: 'system', content: 'system prompt' },
          { role: 'user', content: 'hello' }
        ]
      };
      const res = parseOpenAIRequest(req);
      expect(res.systemInstruction?.parts).toEqual([{ text: 'system prompt' }]);
      expect(res.contents).toHaveLength(1); // User message only
    });

    it('handles multi-turn conversations with alternating user/model roles', () => {
      const req = {
        model: 'test',
        messages: [
          { role: 'user', content: 'q1' },
          { role: 'assistant', content: 'a1' },
          { role: 'user', content: 'q2' }
        ]
      };
      const res = parseOpenAIRequest(req);
      expect(res.contents).toHaveLength(3);
      expect(res.contents.map(c => c.role)).toEqual(['user', 'model', 'user']);
    });

    it('maps an array content block with type "text" to a text part', () => {
      const req = {
        model: 'test',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello array' }] }
        ]
      };
      const res = parseOpenAIRequest(req);
      expect(res.contents[0].parts).toEqual([{ text: 'hello array' }]);
    });

    it('maps an image_url content block to an inlineData part with correct mimeType', () => {
      const req = {
        model: 'test',
        messages: [
          { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0K...' } }] }
        ]
      };
      const res = parseOpenAIRequest(req);
      expect(res.contents[0].parts).toEqual([{ inlineData: { mimeType: 'image/png', data: 'iVBORw0K...' } }]);
    });

    it('handles mixed text and image content blocks in order', () => {
      const req = {
        model: 'test',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'look at this' },
              { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,123' } }
            ]
          }
        ]
      };
      const res = parseOpenAIRequest(req);
      expect(res.contents[0].parts).toHaveLength(2);
      expect(res.contents[0].parts[0].text).toBe('look at this');
      expect(res.contents[0].parts[1].inlineData).toEqual({ mimeType: 'image/jpeg', data: '123' });
    });

    it('maps assistant tool_calls to a functionCall part in the model turn', () => {
      vi.spyOn(signatureCache, 'getCachedSignature').mockReturnValue('mock-signature');
      const req = {
        model: 'test',
        messages: [
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"loc":"nyc"}' } }]
          }
        ]
      };
      const res = parseOpenAIRequest(req);
      expect(res.contents[0].parts).toHaveLength(1);
      expect(res.contents[0].parts[0].functionCall).toEqual({ name: 'get_weather', args: { loc: 'nyc' } });
      expect(res.contents[0].parts[0].thoughtSignature).toBe('mock-signature');
      vi.restoreAllMocks();
    });

    it('maps a tool role message to a functionResponse part in a user turn', () => {
      const req = {
        model: 'test',
        messages: [
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }]
          },
          {
            role: 'tool',
            tool_call_id: 'call_1',
            content: 'sunny'
          }
        ]
      };
      const res = parseOpenAIRequest(req);
      expect(res.contents).toHaveLength(2);
      expect(res.contents[1].role).toBe('user');
      expect(res.contents[1].parts[0].functionResponse).toEqual({ name: 'get_weather', response: { result: 'sunny' } });
    });

    it('throws if messages field is missing', () => {
      expect(() => parseOpenAIRequest({ model: 'test' })).toThrow(/messages is required/);
    });

    it('throws if messages is not an array', () => {
      expect(() => parseOpenAIRequest({ model: 'test', messages: 'hello' })).toThrow(/must be an array/);
    });

    it('throws if a message has an unrecognised role', () => {
      expect(() => parseOpenAIRequest({ model: 'test', messages: [{ role: 'alien', content: 'hi' }] })).toThrow(/Unsupported role/);
    });
  });

  describe('generation config mapping', () => {
    it('maps max_tokens to generationConfig.maxOutputTokens', () => {
      const res = parseOpenAIRequest({ model: 'test', messages: [], max_tokens: 100 });
      expect(res.generationConfig.maxOutputTokens).toBe(100);
    });

    it('maps max_completion_tokens to generationConfig.maxOutputTokens', () => {
      const res = parseOpenAIRequest({ model: 'test', messages: [], max_completion_tokens: 200 });
      expect(res.generationConfig.maxOutputTokens).toBe(200);
    });

    it('maps temperature to generationConfig.temperature', () => {
      const res = parseOpenAIRequest({ model: 'test', messages: [], temperature: 0.5 });
      expect(res.generationConfig.temperature).toBe(0.5);
    });

    it('maps top_p to generationConfig.topP', () => {
      const res = parseOpenAIRequest({ model: 'test', messages: [], top_p: 0.9 });
      expect(res.generationConfig.topP).toBe(0.9);
    });

    it('maps a stop string to generationConfig.stopSequences as single-element array', () => {
      const res = parseOpenAIRequest({ model: 'test', messages: [], stop: 'END' });
      expect(res.generationConfig.stopSequences).toEqual(['END']);
    });

    it('maps a stop array to generationConfig.stopSequences directly', () => {
      const res = parseOpenAIRequest({ model: 'test', messages: [], stop: ['END', 'STOP'] });
      expect(res.generationConfig.stopSequences).toEqual(['END', 'STOP']);
    });

    it('omits generationConfig fields that are not provided', () => {
      const res = parseOpenAIRequest({ model: 'test', messages: [] });
      expect(res.generationConfig).toEqual({});
    });
  });

  describe('tool mapping', () => {
    it('maps a tools array to functionDeclarations with name, description, parameters', () => {
      const req = {
        model: 'test',
        messages: [],
        tools: [{ type: 'function', function: { name: 'f1', description: 'desc', parameters: { type: 'object' } } }]
      };
      const res = parseOpenAIRequest(req);
      expect(res.tools).toHaveLength(1);
      expect(res.tools![0].functionDeclarations[0]).toEqual({ name: 'f1', description: 'desc', parameters: { type: 'object' } });
    });

    it('maps tool_choice "auto" to functionCallingConfig mode AUTO', () => {
      const res = parseOpenAIRequest({ model: 'test', messages: [], tool_choice: 'auto' });
      expect(res.toolConfig?.functionCallingConfig.mode).toBe('AUTO');
    });

    it('maps tool_choice "none" to functionCallingConfig mode NONE', () => {
      const res = parseOpenAIRequest({ model: 'test', messages: [], tool_choice: 'none' });
      expect(res.toolConfig?.functionCallingConfig.mode).toBe('NONE');
    });

    it('maps tool_choice "required" to functionCallingConfig mode ANY', () => {
      const res = parseOpenAIRequest({ model: 'test', messages: [], tool_choice: 'required' });
      expect(res.toolConfig?.functionCallingConfig.mode).toBe('ANY');
    });

    it('maps tool_choice object { type:"function", function:{name} } to mode ANY with allowedFunctionNames', () => {
      const res = parseOpenAIRequest({ model: 'test', messages: [], tool_choice: { type: 'function', function: { name: 'f1' } } });
      expect(res.toolConfig?.functionCallingConfig.mode).toBe('ANY');
      expect(res.toolConfig?.functionCallingConfig.allowedFunctionNames).toEqual(['f1']);
    });

    it('omits toolConfig when no tool_choice is provided', () => {
      const res = parseOpenAIRequest({ model: 'test', messages: [] });
      expect(res.toolConfig).toBeUndefined();
    });
  });

  describe('model passthrough', () => {
    it('passes the model name through unchanged', () => {
      const res = parseOpenAIRequest({ model: 'gpt-4o', messages: [] });
      expect(res.model).toBe('gpt-4o');
    });
  });

  describe('Google Search Grounding', () => {
    it('injects googleSearch tool if google_search is true', () => {
      const res = parseOpenAIRequest({ model: 'gemini-2.5-pro', messages: [], google_search: true });
      expect(res.tools).toBeDefined();
      expect(res.tools).toContainEqual({ googleSearch: {} });
    });

    it('does not inject googleSearch if google_search is omitted', () => {
      const res = parseOpenAIRequest({ model: 'gemini-2.5-pro', messages: [] });
      expect(res.tools).toBeUndefined();
    });
  });
});

describe('formatOpenAIResponse', () => {
  it('maps a single text part to choices[0].message.content string', () => {
    const res = formatOpenAIResponse({ // @ts-ignore
// @ts-expect-error
        candidates: [{ content: { parts: [{ text: 'hello' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }, 'test-model');
    expect(res.choices[0].message.content).toBe('hello');
    expect(res.choices[0].message.role).toBe('assistant');
  });

  it('concatenates multiple text parts into a single content string', () => {
    const res = formatOpenAIResponse({ // @ts-ignore
// @ts-expect-error
        candidates: [{ content: { parts: [{ text: 'hello ' }, { text: 'world' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }, 'test-model');
    expect(res.choices[0].message.content).toBe('hello world');
  });

  it('maps a functionCall part to choices[0].message.tool_calls with stringified arguments and caches signature', () => {
      const cacheSpy = vi.spyOn(signatureCache, 'cacheSignature');
      const res = formatOpenAIResponse({ // @ts-ignore
// @ts-expect-error
        candidates: [{ content: { parts: [{ functionCall: { name: 'f1', args: { a: 1 } }, thoughtSignature: 'test-sig' }] }, finishReason: 'TOOL_USE' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }, 'test-model');
      expect(res.choices[0].message.tool_calls).toHaveLength(1);
      expect(res.choices[0].message.tool_calls[0].function.name).toBe('f1');
      expect(res.choices[0].message.tool_calls[0].function.arguments).toBe('{"a":1}');
      expect(cacheSpy).toHaveBeenCalledWith(res.choices[0].message.tool_calls[0].id, 'test-sig');
      vi.restoreAllMocks();
  });

  it('maps multiple functionCall parts to multiple tool_calls entries', () => {
    const res = formatOpenAIResponse({ // @ts-ignore
// @ts-expect-error
        candidates: [{ content: { parts: [{ functionCall: { name: 'f1', args: {} } }, { functionCall: { name: 'f2', args: {} } }] }, finishReason: 'TOOL_USE' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }, 'test-model');
    expect(res.choices[0].message.tool_calls).toHaveLength(2);
  });

  it('sets content and tool_calls when both text and functionCall parts are present', () => {
    const res = formatOpenAIResponse({ // @ts-ignore
// @ts-expect-error
        candidates: [{ content: { parts: [{ text: 'thinking...' }, { functionCall: { name: 'f1', args: {} } }] }, finishReason: 'TOOL_USE' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }, 'test-model');
    expect(res.choices[0].message.content).toBe('thinking...');
    expect(res.choices[0].message.tool_calls).toHaveLength(1);
  });

  it('sets finish_reason "stop" for finishReason STOP', () => {
    const res = formatOpenAIResponse({ // @ts-ignore
// @ts-expect-error
        candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }, 'test-model');
    expect(res.choices[0].finish_reason).toBe('stop');
  });

  it('sets finish_reason "length" for finishReason MAX_TOKENS', () => {
    const res = formatOpenAIResponse({ // @ts-ignore
// @ts-expect-error
        candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }, 'test-model');
    expect(res.choices[0].finish_reason).toBe('length');
  });

  it('sets finish_reason "tool_calls" for finishReason TOOL_USE', () => {
    const res = formatOpenAIResponse({ // @ts-ignore
// @ts-expect-error
        candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'TOOL_USE' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }, 'test-model');
    expect(res.choices[0].finish_reason).toBe('tool_calls');
  });

  it('infers finish_reason "tool_calls" when functionCall parts are present and finishReason is absent', () => {
    const res = formatOpenAIResponse({ // @ts-ignore
// @ts-expect-error
        candidates: [{ content: { parts: [{ functionCall: { name: 'f1', args: {} } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }, 'test-model');
    // Function calls override the STOP
    expect(res.choices[0].finish_reason).toBe('tool_calls');
  });

  it('maps usageMetadata to prompt_tokens, completion_tokens, total_tokens', () => {
    const res = formatOpenAIResponse({ // @ts-ignore
// @ts-expect-error
        candidates: [{ content: { parts: [] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }, 'test-model');
    expect(res.usage.prompt_tokens).toBe(10);
    expect(res.usage.completion_tokens).toBe(5);
    expect(res.usage.total_tokens).toBe(15);
  });

  it('returns a safe empty response for an empty candidates array', () => {
    const res = formatOpenAIResponse({ // @ts-ignore
// @ts-expect-error
        candidates: [], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }, 'test-model');
    expect(res.choices).toHaveLength(0);
    expect(res.usage.prompt_tokens).toBe(0);
  });

  it('sets object field to "chat.completion"', () => {
    const res = formatOpenAIResponse({ // @ts-ignore
// @ts-expect-error
        candidates: [], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }, 'test-model');
    expect(res.object).toBe('chat.completion');
  });

  it('generates an id prefixed with "chatcmpl-"', () => {
    const res = formatOpenAIResponse({ // @ts-ignore
// @ts-expect-error
        candidates: [], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }, 'test-model');
    expect(res.id.startsWith('chatcmpl-')).toBe(true);
  });

  describe('Google Search Grounding', () => {
    it('appends footnotes to content if groundingMetadata is present', () => {
      const res = formatOpenAIResponse({ 
        // @ts-ignore
// @ts-expect-error
        candidates: [{ 
          content: { parts: [{ text: 'Answer' }] }, 
          finishReason: 'STOP',
          groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.com', title: 'Example' } }] }
        }], 
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } 
      }, 'test-model');
      expect(res.choices[0].message.content).toContain('Answer\n\n---\n**Search Sources:**\n1. [Example](https://example.com)');
    });
  });
});

describe('formatOpenAIStreamChunk', () => {
  const makeState = (hasEmittedRole = false): OpenAIStreamState => ({
    id: 'chatcmpl-test',
    model: 'test-model',
    created: 12345,
    hasEmittedRole,
    toolCallIndex: 0,
  });

  it('emits a role+content delta as the very first chunk, even before text parts', () => {
    const state = makeState(false);
    const chunk = { // @ts-ignore
// @ts-expect-error
        candidates: [{ content: { parts: [{ text: 'hi' }] } }] };
    const res = formatOpenAIStreamChunk(chunk, state) as string;
    // First data: line should be the role chunk
    const firstLine = res.split('\n\n')[0];
    const parsed = JSON.parse(firstLine.replace('data: ', ''));
    expect(parsed.choices[0].delta.role).toBe('assistant');
    expect(state.hasEmittedRole).toBe(true);
  });

  it('emits text content deltas as data: lines with no event: prefix', () => {
    const state = makeState(true);
    const chunk = { // @ts-ignore
// @ts-expect-error
        candidates: [{ content: { parts: [{ text: 'hi' }] } }] };
    const res = formatOpenAIStreamChunk(chunk, state);
    expect(res).toContain('data: {');
    expect(res).not.toContain('event:');
    expect(res).toContain('"content":"hi"');
  });

  it('does not repeat role in subsequent text chunks', () => {
    const state = makeState(true);
    const chunk = { // @ts-ignore
// @ts-expect-error
        candidates: [{ content: { parts: [{ text: 'hi' }] } }] };
    const res = formatOpenAIStreamChunk(chunk, state);
    expect(res).not.toContain('"role":"assistant"');
  });

  it('emits tool_call delta with index, id, type, function name, content: null and caches signature', () => {
    const cacheSpy = vi.spyOn(signatureCache, 'cacheSignature');
    const state = makeState(true);
    const chunk = { // @ts-ignore
// @ts-expect-error
        candidates: [{ content: { parts: [{ functionCall: { name: 'f1', args: { a: 1 } }, thoughtSignature: 'test-sig-stream' }] } }] };
    const res = formatOpenAIStreamChunk(chunk, state) as string;
    const parsed = JSON.parse(res.trim().replace(/^data: /, '').split('\n\ndata: ')[0]);
    const delta = parsed.choices[0].delta;
    expect(delta.content).toBeNull();
    expect(delta.tool_calls[0].index).toBe(0);
    expect(delta.tool_calls[0].function.name).toBe('f1');
    expect(state.toolCallIndex).toBe(1);
    expect(cacheSpy).toHaveBeenCalledWith(delta.tool_calls[0].id, 'test-sig-stream');
    vi.restoreAllMocks();
  });

  it('emits argument fragment deltas for subsequent tool chunks', () => {
    const state = makeState(true);
    const chunk = { // @ts-ignore
// @ts-expect-error
        candidates: [{ content: { parts: [{ functionCall: { name: 'f1', args: { a: 1 } } }] } }] };
    const res = formatOpenAIStreamChunk(chunk, state);
    expect(res).toContain('"arguments":"{\\"a\\":1}"');
  });

  it('emits a finish_reason chunk on the final chunk', () => {
    const state = makeState(true);
    const chunk = { // @ts-ignore
// @ts-expect-error
        candidates: [{ finishReason: 'STOP' }] };
    const res = formatOpenAIStreamChunk(chunk, state) as string;
    // finishReason chunk uses finish_reason:"stop", delta:{}
    const parsed = JSON.parse(res.trim().replace(/^data: /, ''));
    expect(parsed.choices[0].finish_reason).toBe('stop');
    expect(parsed.choices[0].delta).toEqual({});
  });

  it('returns null for chunks with no candidates', () => {
    const state = makeState(true);
    const chunk = { // @ts-ignore
// @ts-expect-error
        candidates: [] };
    const res = formatOpenAIStreamChunk(chunk, state);
    expect(res).toBeNull();
  });

  it('formats thought: true parts with <think> tags', () => {
    const state = makeState(false);
    const chunk = { // @ts-ignore
// @ts-expect-error
        candidates: [{ content: { parts: [{ text: 'thinking', thought: true }] } }] };
    const res = formatOpenAIStreamChunk(chunk, state) as string;
    expect(state.hasEmittedRole).toBe(true);
    expect(res).toContain('<think>\\nthinking');
    expect(state.isThinking).toBe(true);

    const chunk2 = { // @ts-ignore
// @ts-expect-error
        candidates: [{ content: { parts: [{ text: ' done' }] } }] };
    const res2 = formatOpenAIStreamChunk(chunk2, state) as string;
    expect(res2).toContain('\\n</think>\\n\\n done');
    expect(state.isThinking).toBe(false);
  });

  describe('Google Search Grounding', () => {
    it('emits an extra chunk for footnotes before finish reason chunk', () => {
      const state = makeState(true);
      const chunk = { 
        // @ts-ignore
// @ts-expect-error
        candidates: [{ 
          finishReason: 'STOP',
          groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.com', title: 'Example' } }] }
        }] 
      };
      const res = formatOpenAIStreamChunk(chunk, state) as string;
      expect(res).not.toBeNull();
      
      const dataLines = res.split('\n\n').filter(l => l.startsWith('data: '));
      expect(dataLines).toHaveLength(2);
      
      const footnoteChunk = JSON.parse(dataLines[0].replace('data: ', ''));
      expect(footnoteChunk.choices[0].delta.content).toContain('Search Sources');
      
      const finishChunk = JSON.parse(dataLines[1].replace('data: ', ''));
      expect(finishChunk.choices[0].finish_reason).toBe('stop');
    });
  });
});

/**
 * ─── Regression Tests ──────────────────────────────────────────────────────
 * Explicit guards for each spec-compliance bug found in the OpenAI audit.
 * Each test documents the bug, the wrong behaviour, and the correct behaviour.
 */
describe('OpenAI spec compliance regressions', () => {
  // ── Non-streaming response ──────────────────────────────────────────────

  describe('formatOpenAIResponse', () => {
    it('regression: content must be null (not "") when response is tool-call only', () => {
      /**
       * BUG: content was always set to the accumulated text string even when empty.
       * For a pure tool-call response the text accumulator is "", which was then
       * set as content. The OpenAI spec requires content to be null in this case
       * so that clients (LangChain, openai-node SDK) can detect tool-only turns.
       *
       * WRONG:   { role: "assistant", content: "" }
       * CORRECT: { role: "assistant", content: null, tool_calls: [...] }
       */
      const res = formatOpenAIResponse(
        {
          // @ts-ignore
// @ts-expect-error
        candidates: [{
            content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'NYC' } } }] },
            finishReason: 'TOOL_USE',
          }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        },
        'test-model',
      ) as StandardStreamChunk;

      expect(res.choices[0].message.content).toBeNull();
      expect(res.choices[0].message.tool_calls).toHaveLength(1);
    });

    it('regression: content is preserved (not null) when text AND tool calls coexist', () => {
      /**
       * BUG FOLLOW-UP: after fixing tool-only -> null, must not break mixed responses
       * where the model legitimately produced both text reasoning AND a tool call.
       * The text content must survive.
       *
       * WRONG:   { content: null }  <- over-applying the null rule
       * CORRECT: { content: "thinking out loud...", tool_calls: [...] }
       */
      const res = formatOpenAIResponse(
        {
          // @ts-ignore
// @ts-expect-error
        candidates: [{
            content: { parts: [{ text: 'thinking out loud...' }, { functionCall: { name: 'f1', args: {} } }] },
            finishReason: 'TOOL_USE',
          }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        },
        'test-model',
      ) as StandardStreamChunk;

      expect(res.choices[0].message.content).toBe('thinking out loud...');
      expect(res.choices[0].message.tool_calls).toHaveLength(1);
    });
  });

  // ── Streaming response ──────────────────────────────────────────────────

  describe('formatOpenAIStreamChunk', () => {
    const makeState = (hasEmittedRole = false): OpenAIStreamState => ({
      id: 'chatcmpl-regression',
      model: 'test-model',
      created: 99999,
      hasEmittedRole,
      toolCallIndex: 0,
    });

    it('regression: role is emitted as its own dedicated first chunk, not mixed into content chunks', () => {
      /**
       * BUG: The role "assistant" was baked into a shared baseChunk template and then
       * deep-cloned for every text part. This caused the role to appear on every text
       * delta chunk, not just the first — violating the SSE protocol where role is a
       * one-time announcement in its own delta.
       *
       * WRONG:   [{ delta: { role:"assistant", content:"Hello" } }, { delta: { role:"assistant", content:" world" } }]
       * CORRECT: [{ delta: { role:"assistant", content:"" } }, { delta: { content:"Hello" } }, { delta: { content:" world" } }]
       */
      const state = makeState(false);
      const chunk = { // @ts-ignore
// @ts-expect-error
        candidates: [{ content: { parts: [{ text: 'Hello' }, { text: ' world' }] } }] };
      const res = formatOpenAIStreamChunk(chunk, state) as string;

      const dataLines = res.split('\n\n').filter(l => l.startsWith('data: '));
      const parsed = dataLines.map(l => JSON.parse(l.replace('data: ', '')));

      // First chunk must be the role chunk
      expect(parsed[0].choices[0].delta.role).toBe('assistant');

      // Subsequent content chunks must NOT carry the role field
      for (const p of parsed.slice(1)) {
        expect(p.choices[0].delta).not.toHaveProperty('role');
      }
    });

    it('regression: all chunks in a stream share the same id and created timestamp', () => {
      /**
       * BUG: The old code called crypto.randomUUID() and Date.now() inside the formatter
       * for every single chunk. This produced a different id/timestamp per SSE line,
       * which breaks clients that use the id to correlate chunks into one response.
       *
       * CORRECT: all chunks share the id/created from the state initialised once per request.
       */
      const state = makeState(false);
      const chunk = { // @ts-ignore
// @ts-expect-error
        candidates: [{ content: { parts: [{ text: 'A' }, { text: 'B' }] } }] };
      const res = formatOpenAIStreamChunk(chunk, state) as string;

      const dataLines = res.split('\n\n').filter(l => l.startsWith('data: '));
      const parsed = dataLines.map(l => JSON.parse(l.replace('data: ', '')));

      const ids = parsed.map((p: OpenAIResponse) => p.id);
      const timestamps = parsed.map((p: OpenAIResponse) => p.created);

      expect(new Set(ids).size).toBe(1);
      expect(ids[0]).toBe('chatcmpl-regression');
      expect(new Set(timestamps).size).toBe(1);
      expect(timestamps[0]).toBe(99999);
    });

    it('regression: tool call delta must have content: null, not undefined or a missing key', () => {
      /**
       * BUG: When a tool call was streamed, delta was built without a content field at all.
       * The OpenAI spec and clients like LangChain explicitly check delta.content === null
       * (not just falsy) to distinguish a tool-call delta from a text delta.
       *
       * WRONG:   { delta: { tool_calls: [...] } }            <- content key absent
       * CORRECT: { delta: { content: null, tool_calls: [...] } }
       */
      const state = makeState(true);
      const chunk = {
        // @ts-ignore
// @ts-expect-error
        candidates: [{
          content: { parts: [{ functionCall: { name: 'search', args: { q: 'test' } } }] },
        }],
      };
      const res = formatOpenAIStreamChunk(chunk, state) as string;
      const parsed = JSON.parse(res.trim().replace(/^data: /, ''));
      const delta = parsed.choices[0].delta;

      expect(Object.prototype.hasOwnProperty.call(delta, 'content')).toBe(true);
      expect(delta.content).toBeNull();
    });

    it('regression: finish_reason chunk has an empty delta {}, not a delta with stale fields', () => {
      /**
       * BUG (related): Previously the finish chunk was cloned from baseChunk which could
       * carry stale delta state. The final chunk must have delta: {} (empty object) with
       * finish_reason set. openai-python checks delta == {} to identify the sentinel.
       *
       * CORRECT: { choices: [{ delta: {}, finish_reason: "stop" }] }
       */
      const state = makeState(true);
      const chunk = { // @ts-ignore
// @ts-expect-error
        candidates: [{ finishReason: 'STOP' }] };
      const res = formatOpenAIStreamChunk(chunk, state) as string;
      const parsed = JSON.parse(res.trim().replace(/^data: /, ''));

      expect(parsed.choices[0].delta).toStrictEqual({});
      expect(parsed.choices[0].finish_reason).toBe('stop');
    });

    it('regression: intermediate chunks have finish_reason: null present in JSON', () => {
      /**
       * SPEC REQUIREMENT: OpenAI spec says finish_reason must be null on all non-terminal
       * chunks. It must be serialised as null in JSON, not omitted. Some client parsers
       * distinguish between key: null and a missing key.
       */
      const state = makeState(true);
      const chunk = { // @ts-ignore
// @ts-expect-error
        candidates: [{ content: { parts: [{ text: 'partial' }] } }] };
      const res = formatOpenAIStreamChunk(chunk, state) as string;

      const contentLine = res.split('\n\n').find(l => l.includes('"content":"partial"'))!;
      expect(contentLine).toBeTruthy();
      const parsed = JSON.parse(contentLine.replace('data: ', ''));

      expect(Object.prototype.hasOwnProperty.call(parsed.choices[0], 'finish_reason')).toBe(true);
      expect(parsed.choices[0].finish_reason).toBeNull();
    });
  });
});
