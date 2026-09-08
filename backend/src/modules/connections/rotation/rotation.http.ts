import { RotationError, RotationHttp } from './rotation.interface';

/**
 * The few HTTP chores every rotation provider repeats: a JSON call with
 * a timeout, a body reader that tolerates non-JSON, and the status to
 * error-code mapping. Providers stay small and their fixtures assert on
 * exact requests instead of on helper internals.
 */

export const ROTATION_TIMEOUT_MS = 15_000;

export function defaultRotationHttp(): RotationHttp {
  return (url, init) => fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(ROTATION_TIMEOUT_MS) });
}

export interface JsonReply {
  status: number;
  ok: boolean;
  json: any;
  text: string;
}

/** Runs one request and reads the body once; a transport failure is ROTATION_FAILED, never a thrown fetch error. */
export async function callJson(http: RotationHttp, url: string, init: RequestInit & { headers?: Record<string, string> }): Promise<JsonReply> {
  let res: Response;
  try {
    res = await http(url, init);
  } catch (e: any) {
    throw new RotationError('ROTATION_FAILED', `could not reach ${new URL(url).host}: ${e?.message ?? e}`);
  }
  const text = await res.text().catch(() => '');
  let json: any = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res.status, ok: res.ok, json, text };
}

/** Provider error text without secrets: the first 160 chars of the message field or body. */
export function shortError(reply: JsonReply): string {
  const m = reply.json?.error?.message ?? reply.json?.error_description ?? reply.json?.message ?? reply.json?.detail ?? reply.json?.error ?? reply.text;
  return String(typeof m === 'string' ? m : JSON.stringify(m ?? '')).replace(/\s+/g, ' ').trim().slice(0, 160);
}

/** 401 / 403 mean the credential cannot manage keys; everything else non-2xx is a failed call. */
export function failOn(reply: JsonReply, what: string): void {
  if (reply.ok) return;
  const detail = shortError(reply);
  if (reply.status === 401 || reply.status === 403) {
    throw new RotationError('ROTATION_AUTH', `${what}: provider rejected the credential (${reply.status}${detail ? ': ' + detail : ''})`, reply.status);
  }
  throw new RotationError('ROTATION_FAILED', `${what}: provider answered ${reply.status}${detail ? ': ' + detail : ''}`, reply.status);
}

export function requireField(secrets: Record<string, any>, field: string, provider: string): string {
  const v = secrets[field];
  if (typeof v !== 'string' || !v.trim()) throw new RotationError('ROTATION_UNSUPPORTED', `${provider}: ${field} is required`);
  return v.trim();
}

/** A path segment from user-supplied config: encoded, and refused when empty. */
export function segment(value: string, name: string, provider: string): string {
  if (!value || /[\/\s]/.test(value)) throw new RotationError('ROTATION_FAILED', `${provider}: ${name} is not a valid identifier`);
  return encodeURIComponent(value);
}

export function unixSeconds(v: unknown): Date | undefined {
  return typeof v === 'number' && v > 0 ? new Date(v * 1000) : undefined;
}

export function isoDate(v: unknown): Date | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** `sk-abc...def` style hints: true when the full secret starts and ends with the hint's visible parts. */
export function matchesRedacted(secret: string, hint: string | null | undefined): boolean {
  if (!hint) return false;
  const parts = hint.split(/\.{3}|\*+/);
  if (parts.length < 2) return secret.endsWith(hint) || secret.startsWith(hint);
  const [head, tail] = [parts[0], parts[parts.length - 1]];
  return (!head || secret.startsWith(head)) && (!tail || secret.endsWith(tail));
}

/** Default label for a minted key: what the org will see in the vendor console. */
export function keyLabel(ctx: { label?: string; connectionId: string; now?: Date }): string {
  if (ctx.label) return ctx.label;
  const day = (ctx.now ?? new Date()).toISOString().slice(0, 10);
  return `almyty ${ctx.connectionId.slice(0, 8)} ${day}`;
}
