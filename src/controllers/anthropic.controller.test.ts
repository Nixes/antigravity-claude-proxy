import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import anthropicRouter from './anthropic.controller.js';
import * as cloudcode from '../cloudcode/index.js';
import { accountManager } from '../server-state.js';
import usageStats from '../modules/usage-stats.js';

// Mock dependencies
vi.mock('../modules/usage-stats.js', () => ({
    default: {
        track: vi.fn()
    }
}));

vi.mock('../cloudcode/index.js', () => ({
    sendMessage: vi.fn().mockResolvedValue({ candidates: [] }),
    sendMessageStream: vi.fn(),
    isValidModel: vi.fn().mockResolvedValue(true)
}));

vi.mock('../server-state.js', () => ({
    accountManager: {
        selectAccount: vi.fn().mockReturnValue({ account: { email: 'test@example.com' } }),
        getTokenForAccount: vi.fn().mockResolvedValue('fake-token'),
        isAllRateLimited: vi.fn().mockReturnValue(false),
        resetAllRateLimits: vi.fn()
    },
    ensureInitialized: vi.fn().mockResolvedValue(undefined),
    FALLBACK_ENABLED: false
}));

const app = express();
app.use(express.json());
app.use('/', anthropicRouter);

describe('Anthropic Controller - Grounding Support', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('extracts google_search flag and passes it to sendMessage', async () => {
        const reqBody = {
            model: 'gemini-2.5-pro',
            messages: [{ role: 'user', content: 'test' }],
            google_search: true
        };

        const res = await request(app)
            .post('/messages')
            .send(reqBody);

        expect(res.status).toBe(200);
        expect(cloudcode.sendMessage).toHaveBeenCalledTimes(1);
        
        // Assert that the request object built by the controller contains google_search: true
        const passedRequest = vi.mocked(cloudcode.sendMessage).mock.calls[0][0];
        expect(passedRequest).toHaveProperty('google_search', true);
    });

    it('passes google_search: true to sendMessageStream when stream is true', async () => {
        // Mock a generator for stream
        const mockGenerator = async function* () {
            yield { type: 'message_start' };
            yield { type: 'message_stop' };
        };
        vi.mocked(cloudcode.sendMessageStream).mockReturnValue(mockGenerator() as any);

        const reqBody = {
            model: 'gemini-2.5-pro',
            messages: [{ role: 'user', content: 'test' }],
            stream: true,
            google_search: true
        };

        const res = await request(app)
            .post('/messages')
            .send(reqBody);

        expect(res.status).toBe(200);
        expect(cloudcode.sendMessageStream).toHaveBeenCalledTimes(1);
        
        const passedRequest = vi.mocked(cloudcode.sendMessageStream).mock.calls[0][0];
        expect(passedRequest).toHaveProperty('google_search', true);
    });

    it('omits google_search if not provided', async () => {
        const reqBody = {
            model: 'gemini-2.5-pro',
            messages: [{ role: 'user', content: 'test' }]
        };

        await request(app)
            .post('/messages')
            .send(reqBody);

        const passedRequest = vi.mocked(cloudcode.sendMessage).mock.calls[0][0];
        expect(passedRequest.google_search).toBeUndefined();
    });
});

describe('Anthropic Controller - Model Mapping & Usage Stats (#402)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(cloudcode.isValidModel).mockResolvedValue(true);
        vi.mocked(cloudcode.sendMessage).mockResolvedValue({ model: 'claude-opus-4-6-thinking', candidates: [] });
    });

    it('resolves built-in model mappings and tracks resolved model on successful non-streaming dispatch', async () => {
        const res = await request(app)
            .post('/messages')
            .send({
                model: 'claude-opus-5-5',
                messages: [{ role: 'user', content: 'hi' }]
            });

        expect(res.status).toBe(200);
        const passedRequest = vi.mocked(cloudcode.sendMessage).mock.calls[0][0];
        expect(passedRequest.model).toBe('claude-opus-4-6-thinking');
        expect(usageStats.track).toHaveBeenCalledTimes(1);
        expect(usageStats.track).toHaveBeenCalledWith('claude-opus-4-6-thinking');
    });

    it('tracks resolved model on streaming dispatch and does not track on invalid requests', async () => {
        const badRes = await request(app)
            .post('/messages')
            .send({ model: 'claude-opus-5-5' });
        expect(badRes.status).toBe(400);
        expect(usageStats.track).not.toHaveBeenCalled();

        const mockGenerator = async function* () {
            yield { type: 'message_start' };
            yield { type: 'message_stop' };
        };
        vi.mocked(cloudcode.sendMessageStream).mockReturnValue(mockGenerator() as ReturnType<typeof cloudcode.sendMessageStream>);

        const streamRes = await request(app)
            .post('/messages')
            .send({
                model: 'claude-sonnet-5-5',
                messages: [{ role: 'user', content: 'hi' }],
                stream: true
            });
        expect(streamRes.status).toBe(200);
        expect(usageStats.track).toHaveBeenCalledWith('claude-sonnet-4-6');
    });
});
