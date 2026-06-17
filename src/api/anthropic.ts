import { StandardRequest, StandardResponse, AnthropicRequest } from './types.js';
import { convertAnthropicToGoogle } from '../format/request-converter.js';
import { convertGoogleToAnthropic } from '../format/response-converter.js';

export function parseAnthropicRequest(body: unknown): StandardRequest {
  if (!body || typeof body !== 'object') {
    throw new Error('invalid_request_error: Invalid body');
  }
  const req = body as AnthropicRequest;
  if (!req.model) {
    throw new Error('invalid_request_error: Missing model');
  }
  if (!req.messages || !Array.isArray(req.messages)) {
    throw new Error('invalid_request_error: messages is required and must be an array');
  }

  return convertAnthropicToGoogle(req);
}

export function formatAnthropicResponse(res: StandardResponse, model: string): object {
  return convertGoogleToAnthropic(res, model);
}

