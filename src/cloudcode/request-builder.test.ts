import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildCloudCodeRequestFromStandard } from './request-builder.js';
import { ANTIGRAVITY_SYSTEM_INSTRUCTION } from '../constants.js';

vi.mock('./session-manager.js', () => ({
  deriveSessionId: vi.fn(() => 'mock-session-id')
}));

describe('buildCloudCodeRequestFromStandard', () => {
  it('returns a payload with project, model, request, userAgent, requestType, requestId fields', () => {
    const stdReq = { model: 'test-model', contents: [], generationConfig: {} };
    const payload = buildCloudCodeRequestFromStandard(stdReq, 'project-123', 'test@test.com');
    expect(payload.project).toBe('project-123');
    expect(payload.model).toBe('test-model');
    expect(payload.userAgent).toBe('antigravity');
    expect(payload.requestType).toBe('agent');
    expect(payload.requestId).toBeDefined();
    expect(payload.request).toBeDefined();
  });

  it('sets requestId to a string beginning with "agent-"', () => {
    const stdReq = { model: 'test-model', contents: [], generationConfig: {} };
    const payload = buildCloudCodeRequestFromStandard(stdReq, 'project-123', 'test@test.com');
    expect(payload.requestId.startsWith('agent-')).toBe(true);
  });

  it('injects the Cloud Code systemInstruction as the first part', () => {
    const stdReq = { model: 'test-model', contents: [], generationConfig: {} };
    const payload = buildCloudCodeRequestFromStandard(stdReq, 'project-123', 'test@test.com');
    expect(payload.request.systemInstruction.parts[0].text).toBe(ANTIGRAVITY_SYSTEM_INSTRUCTION);
  });

  it('appends the user-provided systemInstruction parts after the Cloud Code instruction', () => {
    const stdReq = {
      model: 'test-model', contents: [], generationConfig: {},
      systemInstruction: { parts: [{ text: 'user prompt' }] }
    };
    const payload = buildCloudCodeRequestFromStandard(stdReq, 'project-123', 'test@test.com');
    const parts = payload.request.systemInstruction.parts;
    expect(parts.length).toBeGreaterThan(2);
    expect(parts[parts.length - 1].text).toBe('user prompt');
  });

  it('uses an empty system part list when StandardRequest has no systemInstruction', () => {
    const stdReq = { model: 'test-model', contents: [], generationConfig: {} };
    const payload = buildCloudCodeRequestFromStandard(stdReq, 'project-123', 'test@test.com');
    expect(payload.request.systemInstruction.parts).toHaveLength(2); // Only antigravity system parts
  });

  it('sets request.sessionId from deriveSessionId', () => {
    const stdReq = { model: 'test-model', contents: [], generationConfig: {} };
    const payload = buildCloudCodeRequestFromStandard(stdReq, 'project-123', 'test@test.com');
    expect(payload.request.sessionId).toBe('mock-session-id');
  });

  it('preserves StandardRequest contents, generationConfig, and tools in payload.request', () => {
    const stdReq = {
      model: 'test-model',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      generationConfig: { temperature: 0.5 },
      tools: [{ functionDeclarations: [{ name: 'f1' }] }]
    };
    const payload = buildCloudCodeRequestFromStandard(stdReq, 'project-123', 'test@test.com');
    expect(payload.request.contents).toEqual(stdReq.contents);
    expect(payload.request.generationConfig).toEqual(stdReq.generationConfig);
    expect(payload.request.tools).toEqual(stdReq.tools);
  });

  it('sets payload.project to null when projectId is null', () => {
    const stdReq = { model: 'test-model', contents: [], generationConfig: {} };
    const payload = buildCloudCodeRequestFromStandard(stdReq, null, 'test@test.com');
    expect(payload.project).toBeNull();
  });
});

describe('buildCloudCodeRequestFromStandard identity scrubbing', () => {
  const buildWithSystemText = (...texts: string[]): string[] => {
    const stdReq = {
      model: 'test-model', contents: [], generationConfig: {},
      systemInstruction: { parts: texts.map((text) => ({ text })) }
    };
    const payload = buildCloudCodeRequestFromStandard(stdReq, 'project-123', 'test@test.com');
    // Drop the two injected Antigravity parts; keep only caller-supplied parts
    return payload.request.systemInstruction.parts.slice(2).map((part: { text: string }) => part.text);
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('replaces default third-party identities in caller system parts', () => {
    const [text] = buildWithSystemText('You are Hermes Agent, created by Nous Research.');
    expect(text).toBe('You are the assistant, created by the assistant team.');
  });

  it('replaces every occurrence of a term', () => {
    const [text] = buildWithSystemText('Hermes talks to Hermes.');
    expect(text).toBe('the assistant talks to the assistant.');
  });

  it('scrubs each caller-supplied part independently', () => {
    const texts = buildWithSystemText('Nous Research', 'plain', 'Hermes');
    expect(texts).toEqual(['the assistant team', 'plain', 'the assistant']);
  });

  it('leaves unrelated system text unchanged', () => {
    const [text] = buildWithSystemText('You are a helpful coding assistant.');
    expect(text).toBe('You are a helpful coding assistant.');
  });

  it('does not scrub the injected Antigravity instruction parts', () => {
    vi.stubEnv('ANTIGRAVITY_SCRUB_IDENTITY', 'Antigravity=>Other');
    const stdReq = { model: 'test-model', contents: [], generationConfig: {} };
    const payload = buildCloudCodeRequestFromStandard(stdReq, 'project-123', 'test@test.com');
    expect(payload.request.systemInstruction.parts[0].text).toBe(ANTIGRAVITY_SYSTEM_INSTRUCTION);
  });

  it('applies custom rules from ANTIGRAVITY_SCRUB_IDENTITY', () => {
    vi.stubEnv('ANTIGRAVITY_SCRUB_IDENTITY', 'Acme Bot=>the helper, Acme Corp => the company');
    const [text] = buildWithSystemText('Acme Bot is made by Acme Corp.');
    expect(text).toBe('the helper is made by the company.');
  });

  it('keeps default rules when custom rules are supplied', () => {
    vi.stubEnv('ANTIGRAVITY_SCRUB_IDENTITY', 'Acme Bot=>the helper');
    const [text] = buildWithSystemText('Acme Bot by Nous Research');
    expect(text).toBe('the helper by the assistant team');
  });

  it('allows an empty replacement', () => {
    vi.stubEnv('ANTIGRAVITY_SCRUB_IDENTITY', 'Acme=>');
    const [text] = buildWithSystemText('Acme tools');
    expect(text).toBe(' tools');
  });

  it('ignores malformed pairs and empty terms in the env var', () => {
    vi.stubEnv('ANTIGRAVITY_SCRUB_IDENTITY', 'no-separator,=>orphan,Valid=>ok');
    const [text] = buildWithSystemText('no-separator Valid orphan');
    expect(text).toBe('no-separator ok orphan');
  });

  it('reads the env var on each request', () => {
    vi.stubEnv('ANTIGRAVITY_SCRUB_IDENTITY', 'First=>1');
    expect(buildWithSystemText('First Second')).toEqual(['1 Second']);

    vi.stubEnv('ANTIGRAVITY_SCRUB_IDENTITY', 'Second=>2');
    expect(buildWithSystemText('First Second')).toEqual(['First 2']);
  });
});
