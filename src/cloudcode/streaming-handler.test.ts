/**
 * Tests for sendMessageStreamStandard in streaming-handler.ts
 *
 * These tests specifically cover bugs found during the OpenAI compatibility audit:
 *
 * BUG 1: sendMessageStreamStandard was calling `streamSSEResponse(response, anthropicRequest.model)`
 *         where `anthropicRequest` is undefined — this would crash at runtime. The function must
 *         parse raw Google SSE and yield native Google JSON chunks.
 *
 * BUG 2: The end-of-retries fallback block referenced `anthropicRequest` (undefined) and called
 *         `sendMessageStream` (the Anthropic-format version) instead of `sendMessageStreamStandard`.
 *
 * These are tested by mocking the fetch layer and verifying:
 *   - The generator yields raw Google-native JSON objects (not Anthropic-format events)
 *   - The function does not throw a ReferenceError for undefined `anthropicRequest`
 *   - The yielded objects come directly from the SSE stream without re-formatting
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StandardRequest } from '../api/types.js';

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

// vi.mock is automatically hoisted to the top of the file by Vitest/esbuild,
// so this mock is applied before any module import.
vi.mock('../utils/helpers.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../utils/helpers.js')>();
  return {
    ...original,
    // Provide a spy; individual tests configure the resolved value.
    throttledFetch: vi.fn(),
    // Do NOT sleep in tests
    sleep: vi.fn().mockResolvedValue(undefined),
  };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeStandardRequest(overrides: Partial<StandardRequest> = {}): StandardRequest {
  return {
    model: 'claude-opus-4-5',
    contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    generationConfig: {},
    ...overrides,
  };
}

function makeSseBody(chunks: object[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines));
      controller.close();
    },
  });
}

function makeOkSseResponse(chunks: object[]): Response {
  return {
    ok: true,
    status: 200,
    body: makeSseBody(chunks),
  } as unknown as Response;
}

function makeAccountManager() {
  const account = { email: 'test@example.com', subscription: { projectId: 'proj-1' } };
  return {
    getAccountCount: () => 1,
    clearExpiredLimits: vi.fn(),
    getAvailableAccounts: () => [account],
    isAllAccountsInvalid: () => false,
    isAllRateLimited: () => false,
    getMinWaitTimeMs: () => 0,
    selectAccount: () => ({ account, waitMs: 0 }),
    getTokenForAccount: vi.fn().mockResolvedValue('fake-token'),
    getProjectForAccount: vi.fn().mockResolvedValue('proj-1'),
    notifySuccess: vi.fn(),
    notifyRateLimit: vi.fn(),
    notifyFailure: vi.fn(),
    markRateLimited: vi.fn(),
    markInvalid: vi.fn(),
    clearTokenCache: vi.fn(),
    clearProjectCache: vi.fn(),
    incrementConsecutiveFailures: vi.fn(),
    getConsecutiveFailures: vi.fn().mockReturnValue(0),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('sendMessageStreamStandard', () => {
  // Import the module once (mocks are already applied by vi.mock hoisting)
  let sendMessageStreamStandard: typeof import('./streaming-handler.js').sendMessageStreamStandard;
  let throttledFetch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetAllMocks();
    const handler = await import('./streaming-handler.js');
    sendMessageStreamStandard = handler.sendMessageStreamStandard;
    const helpers = await import('../utils/helpers.js');
    throttledFetch = helpers.throttledFetch as ReturnType<typeof vi.fn>;
    // Re-mock sleep to be instant in all tests
    (helpers.sleep as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  it('regression: does NOT throw ReferenceError for undefined anthropicRequest — yields Google-native chunks', async () => {
    /**
     * REGRESSION TEST for BUG 1:
     * The original code called `streamSSEResponse(response, anthropicRequest.model)` inside
     * sendMessageStreamStandard. Since `anthropicRequest` is not a parameter of that function,
     * this would throw: ReferenceError: anthropicRequest is not defined
     *
     * The fix: parse raw SSE and yield Google JSON chunks directly.
     */
    const googleChunk = {
      candidates: [{ content: { parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
    };
    throttledFetch.mockResolvedValue(makeOkSseResponse([googleChunk]));

    const chunks: Array<StandardStreamChunk> = [];
    let threw: Error | null = null;
    try {
      for await (const chunk of sendMessageStreamStandard(makeStandardRequest(), makeAccountManager(), false)) {
        chunks.push(chunk);
      }
    } catch (e: unknown) {
      threw = e;
    }

    // Must not be a ReferenceError
    if (threw) {
      expect(threw).not.toBeInstanceOf(ReferenceError);
      expect(threw.message).not.toMatch(/anthropicRequest is not defined/i);
    }
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('regression: yields raw Google-native JSON objects, NOT Anthropic-format events', async () => {
    /**
     * REGRESSION TEST for BUG 1 (continued):
     * The old code piped through `streamSSEResponse` which yields Anthropic-format events
     * (objects with `type: "content_block_delta"` etc). The new code must yield the raw
     * Google response JSON with `candidates` array.
     */
    const googleChunk = {
      candidates: [{ content: { parts: [{ text: 'world' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
    };
    throttledFetch.mockResolvedValue(makeOkSseResponse([googleChunk]));

    const chunks: Array<StandardStreamChunk> = [];
    for await (const chunk of sendMessageStreamStandard(makeStandardRequest(), makeAccountManager(), false)) {
      chunks.push(chunk);
    }

    // Must have Google-format candidates, NOT Anthropic type fields
    expect(chunks[0]).toHaveProperty('candidates');
    expect(chunks[0]).not.toHaveProperty('type'); // Anthropic has type: "message_start" etc
  });

  it('yields each SSE data line as a separate chunk', async () => {
    const chunk1 = { candidates: [{ content: { parts: [{ text: 'foo' }] } }] };
    const chunk2 = {
      candidates: [{ content: { parts: [{ text: 'bar' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
    };
    throttledFetch.mockResolvedValue(makeOkSseResponse([chunk1, chunk2]));

    const chunks: Array<StandardStreamChunk> = [];
    for await (const chunk of sendMessageStreamStandard(makeStandardRequest(), makeAccountManager(), false)) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0].candidates[0].content.parts[0].text).toBe('foo');
    expect(chunks[1].candidates[0].content.parts[0].text).toBe('bar');
  });

  it('regression: end-of-retries error is exhaustion error, NOT a ReferenceError about anthropicRequest', async () => {
    /**
     * REGRESSION TEST for BUG 2:
     * The original fallback block did:
     *   const fallbackRequest = { ...anthropicRequest, model: fallbackModel };
     *   yield* sendMessageStream(fallbackRequest, accountManager, false);
     *
     * `anthropicRequest` is not defined in sendMessageStreamStandard, so this would have thrown
     * ReferenceError at the point all retries were exhausted.
     *
     * The fix: use `...standardRequest` and `sendMessageStreamStandard`.
     * With no fallback model configured, it should throw "Max retries exceeded", not a ReferenceError.
     */
    // Always return a 500 to exhaust retries (sleep is mocked so this is instant)
    throttledFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue('Internal Server Error'),
    });

    let thrownError: Error | null = null;
    try {
      for await (const _ of sendMessageStreamStandard(makeStandardRequest(), makeAccountManager(), false)) { /* drain */ }
    } catch (e: unknown) {
      thrownError = e;
    }

    expect(thrownError).not.toBeNull();
    // Must NOT be a ReferenceError about anthropicRequest
    expect(thrownError).not.toBeInstanceOf(ReferenceError);
    expect(thrownError!.message).not.toMatch(/anthropicRequest/i);
    // Must be the expected exhaustion error
    expect(thrownError!.message).toMatch(/Max retries exceeded/i);
  }, 10_000);

  it('notifies accountManager of success after a successful stream', async () => {
    const googleChunk = {
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    };
    throttledFetch.mockResolvedValue(makeOkSseResponse([googleChunk]));

    const accountManager = makeAccountManager();
    for await (const _ of sendMessageStreamStandard(makeStandardRequest(), accountManager, false)) { /* drain */ }

    expect(accountManager.notifySuccess).toHaveBeenCalledOnce();
  });

  it('ignores malformed SSE lines and continues yielding valid chunks', async () => {
    const encoder = new TextEncoder();
    const rawLines = [
      'data: not-valid-json\n\n',
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'good' }] } }] })}\n\n`,
    ].join('');

    throttledFetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(c) { c.enqueue(encoder.encode(rawLines)); c.close(); },
      }),
    });

    const chunks: Array<StandardStreamChunk> = [];
    for await (const chunk of sendMessageStreamStandard(makeStandardRequest(), makeAccountManager(), false)) {
      chunks.push(chunk);
    }

    // The malformed line is silently skipped, only the valid chunk comes through
    expect(chunks).toHaveLength(1);
    expect(chunks[0].candidates[0].content.parts[0].text).toBe('good');
  });
});
