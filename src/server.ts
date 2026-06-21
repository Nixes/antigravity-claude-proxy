/**
 * Express Server - Anthropic-compatible API
 * Proxies to Google Cloud Code via Antigravity
 * Supports multi-account load balancing
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

import { mountWebUI } from './webui/index.js';
import { config } from './config.js';
import { REQUEST_BODY_LIMIT } from './constants.js';
import { logger } from './utils/logger.js';
import usageStats from './modules/usage-stats.js';

// Import shared state (re-exported for index.js compatibility)
import { accountManager, FALLBACK_ENABLED, ensureInitialized } from './server-state.js';
export { accountManager };

// Import controllers
import systemRouter from './controllers/system.controller.js';
import adminRouter from './controllers/admin.controller.js';
import modelsRouter from './controllers/models.controller.js';
import anthropicRouter from './controllers/anthropic.controller.js';
import openaiRouter from './controllers/openai.controller.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Disable x-powered-by header for security
app.disable('x-powered-by');

// Early system interceptors (must be before logging)
app.use(systemRouter);

// Middleware
app.use(cors());
app.use(express.json({ limit: REQUEST_BODY_LIMIT }));

// API Key authentication middleware for /v1/* endpoints
app.use('/v1', (req, res, next) => {
    // Skip validation if apiKey is not configured
    if (!config.apiKey) {
        return next();
    }

    const authHeader = req.headers['authorization'];
    const xApiKey = req.headers['x-api-key'];

    let providedKey = '';
    if (authHeader && authHeader.startsWith('Bearer ')) {
        providedKey = authHeader.substring(7);
    } else if (xApiKey) {
        providedKey = Array.isArray(xApiKey) ? xApiKey[0] : xApiKey;
    }

    if (!providedKey || providedKey !== config.apiKey) {
        logger.warn(`[API] Unauthorized request from ${req.ip}, invalid API key`);
        return res.status(401).json({
            type: 'error',
            error: {
                type: 'authentication_error',
                message: 'Invalid or missing API key'
            }
        });
    }

    next();
});

// Setup usage statistics middleware
usageStats.setupMiddleware(app);

// Mount WebUI (optional web interface for account management)
mountWebUI(app, __dirname, accountManager);

// Request logging middleware
app.use((req, res, next) => {
    const start = Date.now();

    // Log response on finish
    res.on('finish', () => {
        const duration = Date.now() - start;
        const status = res.statusCode;
        const logMsg = `[${req.method}] ${req.originalUrl} ${status} (${duration}ms)`;

        // Skip standard logging for event logging batch unless in debug mode
        if (req.originalUrl === '/api/event_logging/batch' || req.originalUrl.startsWith('/v1/messages/count_tokens') || req.originalUrl.startsWith('/.well-known/')) {
            if (logger.isDebugEnabled) {
                logger.debug(logMsg);
            }
        } else {
            // Colorize status code
            if (status >= 500) {
                logger.error(logMsg);
            } else if (status >= 400) {
                logger.warn(logMsg);
            } else {
                logger.info(logMsg);
            }
        }
    });

    next();
});

// Mount domain controllers
app.use('/', adminRouter);
app.use('/v1', modelsRouter);
app.use('/v1', anthropicRouter);
app.use('/v1', openaiRouter);

// Usage stats routes
usageStats.setupRoutes(app);

// Catch-all for unsupported endpoints
app.use('*', (req, res) => {
    // Log 404s (use originalUrl since wildcard strips req.path)
    if (logger.isDebugEnabled) {
        logger.debug(`[API] 404 Not Found: ${req.method} ${req.originalUrl}`);
    }
    res.status(404).json({
        type: 'error',
        error: {
            type: 'not_found_error',
            message: `Endpoint ${req.method} ${req.originalUrl} not found`
        }
    });
});

export default app;