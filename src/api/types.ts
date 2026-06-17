export interface GPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args: Record<string, any> };
  functionResponse?: { name: string; response: Record<string, any> };
  inlineData?: { mimeType: string; data: string };
}

export interface GContent {
  role: 'user' | 'model';
  parts: GPart[];
}

export interface FunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, any>;
}

export interface StandardRequest {
  model: string;
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
  tools?: [{ functionDeclarations: FunctionDeclaration[] }];
  toolConfig?: { functionCallingConfig: { mode: string; allowedFunctionNames?: string[] } };
}

export interface StandardResponse {
  candidates: Array<{
    content: { parts: GPart[] };
    finishReason: 'STOP' | 'MAX_TOKENS' | 'TOOL_USE' | string;
  }>;
  usageMetadata: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    cachedContentTokenCount?: number;
  };
}

// Stream chunk is identical to response shape, but partial
export type StandardStreamChunk = Partial<StandardResponse>;
