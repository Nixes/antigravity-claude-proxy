import { Router } from 'express';
import { accountManager, ensureInitialized } from '../server-state.js';
import { listModels } from '../cloudcode/index.js';
import { logger } from '../utils/logger.js';

const modelsRouter = Router();

/**
 * List models endpoint (OpenAI-compatible format)
 */
modelsRouter.get('/models', async (req, res) => {
    try {
        await ensureInitialized();
        const { account } = accountManager.selectAccount();
        if (!account) {
            return res.status(503).json({
                type: 'error',
                error: {
                    type: 'api_error',
                    message: 'No accounts available'
                }
            });
        }
        const token = await accountManager.getTokenForAccount(account);
        const models = await listModels(token);
        res.json(models);
    } catch (error: unknown) {
        logger.error('[API] Error listing models:', error);
        res.status(500).json({
            type: 'error',
            error: {
                type: 'api_error',
                message: error instanceof Error ? error.message : String(error)
            }
        });
    }
});

export default modelsRouter;
