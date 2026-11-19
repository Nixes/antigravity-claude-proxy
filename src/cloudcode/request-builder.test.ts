import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildCloudCodeRequest, buildCloudCodeRequestFromStandard } from './request-builder.js';
import { deriveSessionId } from './session-manager.js';
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

  it('injects only the two Cloud Code Antigravity systemInstruction parts', () => {
    const stdReq = {
      model: 'test-model',
      contents: [{ role: 'user' as const, parts: [{ text: 'hi' }] }],
      generationConfig: {},
      systemInstruction: { parts: [{ text: 'user prompt' }] }
    };
    const payload = buildCloudCodeRequestFromStandard(stdReq, 'project-123', 'test@test.com');
    expect(payload.request.systemInstruction?.parts).toHaveLength(2);
    expect(payload.request.systemInstruction?.parts[0].text).toBe(ANTIGRAVITY_SYSTEM_INSTRUCTION);
    expect(payload.request.systemInstruction?.parts[1].text).toContain(ANTIGRAVITY_SYSTEM_INSTRUCTION);
  });

  it('uses only the two Antigravity system parts when StandardRequest has no systemInstruction', () => {
    const stdReq = { model: 'test-model', contents: [], generationConfig: {} };
    const payload = buildCloudCodeRequestFromStandard(stdReq, 'project-123', 'test@test.com');
    expect(payload.request.systemInstruction?.parts).toHaveLength(2);
    expect(payload.request.contents).toEqual([]);
  });

  it('sets request.sessionId from deriveSessionId before prepending <system-instructions>', () => {
    const deriveMock = vi.mocked(deriveSessionId);
    deriveMock.mockClear();
    let seenPartsDuringSessionDerivation: Array<{ text?: string }> = [];
    deriveMock.mockImplementationOnce((req) => {
      const typed = req as { contents?: Array<{ parts?: Array<{ text?: string }> }> };
      seenPartsDuringSessionDerivation = JSON.parse(JSON.stringify(typed?.contents?.[0]?.parts || []));
      return 'mock-session-id';
    });

    const stdReq = {
      model: 'test-model',
      contents: [{ role: 'user' as const, parts: [{ text: 'actual prompt' }] }],
      generationConfig: {},
      systemInstruction: { parts: [{ text: 'dynamic system instructions' }] }
    };
    const payload = buildCloudCodeRequestFromStandard(stdReq, 'project-123', 'test@test.com');
    expect(payload.request.sessionId).toBe('mock-session-id');
    expect(seenPartsDuringSessionDerivation).toEqual([{ text: 'actual prompt' }]);
    expect(payload.request.contents[0].parts[0].text).toContain('<system-instructions>');
  });

  it('preserves StandardRequest contents, generationConfig, and tools in payload.request', () => {
    const stdReq = {
      model: 'test-model',
      contents: [{ role: 'user' as const, parts: [{ text: 'hi' }] }],
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

describe('caller system prompt placement (#408, #410)', () => {
  const TRIGGER = 'IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts.';

  it('keeps caller system prompt out of systemInstruction and prepends it to the first user turn', () => {
    const payload = buildCloudCodeRequest(
      {
        model: 'gemini-3.8-flash-high',
        max_tokens: 64,
        system: TRIGGER,
        messages: [{ role: 'user', content: 'hi' }]
      },
      'project-id',
      'test@example.com'
    );

    const sysText = payload.request.systemInstruction?.parts.map((p) => p.text).join('\n') || '';
    expect(sysText).not.toContain('security testing');
    expect(sysText).toContain(ANTIGRAVITY_SYSTEM_INSTRUCTION);

    expect(payload.request.contents).toHaveLength(1);
    const [first] = payload.request.contents;
    expect(first.role).toBe('user');
    expect(first.parts).toHaveLength(2);
    expect(first.parts[0].text).toBe(`<system-instructions>\n${TRIGGER}\n</system-instructions>`);
    expect(first.parts[1].text).toBe('hi');
  });

  it('joins multiple system blocks into one <system-instructions> part', () => {
    const payload = buildCloudCodeRequest(
      {
        model: 'gemini-3.8-flash-high',
        system: [{ type: 'text', text: 'Block one.' }, { type: 'text', text: 'Block two.' }],
        messages: [{ role: 'user', content: 'hi' }]
      },
      'project-id',
      'test@example.com'
    );

    expect(payload.request.contents[0].parts[0].text).toBe(
      '<system-instructions>\nBlock one.\n\nBlock two.\n</system-instructions>'
    );
  });

  it('leaves contents untouched when there is no system prompt or only a billing header', () => {
    const noSys = buildCloudCodeRequest(
      { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'hi' }] },
      'project-id',
      'test@example.com'
    );
    expect(noSys.request.contents[0].parts).toEqual([{ text: 'hi' }]);

    const billingOnly = buildCloudCodeRequest(
      {
        model: 'gemini-3.8-flash-high',
        system: 'x-anthropic-billing-header: cc_version=2.1.325; cc_entrypoint=sdk-cli;',
        messages: [{ role: 'user', content: 'hi' }]
      },
      'project-id',
      'test@example.com'
    );
    expect(billingOnly.request.contents[0].parts).toEqual([{ text: 'hi' }]);
  });

  it('strips billing header defensively in buildCloudCodeRequestFromStandard (OpenAI path)', () => {
    const stdReq = {
      model: 'gemini-3.8-flash-high',
      contents: [{ role: 'user' as const, parts: [{ text: 'hi' }] }],
      generationConfig: {},
      systemInstruction: {
        parts: [{ text: 'x-anthropic-billing-header: cc_version=2.1.325;\nBe concise.' }]
      }
    };
    const payload = buildCloudCodeRequestFromStandard(stdReq, 'project-id', 'test@example.com');
    expect(payload.request.contents[0].parts[0].text).toBe(
      '<system-instructions>\nBe concise.\n</system-instructions>'
    );
  });

  it('keeps image after the prepended system part in an image-first user turn', () => {
    const payload = buildCloudCodeRequest(
      {
        model: 'gemini-3.8-flash-high',
        system: 'Be brief.',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
              { type: 'text', text: 'what is this' }
            ]
          }
        ]
      },
      'project-id',
      'test@example.com'
    );

    const parts = payload.request.contents[0].parts;
    expect(parts[0].text).toBe('<system-instructions>\nBe brief.\n</system-instructions>');
    expect(parts[1].inlineData).toBeDefined();
  });

  it('inserts a leading user turn when conversation is empty or starts with a model turn', () => {
    const emptyReq = buildCloudCodeRequestFromStandard(
      {
        model: 'test-model',
        contents: [],
        generationConfig: {},
        systemInstruction: { parts: [{ text: 'Be brief.' }] }
      },
      'project-id',
      'test@example.com'
    );
    expect(emptyReq.request.contents).toEqual([
      { role: 'user', parts: [{ text: '<system-instructions>\nBe brief.\n</system-instructions>' }] }
    ]);

    const modelFirst = buildCloudCodeRequest(
      {
        model: 'gemini-3.8-flash-high',
        system: 'Be brief.',
        messages: [
          { role: 'assistant', content: 'Hello.' },
          { role: 'user', content: 'hi' }
        ]
      },
      'project-id',
      'test@example.com'
    );
    expect(modelFirst.request.contents[0].role).toBe('user');
    expect(modelFirst.request.contents[0].parts[0].text).toBe('<system-instructions>\nBe brief.\n</system-instructions>');
    expect(modelFirst.request.contents[1].role).toBe('model');
  });

  it('does not mix system part with a functionResponse-first user turn', () => {
    const payload = buildCloudCodeRequest(
      {
        model: 'gemini-3.8-flash-high',
        system: 'Be brief.',
        messages: [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }]
          }
        ]
      },
      'project-id',
      'test@example.com'
    );

    expect(payload.request.contents[0].parts).toEqual([
      { text: '<system-instructions>\nBe brief.\n</system-instructions>' }
    ]);
    expect(payload.request.contents[1].parts[0].functionResponse).toBeDefined();
  });
});

describe('buildCloudCodeRequestFromStandard identity scrubbing (#364, #401, #404)', () => {
  const buildWithSystemText = (...texts: string[]): string => {
    const stdReq = {
      model: 'test-model',
      contents: [{ role: 'user' as const, parts: [{ text: 'hi' }] }],
      generationConfig: {},
      systemInstruction: { parts: texts.map((text) => ({ text })) }
    };
    const payload = buildCloudCodeRequestFromStandard(stdReq, 'project-123', 'test@test.com');
    return payload.request.contents[0].parts[0].text || '';
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('replaces Hermes, Nous Research, Claude Code, and Anthropic in caller system parts', () => {
    const out = buildWithSystemText("You are Hermes Agent, created by Nous Research. You are Claude Code, Anthropic's official CLI for Claude.");
    expect(out).toBe(
      "<system-instructions>\nYou are the assistant, created by the assistant team. You are the assistant, the vendor's official CLI for Claude.\n</system-instructions>"
    );
  });

  it('preserves bare Claude, lowercase headers, and CLAUDE.md references', () => {
    const out = buildWithSystemText('Read CLAUDE.md. Send x-anthropic-beta and anthropic-version headers for Claude.');
    expect(out).toContain('Read CLAUDE.md. Send x-anthropic-beta and anthropic-version headers for Claude.');
  });

  it('matches whole words only so identifiers containing scrubbed terms are untouched', () => {
    const text = 'Use convertAnthropicToGoogle() and AnthropicRequest types. See HermesHandler.';
    expect(buildWithSystemText(text)).toContain(text);
  });

  it('scrubs possessive and punctuated occurrences', () => {
    const out = buildWithSystemText("Claude Code's docs (Anthropic). Ask Hermes.");
    expect(out).not.toContain('Claude Code');
    expect(out).not.toContain('Anthropic');
    expect(out).not.toContain('Hermes');
    expect(out).toContain("the assistant's docs (the vendor). Ask the assistant.");
  });

  it('scrubs each caller-supplied part independently', () => {
    const out = buildWithSystemText('Nous Research', 'plain', 'Hermes');
    expect(out).toBe('<system-instructions>\nthe assistant team\n\nplain\n\nthe assistant\n</system-instructions>');
  });

  it('does not scrub the injected Antigravity instruction parts', () => {
    vi.stubEnv('ANTIGRAVITY_SCRUB_IDENTITY', 'Antigravity=>Other');
    const stdReq = { model: 'test-model', contents: [], generationConfig: {} };
    const payload = buildCloudCodeRequestFromStandard(stdReq, 'project-123', 'test@test.com');
    expect(payload.request.systemInstruction?.parts[0].text).toBe(ANTIGRAVITY_SYSTEM_INSTRUCTION);
  });

  it('applies custom rules from ANTIGRAVITY_SCRUB_IDENTITY and treats $ literally', () => {
    vi.stubEnv('ANTIGRAVITY_SCRUB_IDENTITY', 'Acme Bot=>the $1 helper, Acme Corp => the company');
    const out = buildWithSystemText('Acme Bot is made by Acme Corp.');
    expect(out).toContain('the $1 helper is made by the company.');
  });

  it('keeps default rules when custom rules are supplied', () => {
    vi.stubEnv('ANTIGRAVITY_SCRUB_IDENTITY', 'Acme Bot=>the helper');
    const out = buildWithSystemText('Acme Bot by Nous Research');
    expect(out).toContain('the helper by the assistant team');
  });

  it('allows an empty replacement and ignores malformed pairs', () => {
    vi.stubEnv('ANTIGRAVITY_SCRUB_IDENTITY', 'no-separator,=>orphan,Acme=>,Valid=>ok');
    const out = buildWithSystemText('no-separator Valid Acme tools orphan');
    expect(out).toContain('no-separator ok  tools orphan');
  });

  it('reads ANTIGRAVITY_SCRUB_IDENTITY on each request', () => {
    vi.stubEnv('ANTIGRAVITY_SCRUB_IDENTITY', 'First=>1');
    expect(buildWithSystemText('First Second')).toContain('1 Second');

    vi.stubEnv('ANTIGRAVITY_SCRUB_IDENTITY', 'Second=>2');
    expect(buildWithSystemText('First Second')).toContain('First 2');
  });

  it('allows overriding defaults and extending with longer phrases containing default terms', () => {
    vi.stubEnv('ANTIGRAVITY_SCRUB_IDENTITY', 'Anthropic=>CustomCorp,Anthropic Labs=>MyLab');
    expect(buildWithSystemText('Anthropic and Anthropic Labs')).toContain('CustomCorp and MyLab');
  });

  it('scrubs non-word-bounded custom terms without corrupting identifiers or emails', () => {
    vi.stubEnv('ANTIGRAVITY_SCRUB_IDENTITY', 'C++=>Rust,@acme=>@team,.claude=>.config');
    const out = buildWithSystemText('Use C++, @acme, and .claude! Keep user@acme.com and foo.claude.');
    expect(out).toContain('Use Rust, @team, and .config! Keep user@acme.com and foo.claude.');
  });

  it('omits <system-instructions> when scrubbing leaves only whitespace and isolates mixed functionResponse turns', () => {
    vi.stubEnv('ANTIGRAVITY_SCRUB_IDENTITY', 'Secret=>');
    const scrubbedEmptyPayload = buildCloudCodeRequestFromStandard(
      {
        model: 'test-model',
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
        generationConfig: {},
        systemInstruction: { parts: [{ text: 'Secret' }] }
      },
      'project-123',
      'test@test.com'
    );
    expect(scrubbedEmptyPayload.request.contents).toEqual([{ role: 'user', parts: [{ text: 'hello' }] }]);

    const mixedTurnPayload = buildCloudCodeRequestFromStandard(
      {
        model: 'test-model',
        contents: [{
          role: 'user',
          parts: [
            { text: 'note' },
            { functionResponse: { name: 'fn', response: { ok: true } } }
          ]
        }],
        generationConfig: {},
        systemInstruction: { parts: [{ text: 'Be brief.' }] }
      },
      'project-123',
      'test@test.com'
    );
    expect(mixedTurnPayload.request.contents).toHaveLength(2);
    expect(mixedTurnPayload.request.contents[0].parts).toEqual([{ text: '<system-instructions>\nBe brief.\n</system-instructions>' }]);
    expect(mixedTurnPayload.request.contents[1].parts[1].functionResponse).toBeDefined();
  });
});
