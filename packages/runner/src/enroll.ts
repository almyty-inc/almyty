/**
 * Enroll mode: how a runner inside a hosted pod gets its identity.
 *
 * A hosted pod never holds anybody's login (docs/hosted-runners.md). The
 * reconcile loop writes a single-use enrollment token into the pod's
 * Secret, which the Deployment hands to the container as
 * ALMYTY_ENROLLMENT_TOKEN (envFrom). This module trades that token once,
 * at POST /runners/enroll, for a runner credential that only works on the
 * runner's own stream and its renewal, and then keeps the credential fresh.
 *
 * The rules this file keeps:
 *
 *   - The credential lives in memory only. It is never written to disk,
 *     never put in process.env (where every spawned command would inherit
 *     it) and never printed: errors name the status and the server's
 *     words, not the request.
 *   - The enrollment token is removed from process.env as soon as it is
 *     read, for the same reason. It is spent after one use anyway.
 *   - Enrollment failing is fatal (EnrollmentError). The CLI exits
 *     non-zero, Kubernetes restarts the container, and the reconcile loop
 *     writes a fresh token if the pod does not enroll in time.
 *   - The credential is renewed well before it expires. A renewal the
 *     server refuses (401, 404: the hosted runner is gone) or one that
 *     cannot succeed before expiry is fatal too.
 */
import { readFileSync } from 'node:fs';

import { assertSecureBackendUrl } from './config.js';
import { RunnerConfig, RunnerRuntimeInfo } from './types.js';

/** Where a pod finds the token: the Secret, through envFrom. */
export const ENROLLMENT_TOKEN_ENV = 'ALMYTY_ENROLLMENT_TOKEN';
/** Or a file, for a pod that mounts the Secret instead of injecting it. */
export const ENROLLMENT_TOKEN_FILE_ENV = 'ALMYTY_ENROLLMENT_TOKEN_FILE';

export const DEFAULT_ENROLL_PATH = '/runners/enroll';
export const DEFAULT_HOSTED_STREAM_PATH = '/runners/hosted/stream';
export const DEFAULT_HOSTED_RENEW_PATH = '/runners/hosted/credential';

/** Renew once this share of the credential's lifetime has passed. */
const RENEW_AT_FRACTION = 0.75;
/** Delay between renewal attempts that failed for a reason worth retrying. */
const RENEW_RETRY_MS = 30_000;

/** Enrollment could not happen; the process should exit non-zero. */
export class EnrollmentError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'EnrollmentError';
  }
}

export interface EnrollSettings {
  backendUrl: string;
  enrollPath: string;
  /** Kept off every log line and error message. */
  token: string;
}

type Env = Record<string, string | undefined>;

/**
 * The token and where to send it, from the environment the Deployment
 * sets. Removes the token variables from `env` once read, so nothing the
 * runner spawns later inherits them.
 */
export function readEnrollSettings(
  env: Env = process.env,
  opts: { url?: string; readFile?: (path: string) => string } = {},
): EnrollSettings {
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, 'utf-8'));
  let token = (env[ENROLLMENT_TOKEN_ENV] ?? '').trim();
  const file = (env[ENROLLMENT_TOKEN_FILE_ENV] ?? '').trim();
  if (!token && file) {
    try {
      token = readFile(file).trim();
    } catch (err: any) {
      throw new EnrollmentError(`cannot read ${ENROLLMENT_TOKEN_FILE_ENV} (${file}): ${err?.code ?? err?.message ?? err}`);
    }
  }
  delete env[ENROLLMENT_TOKEN_ENV];
  delete env[ENROLLMENT_TOKEN_FILE_ENV];
  if (!token) {
    throw new EnrollmentError(`no enrollment token: set ${ENROLLMENT_TOKEN_ENV} or ${ENROLLMENT_TOKEN_FILE_ENV}`);
  }

  const backendUrl = (opts.url ?? env.ALMYTY_API_URL ?? env.ALMYTY_URL ?? '').trim().replace(/\/+$/, '');
  if (!backendUrl) throw new EnrollmentError('no API URL: set ALMYTY_API_URL (or pass --url)');
  try {
    assertSecureBackendUrl(backendUrl);
  } catch (err: any) {
    throw new EnrollmentError(err.message);
  }
  return { backendUrl, enrollPath: pathOr(env.ALMYTY_ENROLL_PATH, DEFAULT_ENROLL_PATH), token };
}

function pathOr(value: string | undefined, fallback: string): string {
  const v = (value ?? '').trim();
  return v.startsWith('/') ? v : fallback;
}

export interface EnrollResult {
  runnerId: string;
  credential: string;
  expiresAt: Date;
  effectiveConfig: RunnerConfig;
  streamPath: string;
  renewPath: string;
}

/**
 * Trade the token for a runner credential, once. Throws EnrollmentError
 * on any refusal or malformed answer; the message never carries the token
 * or a credential.
 */
export async function enroll(
  settings: EnrollSettings,
  body: { runtimeInfo: RunnerRuntimeInfo; config?: Partial<RunnerConfig> },
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<EnrollResult> {
  let res: Response;
  try {
    res = await fetchImpl(`${settings.backendUrl}${settings.enrollPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: settings.token, runtimeInfo: body.runtimeInfo, ...(body.config ? { config: body.config } : {}) }),
    });
  } catch (err: any) {
    throw new EnrollmentError(`enrollment request failed: ${networkReason(err)}`);
  }
  if (!res.ok) {
    throw new EnrollmentError(`enrollment refused: ${res.status} ${serverMessage(await safeText(res), settings.token)}`, res.status);
  }
  const json = (await res.json().catch(() => null)) as { data?: any } | null;
  const d = json?.data;
  const expiresAt = new Date(d?.expiresAt);
  if (
    !d || typeof d.runnerId !== 'string' || typeof d.credential !== 'string' || !d.credential ||
    Number.isNaN(expiresAt.getTime()) || !d.effectiveConfig || typeof d.effectiveConfig !== 'object'
  ) {
    throw new EnrollmentError('enrollment answered without a runner id, credential, expiry and config');
  }
  return {
    runnerId: d.runnerId,
    credential: d.credential,
    expiresAt,
    effectiveConfig: d.effectiveConfig,
    streamPath: pathOr(d.streamPath, DEFAULT_HOSTED_STREAM_PATH),
    renewPath: pathOr(d.renewPath, DEFAULT_HOSTED_RENEW_PATH),
  };
}

export interface RunnerCredentialOptions {
  backendUrl: string;
  renewPath: string;
  credential: string;
  expiresAt: Date;
  /** Renewal is impossible: the process should stop. */
  onFatal: (reason: string) => void;
  log?: (line: string) => void;
  fetch?: typeof globalThis.fetch;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  now?: () => number;
}

/**
 * Holds the runner credential and renews it before it expires. `current()`
 * is what every request reads, so a renewed credential is used from the
 * next request on without reconnecting.
 */
export class RunnerCredential {
  private credential: string;
  private expiresAt: Date;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly now: () => number;

  constructor(private readonly opts: RunnerCredentialOptions) {
    this.credential = opts.credential;
    this.expiresAt = opts.expiresAt;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = opts.clearTimeoutFn ?? clearTimeout;
    this.now = opts.now ?? Date.now;
  }

  current(): string {
    return this.credential;
  }

  expiry(): Date {
    return this.expiresAt;
  }

  /** Arm the renewal timer for the current credential. */
  start(): void {
    this.schedule(this.renewDelay());
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) this.clearTimeoutFn(this.timer);
    this.timer = null;
  }

  /** When the current credential should be renewed, from now. */
  renewDelay(): number {
    const left = this.expiresAt.getTime() - this.now();
    return Math.max(0, Math.floor(left * RENEW_AT_FRACTION));
  }

  /**
   * One renewal attempt. Resolves true when a new credential is in place;
   * otherwise schedules a retry, or reports fatal when the server refused
   * or the credential will expire before another try.
   */
  async renew(): Promise<boolean> {
    if (this.stopped) return false;
    let status = 0;
    let detail = '';
    try {
      const res = await this.fetchImpl(`${this.opts.backendUrl}${this.opts.renewPath}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.credential}` },
      });
      status = res.status;
      if (res.ok) {
        const json = (await res.json().catch(() => null)) as { data?: any } | null;
        const next = json?.data?.credential;
        const expiresAt = new Date(json?.data?.expiresAt);
        if (typeof next === 'string' && next && !Number.isNaN(expiresAt.getTime())) {
          this.credential = next;
          this.expiresAt = expiresAt;
          this.opts.log?.(`runner credential renewed; next renewal in ${Math.round(this.renewDelay() / 1000)}s`);
          this.schedule(this.renewDelay());
          return true;
        }
        detail = 'answer carried no credential';
      } else {
        detail = serverMessage(await safeText(res), this.credential);
      }
    } catch (err: any) {
      detail = networkReason(err);
    }
    if (this.stopped) return false;
    // 401: the credential is no longer accepted. 404: the hosted runner is
    // gone or being torn down. Neither gets better by asking again.
    if (status === 401 || status === 403 || status === 404) {
      this.opts.onFatal(`credential renewal refused: ${status} ${detail}`.trim());
      return false;
    }
    const left = this.expiresAt.getTime() - this.now();
    if (left <= RENEW_RETRY_MS) {
      this.opts.onFatal(`credential renewal failed and the credential expires before another try: ${status || ''} ${detail}`.trim());
      return false;
    }
    this.opts.log?.(`credential renewal failed (${status || 'no answer'} ${detail}); retrying in ${RENEW_RETRY_MS / 1000}s`);
    this.schedule(RENEW_RETRY_MS);
    return false;
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    if (this.timer) this.clearTimeoutFn(this.timer);
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      void this.renew();
    }, delay);
    // Not the keep-alive: the heartbeat timer holds the process up.
    (this.timer as any)?.unref?.();
  }
}

/** The server's words, short, with anything secret-shaped removed. */
function serverMessage(text: string, ...secrets: string[]): string {
  let out = text;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.message === 'string') out = parsed.message;
    else if (Array.isArray(parsed?.message)) out = parsed.message.join('; ');
  } catch { /* plain text */ }
  for (const s of secrets) if (s) out = out.split(s).join('[redacted]');
  return out.replace(/\s+/g, ' ').slice(0, 200);
}

/** fetch's own "fetch failed" says nothing; the cause names the socket error. */
function networkReason(err: any): string {
  const code = err?.cause?.code ?? err?.cause?.errors?.[0]?.code;
  return [err?.message ?? String(err), code].filter(Boolean).join(': ');
}

async function safeText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ''; }
}
