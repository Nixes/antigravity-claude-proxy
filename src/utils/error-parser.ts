export interface ParsedError {
    errorType: string;
    statusCode: number;
    errorMessage: string;
}

/**
 * Parse error message to extract error type, status code, and user-friendly message
 */
export function parseError(error: any): ParsedError {
    let errorType = 'api_error';
    let statusCode = 500;
    let errorMessage = error.message;

    if (error.message.includes('401') || error.message.includes('UNAUTHENTICATED')) {
        errorType = 'authentication_error';
        statusCode = 401;
        errorMessage = 'Authentication failed. Make sure Antigravity is running with a valid token.';
    } else if (error.message.includes('429') || error.message.includes('RESOURCE_EXHAUSTED') || error.message.includes('QUOTA_EXHAUSTED')) {
        errorType = 'invalid_request_error';  // Use invalid_request_error to force client to purge/stop
        statusCode = 400;  // Use 400 to ensure client does not retry (429 and 529 trigger retries)

        // Try to extract the quota reset time from the error
        const resetMatch = error.message.match(/quota will reset after ([\dh\dm\ds]+)/i);
        // Try to extract model from our error format "Rate limited on <model>" or JSON format
        const modelMatch = error.message.match(/Rate limited on ([^.]+)\./) || error.message.match(/"model":\s*"([^"]+)"/);
        const model = modelMatch ? modelMatch[1] : 'the model';

        if (resetMatch) {
            errorMessage = `RESOURCE_EXHAUSTED: You have exhausted your capacity on ${model}. Quota will reset after ${resetMatch[1]}.`;
        } else {
            errorMessage = `RESOURCE_EXHAUSTED: You have exhausted your capacity on ${model}. Please wait for your quota to reset.`;
        }
    } else if (error.message.includes('invalid_request_error') || error.message.includes('INVALID_ARGUMENT')) {
        errorType = 'invalid_request_error';
        statusCode = 400;
        const msgMatch = error.message.match(/"message":"([^"]+)"/);
        if (msgMatch) errorMessage = msgMatch[1];
    } else if (error.message.includes('All endpoints failed')) {
        errorType = 'api_error';
        statusCode = 503;
        errorMessage = 'Unable to connect to Claude API. Check that Antigravity is running.';
    } else if (error.message.includes('PERMISSION_DENIED')) {
        errorType = 'permission_error';
        statusCode = 403;
        errorMessage = errorMessage;
    }

    return { errorType, statusCode, errorMessage };
}
