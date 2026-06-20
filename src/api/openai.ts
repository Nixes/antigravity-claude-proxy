import { StandardRequest, StandardResponse, StandardStreamChunk, GContent, GPart, OpenAIRequest, OpenAIResponse } from './types.js';
import { cacheSignature, getCachedSignature } from '../format/signature-cache.js';
import { formatGroundingFootnotes } from '../format/grounding-formatter.js';
export function parseOpenAIRequest(req: OpenAIRequest): StandardRequest {
  if (!req.messages || !Array.isArray(req.messages)) {
    throw new Error('invalid_request_error: messages is required and must be an array');
  }

  const systemParts: { text: string }[] = [];
  const contents: GContent[] = [];

  // Map to track tool_call_id -> function name for resolving tool responses
  const toolCallIdToName = new Map<string, string>();

  for (const msg of req.messages) {
    if (msg.role === 'system') {
      if (typeof msg.content === 'string') {
        systemParts.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text') systemParts.push({ text: part.text });
        }
      }
      continue;
    }

    if (!['user', 'assistant', 'tool'].includes(msg.role)) {
      throw new Error(`invalid_request_error: Unsupported role: ${msg.role}`);
    }

    const parts: GPart[] = [];

    if (msg.role === 'user' || msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        if (msg.content) parts.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text') {
            parts.push({ text: block.text });
          } else if (block.type === 'image_url') {
            // "image_url": { "url": "data:image/jpeg;base64,..." }
            const url = block.image_url?.url || '';
            const match = url.match(/^data:(.*?);base64,(.*)$/);
            if (match) {
              parts.push({
                inlineData: {
                  mimeType: match[1],
                  data: match[2],
                },
              });
            }
          }
        }
      }
    }

    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const call of msg.tool_calls) {
        if (call.type === 'function') {
          toolCallIdToName.set(call.id, call.function.name);
          parts.push({
            functionCall: {
              name: call.function.name,
              args: call.function.arguments ? JSON.parse(call.function.arguments) : {},
            },
            thoughtSignature: getCachedSignature(call.id) || undefined,
          });
        }
      }
    }

    if (msg.role === 'tool') {
      const functionName = toolCallIdToName.get(msg.tool_call_id) || 'unknown_function';
      parts.push({
        functionResponse: {
          name: functionName,
          response: { result: msg.content },
        },
      });
      contents.push({ role: 'user', parts });
      continue;
    }

    // Google requires at least one part
    if (parts.length === 0) {
      parts.push({ text: '' });
    }

    contents.push({
      role: msg.role === 'user' ? 'user' : 'model',
      parts,
    });
  }

  const generationConfig: StandardRequest['generationConfig'] = {};
  if (req.max_completion_tokens !== undefined) generationConfig.maxOutputTokens = req.max_completion_tokens;
  else if (req.max_tokens !== undefined) generationConfig.maxOutputTokens = req.max_tokens;
  
  if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
  if (req.top_p !== undefined) generationConfig.topP = req.top_p;
  
  if (req.stop) {
    generationConfig.stopSequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  }

  const standardReq: StandardRequest = {
    model: req.model,
    contents,
    generationConfig,
  };

  if (systemParts.length > 0) {
    standardReq.systemInstruction = { parts: systemParts };
  }

  if (req.tools && Array.isArray(req.tools)) {
    const functionDeclarations = req.tools
      .filter((t: unknown) => (t as any).type === 'function')
      .map((t: unknown) => ({
        name: (t as any).function.name,
        description: (t as any).function.description || '',
        parameters: (t as any).function.parameters || { type: 'object' },
      }));
    if (functionDeclarations.length > 0) {
      standardReq.tools = [{ functionDeclarations }];
    }
  }

  if (req.google_search === true) {
    standardReq.tools = standardReq.tools || [];
    standardReq.tools.push({ googleSearch: {} });
  }

  if (req.tool_choice) {
    if (req.tool_choice === 'auto') {
      standardReq.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
    } else if (req.tool_choice === 'none') {
      standardReq.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
    } else if (req.tool_choice === 'required') {
      standardReq.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
    } else if (typeof req.tool_choice === 'object' && (req.tool_choice as any).type === 'function') {
      standardReq.toolConfig = {
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: [(req.tool_choice as any).function.name],
        },
      };
    }
  }

  return standardReq;
}

export function formatOpenAIResponse(res: StandardResponse, model: string): OpenAIResponse {
  if (!res.candidates || res.candidates.length === 0) {
    return {
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }

  const candidate = res.candidates[0];
  const parts = candidate.content?.parts || [];
  
  let content = '';
  const tool_calls: Array<{ id: string, type: string, function: { name: string, arguments: string } }> = [];
  
  for (const part of parts) {
    if (part.thought) {
      content += `<think>\n${part.text}\n</think>\n\n`;
    } else if (part.text) {
      content += part.text;
    } else if (part.functionCall) {
      const toolCallId = `call_${crypto.randomUUID().replace(/-/g, '').substring(0, 24)}`;
      tool_calls.push({
        id: toolCallId,
        type: 'function',
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args),
        },
      });
      if (part.thoughtSignature) {
        cacheSignature(toolCallId, part.thoughtSignature);
      }
    }
  }

  const footnotes = formatGroundingFootnotes(candidate.groundingMetadata);
  if (footnotes) {
    content += footnotes;
  }

  let finish_reason = 'stop';
  if (candidate.finishReason === 'MAX_TOKENS') finish_reason = 'length';
  else if (candidate.finishReason === 'TOOL_USE' || tool_calls.length > 0) finish_reason = 'tool_calls';

  const message: { role: string, content: string | null, tool_calls?: typeof tool_calls } = { 
    role: 'assistant', 
    content: (tool_calls.length > 0 && content === '') ? null : content 
  };
  if (tool_calls.length > 0) message.tool_calls = tool_calls;

  const usage = res.usageMetadata || { promptTokenCount: 0, candidatesTokenCount: 0 };
  const input_tokens = usage.promptTokenCount - (usage.cachedContentTokenCount || 0);

  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason,
      },
    ],
    usage: {
      prompt_tokens: input_tokens,
      completion_tokens: usage.candidatesTokenCount,
      total_tokens: input_tokens + usage.candidatesTokenCount,
    },
  };
}

export interface OpenAIStreamState {
  id: string;
  model: string;
  created: number;
  hasEmittedRole: boolean;
  toolCallIndex: number;
  isThinking?: boolean;
}

export function formatOpenAIStreamChunk(chunk: StandardStreamChunk, state: OpenAIStreamState): string | null {
  const innerResponse = ('response' in chunk ? (chunk as unknown as { response: StandardStreamChunk }).response : chunk) as StandardStreamChunk;
  const candidates = innerResponse.candidates || [];
  if (candidates.length === 0) return null;

  const candidate = candidates[0];
  const parts = candidate.content?.parts || [];
  let chunksToEmit: string[] = [];


  if (!state.hasEmittedRole) {
    state.hasEmittedRole = true;
    // The role chunk is always the very first chunk, emitted separately.
    const roleChunk = {
      id: state.id,
      object: 'chat.completion.chunk',
      created: state.created,
      model: state.model,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    };
    chunksToEmit.push(`data: ${JSON.stringify(roleChunk)}\n\n`);
  }

  for (const part of parts) {
    if (part.thought) {
      let textToEmit = '';
      if (!state.isThinking) {
        textToEmit += '<think>\n';
        state.isThinking = true;
      }
      if (part.text) textToEmit += part.text;
      
      if (textToEmit) {
        const textChunk = {
          id: state.id,
          object: 'chat.completion.chunk',
          created: state.created,
          model: state.model,
          choices: [{ index: 0, delta: { content: textToEmit }, finish_reason: null }],
        };
        chunksToEmit.push(`data: ${JSON.stringify(textChunk)}\n\n`);
      }
    } else if (part.text) {
      let textToEmit = '';
      if (state.isThinking) {
        textToEmit += '\n</think>\n\n';
        state.isThinking = false;
      }
      textToEmit += part.text;

      const textChunk = {
        id: state.id,
        object: 'chat.completion.chunk',
        created: state.created,
        model: state.model,
        choices: [{ index: 0, delta: { content: textToEmit }, finish_reason: null }],
      };
      chunksToEmit.push(`data: ${JSON.stringify(textChunk)}\n\n`);
    } else if (part.functionCall) {
      if (state.isThinking) {
        const closeThinkChunk = {
          id: state.id,
          object: 'chat.completion.chunk',
          created: state.created,
          model: state.model,
          choices: [{ index: 0, delta: { content: '\n</think>\n\n' }, finish_reason: null }],
        };
        chunksToEmit.push(`data: ${JSON.stringify(closeThinkChunk)}\n\n`);
        state.isThinking = false;
      }

      const toolCallId = `call_${crypto.randomUUID().replace(/-/g, '').substring(0, 24)}`;
      if (part.thoughtSignature) {
        cacheSignature(toolCallId, part.thoughtSignature);
      }

      const toolChunk = {
        id: state.id,
        object: 'chat.completion.chunk',
        created: state.created,
        model: state.model,
        choices: [{ index: 0, delta: { content: null, tool_calls: [{
          index: state.toolCallIndex,
          id: toolCallId,
          type: 'function',
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args),
          },
        }]}, finish_reason: null }],
      };
      chunksToEmit.push(`data: ${JSON.stringify(toolChunk)}\n\n`);
      state.toolCallIndex++;
    }
  }

  if (candidate.finishReason) {
    const footnotes = formatGroundingFootnotes(candidate.groundingMetadata);
    if (footnotes) {
      const footnoteChunk = {
        id: state.id,
        object: 'chat.completion.chunk',
        created: state.created,
        model: state.model,
        choices: [{ index: 0, delta: { content: footnotes }, finish_reason: null }],
      };
      chunksToEmit.push(`data: ${JSON.stringify(footnoteChunk)}\n\n`);
    }

    if (state.isThinking) {
      const closeThinkChunk = {
        id: state.id,
        object: 'chat.completion.chunk',
        created: state.created,
        model: state.model,
        choices: [{ index: 0, delta: { content: '\n</think>\n\n' }, finish_reason: null }],
      };
      chunksToEmit.push(`data: ${JSON.stringify(closeThinkChunk)}\n\n`);
      state.isThinking = false;
    }
    let finish_reason: string;
    if (candidate.finishReason === 'MAX_TOKENS') finish_reason = 'length';
    else if (candidate.finishReason === 'TOOL_USE') finish_reason = 'tool_calls';
    else finish_reason = 'stop';
    const finishChunk = {
      id: state.id,
      object: 'chat.completion.chunk',
      created: state.created,
      model: state.model,
      choices: [{ index: 0, delta: {}, finish_reason }],
    };
    chunksToEmit.push(`data: ${JSON.stringify(finishChunk)}\n\n`);
  }

  return chunksToEmit.length > 0 ? chunksToEmit.join('') : null;
}
