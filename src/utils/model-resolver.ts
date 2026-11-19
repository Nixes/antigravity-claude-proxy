import { BUILTIN_MODEL_MAPPINGS } from '../constants.js';
import { logger } from './logger.js';

export interface ModelMappingEntry {
    mapping?: string;
}

/**
 * Resolve a requested client model ID through user-configured modelMapping
 * first, then built-in legacy/alias mappings.
 */
export function resolveModelId(
    requestedModel: string,
    modelMapping?: Record<string, ModelMappingEntry>
): string {
    const mapped = modelMapping?.[requestedModel]?.mapping;
    if (mapped) {
        logger.info(`[Server] Mapping model ${requestedModel} -> ${mapped}`);
        return mapped;
    }

    const builtin = (BUILTIN_MODEL_MAPPINGS as Record<string, string>)[requestedModel];
    if (builtin) {
        logger.info(`[Server] Built-in mapping model ${requestedModel} -> ${builtin}`);
        return builtin;
    }

    return requestedModel;
}
