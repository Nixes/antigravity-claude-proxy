/**
 * Session Management for Cloud Code
 *
 * Handles session ID derivation for prompt caching continuity.
 * Session IDs are derived from the first user message to ensure
 * the same conversation uses the same session across turns.
 */

import crypto from 'crypto';

// Runtime storage for per-account fallback session IDs (used only when
// a request carries no user text at all).
const runtimeSessionStore = new Map();

/**
 * Extract the first meaningful user text from either an Anthropic request
 * (`messages`) or a Google StandardRequest (`contents`).
 * Returns null when no user message carries text (e.g. tool_result/functionResponse-only turns).
 *
 * @param {Object} request
 * @returns {string|null}
 */
function extractFirstUserText(request) {
    if (!request || typeof request !== 'object') return null;

    if (Array.isArray(request.messages)) {
        for (const msg of request.messages) {
            if (!msg || msg.role !== 'user') continue;
            const content = msg.content;
            let text = null;
            if (typeof content === 'string') {
                text = content;
            } else if (Array.isArray(content)) {
                const parts = [];
                for (const block of content) {
                    if (block && block.type === 'text' && typeof block.text === 'string') {
                        parts.push(block.text);
                    }
                }
                if (parts.length > 0) text = parts.join('\n');
            }
            if (text && text.trim().length > 0) {
                // Hash the full text, never a prefix: clients such as Claude Code
                // open the first user message with a long shared preamble
                // (<system-reminder>, CLAUDE.md), so a truncated prefix maps
                // every conversation in a project to the same session ID.
                return text;
            }
        }
        return null;
    }

    if (Array.isArray(request.contents)) {
        for (const content of request.contents) {
            if (!content || content.role !== 'user' || !Array.isArray(content.parts)) continue;
            const parts = [];
            for (const part of content.parts) {
                if (part && typeof part.text === 'string') {
                    parts.push(part.text);
                }
            }
            if (parts.length > 0) {
                const text = parts.join('\n');
                if (text.trim().length > 0) {
                    return text;
                }
            }
        }
    }

    return null;
}

/**
 * Derive a deterministic per-conversation session ID shaped like the binary's
 * `uuid + Date.now()` format. The same conversation (same first user text,
 * same account) always maps to the same ID across turns and proxy restarts.
 */
function deriveConversationSessionId(request, accountEmail) {
    const firstUserText = extractFirstUserText(request);
    if (!firstUserText) return null;
    const digest = crypto
        .createHash('sha256')
        .update(`${accountEmail || 'anonymous'}\u0000${firstUserText}`)
        .digest('hex');
    const uuid =
        `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-` +
        `${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
    const tail = BigInt(`0x${digest.slice(32, 45)}`).toString();
    return `${uuid}${tail}`;
}

/**
 * Get or create a session ID for a request.
 *
 * Priority:
 *   1. Per-conversation deterministic ID from the first user message —
 *      restores cache continuity per conversation and isolates concurrent
 *      conversations from each other's cache pressure.
 *   2. Per-account process-lifetime ID when the request carries no user
 *      text at all (previous behavior).
 *
 * @param {Object} request - Anthropic request or Google StandardRequest
 * @param {string} accountEmail - The account email to scope IDs
 * @returns {string} A stable session ID string matching binary format
 */
export function deriveSessionId(request, accountEmail) {
    const conversationId = deriveConversationSessionId(request, accountEmail);
    if (conversationId) {
        return conversationId;
    }

    if (!accountEmail) {
        return generateBinaryStyleId();
    }

    if (runtimeSessionStore.has(accountEmail)) {
        return runtimeSessionStore.get(accountEmail);
    }

    const newSessionId = generateBinaryStyleId();
    runtimeSessionStore.set(accountEmail, newSessionId);

    return newSessionId;
}

/**
 * Generate a Session ID using the binary's exact logic.
 * logic: `rs() + Date.now()` where `rs()` is randomUUID
 */
function generateBinaryStyleId() {
    return crypto.randomUUID() + Date.now().toString();
}

/**
 * Clears all session IDs (e.g. useful for testing or explicit reset)
 */
export function clearSessionStore() {
    runtimeSessionStore.clear();
}
