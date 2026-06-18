import { Router } from 'express';

const systemRouter = Router();

/**
 * Silent handler for Claude Code CLI root POST requests
 * Claude Code sends heartbeat/event requests to POST / which we don't need
 * Using app.use instead of app.post for earlier middleware interception
 */
systemRouter.use((req, res, next) => {
    // Handle Claude Code event logging requests silently
    if (req.method === 'POST' && req.path === '/api/event_logging/batch') {
        return res.status(200).json({ status: 'ok' });
    }
    // Handle Claude Code root POST requests silently
    if (req.method === 'POST' && req.path === '/') {
        return res.status(200).json({ status: 'ok' });
    }
    next();
});

/**
 * Silent handler for Claude Code CLI root POST requests
 * Claude Code sends heartbeat/event requests to POST / which we don't need
 */
systemRouter.post('/', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

export default systemRouter;
