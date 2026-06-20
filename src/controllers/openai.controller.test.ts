import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import openaiRouter from './openai.controller.js';
import * as cloudcode from '../cloudcode/index.js';
import * as openaiApi from '../api/openai.js';

// Mock dependencies
vi.mock('../cloudcode/index.js', () => ({
    sendMessageStandard: vi.fn().mockResolvedValue({ candidates: [] }),
    sendMessageStreamStandard: vi.fn(),
    isValidModel: vi.fn().mockResolvedValue(true)
}));

vi.mock('../api/openai.js', () => ({
    parseOpenAIRequest: vi.fn().mockReturnValue({ model: 'gemini-2.5-pro', contents: [] }),
    formatOpenAIResponse: vi.fn().mockReturnValue({ choices: [] }),
    formatOpenAIStreamChunk: vi.fn()
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
app.use('/', openaiRouter);

describe('OpenAI Controller - Grounding Support', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('passes google_search flag to parseOpenAIRequest for non-streaming requests', async () => {
        const reqBody = {
            model: 'gemini-2.5-pro',
            messages: [{ role: 'user', content: 'test' }],
            google_search: true
        };

        const res = await request(app)
            .post('/chat/completions')
            .send(reqBody);

        expect(res.status).toBe(200);
        expect(openaiApi.parseOpenAIRequest).toHaveBeenCalledTimes(1);
        
        // Assert that the raw body passed to parseOpenAIRequest contains google_search: true
        const passedArgs = vi.mocked(openaiApi.parseOpenAIRequest).mock.calls[0][0];
        expect(passedArgs).toHaveProperty('google_search', true);
    });

    it('passes google_search flag to parseOpenAIRequest for streaming requests', async () => {
        // Mock a generator for stream
        const mockGenerator = async function* () {
            yield { response: { candidates: [] } };
        };
        vi.mocked(cloudcode.sendMessageStreamStandard).mockReturnValue(mockGenerator() as any);
        // Mock formatOpenAIStreamChunk to return a dummy chunk
        vi.mocked(openaiApi.formatOpenAIStreamChunk).mockReturnValue('data: {}\n\n');

        const reqBody = {
            model: 'gemini-2.5-pro',
            messages: [{ role: 'user', content: 'test' }],
            stream: true,
            google_search: true
        };

        const res = await request(app)
            .post('/chat/completions')
            .send(reqBody);

        expect(res.status).toBe(200);
        expect(openaiApi.parseOpenAIRequest).toHaveBeenCalledTimes(1);
        
        const passedArgs = vi.mocked(openaiApi.parseOpenAIRequest).mock.calls[0][0];
        expect(passedArgs).toHaveProperty('google_search', true);
    });

    it('omits google_search if not provided', async () => {
        const reqBody = {
            model: 'gemini-2.5-pro',
            messages: [{ role: 'user', content: 'test' }]
        };

        await request(app)
            .post('/chat/completions')
            .send(reqBody);

        const passedArgs = vi.mocked(openaiApi.parseOpenAIRequest).mock.calls[0][0];
        expect(passedArgs.google_search).toBeUndefined();
    });
});
