export interface GPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  inlineData?: { mimeType: string; data: string };
  fileData?: { mimeType: string; fileUri: string };
}

export interface GContent {
  role: 'user' | 'model';
  parts: GPart[];
}

export interface FunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface StandardRequest {
  model: string;
  sessionId?: string;
  contents: GContent[];
  systemInstruction?: { parts: { text: string }[] };
  generationConfig: {
    maxOutputTokens?: number;
    temperature?: number;
    topP?: number;
    topK?: number;
    stopSequences?: string[];
    thinkingConfig?: {
      include_thoughts?: boolean;
      thinking_budget?: number;
      includeThoughts?: boolean;
      thinkingBudget?: number;
    };
  };
  tools?: Array<{ functionDeclarations?: FunctionDeclaration[]; googleSearch?: Record<string, unknown> }>;
  toolConfig?: { functionCallingConfig: { mode: string; allowedFunctionNames?: string[] } };
}

export interface StandardResponse {
  candidates: Array<{
    content: { parts: GPart[] };
    finishReason: 'STOP' | 'MAX_TOKENS' | 'TOOL_USE' | string;
    groundingMetadata?: {
      webSearchQueries?: string[];
      groundingChunks?: Array<{ web?: { uri: string; title: string } }>;
    };
  }>;
  usageMetadata: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    cachedContentTokenCount?: number;
  };
}

// Stream chunk is identical to response shape, but partial
export type StandardStreamChunk = Partial<StandardResponse>;

export interface Account {
  email: string;
  source?: string;
  enabled?: boolean;
  projectId?: string | null;
  modelRateLimits?: Record<string, { isRateLimited: boolean, resetTime: number }>;
  isInvalid?: boolean;
  invalidReason?: string;
  invalidAt?: number;
  verifyUrl?: string | null;
  lastUsed?: string | number;
  quotaThreshold?: number;
  modelQuotaThresholds?: Record<string, number>;
  subscription?: { tier: string; projectId: string | null; detectedAt?: number };
  quota?: { models: Record<string, any>; lastChecked: number };
}

export interface AccountStatus {
  total: number;
  available: number;
  rateLimited: number;
  invalid: number;
  summary: string;
  accounts: Account[];
}

export interface IAccountManager {
  getStatus(): AccountStatus;
  getAllAccounts(): Account[];
  getAccountCount(): number;
  clearExpiredLimits(): void;
  getAvailableAccounts(model: string): Account[];
  isAllAccountsInvalid(): boolean;
  getInvalidAccounts(): Account[];
  isAllRateLimited(model: string): boolean;
  getMinWaitTimeMs(model: string): number;
  selectAccount(model: string): { account: Account | null, waitMs: number };
  getTokenForAccount(account: Account): Promise<string>;
  getProjectForAccount(account: Account, token: string): Promise<string | null>;
  markInvalid(email: string, reason: string, verifyUrl?: string): void;
  clearTokenCache(email: string): void;
  clearProjectCache(email: string): void;
  getConsecutiveFailures(email: string): number;
  incrementConsecutiveFailures(email: string): void;
  markRateLimited(email: string, delayMs: number, model: string): void;
  notifySuccess(account: Account, model: string): void;
  notifyRateLimit(account: Account, model: string): void;
  notifyFailure(account: Account, model: string): void;
  resetAllRateLimits(): void;
}

export interface AnthropicRequest {
  model: string;
  google_search?: boolean;
  messages: Array<{ role: string, content: unknown }>;
  system?: string | Array<{ type: string, text: string }>;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  tools?: unknown[];
  tool_choice?: unknown;
  thinking?: unknown;
  stream?: boolean;
}

export interface OpenAIRequest {
  model: string;
  google_search?: boolean;
  messages: Array<{ 
    role: string, 
    content: unknown, 
    tool_calls?: Array<{ id: string, type: string, function: { name: string, arguments: string } }>, 
    tool_call_id?: string, 
    name?: string 
  }>;
  stream?: boolean;
  max_completion_tokens?: number;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  stop?: string | string[];
}

export interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> };
    finish_reason: string | null;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

declare global {
  namespace Express {
    export interface Response {
      flush?: () => void;
    }
  }
}
