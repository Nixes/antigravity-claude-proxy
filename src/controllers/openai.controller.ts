import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { accountManager, ensureInitialized, FALLBACK_ENABLED } from '../server-state.js';
import { sendMessageStandard, sendMessageStreamStandard, isValidModel } from '../cloudcode/index.js';
import { parseOpenAIRequest, formatOpenAIResponse, formatOpenAIStreamChunk, OpenAIStreamState } from '../api/openai.js';
import { OpenAIRequest, StandardResponse, StandardStreamChunk } from '../api/types.js';
import { parseError } from '../utils/error-parser.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { resolveModelId } from '../utils/model-resolver.js';
import usageStats from '../modules/usage-stats.js';

const openaiRouter = Router();

/**
 * OpenAI-compatible Completions API
 * POST /v1/chat/completions
 */
openaiRouter.post('/chat/completions', async (req: Request, res: Response) => {
    const flushableRes = res as Response & { flush?: () => void };
    try {
        await ensureInitialized();

        const body = (req.body ?? {}) as Partial<OpenAIRequest> & { model?: string; stream?: boolean };
        const requestedModel = resolveModelId(
            body.model || 'gpt-4o',
            config.modelMapping
        );

        const standardRequest = parseOpenAIRequest({ ...body, model: requestedModel } as OpenAIRequest);

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

        logger.info(`[API] OpenAI Request for model: ${modelId}, stream: ${!!body.stream}`);

        if (body.stream) {
            try {
                const generator = sendMessageStreamStandard(standardRequest, accountManager, FALLBACK_ENABLED);
                
                const firstResult = await generator.next();
                usageStats.track(modelId);

                res.status(200);
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Accel-Buffering', 'no');
                res.flushHeaders();

                const state: OpenAIStreamState = {
                    model: requestedModel,
                    id: `chatcmpl-${crypto.randomUUID().replace(/-/g, '')}`,
                    created: Math.floor(Date.now() / 1000),
                    hasEmittedRole: false,
                    toolCallIndex: 0,
                    hasToolCalls: false
                };

                if (!firstResult.done) {
                    const chunkStr = formatOpenAIStreamChunk(firstResult.value as StandardStreamChunk, state);
                    if (chunkStr) {
                        res.write(chunkStr);
                        if (flushableRes.flush) flushableRes.flush();
                    }
                }

                for await (const event of generator) {
                    const chunkStr = formatOpenAIStreamChunk(event as StandardStreamChunk, state);
                    if (chunkStr) {
                        res.write(chunkStr);
                        if (flushableRes.flush) flushableRes.flush();
                    }
                }
                
                res.write('data: [DONE]\n\n');
                res.end();

            } catch (error: unknown) {
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
            usageStats.track(modelId);
            const openAiResponse = formatOpenAIResponse(googleResponse as StandardResponse, requestedModel);
            res.json(openAiResponse);
        }
    } catch (error: unknown) {
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
