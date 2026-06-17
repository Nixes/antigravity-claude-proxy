import { StandardRequest, StandardResponse } from './types.js';
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

