import { StandardRequest, StandardResponse, StandardStreamChunk } from './types.js';
import { convertAnthropicToGoogle } from '../format/request-converter.js';
import { convertGoogleToAnthropic } from '../format/response-converter.js';

export function parseAnthropicRequest(body: unknown): StandardRequest {
  if (!body || typeof body !== 'object') {
    throw new Error('invalid_request_error: Invalid body');
  }
  if (!(body as any).model) {
    throw new Error('invalid_request_error: Missing model');
  }
  if (!(body as any).messages || !Array.isArray((body as any).messages)) {
    throw new Error('invalid_request_error: messages is required and must be an array');
  }

  return convertAnthropicToGoogle(body);
}

export function formatAnthropicResponse(res: StandardResponse, model: string): object {
  return convertGoogleToAnthropic(res, model);
}

export interface AnthropicStreamState {
  model: string;
  hasEmittedStart: boolean;
  blockIndex: number;
}

export function formatAnthropicStreamChunk(chunk: StandardStreamChunk, state: AnthropicStreamState): string | null {
  const innerResponse = (chunk as any).response || chunk;
  const candidates = innerResponse.candidates || [];
  if (candidates.length === 0) return null;

  const candidate = candidates[0];
  const parts = candidate.content?.parts || [];
  let chunksToEmit: string[] = [];

  if (!state.hasEmittedStart && parts.length > 0) {
    state.hasEmittedStart = true;
    chunksToEmit.push(
      `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: `msg_${crypto.randomUUID().replace(/-/g, '').substring(0, 24)}`,
          type: 'message',
          role: 'assistant',
          content: [],
          model: state.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      })}\n\n`
    );

    // Also emit content_block_start
    chunksToEmit.push(
      `event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index: state.blockIndex,
        content_block: { type: 'text', text: '' }
      })}\n\n`
    );
  }

  for (const part of parts) {
    if (part.text) {
      chunksToEmit.push(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: 'content_block_delta',
          index: state.blockIndex,
          delta: { type: 'text_delta', text: part.text }
        })}\n\n`
      );
    }
  }

  if (candidate.finishReason) {
    chunksToEmit.push(
      `event: content_block_stop\ndata: ${JSON.stringify({
        type: 'content_block_stop',
        index: state.blockIndex
      })}\n\n`
    );

    let stop_reason = 'end_turn';
    if (candidate.finishReason === 'MAX_TOKENS') stop_reason = 'max_tokens';

    chunksToEmit.push(
      `event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason, stop_sequence: null },
        usage: { output_tokens: 0 }
      })}\n\n`
    );

    chunksToEmit.push(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
  }

  return chunksToEmit.length > 0 ? chunksToEmit.join('') : null;
}
