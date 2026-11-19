import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getModelFamily, isThinkingModel, GEMINI_MAX_OUTPUT_TOKENS } from '../constants.js';
import { clearModelRegistry, getRegisteredModel } from './model-registry.js';
import { listModels, isValidModel, getModelQuotas } from './model-api.js';
import { buildCloudCodeRequest, buildHeaders } from './request-builder.js';
import { convertAnthropicToGoogle } from '../format/request-converter.js';
import { streamSSEResponse } from './sse-streamer.js';
import { getCachedSignatureFamily } from '../format/signature-cache.js';

const CODENAME = 'fixture-codename-model';

const FIXTURE = {
    models: {
        'gemini-3.8-flash-tiered': {
            supportsThinking: true,
            thinkingBudget: -1,
            maxOutputTokens: 65536,
            apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
            modelProvider: 'MODEL_PROVIDER_GOOGLE',
            quotaInfo: { remainingFraction: 0.9, resetTime: '2026-01-01T00:00:00Z' }
        },
        'claude-sonnet-5-5-low': {
            displayName: 'Claude Sonnet 5.5 (Low)',
            supportsThinking: true,
            maxOutputTokens: 128000,
            apiProvider: 'API_PROVIDER_ANTHROPIC_VERTEX',
            modelProvider: 'MODEL_PROVIDER_ANTHROPIC'
        },
        'gemini-2.5-pro': {
            displayName: 'Gemini 2.5 Pro',
            supportsThinking: true,
            apiProvider: 'API_PROVIDER_GOOGLE_GEMINI'
        },
        [CODENAME]: {
            displayName: 'Fixture Codename Model',
            supportsThinking: true,
            maxOutputTokens: 65536,
            apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
            modelProvider: 'MODEL_PROVIDER_GOOGLE',
            quotaInfo: { remainingFraction: 0.5, resetTime: '2026-01-01T00:00:00Z' }
        },
        'tab_flash_lite_preview': {
            maxOutputTokens: 4096,
            apiProvider: 'API_PROVIDER_GOOGLE_GEMINI'
        },
        'chat_23310': { apiProvider: 'API_PROVIDER_INTERNAL' },
        'gpt-oss-120b-medium': {
            displayName: 'GPT-OSS 120B (Medium)',
            supportsThinking: true,
            apiProvider: 'API_PROVIDER_OPENAI_VERTEX'
        },
        'gemini-4-argon-disabled': {
            displayName: 'Gemini 4 Argon (Disabled)',
            supportsThinking: true,
            apiProvider: 'API_PROVIDER_GOOGLE_GEMINI'
        }
    },
    agentModelSorts: [{
        displayName: 'Recommended',
        groups: [{ modelIds: [CODENAME, 'claude-sonnet-5-5-low', 'gpt-oss-120b-medium'] }]
    }],
    tieredModelIds: { flash: ['gemini-3.8-flash-tiered'], pro: ['gemini-3.8-flash-tiered'] }
};

function jsonResponse(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body)
    } as Response;
}

function sseResponse(chunks: unknown[]): Response {
    const encoder = new TextEncoder();
    const payload = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('');
    let sent = false;
    return {
        body: {
            getReader: () => ({
                read: async () => {
                    if (sent) return { done: true, value: undefined };
                    sent = true;
                    return { done: false, value: encoder.encode(payload) };
                }
            })
        }
    } as unknown as Response;
}

interface SseEvent {
    type: string;
    message?: { model?: string };
    content_block?: { type: string };
    delta?: { type: string; partial_json?: string; stop_reason?: string };
}

describe('Model Registry & Routing', () => {
    let fetchMode: 'ok' | 'fail' = 'ok';

    beforeEach(() => {
        fetchMode = 'ok';
        vi.stubGlobal('fetch', async () => {
            if (fetchMode === 'fail') return jsonResponse({ error: 'unavailable' }, 503);
            return jsonResponse(FIXTURE);
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        clearModelRegistry();
    });

    it('treats codename id as unknown before backend metadata is loaded', () => {
        clearModelRegistry();
        expect(getModelFamily(CODENAME)).toBe('unknown');
        expect(isThinkingModel(CODENAME)).toBe(false);
    });

    it('keeps name-based family and thinking detection for existing ids without registry', () => {
        expect(getModelFamily('gemini-3.8-flash-tiered')).toBe('gemini');
        expect(isThinkingModel('gemini-3.8-flash-tiered')).toBe(true);
        expect(getModelFamily('claude-sonnet-5-5-low')).toBe('claude');
        expect(isThinkingModel('claude-sonnet-5-5-low')).toBe(false);
        expect(isThinkingModel('claude-opus-4-6-thinking')).toBe(true);
    });

    it('lists Gemini, Claude, and codename agent models while hiding internal/old/disabled/other-provider ids', async () => {
        const listing = await listModels('fake-token');
        const listedIds = listing.data.map((m: { id: string }) => m.id).sort();

        expect(listedIds).toEqual([CODENAME, 'claude-sonnet-5-5-low', 'gemini-3.8-flash-tiered'].sort());
        for (const hidden of ['tab_flash_lite_preview', 'chat_23310', 'gpt-oss-120b-medium', 'gemini-2.5-pro', 'gemini-4-argon-disabled']) {
            expect(listedIds).not.toContain(hidden);
        }

        const byId = Object.fromEntries(listing.data.map((m: { id: string; description: string }) => [m.id, m.description]));
        expect(byId[CODENAME]).toBe('Fixture Codename Model');
        expect(byId['gemini-3.8-flash-tiered']).toBe('gemini-3.8-flash-tiered');
    });

    it('resolves codename family, thinking support, and excludes non-agent/non-Gemini ids', async () => {
        await listModels('fake-token');

        expect(getModelFamily(CODENAME)).toBe('gemini');
        expect(isThinkingModel(CODENAME)).toBe(true);
        expect(getRegisteredModel(CODENAME)?.maxOutputTokens).toBe(65536);

        expect(getRegisteredModel('tab_flash_lite_preview')).toBeUndefined();
        expect(getRegisteredModel('gpt-oss-120b-medium')).toBeUndefined();
        expect(getModelFamily('gpt-oss-120b-medium')).toBe('unknown');
    });

    it('validates listed and hidden-but-supported ids, and rejects unlisted ids', async () => {
        await listModels('fake-token');

        expect(await isValidModel(CODENAME, 'fake-token')).toBe(true);
        expect(await isValidModel('gemini-3.8-flash-tiered', 'fake-token')).toBe(true);
        expect(await isValidModel('gemini-2.5-pro', 'fake-token')).toBe(true);

        expect(await isValidModel('gemini-4-argon', 'fake-token')).toBe(false);
        expect(await isValidModel('tab_flash_lite_preview', 'fake-token')).toBe(false);
        expect(await isValidModel('gpt-oss-120b-medium', 'fake-token')).toBe(false);
    });

    it('tracks quotas for codename models and excludes non-supported providers', async () => {
        const quotas = await getModelQuotas('fake-token');
        expect(quotas[CODENAME].remainingFraction).toBe(0.5);
        expect(quotas['gpt-oss-120b-medium']).toBeUndefined();
    });

    it('surfaces backend fetch failures from listModels', async () => {
        fetchMode = 'fail';
        await expect(listModels('fake-token')).rejects.toThrow();
    });

    it('routes codename models with exact id, Gemini thinkingConfig, token cap, tools, and headers', async () => {
        await listModels('fake-token');

        const baseRequest = {
            max_tokens: 64000,
            messages: [{ role: 'user', content: 'hi' }],
            tools: [{ name: 'get_weather', description: 'w', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }]
        };

        const payload = buildCloudCodeRequest({ ...baseRequest, model: CODENAME }, 'proj', 'a@example.com');
        expect(payload.model).toBe(CODENAME);
        const tiered = buildCloudCodeRequest({ ...baseRequest, model: 'gemini-3.8-flash-tiered' }, 'proj', 'a@example.com');
        expect(tiered.model).toBe('gemini-3.8-flash-tiered');

        const req = convertAnthropicToGoogle({ ...baseRequest, model: CODENAME });
        expect(req.generationConfig.thinkingConfig?.includeThoughts).toBe(true);
        expect(typeof req.generationConfig.thinkingConfig?.thinkingBudget).toBe('number');
        expect(req.generationConfig.maxOutputTokens).toBe(Math.min(64000, GEMINI_MAX_OUTPUT_TOKENS));
        expect(req.tools?.[0]?.functionDeclarations?.[0]?.name).toBe('get_weather');
        expect(req.toolConfig).toBeUndefined();

        const tieredReq = convertAnthropicToGoogle({ ...baseRequest, model: 'gemini-3.8-flash-tiered' });
        expect(tieredReq.generationConfig.thinkingConfig?.includeThoughts).toBe(true);
        expect(tieredReq.generationConfig.maxOutputTokens).toBe(Math.min(64000, GEMINI_MAX_OUTPUT_TOKENS));

        expect(buildHeaders('t', CODENAME)['anthropic-beta']).toBeUndefined();
        expect(buildHeaders('t', 'claude-opus-4-6-thinking')['anthropic-beta']).toBe('interleaved-thinking-2025-05-14');
    });

    it('streams thinking, text, and tool_use events for codename models and caches signature under backend family', async () => {
        await listModels('fake-token');

        const signature = 'sig-' + 'x'.repeat(80);
        const response = sseResponse([
            { response: { candidates: [{ content: { parts: [{ text: 'plan', thought: true, thoughtSignature: signature }] } }] } },
            { response: { candidates: [{ content: { parts: [{ text: 'Checking.' }] } }] } },
            {
                response: {
                    candidates: [{ content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }] }, finishReason: 'STOP' }],
                    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }
                }
            }
        ]);

        const events: SseEvent[] = [];
        for await (const ev of streamSSEResponse(response, CODENAME)) {
            events.push(ev as SseEvent);
        }

        const starts = events.filter(e => e.type === 'content_block_start').map(e => e.content_block?.type);
        expect(starts).toEqual(['thinking', 'text', 'tool_use']);
        expect(events[0].type).toBe('message_start');
        expect(events[0].message?.model).toBe(CODENAME);

        const toolInput = events.find(e => e.delta?.type === 'input_json_delta');
        expect(JSON.parse(toolInput?.delta?.partial_json || '{}')).toEqual({ city: 'Paris' });

        const msgDelta = events.find(e => e.type === 'message_delta');
        expect(msgDelta?.delta?.stop_reason).toBe('tool_use');
        expect(events[events.length - 1].type).toBe('message_stop');
        expect(getCachedSignatureFamily(signature)).toBe('gemini');
    });
});
