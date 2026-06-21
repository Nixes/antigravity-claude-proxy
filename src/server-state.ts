import { AccountManager } from './account-manager/index.js';
import { logger } from './utils/logger.js';
import { AccountStatus } from './api/types.js';

// Parse fallback flag directly from command line args to avoid circular dependency
const args = process.argv.slice(2);
export const FALLBACK_ENABLED = args.includes('--fallback') || process.env.FALLBACK === 'true';

// Parse --strategy flag (format: --strategy=sticky or --strategy sticky)
let STRATEGY_OVERRIDE: string | null = null;
for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--strategy=')) {
        STRATEGY_OVERRIDE = args[i].split('=')[1];
    } else if (args[i] === '--strategy' && args[i + 1]) {
        STRATEGY_OVERRIDE = args[i + 1];
    }
}

// Initialize account manager (will be fully initialized on first request or startup)
export const accountManager = new AccountManager();

// Track initialization status
let isInitialized = false;
let initError: Error | null = null;
let initPromise: Promise<void> | null = null;

/**
 * Ensure account manager is initialized (with race condition protection)
 */
export async function ensureInitialized() {
    if (isInitialized) return;

    // If initialization is already in progress, wait for it
    if (initPromise) return initPromise;

    initPromise = (async () => {
        try {
            await accountManager.initialize(STRATEGY_OVERRIDE || undefined);
            isInitialized = true;
            const status: AccountStatus = accountManager.getStatus();
            logger.success(`[Server] Account pool initialized: ${status.summary}`);
        } catch (error: any) {
            initError = error;
            initPromise = null; // Allow retry on failure
            logger.error('[Server] Failed to initialize account manager:', error.message);
            throw error;
        }
    })();

    return initPromise;
}
