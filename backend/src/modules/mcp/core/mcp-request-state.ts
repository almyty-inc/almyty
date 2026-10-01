/**
 * Sealed `requestState` for MCP multi round-trip requests (2026-07-28,
 * "Multi Round-Trip Requests").
 *
 * When a call needs a person's input, the server answers
 * `resultType: "input_required"` with a `requestState` the client echoes on
 * its retry. Ours decides what the retry may do (which approval it answers,
 * which run it resumes), so the spec requires it to be integrity protected
 * and bound to the principal, a short expiry and the request it belongs to.
 *
 * It is AES-256-GCM under a key derived from ENCRYPTION_KEY (HKDF, its own
 * `info`, so it shares no key with stored secrets): the client can neither
 * read nor change it. The payload carries:
 *  - `sub`: who may present it (a user id, or nobody for an anonymous caller,
 *    which no retry can match);
 *  - `exp`: epoch seconds after which it is refused
 *    (MCP_REQUEST_STATE_TTL_SECONDS);
 *  - `req`: a digest of the method, the tool/prompt/resource and its
 *    arguments, so it cannot be moved onto another call;
 *  - `kind` and `data`: what the input is for.
 *
 * Single use is not promised by the seal itself. The things it unlocks are
 * single-use where it matters: an approval can be decided once, and a run
 * takes an answer only while it waits for one.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'crypto';

import { mcpProtocolSettings } from './mcp-settings';

const INFO = 'almyty mcp requestState v1';
const VERSION = 1;

let devKeyWarned = false;

function stateKey(env: Record<string, string | undefined> = process.env): Buffer {
  const secret = env.ENCRYPTION_KEY;
  if (!secret) {
    if (env.NODE_ENV === 'production') {
      throw new Error('ENCRYPTION_KEY is required in production to seal MCP request state.');
    }
    if (!devKeyWarned) {
      // eslint-disable-next-line no-console
      console.warn('[SECURITY WARNING] ENCRYPTION_KEY not set; MCP request state is sealed with a development key.');
      devKeyWarned = true;
    }
  }
  return Buffer.from(hkdfSync('sha256', secret || 'default-encryption-key-change-me!', Buffer.alloc(0), INFO, 32));
}

/** What the retry is allowed to do. */
export interface McpRequestStatePayload {
  kind: string;
  data: Record<string, unknown>;
}

interface SealedPayload extends McpRequestStatePayload {
  v: number;
  sub: string | null;
  exp: number;
  req: string;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.keys(value as object)
      .sort()
      .reduce((out, key) => {
        out[key] = stable((value as Record<string, unknown>)[key]);
        return out;
      }, {} as Record<string, unknown>);
  }
  return value;
}

/**
 * The salient part of a request: its method, what it names, and its
 * arguments. `_meta`, `inputResponses` and `requestState` change between the
 * first call and the retry, so they are not part of it.
 */
export function requestDigest(method: string, params: any): string {
  const p = params && typeof params === 'object' ? params : {};
  const salient = {
    method,
    name: p.name ?? null,
    uri: p.uri ?? null,
    arguments: p.arguments ?? null,
  };
  return createHash('sha256').update(JSON.stringify(stable(salient))).digest('base64url');
}

export function sealRequestState(
  payload: McpRequestStatePayload,
  bind: { principal: string | null | undefined; method: string; params: any },
  now: number = Date.now(),
): string {
  const sealed: SealedPayload = {
    v: VERSION,
    kind: payload.kind,
    data: payload.data,
    sub: bind.principal ?? null,
    exp: Math.floor(now / 1000) + mcpProtocolSettings().requestStateTtlSeconds,
    req: requestDigest(bind.method, bind.params),
  };
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', stateKey(), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(sealed), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url');
}

/** Why a presented requestState was refused. */
export type RequestStateRefusal = 'malformed' | 'tampered' | 'expired' | 'wrong_principal' | 'wrong_request';

/**
 * Open a requestState presented on a retry. Every failure is a refusal,
 * never a partial payload: the caller answers it as invalid params.
 */
export function openRequestState(
  value: unknown,
  bind: { principal: string | null | undefined; method: string; params: any },
  now: number = Date.now(),
): { payload: McpRequestStatePayload } | { refusal: RequestStateRefusal } {
  if (typeof value !== 'string' || value.length < 40 || value.length > 16_384) return { refusal: 'malformed' };
  let raw: Buffer;
  try {
    raw = Buffer.from(value, 'base64url');
  } catch {
    return { refusal: 'malformed' };
  }
  if (raw.length < 12 + 16 + 2) return { refusal: 'malformed' };
  let sealed: SealedPayload;
  try {
    const decipher = createDecipheriv('aes-256-gcm', stateKey(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    sealed = JSON.parse(plain);
  } catch {
    return { refusal: 'tampered' };
  }
  if (!sealed || sealed.v !== VERSION || typeof sealed.kind !== 'string') return { refusal: 'malformed' };
  if (typeof sealed.exp !== 'number' || sealed.exp * 1000 <= now) return { refusal: 'expired' };
  // A state minted for nobody matches nobody.
  if (!sealed.sub || sealed.sub !== (bind.principal ?? null)) return { refusal: 'wrong_principal' };
  if (sealed.req !== requestDigest(bind.method, bind.params)) return { refusal: 'wrong_request' };
  return { payload: { kind: sealed.kind, data: sealed.data ?? {} } };
}

export const REQUEST_STATE_REFUSAL_MESSAGE: Record<RequestStateRefusal, string> = {
  malformed: 'requestState is not one this server issued',
  tampered: 'requestState failed verification',
  expired: 'requestState has expired; call again without it',
  wrong_principal: 'requestState was issued to another caller',
  wrong_request: 'requestState belongs to a different request',
};
