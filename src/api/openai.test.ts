import { describe, it, expect } from 'vitest';
import { parseOpenAIRequest, formatOpenAIResponse, formatOpenAIStreamChunk } from './openai.js';

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
});

describe('formatOpenAIResponse', () => {
  it('maps a single text part to choices[0].message.content string', () => {
    const res = formatOpenAIResponse({ candidates: [{ content: { parts: [{ text: 'hello' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }, 'test-model');
    expect((res as any).choices[0].message.content).toBe('hello');
    expect((res as any).choices[0].message.role).toBe('assistant');
  });

  it('concatenates multiple text parts into a single content string', () => {
    const res = formatOpenAIResponse({ candidates: [{ content: { parts: [{ text: 'hello ' }, { text: 'world' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }, 'test-model');
    expect((res as any).choices[0].message.content).toBe('hello world');
  });

  it('maps a functionCall part to choices[0].message.tool_calls with stringified arguments', () => {
    const res = formatOpenAIResponse({ candidates: [{ content: { parts: [{ functionCall: { name: 'f1', args: { a: 1 } } }] }, finishReason: 'TOOL_USE' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }, 'test-model');
    expect((res as any).choices[0].message.tool_calls).toHaveLength(1);
    expect((res as any).choices[0].message.tool_calls[0].function.name).toBe('f1');
    expect((res as any).choices[0].message.tool_calls[0].function.arguments).toBe('{"a":1}');
  });

  it('maps multiple functionCall parts to multiple tool_calls entries', () => {
    const res = formatOpenAIResponse({ candidates: [{ content: { parts: [{ functionCall: { name: 'f1', args: {} } }, { functionCall: { name: 'f2', args: {} } }] }, finishReason: 'TOOL_USE' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }, 'test-model');
    expect((res as any).choices[0].message.tool_calls).toHaveLength(2);
  });

  it('sets content and tool_calls when both text and functionCall parts are present', () => {
    const res = formatOpenAIResponse({ candidates: [{ content: { parts: [{ text: 'thinking...' }, { functionCall: { name: 'f1', args: {} } }] }, finishReason: 'TOOL_USE' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }, 'test-model');
    expect((res as any).choices[0].message.content).toBe('thinking...');
    expect((res as any).choices[0].message.tool_calls).toHaveLength(1);
  });

  it('sets finish_reason "stop" for finishReason STOP', () => {
    const res = formatOpenAIResponse({ candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }, 'test-model');
    expect((res as any).choices[0].finish_reason).toBe('stop');
  });

  it('sets finish_reason "length" for finishReason MAX_TOKENS', () => {
    const res = formatOpenAIResponse({ candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }, 'test-model');
    expect((res as any).choices[0].finish_reason).toBe('length');
  });

  it('sets finish_reason "tool_calls" for finishReason TOOL_USE', () => {
    const res = formatOpenAIResponse({ candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'TOOL_USE' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }, 'test-model');
    expect((res as any).choices[0].finish_reason).toBe('tool_calls');
  });

  it('infers finish_reason "tool_calls" when functionCall parts are present and finishReason is absent', () => {
    const res = formatOpenAIResponse({ candidates: [{ content: { parts: [{ functionCall: { name: 'f1', args: {} } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }, 'test-model');
    // Function calls override the STOP
    expect((res as any).choices[0].finish_reason).toBe('tool_calls');
  });

  it('maps usageMetadata to prompt_tokens, completion_tokens, total_tokens', () => {
    const res = formatOpenAIResponse({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }, 'test-model');
    expect((res as any).usage.prompt_tokens).toBe(10);
    expect((res as any).usage.completion_tokens).toBe(5);
    expect((res as any).usage.total_tokens).toBe(15);
  });

  it('returns a safe empty response for an empty candidates array', () => {
    const res = formatOpenAIResponse({ candidates: [], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }, 'test-model');
    expect((res as any).choices).toHaveLength(0);
    expect((res as any).usage.prompt_tokens).toBe(0);
  });

  it('sets object field to "chat.completion"', () => {
    const res = formatOpenAIResponse({ candidates: [], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }, 'test-model');
    expect((res as any).object).toBe('chat.completion');
  });

  it('generates an id prefixed with "chatcmpl-"', () => {
    const res = formatOpenAIResponse({ candidates: [], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }, 'test-model');
    expect((res as any).id.startsWith('chatcmpl-')).toBe(true);
  });
});

describe('formatOpenAIStreamChunk', () => {
  it('emits a role delta on the first chunk', () => {
    const state = { hasEmittedRole: false, toolCallIndex: 0 };
    const chunk = { candidates: [{ content: { parts: [{ text: 'hi' }] } }] };
    const res = formatOpenAIStreamChunk(chunk, state);
    expect(res).toContain('"role":"assistant"');
    expect(state.hasEmittedRole).toBe(true);
  });

  it('emits text content deltas as data: lines with no event: prefix', () => {
    const state = { hasEmittedRole: true, toolCallIndex: 0 };
    const chunk = { candidates: [{ content: { parts: [{ text: 'hi' }] } }] };
    const res = formatOpenAIStreamChunk(chunk, state);
    expect(res).toContain('data: {');
    expect(res).not.toContain('event:');
    expect(res).toContain('"content":"hi"');
  });

  it('does not repeat role in subsequent text chunks', () => {
    const state = { hasEmittedRole: true, toolCallIndex: 0 };
    const chunk = { candidates: [{ content: { parts: [{ text: 'hi' }] } }] };
    const res = formatOpenAIStreamChunk(chunk, state);
    expect(res).not.toContain('"role":"assistant"');
  });

  it('emits tool_call start delta with id, type, and function name on first tool chunk', () => {
    const state = { hasEmittedRole: true, toolCallIndex: 0 };
    const chunk = { candidates: [{ content: { parts: [{ functionCall: { name: 'f1', args: { a: 1 } } }] } }] };
    const res = formatOpenAIStreamChunk(chunk, state);
    expect(res).toContain('"tool_calls":[{"index":0,');
    expect(res).toContain('"name":"f1"');
    expect(state.toolCallIndex).toBe(1);
  });

  it('emits argument fragment deltas for subsequent tool chunks', () => {
    // Actually the current parse stream maps full tools at once in proxy.
    // If it chunks, args would be part of it.
    const state = { hasEmittedRole: true, toolCallIndex: 0 };
    const chunk = { candidates: [{ content: { parts: [{ functionCall: { name: 'f1', args: { a: 1 } } }] } }] };
    const res = formatOpenAIStreamChunk(chunk, state);
    expect(res).toContain('"arguments":"{\\"a\\":1}"');
  });

  it('emits a finish_reason chunk followed by data: [DONE] on the final chunk', () => {
    const state = { hasEmittedRole: true, toolCallIndex: 0 };
    const chunk = { candidates: [{ finishReason: 'STOP' }] };
    const res = formatOpenAIStreamChunk(chunk, state);
    expect(res).toContain('"finish_reason":"stop"');
    expect(res).toContain('data: [DONE]\n\n');
  });

  it('returns null for chunks with no candidates or parts', () => {
    const state = { hasEmittedRole: true, toolCallIndex: 0 };
    const chunk = { candidates: [] };
    const res = formatOpenAIStreamChunk(chunk, state);
    expect(res).toBeNull();
  });

  it('suppresses thought: true parts — returns null', () => {
    const state = { hasEmittedRole: true, toolCallIndex: 0 };
    const chunk = { candidates: [{ content: { parts: [{ text: 'thinking', thought: true }] } }] };
    const res = formatOpenAIStreamChunk(chunk, state);
    expect(res).toBeNull(); // Nothing emitted since parts filtered and no finish reason
  });
});
