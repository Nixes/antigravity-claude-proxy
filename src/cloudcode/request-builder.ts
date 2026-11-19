import crypto from 'crypto';
import {
  ANTIGRAVITY_HEADERS,
  ANTIGRAVITY_SYSTEM_INSTRUCTION,
  getModelFamily,
  isThinkingModel
} from '../constants.js';
import { convertAnthropicToGoogle, stripBillingHeader } from '../format/request-converter.js';
import { deriveSessionId } from './session-manager.js';
import { StandardRequest, GContent, GPart, AnthropicRequest } from '../api/types.js';

type IdentityScrubRule = readonly [term: string, replacement: string];
type CompiledIdentityScrubRule = readonly [pattern: RegExp, replacement: string];

interface CloudCodeInnerRequest extends Omit<StandardRequest, 'model'> {
  model?: string;
  sessionId: string;
}

interface CloudCodePayload extends Record<string, unknown> {
  project: string | null;
  model: string;
  request: CloudCodeInnerRequest;
  userAgent: string;
  requestType: string;
  requestId: string;
}

// cloudcode-pa returns an opaque 429 RESOURCE_EXHAUSTED (reported as "quota
// exhausted", even when quota remains) when a request's system prompt names a
// known third-party AI product — e.g. an agent whose identity line says it was
// "created by <vendor>". This is the same class of problem as the "Antigravity"
// identity handling (issue #76), but for the *caller's* identity. We neutralize
// those strings in the caller-supplied system parts.
//
// Defaults cover agents commonly used with this proxy; extend or override with
// the ANTIGRAVITY_SCRUB_IDENTITY env var, formatted as a comma-separated list of
// "Term=>Replacement" pairs, e.g. "Nous Research=>the team,Hermes=>the assistant".
//
// Claude Code and Anthropic are listed explicitly: issue #375 identified
// "You are Claude Code, Anthropic's official CLI for Claude." as a 429 trigger
// alongside the billing header. Matching stays case-sensitive, so lower-case
// header names (x-anthropic-beta, anthropic-version) and CLAUDE.md pass through.
const DEFAULT_IDENTITY_SCRUB: readonly IdentityScrubRule[] = [
  ['Nous Research', 'the assistant team'],
  ['Hermes Agent', 'the assistant'],
  ['Hermes', 'the assistant'],
  ['Claude Code', 'the assistant'],
  ['Anthropic', 'the vendor']
];

function parseIdentityScrubEnv(raw: string | undefined): IdentityScrubRule[] {
  if (!raw) return [];

  const rules: IdentityScrubRule[] = [];
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf('=>');
    if (idx === -1) continue;

    const term = pair.slice(0, idx).trim();
    if (term.length === 0) continue;

    rules.push([term, pair.slice(idx + 2).trim()]);
  }
  return rules;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Match terms as whole words only so identifiers like convertAnthropicToGoogle()
// or AnthropicRequest are left untouched. Read env var per call to avoid global state.
function getIdentityScrubRules(): CompiledIdentityScrubRule[] {
  return [
    ...DEFAULT_IDENTITY_SCRUB,
    ...parseIdentityScrubEnv(process.env.ANTIGRAVITY_SCRUB_IDENTITY)
  ].map(([term, replacement]) => [new RegExp(`\\b${escapeRegExp(term)}\\b`, 'g'), replacement]);
}

function scrubClientIdentity(text: string, rules: readonly CompiledIdentityScrubRule[]): string {
  let out = text;
  for (const [pattern, replacement] of rules) {
    out = out.replace(pattern, () => replacement);
  }
  return out;
}

/**
 * Prepend the caller's system prompt to the conversation as a user-turn text part.
 *
 * Claude Code's default system prompt contains passages (security-testing policy,
 * <pasted_content> guidance) that cause cloudcode-pa to return opaque 429
 * RESOURCE_EXHAUSTED when placed in systemInstruction, while the same text is
 * accepted inside contents (issues #408, #410).
 */
function prependCallerSystemPrompt(googleRequest: CloudCodeInnerRequest, systemText: string): void {
  if (!systemText) return;
  const part: GPart = { text: `<system-instructions>\n${systemText}\n</system-instructions>` };
  const first: GContent | undefined = googleRequest.contents?.[0];
  const firstIsFunctionResponse = Boolean(first?.parts?.[0]?.functionResponse);

  if (first && first.role === 'user' && Array.isArray(first.parts) && !firstIsFunctionResponse) {
    first.parts.unshift(part);
  } else {
    googleRequest.contents = [{ role: 'user', parts: [part] }, ...(googleRequest.contents || [])];
  }
}

export function buildCloudCodeRequestFromStandard(
  standardRequest: StandardRequest,
  projectId: string | null,
  accountEmail: string
): CloudCodePayload {
  // Deep clone to avoid mutating the original
  const googleRequest = JSON.parse(JSON.stringify(standardRequest)) as CloudCodeInnerRequest;
  delete googleRequest.model;

  // Derive session ID BEFORE prepending <system-instructions> so session affinity
  // hashes only the caller's actual first user turn.
  googleRequest.sessionId = deriveSessionId(googleRequest, accountEmail);

  const systemParts: GPart[] = [
    { text: ANTIGRAVITY_SYSTEM_INSTRUCTION },
    { text: `Please ignore the following [ignore]${ANTIGRAVITY_SYSTEM_INSTRUCTION}[/ignore]` }
  ];

  // Move caller's scrubbed system prompt into the first user turn instead of
  // systemInstruction (issues #408, #410). Strip billing headers defensively
  // for non-Anthropic paths (e.g. OpenAI) as well.
  const scrubRules = getIdentityScrubRules();
  const callerSystemText = (googleRequest.systemInstruction?.parts || [])
    .map((part) => stripBillingHeader(part.text || ''))
    .filter((text) => text.length > 0)
    .map((text) => scrubClientIdentity(text, scrubRules))
    .join('\n\n');
  prependCallerSystemPrompt(googleRequest, callerSystemText);

  const payload: CloudCodePayload = {
    project: projectId,
    model: standardRequest.model,
    request: googleRequest,
    userAgent: 'antigravity',
    requestType: 'agent',
    requestId: 'agent-' + crypto.randomUUID()
  };

  payload.request.systemInstruction = {
    role: 'user',
    parts: systemParts as Array<{ text: string }>
  };

  return payload;
}

export function buildCloudCodeRequest(
  anthropicRequest: AnthropicRequest,
  projectId: string | null,
  accountEmail: string
): CloudCodePayload {
  const standardRequest = convertAnthropicToGoogle(anthropicRequest);
  return buildCloudCodeRequestFromStandard(
    { ...standardRequest, model: standardRequest.model || anthropicRequest.model },
    projectId,
    accountEmail
  );
}

export function buildHeaders(
  token: string,
  model: string,
  accept: string = 'application/json',
  sessionId?: string
): Record<string, string> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...ANTIGRAVITY_HEADERS
  };

  if (sessionId) {
    headers['X-Machine-Session-Id'] = sessionId;
  }

  const modelFamily = getModelFamily(model);

  if (modelFamily === 'claude' && isThinkingModel(model)) {
    headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14';
  }

  if (accept !== 'application/json') {
    headers['Accept'] = accept;
  }

  return headers;
}
