import { StandardRequest, StandardResponse, StandardStreamChunk, GContent, GPart } from './types.js';

export function parseOpenAIRequest(req: any): StandardRequest {
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
      .filter((t: any) => t.type === 'function')
      .map((t: any) => ({
        name: t.function.name,
        description: t.function.description || '',
        parameters: t.function.parameters || { type: 'object' },
      }));
    if (functionDeclarations.length > 0) {
      standardReq.tools = [{ functionDeclarations }];
    }
  }

  if (req.tool_choice) {
    if (req.tool_choice === 'auto') {
      standardReq.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
    } else if (req.tool_choice === 'none') {
      standardReq.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
    } else if (req.tool_choice === 'required') {
      standardReq.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
    } else if (typeof req.tool_choice === 'object' && req.tool_choice.type === 'function') {
      standardReq.toolConfig = {
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: [req.tool_choice.function.name],
        },
      };
    }
  }

  return standardReq;
}

export function formatOpenAIResponse(res: StandardResponse, model: string): object {
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
  const tool_calls: any[] = [];
  
  for (const part of parts) {
    if (part.text) {
      content += part.text;
    } else if (part.functionCall) {
      tool_calls.push({
        id: `call_${crypto.randomUUID().replace(/-/g, '').substring(0, 24)}`,
        type: 'function',
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args),
        },
      });
    }
  }

  let finish_reason = 'stop';
  if (candidate.finishReason === 'MAX_TOKENS') finish_reason = 'length';
  else if (candidate.finishReason === 'TOOL_USE' || tool_calls.length > 0) finish_reason = 'tool_calls';

  const message: any = { role: 'assistant', content };
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
  hasEmittedRole: boolean;
  toolCallIndex: number;
}

export function formatOpenAIStreamChunk(chunk: StandardStreamChunk, state: OpenAIStreamState): string | null {
  const innerResponse = (chunk as any).response || chunk;
  const candidates = innerResponse.candidates || [];
  if (candidates.length === 0) return null;

  const candidate = candidates[0];
  const parts = candidate.content?.parts || [];
  let chunksToEmit: string[] = [];

  const baseChunk = {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'model',
    choices: [{ index: 0, delta: {} as any, finish_reason: null }],
  };

  if (!state.hasEmittedRole && parts.length > 0) {
    state.hasEmittedRole = true;
    baseChunk.choices[0].delta.role = 'assistant';
  }

  for (const part of parts) {
    if (part.thought) continue; // Suppress thinking

    if (part.text) {
      const textChunk = JSON.parse(JSON.stringify(baseChunk));
      textChunk.choices[0].delta.content = part.text;
      chunksToEmit.push(`data: ${JSON.stringify(textChunk)}\n\n`);
    } else if (part.functionCall) {
      const toolChunk = JSON.parse(JSON.stringify(baseChunk));
      toolChunk.choices[0].delta.tool_calls = [{
        index: state.toolCallIndex,
        id: `call_${crypto.randomUUID().replace(/-/g, '').substring(0, 24)}`,
        type: 'function',
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args),
        },
      }];
      chunksToEmit.push(`data: ${JSON.stringify(toolChunk)}\n\n`);
      state.toolCallIndex++;
    }
  }

  if (candidate.finishReason) {
    const finishChunk = JSON.parse(JSON.stringify(baseChunk));
    if (candidate.finishReason === 'MAX_TOKENS') finishChunk.choices[0].finish_reason = 'length';
    else if (candidate.finishReason === 'TOOL_USE') finishChunk.choices[0].finish_reason = 'tool_calls';
    else finishChunk.choices[0].finish_reason = 'stop';
    chunksToEmit.push(`data: ${JSON.stringify(finishChunk)}\n\n`);
    chunksToEmit.push('data: [DONE]\n\n');
  }

  return chunksToEmit.length > 0 ? chunksToEmit.join('') : null;
}
