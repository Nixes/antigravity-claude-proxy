import { Router } from 'express';
import { accountManager, ensureInitialized } from '../server-state.js';
import { formatDuration } from '../utils/helpers.js';
import { getModelQuotas, getSubscriptionTier } from '../cloudcode/index.js';
import { forceRefresh } from '../auth/token-extractor.js';
import { clearThinkingSignatureCache } from '../format/signature-cache.js';
import { config } from '../config.js';
import usageStats from '../modules/usage-stats.js';
import { logger } from '../utils/logger.js';

const adminRouter = Router();

/**
 * Test endpoint - Clear thinking signature cache
 * Used for testing cold cache scenarios in cross-model tests
 */
adminRouter.post('/test/clear-signature-cache', (req, res) => {
    clearThinkingSignatureCache();
    logger.debug('[Test] Cleared thinking signature cache');
    res.json({ success: true, message: 'Thinking signature cache cleared' });
});

/**
 * Health check endpoint - Detailed status
 * Returns status of all accounts including rate limits and model quotas
 */
adminRouter.get('/health', async (req, res) => {
    try {
        await ensureInitialized();
        const start = Date.now();

        // Get high-level status first
        const status = accountManager.getStatus();
        const allAccounts: import('../api/types.js').Account[] = accountManager.getAllAccounts();

        // Fetch quotas for each account in parallel to get detailed model info
        const accountDetails = await Promise.allSettled(
            allAccounts.map(async (account: import('../api/types.js').Account) => {
                // Check model-specific rate limits
                const activeModelLimits = Object.entries(account.modelRateLimits || {})
                    .filter(([_, limit]) => limit.isRateLimited && limit.resetTime > Date.now());
                const isRateLimited = activeModelLimits.length > 0;
                const soonestReset = activeModelLimits.length > 0
                    ? Math.min(...activeModelLimits.map(([_, l]) => l.resetTime))
                    : null;

                const baseInfo = {
                    email: account.email,
                    lastUsed: account.lastUsed ? new Date(account.lastUsed).toISOString() : null,
                    modelRateLimits: account.modelRateLimits || {},
                    rateLimitCooldownRemaining: soonestReset ? Math.max(0, soonestReset - Date.now()) : 0
                };

                // Skip invalid accounts for quota check
                if (account.isInvalid) {
                    const isBanned = account.invalidReason?.toLowerCase().includes('banned') || 
                                     account.invalidReason?.toLowerCase().includes('terms of service');
                    return {
                        ...baseInfo,
                        status: isBanned ? 'banned' : 'invalid',
                        error: account.invalidReason,
                        models: {}
                    };
                }

                try {
                    const token = await accountManager.getTokenForAccount(account);
                    const projectId = account.subscription?.projectId || undefined;
                    const quotas = await getModelQuotas(token, projectId);

                    // Format quotas for readability
                    const formattedQuotas: Record<string, any> = {};
                    for (const [modelId, info] of Object.entries(quotas)) {
                        formattedQuotas[modelId] = {
                            remaining: info.remainingFraction !== null ? `${Math.round(info.remainingFraction * 100)}%` : 'N/A',
                            remainingFraction: info.remainingFraction,
                            resetTime: info.resetTime || null
                        };
                    }

                    return {
                        ...baseInfo,
                        status: isRateLimited ? 'rate-limited' : 'ok',
                        models: formattedQuotas
                    };
                } catch (error: unknown) {
                    return {
                        ...baseInfo,
                        status: 'error',
                        error: error instanceof Error ? error.message : String(error),
                        models: {}
                    };
                }
            })
        );

        // Process results
        const detailedAccounts = accountDetails.map((result, index) => {
            if (result.status === 'fulfilled') {
                return result.value;
            } else {
                const acc = allAccounts[index];
                return {
                    email: acc.email,
                    status: 'error',
                    error: result.reason?.message || 'Unknown error',
                    modelRateLimits: acc.modelRateLimits || {}
                };
            }
        });

        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            latencyMs: Date.now() - start,
            summary: status.summary,
            counts: {
                total: status.total,
                available: status.available,
                rateLimited: status.rateLimited,
                invalid: status.invalid
            },
            accounts: detailedAccounts
        });

    } catch (error: unknown) {
        logger.error('[API] Health check failed:', error);
        res.status(503).json({
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * Account limits endpoint - fetch quota/limits for all accounts × all models
 * Returns a table showing remaining quota and reset time for each combination
 * Use ?format=table for ASCII table output, default is JSON
 */
adminRouter.get('/account-limits', async (req, res) => {
    try {
        await ensureInitialized();
        const allAccounts: import('../api/types.js').Account[] = accountManager.getAllAccounts();
        const format = req.query.format || 'json';
        const includeHistory = req.query.includeHistory === 'true';

        // Fetch quotas for each account in parallel
        const results = await Promise.allSettled(
            allAccounts.map(async (account: import('../api/types.js').Account) => {
                // Skip invalid accounts
                if (account.isInvalid) {
                    return {
                        email: account.email,
                        status: 'invalid',
                        error: account.invalidReason,
                        models: {}
                    };
                }

                try {
                    const token = await accountManager.getTokenForAccount(account);

                    // Fetch subscription tier first to get project ID
                    const subscription = await getSubscriptionTier(token);

                    // Then fetch quotas with project ID for accurate quota info
                    const quotas = await getModelQuotas(token, subscription.projectId || undefined);

                    // Update account object with fresh data
                    account.subscription = {
                        tier: subscription.tier,
                        projectId: subscription.projectId,
                        detectedAt: Date.now()
                    };
                    account.quota = {
                        models: quotas,
                        lastChecked: Date.now()
                    };

                    // Save updated account data to disk (async, don't wait)
                    accountManager.saveToDisk().catch(err => {
                        logger.error('[Server] Failed to save account data:', err);
                    });

                    return {
                        email: account.email,
                        status: 'ok',
                        subscription: account.subscription,
                        models: quotas
                    };
                } catch (error: unknown) {
                    // Detect ToS ban from quota/subscription fetch and mark account invalid
                    if (error instanceof Error && error.message?.startsWith('ACCOUNT_BANNED:')) {
                        accountManager.markInvalid(account.email, 'Account banned — Gemini disabled for Terms of Service violation');
                        return {
                            email: account.email,
                            status: 'banned',
                            error: 'Account banned — Gemini disabled for Terms of Service violation',
                            subscription: account.subscription || { tier: 'unknown', projectId: null },
                            models: {}
                        };
                    }
                    return {
                        email: account.email,
                        status: 'error',
                        error: error instanceof Error ? error.message : String(error),
                        subscription: account.subscription || { tier: 'unknown', projectId: null },
                        models: {}
                    };
                }
            })
        );

        // Process results
        const accountLimits = results.map((result, index) => {
            if (result.status === 'fulfilled') {
                return result.value;
            } else {
                return {
                    email: allAccounts[index].email,
                    status: 'error',
                    error: result.reason?.message || 'Unknown error',
                    models: {}
                };
            }
        });

        // Collect all unique model IDs
        const allModelIds = new Set<string>();
        for (const account of accountLimits) {
            for (const modelId of Object.keys(account.models || {})) {
                allModelIds.add(modelId);
            }
        }

        const sortedModels = Array.from(allModelIds).sort();

        // Return ASCII table format
        if (format === 'table') {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');

            // Build table
            const lines = [];
            const timestamp = new Date().toLocaleString();
            lines.push(`Account Limits (${timestamp})`);

            // Get account status info
            const status = accountManager.getStatus();
            lines.push(`Accounts: ${status.total} total, ${status.available} available, ${status.rateLimited} rate-limited, ${status.invalid} invalid`);
            lines.push('');

            // Table 1: Account status
            const accColWidth = 25;
            const statusColWidth = 15;
            const lastUsedColWidth = 25;
            const resetColWidth = 25;

            let accHeader = 'Account'.padEnd(accColWidth) + 'Status'.padEnd(statusColWidth) + 'Last Used'.padEnd(lastUsedColWidth) + 'Quota Reset';
            lines.push(accHeader);
            lines.push('─'.repeat(accColWidth + statusColWidth + lastUsedColWidth + resetColWidth));

            for (const acc of status.accounts) {
                const shortEmail = acc.email.split('@')[0].slice(0, 22);
                const lastUsed = acc.lastUsed ? new Date(acc.lastUsed).toLocaleString() : 'never';

                // Get status and error from accountLimits
                const accLimit = accountLimits.find(a => a.email === acc.email);
                let accStatus;
                if (acc.isInvalid) {
                    accStatus = 'invalid';
                } else if (accLimit?.status === 'error') {
                    accStatus = 'error';
                } else {
                    // Count exhausted models (0% or null remaining)
                    const models = accLimit?.models || {};
                    const modelCount = Object.keys(models).length;
                    const exhaustedCount = Object.values(models).filter(
                        (q) => q.remainingFraction === 0 || q.remainingFraction === null
                    ).length;

                    if (exhaustedCount === 0) {
                        accStatus = 'ok';
                    } else {
                        accStatus = `(${exhaustedCount}/${modelCount}) limited`;
                    }
                }

                // Get reset time from quota API
                const claudeModel = sortedModels.find((m) => m.includes('claude'));
                const quota = claudeModel && (accLimit?.models as Record<string, any>)?.[claudeModel];
                const resetTime = quota?.resetTime
                    ? new Date(quota.resetTime).toLocaleString()
                    : '-';

                let row = shortEmail.padEnd(accColWidth) + accStatus.padEnd(statusColWidth) + lastUsed.padEnd(lastUsedColWidth) + resetTime;

                // Add error on next line if present
                if (accLimit?.error) {
                    lines.push(row);
                    lines.push('  └─ ' + accLimit.error);
                } else {
                    lines.push(row);
                }
            }
            lines.push('');

            // Calculate column widths - need more space for reset time info
            const modelColWidth = Math.max(28, ...sortedModels.map((m) => m.length)) + 2;
            const accountColWidth = 30;

            // Header row
            let header = 'Model'.padEnd(modelColWidth);
            for (const acc of accountLimits) {
                const shortEmail = acc.email.split('@')[0].slice(0, 26);
                header += shortEmail.padEnd(accountColWidth);
            }
            lines.push(header);
            lines.push('─'.repeat(modelColWidth + accountLimits.length * accountColWidth));

            // Data rows
            for (const modelId of sortedModels) {
                let row = (modelId as string).padEnd(modelColWidth);
                for (const acc of accountLimits) {
                    const quota = (acc.models as Record<string, any>)?.[modelId];
                    let cell;
                    if (acc.status !== 'ok' && acc.status !== 'rate-limited') {
                        cell = `[${acc.status}]`;
                    } else if (!quota) {
                        cell = '-';
                    } else if (quota.remainingFraction === 0 || quota.remainingFraction === null) {
                        // Show reset time for exhausted models
                        if (quota.resetTime) {
                            const resetMs = new Date(quota.resetTime).getTime() - Date.now();
                            if (resetMs > 0) {
                                cell = `0% (wait ${formatDuration(resetMs)})`;
                            } else {
                                cell = '0% (resetting...)';
                            }
                        } else {
                            cell = '0% (exhausted)';
                        }
                    } else {
                        const pct = Math.round(quota.remainingFraction * 100);
                        cell = `${pct}%`;
                    }
                    row += cell.padEnd(accountColWidth);
                }
                lines.push(row);
            }

            return res.send(lines.join('\n'));
        }

        // Get account metadata from AccountManager
        const accountStatus = accountManager.getStatus();
        const accountMetadataMap = new Map(
            accountStatus.accounts.map(a => [a.email, a])
        );

        // Build response data
        const responseData = {
            timestamp: new Date().toLocaleString(),
            totalAccounts: allAccounts.length,
            models: sortedModels,
            modelConfig: config.modelMapping || {},
            globalQuotaThreshold: config.globalQuotaThreshold || 0,
            accounts: accountLimits.map(acc => {
                // Merge quota data with account metadata
                const metadata: any = accountMetadataMap.get(acc.email) || {};
                return {
                    email: acc.email,
                    status: acc.status,
                    error: (acc as any).error || null,
                    // Include metadata from AccountManager (WebUI needs these)
                    source: metadata.source || 'unknown',
                    enabled: metadata.enabled !== false,
                    projectId: metadata.projectId || null,
                    isInvalid: metadata.isInvalid || false,
                    invalidReason: metadata.invalidReason || null,
                    verifyUrl: metadata.verifyUrl || null,
                    lastUsed: metadata.lastUsed || null,
                    modelRateLimits: metadata.modelRateLimits || {},
                    // Quota threshold settings
                    quotaThreshold: metadata.quotaThreshold,
                    modelQuotaThresholds: metadata.modelQuotaThresholds || {},
                    // Subscription data (new)
                    subscription: (acc as any).subscription || metadata.subscription || { tier: 'unknown', projectId: null },
                    // Quota limits
                    limits: Object.fromEntries(
                        sortedModels.map(modelId => {
                            const quota = (acc.models as Record<string, any>)?.[modelId];
                            if (!quota) {
                                return [modelId, null];
                            }
                            return [modelId, {
                                remaining: quota.remainingFraction !== null
                                    ? `${Math.round(quota.remainingFraction * 100)}%`
                                    : 'N/A',
                                remainingFraction: quota.remainingFraction,
                                resetTime: quota.resetTime || null
                            }];
                        })
                    )
                };
            })
        };

        // Optionally include usage history (for dashboard performance optimization)
        if (includeHistory) {
            (responseData as { history?: any }).history = usageStats.getHistory();
        }

        res.json(responseData);
    } catch (error: unknown) {
        res.status(500).json({
            status: 'error',
            error: error instanceof Error ? error.message : String(error)
        });
    }
});

/**
 * Force token refresh endpoint
 */
adminRouter.post('/refresh-token', async (req, res) => {
    try {
        await ensureInitialized();
        // Clear all caches
        accountManager.clearTokenCache();
        accountManager.clearProjectCache();
        // Force refresh default token
        const token = await forceRefresh();
        res.json({
            status: 'ok',
            message: 'Token caches cleared and refreshed',
            tokenPrefix: token.substring(0, 10) + '...'
        });
    } catch (error: unknown) {
        res.status(500).json({
            status: 'error',
            error: error instanceof Error ? error.message : String(error)
        });
    }
});

export default adminRouter;
