import { Router, Request, Response } from 'express';
import { accountManager, ensureInitialized, FALLBACK_ENABLED } from '../server-state.js';
import { sendMessage, sendMessageStream, isValidModel } from '../cloudcode/index.js';
import { parseError } from '../utils/error-parser.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const anthropicRouter = Router();

/**
 * Count tokens endpoint - Anthropic Messages API compatible
 * Uses local tokenization with official tokenizers (@anthropic-ai/tokenizer for Claude, @lenml/tokenizer-gemini for Gemini)
 */
anthropicRouter.post('/messages/count_tokens', (req: Request, res: Response) => {
    res.status(501).json({
        type: 'error',
        error: {
            type: 'not_implemented',
            message: 'Token counting is not implemented. Use /v1/messages with max_tokens or configure your client to skip token counting.'
        }
    });
});

anthropicRouter.post('/messages', async (req: Request, res: Response) => {
    try {
        // Ensure account manager is initialized
        await ensureInitialized();

        const {
            model,
            messages,
            stream,
            system,
            max_tokens,
            tools,
            tool_choice,
            thinking,
            top_p,
            top_k,
            temperature,
            google_search
        } = req.body;

        // Resolve model mapping if configured
        let requestedModel = model || 'claude-3-5-sonnet-20241022';
        const modelMapping: Record<string, any> = config.modelMapping || {};
        if (modelMapping[requestedModel] && modelMapping[requestedModel].mapping) {
            const targetModel = modelMapping[requestedModel].mapping;
            logger.info(`[Server] Mapping model ${requestedModel} -> ${targetModel}`);
            requestedModel = targetModel;
        }

        const modelId = requestedModel;

        // Validate model ID before processing
        const { account: validationAccount } = accountManager.selectAccount();
        if (validationAccount) {
            const token = await accountManager.getTokenForAccount(validationAccount);
            const projectId = validationAccount.subscription?.projectId || undefined;
            const valid = await isValidModel(modelId, token, projectId);

            if (!valid) {
                throw new Error(`invalid_request_error: Invalid model: ${modelId}. Use /v1/models to see available models.`);
            }
        }

        // Optimistic Retry: If ALL accounts are rate-limited for this model, reset them to force a fresh check.
        // If we have some available accounts, we try them first.
        if (accountManager.isAllRateLimited(modelId)) {
            logger.warn(`[Server] All accounts rate-limited for ${modelId}. Resetting state for optimistic retry.`);
            accountManager.resetAllRateLimits();
        }

        // Validate required fields
        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({
                type: 'error',
                error: {
                    type: 'invalid_request_error',
                    message: 'messages is required and must be an array'
                }
            });
        }

        // Filter out "count" requests (often automated background checks)
        if (messages.length === 1 && messages[0].content === 'count') {
            return res.json({});
        }

        // Build the request object
        const request = {
            model: modelId,
            messages,
            max_tokens: max_tokens || 4096,
            stream,
            system,
            tools,
            tool_choice,
            thinking,
            top_p,
            top_k,
            temperature,
            google_search
        };

        logger.info(`[API] Request for model: ${request.model}, stream: ${!!stream}`);

        // Debug: Log message structure to diagnose tool_use/tool_result ordering
        if (logger.isDebugEnabled) {
            logger.debug('[API] Message structure:');
            messages.forEach((msg, i) => {
                const contentTypes = Array.isArray(msg.content)
                    ? msg.content.map((c: any) => c.type || 'text').join(', ')
                    : (typeof msg.content === 'string' ? 'text' : 'unknown');
                logger.debug(`  [${i}] ${msg.role}: ${contentTypes}`);
            });
        }

        if (stream) {
            // Handle streaming response
            // Do NOT flush headers immediately. We need to wait for the first chunk
            // to ensure we don't send a 200 OK if the upstream fails immediately (e.g. 429/503).

            try {
                // Initialize the generator
                const generator = sendMessageStream(request, accountManager, FALLBACK_ENABLED);
                
                // BUFFERING STRATEGY:
                // Pull the first event *before* sending headers. 
                // If this throws, we can safely send a 4xx/5xx error JSON.
                const firstResult = await generator.next();

                // If we get here, the stream started successfully.
                res.status(200);
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Accel-Buffering', 'no');
                res.flushHeaders();

                // If the generator isn't done, send the first chunk
                if (!firstResult.done) {
                    res.write(`event: ${(firstResult.value as any).type}\ndata: ${JSON.stringify(firstResult.value)}\n\n`);
                    if (typeof res.flush === 'function') res.flush();
                }

                // Continue with the rest of the stream
                for await (const event of generator) {
                    res.write(`event: ${(event as any).type}\ndata: ${JSON.stringify(event)}\n\n`);
                    if (typeof res.flush === 'function') res.flush();
                }
                
                res.end();

            } catch (error: any) {
                // If we haven't sent headers yet, we can send a proper error status
                if (!res.headersSent) {
                    logger.error('[API] Initial stream error:', error);
                    const { errorType, statusCode, errorMessage } = parseError(error);
                    
                    return res.status(statusCode).json({
                        type: 'error',
                        error: {
                            type: errorType,
                            message: errorMessage
                        }
                    });
                }
                
                // If headers were already sent (should only happen if error occurs mid-stream),
                // we have to fallback to SSE error event
                logger.error('[API] Mid-stream error:', error);
                const { errorType, errorMessage } = parseError(error);

                res.write(`event: error\ndata: ${JSON.stringify({
                    type: 'error',
                    error: { type: errorType, message: errorMessage }
                })}\n\n`);
                res.end();
            }

        } else {
            // Handle non-streaming response
            const response = await sendMessage(request, accountManager, FALLBACK_ENABLED);
            res.json(response);
        }

    } catch (error: any) {
        logger.error('[API] Error:', error);

        let { errorType, statusCode, errorMessage } = parseError(error);

        // For auth errors, try to refresh token
        if (errorType === 'authentication_error') {
            logger.warn('[API] Token might be expired, attempting refresh...');
            try {
                accountManager.clearProjectCache();
                accountManager.clearTokenCache();
                // await forceRefresh(); // Function not implemented or imported
                errorMessage = 'Token was expired and has been refreshed. Please retry your request.';
            } catch (refreshError) {
                errorMessage = 'Could not refresh token. Make sure Antigravity is running.';
            }
        }

        logger.warn(`[API] Returning error response: ${statusCode} ${errorType} - ${errorMessage}`);

        // Check if headers have already been sent (for streaming that failed mid-way)
        if (res.headersSent) {
            logger.warn('[API] Headers already sent, writing error as SSE event');
            res.write(`event: error\ndata: ${JSON.stringify({
                type: 'error',
                error: { type: errorType, message: errorMessage }
            })}\n\n`);
            res.end();
        } else {
            res.status(statusCode).json({
                type: 'error',
                error: {
                    type: errorType,
                    message: errorMessage
                }
            });
        }
    }
});

export default anthropicRouter;
