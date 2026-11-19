import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('./modules/usage-stats.js', () => ({
    default: {
        setupMiddleware: vi.fn(),
        setupRoutes: vi.fn(),
        track: vi.fn(),
        getHistory: vi.fn(() => ({}))
    }
}));

vi.mock('./server-state.js', () => ({
    accountManager: {
        selectAccount: vi.fn().mockReturnValue({ account: { email: 'test@example.com' } }),
        getTokenForAccount: vi.fn().mockResolvedValue('fake-token'),
        isAllRateLimited: vi.fn().mockReturnValue(false),
        resetAllRateLimits: vi.fn(),
        getStatus: vi.fn().mockReturnValue({ accounts: [] }),
        getAllAccounts: vi.fn().mockReturnValue([])
    },
    ensureInitialized: vi.fn().mockResolvedValue(undefined),
    FALLBACK_ENABLED: false
}));

vi.mock('./cloudcode/index.js', () => ({
    sendMessage: vi.fn().mockResolvedValue({ candidates: [] }),
    sendMessageStream: vi.fn(),
    sendMessageStandard: vi.fn().mockResolvedValue({ candidates: [] }),
    sendMessageStreamStandard: vi.fn(),
    listModels: vi.fn().mockResolvedValue({ object: 'list', data: [] }),
    fetchAvailableModels: vi.fn(),
    getModelQuotas: vi.fn().mockResolvedValue({}),
    getSubscriptionTier: vi.fn().mockResolvedValue('free'),
    isValidModel: vi.fn().mockResolvedValue(true)
}));

const { default: app } = await import('./server.js');

describe('Express 5 server middleware & routing (#407 / v5 upgrade)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('defaults undefined req.body to {} on body-less POST so handlers return 400 instead of 500', async () => {
        const res = await request(app).post('/v1/messages');
        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            type: 'error',
            error: {
                type: 'invalid_request_error',
                message: 'messages is required and must be an array'
            }
        });
    });

    it('defaults req.body to {} on body-less WebUI POST endpoints', async () => {
        const res = await request(app).post('/api/claude/mode');
        expect(res.status).toBe(400);
        expect(res.body.status).toBe('error');
    });

    it('returns JSON not_found_error from the path-less 404 catch-all', async () => {
        const res = await request(app).get('/does-not-exist');
        expect(res.status).toBe(404);
        expect(res.body).toEqual({
            type: 'error',
            error: {
                type: 'not_found_error',
                message: 'Endpoint GET /does-not-exist not found'
            }
        });
    });
});
