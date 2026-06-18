import { Router } from 'express';
import crypto from 'crypto';
import { accountManager, ensureInitialized, FALLBACK_ENABLED } from '../server-state.js';
import { sendMessageStandard, sendMessageStreamStandard, isValidModel } from '../cloudcode/index.js';
import { parseOpenAIRequest, formatOpenAIResponse, formatOpenAIStreamChunk } from '../api/openai.js';
import { parseError } from '../utils/error-parser.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const openaiRouter = Router();

/**
 * OpenAI-compatible Completions API
 * POST /v1/chat/completions
 */
openaiRouter.post('/chat/completions', async (req: any, res: any) => {
    try {
        await ensureInitialized();

        let requestedModel = req.body.model || 'gpt-4o';
        const modelMapping = config.modelMapping || {};
        if (modelMapping[requestedModel] && modelMapping[requestedModel].mapping) {
            const targetModel = modelMapping[requestedModel].mapping;
            logger.info(`[Server] Mapping model ${requestedModel} -> ${targetModel}`);
            requestedModel = targetModel;
        }

        const standardRequest = parseOpenAIRequest({ ...req.body, model: requestedModel });

        const modelId = standardRequest.model;

        // Validate model ID before processing
        const { account: validationAccount } = accountManager.selectAccount();
        if (validationAccount) {
            const token = await accountManager.getTokenForAccount(validationAccount);
            const projectId = validationAccount.subscription?.projectId || null;
            const valid = await isValidModel(modelId, token, projectId);

            if (!valid) {
                throw new Error(`invalid_request_error: Invalid model: ${modelId}`);
            }
        }

        if (accountManager.isAllRateLimited(modelId)) {
            logger.warn(`[Server] All accounts rate-limited for ${modelId}. Resetting state for optimistic retry.`);
            accountManager.resetAllRateLimits();
        }

        logger.info(`[API] OpenAI Request for model: ${modelId}, stream: ${!!req.body.stream}`);

        if (req.body.stream) {
            try {
                const generator = sendMessageStreamStandard(standardRequest, accountManager, FALLBACK_ENABLED);
                
                const firstResult = await generator.next();

                res.status(200);
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Accel-Buffering', 'no');
                res.flushHeaders();

                let state = {
                    model: requestedModel,
                    id: `chatcmpl-${crypto.randomUUID().replace(/-/g, '')}`,
                    created: Math.floor(Date.now() / 1000),
                    hasEmittedRole: false,
                    toolCallIndex: 0
                };

                if (!firstResult.done) {
                    const chunkStr = formatOpenAIStreamChunk(firstResult.value as any, state);
                    if (chunkStr) {
                        res.write(chunkStr);
                        if (res.flush) res.flush();
                    }
                }

                for await (const event of generator) {
                    const chunkStr = formatOpenAIStreamChunk(event as any, state);
                    if (chunkStr) {
                        res.write(chunkStr);
                        if (res.flush) res.flush();
                    }
                }
                
                res.write('data: [DONE]\n\n');
                res.end();

            } catch (error: any) {
                if (!res.headersSent) {
                    logger.error('[API] Initial stream error:', error);
                    const { errorType, statusCode, errorMessage } = parseError(error);
                    return res.status(statusCode).json({
                        error: {
                            type: errorType,
                            message: errorMessage
                        }
                    });
                }
                
                logger.error('[API] Mid-stream error:', error);
                res.end();
            }
        } else {
            const googleResponse = await sendMessageStandard(standardRequest, accountManager, FALLBACK_ENABLED);
            const openAiResponse = formatOpenAIResponse(googleResponse as any, requestedModel);
            res.json(openAiResponse);
        }
    } catch (error: any) {
        logger.error('[API] Request failed:', error);
        const { errorType, statusCode, errorMessage } = parseError(error);
        
        res.status(statusCode).json({
            error: {
                type: errorType,
                message: errorMessage
            }
        });
    }
});

export default openaiRouter;
