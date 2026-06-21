// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';
import { buildCloudCodeRequestFromStandard } from './request-builder.js';
import { ANTIGRAVITY_SYSTEM_INSTRUCTION } from '../constants.js';

vi.mock('./session-manager.js', () => ({
  deriveSessionId: vi.fn(() => 'mock-session-id')
}));

describe('buildCloudCodeRequestFromStandard', () => {
  it('returns a payload with project, model, request, userAgent, requestType, requestId fields', () => {
    const stdReq = { model: 'test-model', contents: [], generationConfig: {} };
    const payload: any = buildCloudCodeRequestFromStandard(stdReq, 'project-123', 'test@test.com');
    expect(payload.project).toBe('project-123');
    expect(payload.model).toBe('test-model');
    expect(payload.userAgent).toBe('antigravity');
    expect(payload.requestType).toBe('agent');
    expect(payload.requestId).toBeDefined();
    expect(payload.request).toBeDefined();
  });

  it('sets requestId to a string beginning with "agent-"', () => {
    const stdReq = { model: 'test-model', contents: [], generationConfig: {} };
    const payload: any = buildCloudCodeRequestFromStandard(stdReq, 'project-123', 'test@test.com');
    expect(payload.requestId.startsWith('agent-')).toBe(true);
  });

  it('injects the Cloud Code systemInstruction as the first part', () => {
    const stdReq = { model: 'test-model', contents: [], generationConfig: {} };
    const payload: any = buildCloudCodeRequestFromStandard(stdReq, 'project-123', 'test@test.com');
    expect(payload.request.systemInstruction.parts[0].text).toBe(ANTIGRAVITY_SYSTEM_INSTRUCTION);
  });

  it('appends the user-provided systemInstruction parts after the Cloud Code instruction', () => {
    const stdReq = {
      model: 'test-model', contents: [], generationConfig: {},
      systemInstruction: { parts: [{ text: 'user prompt' }] }
    };
    const payload: any = buildCloudCodeRequestFromStandard(stdReq, 'project-123', 'test@test.com');
    const parts = payload.request.systemInstruction.parts;
    expect(parts.length).toBeGreaterThan(2);
    expect(parts[parts.length - 1].text).toBe('user prompt');
  });

  it('uses an empty system part list when StandardRequest has no systemInstruction', () => {
    const stdReq = { model: 'test-model', contents: [], generationConfig: {} };
    const payload: any = buildCloudCodeRequestFromStandard(stdReq, 'project-123', 'test@test.com');
    expect(payload.request.systemInstruction.parts).toHaveLength(2); // Only antigravity system parts
  });

  it('sets request.sessionId from deriveSessionId', () => {
    const stdReq = { model: 'test-model', contents: [], generationConfig: {} };
    const payload: any = buildCloudCodeRequestFromStandard(stdReq, 'project-123', 'test@test.com');
    expect(payload.request.sessionId).toBe('mock-session-id');
  });

  it('preserves StandardRequest contents, generationConfig, and tools in payload.request', () => {
    const stdReq = {
      model: 'test-model',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      generationConfig: { temperature: 0.5 },
      tools: [{ functionDeclarations: [{ name: 'f1' }] }]
    };
    const payload: any = buildCloudCodeRequestFromStandard(stdReq, 'project-123', 'test@test.com');
    expect(payload.request.contents).toEqual(stdReq.contents);
    expect(payload.request.generationConfig).toEqual(stdReq.generationConfig);
    expect(payload.request.tools).toEqual(stdReq.tools);
  });

  it('sets payload.project to null when projectId is null', () => {
    const stdReq = { model: 'test-model', contents: [], generationConfig: {} };
    const payload: any = buildCloudCodeRequestFromStandard(stdReq, null, 'test@test.com');
    expect(payload.project).toBeNull();
  });
});
