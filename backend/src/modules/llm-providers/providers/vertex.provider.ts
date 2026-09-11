import { JWT } from 'google-auth-library';

import { LlmProvider } from '../../../entities/llm-provider.entity';
import { Conversation } from '../../../entities/conversation.entity';
import { Tool } from '../../../entities/tool.entity';
import { ChatRequest, ChatResponse, StreamChunk } from '../dto/llm-providers.dto';
import { callOpenAI, callOpenAIStream } from './openai.provider';

/**
 * Google Vertex AI, through its OpenAI-compatible `endpoints/openapi`
 * surface.
 *
 * This is a different product from the `google` provider type, which is the
 * Gemini Developer API on generativelanguage.googleapis.com with a static
 * API key. Vertex is the customer's OWN Google Cloud project: their quota,
 * their region, their VPC, their Model Garden endpoints.
 *
 * The one thing that makes Vertex not just another base URL: it does not
 * accept a static API key on this surface. Google's docs are explicit that
 * "only Google Cloud Auth is supported using the OpenAI library" - the
 * credential is a one-hour OAuth access token. Vertex API keys exist, but
 * express mode only covers `generateContent`/`streamGenerateContent`, not
 * `endpoints/openapi`. So the stored credential is a service-account JSON
 * key and the token is minted per call (google-auth-library caches it and
 * refreshes on expiry, so this is not a network round trip every time).
 *
 * Verified 2026-09-09, see docs/design/call-only-vendors.md.
 *
 * Model Garden third-party models (Claude, Mistral, Grok, Jamba) are NOT on
 * this surface - they use `:rawPredict` with each vendor's native body - so
 * this adapter serves Gemini on Vertex plus any self-deployed endpoint.
 */

/** Scope required for any Vertex AI prediction call. */
const VERTEX_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/**
 * One JWT client per service account, so google-auth-library's own token
 * cache survives across calls instead of minting a fresh token each time.
 * Keyed by client_email, which is unique per service account.
 */
const jwtClients = new Map<string, JWT>();

export class VertexCredentialError extends Error {
  readonly code = 'VERTEX_CREDENTIAL_INVALID';
}

/**
 * Parse the stored credential as a service-account JSON key. The key is
 * stored as the provider's API key, so it arrives as a string; a bare token
 * (someone pasting an access token) is accepted as-is and passed through,
 * which keeps a short-lived-token workflow possible without a service
 * account.
 */
export function readVertexCredential(raw: string | undefined):
  | { kind: 'service_account'; clientEmail: string; privateKey: string }
  | { kind: 'access_token'; token: string } {
  const value = (raw ?? '').trim();
  if (!value) {
    throw new VertexCredentialError(
      'Vertex AI needs a Google Cloud service-account JSON key (or a current access token) as its credential.',
    );
  }
  if (!value.startsWith('{')) {
    return { kind: 'access_token', token: value };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new VertexCredentialError('Vertex AI credential is not valid JSON; paste the whole service-account key file.');
  }
  if (!parsed?.client_email || !parsed?.private_key) {
    throw new VertexCredentialError(
      'Vertex AI service-account key is missing client_email or private_key.',
    );
  }
  return { kind: 'service_account', clientEmail: parsed.client_email, privateKey: parsed.private_key };
}

/** Mint (or reuse) an access token and shape it into request headers. */
export async function vertexAuthHeaders(provider: LlmProvider): Promise<Record<string, string>> {
  const credential = readVertexCredential(provider.getDecryptedApiKey());

  let token: string | null | undefined;
  if (credential.kind === 'access_token') {
    token = credential.token;
  } else {
    let client = jwtClients.get(credential.clientEmail);
    if (!client) {
      client = new JWT({
        email: credential.clientEmail,
        key: credential.privateKey,
        scopes: [VERTEX_SCOPE],
      });
      jwtClients.set(credential.clientEmail, client);
    }
    const minted = await client.getAccessToken();
    token = typeof minted === 'string' ? minted : minted?.token;
  }

  if (!token) {
    throw new VertexCredentialError('Vertex AI access token could not be minted from the stored credential.');
  }

  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'almyty/1.0',
  };
}

export async function callVertex(
  provider: LlmProvider,
  request: ChatRequest,
  conversation: Conversation,
  tools: Tool[],
  startTime: number,
  calculateProviderCost: (provider: LlmProvider, inputTokens: number, outputTokens: number) => number,
): Promise<ChatResponse> {
  const headers = await vertexAuthHeaders(provider);
  return callOpenAI(provider, request, conversation, tools, startTime, calculateProviderCost, { headers });
}

export async function callVertexStream(
  provider: LlmProvider,
  request: ChatRequest,
  conversation: Conversation,
  tools: Tool[],
  startTime: number,
  calculateProviderCost: (provider: LlmProvider, inputTokens: number, outputTokens: number) => number,
  onChunk: (chunk: StreamChunk) => void,
): Promise<ChatResponse> {
  const headers = await vertexAuthHeaders(provider);
  return callOpenAIStream(provider, request, conversation, tools, startTime, calculateProviderCost, onChunk, { headers });
}

/** Test seam: drop cached JWT clients between cases. */
export function resetVertexClients(): void {
  jwtClients.clear();
}
