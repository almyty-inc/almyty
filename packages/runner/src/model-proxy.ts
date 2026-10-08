/**
 * The model proxy of a hosted pod: how the coding CLIs in it reach models
 * while the pod model token stays out of their hands.
 *
 * The reconcile loop puts a short-lived pod model token into the pod's
 * Secret (ALMYTY_MODEL_TOKEN, with its expiry in
 * ALMYTY_MODEL_TOKEN_EXPIRES_AT) and tells the runner where to listen
 * (ALMYTY_MODEL_PROXY_PORT) and where to renew (ALMYTY_MODEL_RENEW_PATH).
 * The image's entrypoint points every CLI at http://127.0.0.1:<port> with a
 * placeholder key (images/runner-env/entrypoint.sh). This module:
 *
 *   - takes the token out of the runner's environment as soon as it is
 *     read, so nothing the runner starts inherits it;
 *   - listens on the loopback port and forwards each /v1/... call to the
 *     almyty API, replacing whatever credential the CLI sent with the
 *     current token, streaming both ways;
 *   - renews the token with itself when three quarters of its life have
 *     passed, so a CLI keeps working past the token's lifetime without
 *     ever seeing it change.
 *
 * A renewal the API refuses (the pod is being stopped) is not fatal to the
 * runner: model calls answer 401 from then on and the next start brings a
 * fresh token. The token is never logged or written to disk.
 */
import { createServer, IncomingMessage, request as httpRequest, Server, ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { AddressInfo } from 'node:net';

export const MODEL_TOKEN_ENV = 'ALMYTY_MODEL_TOKEN';
export const MODEL_TOKEN_EXPIRES_ENV = 'ALMYTY_MODEL_TOKEN_EXPIRES_AT';
export const MODEL_PROXY_PORT_ENV = 'ALMYTY_MODEL_PROXY_PORT';
export const MODEL_RENEW_PATH_ENV = 'ALMYTY_MODEL_RENEW_PATH';
export const DEFAULT_MODEL_RENEW_PATH = '/runners/hosted/model-token';

/** Renew once this share of the token's lifetime has passed. */
const RENEW_AT_FRACTION = 0.75;
/** Delay between renewal attempts that failed for a reason worth retrying. */
const RENEW_RETRY_MS = 30_000;
/** Headers the proxy never passes on: hop-by-hop, and every credential the CLI sent. */
const DROPPED_REQUEST_HEADERS = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'authorization', 'x-api-key', 'proxy-authorization']);
const DROPPED_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding']);

type Env = Record<string, string | undefined>;

export interface ModelAccessSettings {
  token: string;
  /** Unknown when the pod was started without it; the token is then renewed at once. */
  expiresAt: Date | null;
  port: number;
  renewPath: string;
}

/**
 * The pod model token and the proxy's settings, or null when the pod has
 * none (a runner outside a hosted pod, or an older backend). Removes the
 * token variables from `env` once read.
 */
export function readModelAccess(env: Env = process.env): ModelAccessSettings | null {
  const token = (env[MODEL_TOKEN_ENV] ?? '').trim();
  const expires = (env[MODEL_TOKEN_EXPIRES_ENV] ?? '').trim();
  delete env[MODEL_TOKEN_ENV];
  delete env[MODEL_TOKEN_EXPIRES_ENV];
  const port = Number((env[MODEL_PROXY_PORT_ENV] ?? '').trim());
  if (!token || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const expiresAt = expires ? new Date(expires) : null;
  const renewPath = (env[MODEL_RENEW_PATH_ENV] ?? '').trim();
  return {
    token,
    expiresAt: expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null,
    port,
    renewPath: renewPath.startsWith('/') ? renewPath : DEFAULT_MODEL_RENEW_PATH,
  };
}

export interface ModelTokenOptions {
  backendUrl: string;
  renewPath: string;
  token: string;
  expiresAt: Date | null;
  log?: (line: string) => void;
  fetch?: typeof globalThis.fetch;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  now?: () => number;
}

/** Holds the pod model token and renews it before it expires. */
export class ModelToken {
  private token: string;
  private expiresAt: Date | null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly now: () => number;

  constructor(private readonly opts: ModelTokenOptions) {
    this.token = opts.token;
    this.expiresAt = opts.expiresAt;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = opts.clearTimeoutFn ?? clearTimeout;
    this.now = opts.now ?? Date.now;
  }

  current(): string {
    return this.token;
  }

  expiry(): Date | null {
    return this.expiresAt;
  }

  start(): void {
    this.schedule(this.renewDelay());
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) this.clearTimeoutFn(this.timer);
    this.timer = null;
  }

  /** When to renew, from now; at once when the expiry is unknown. */
  renewDelay(): number {
    if (!this.expiresAt) return 0;
    return Math.max(0, Math.floor((this.expiresAt.getTime() - this.now()) * RENEW_AT_FRACTION));
  }

  /** One renewal. True when a new token is in place. Never throws. */
  async renew(): Promise<boolean> {
    if (this.stopped) return false;
    let status = 0;
    try {
      const res = await this.fetchImpl(`${this.opts.backendUrl}${this.opts.renewPath}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}` },
      });
      status = res.status;
      if (res.ok) {
        const json = (await res.json().catch(() => null)) as { data?: any } | null;
        const next = json?.data?.token;
        const expiresAt = new Date(json?.data?.expiresAt);
        if (typeof next === 'string' && next && !Number.isNaN(expiresAt.getTime())) {
          this.token = next;
          this.expiresAt = expiresAt;
          this.opts.log?.(`model token renewed; next renewal in ${Math.round(this.renewDelay() / 1000)}s`);
          this.schedule(this.renewDelay());
          return true;
        }
      }
    } catch {
      status = 0;
    }
    if (this.stopped) return false;
    // Refused: the pod is being stopped or the token is gone. Model calls
    // answer 401 from here on; the next start brings a fresh token.
    if (status === 401 || status === 403 || status === 404) {
      this.opts.log?.(`model token renewal refused (${status}); coding CLIs cannot reach models until the next start`);
      this.stop();
      return false;
    }
    const left = this.expiresAt ? this.expiresAt.getTime() - this.now() : 0;
    if (this.expiresAt && left <= RENEW_RETRY_MS) {
      this.opts.log?.(`model token renewal failed (${status || 'no answer'}) and it expires before another try`);
      return false;
    }
    this.opts.log?.(`model token renewal failed (${status || 'no answer'}); retrying in ${RENEW_RETRY_MS / 1000}s`);
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
    (this.timer as any)?.unref?.();
  }
}

export interface ModelProxyOptions {
  backendUrl: string;
  token: () => string;
  /** 0 picks a free port (tests). */
  port: number;
  log?: (line: string) => void;
}

/**
 * The loopback model proxy. Only /v1/... is forwarded; the CLI's own
 * credential is replaced with the current pod token. Resolves once it
 * listens, with the port it got.
 */
export async function startModelProxy(opts: ModelProxyOptions): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const base = new URL(opts.backendUrl);
  const server = createServer((req, res) => forward(req, res, base, opts));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return { server, port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function forward(req: IncomingMessage, res: ServerResponse, base: URL, opts: ModelProxyOptions): void {
  const path = req.url ?? '/';
  if (!path.startsWith('/v1/')) {
    res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'Only the model endpoints (/v1/...) are served here' } }));
    return;
  }
  const target = new URL(`${base.pathname.replace(/\/+$/, '')}${path}`, base);
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined && !DROPPED_REQUEST_HEADERS.has(name.toLowerCase())) headers[name] = value;
  }
  headers.authorization = `Bearer ${opts.token()}`;
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const upstream = send(target, { method: req.method, headers }, (answer) => {
    const out: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(answer.headers)) {
      if (value !== undefined && !DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) out[name] = value;
    }
    res.writeHead(answer.statusCode ?? 502, out);
    answer.pipe(res);
  });
  upstream.on('error', (err) => {
    opts.log?.(`model proxy: almyty could not be reached (${err.message})`);
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'almyty could not be reached' } }));
  });
  // A client that goes away stops the upstream call too.
  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy();
  });
  req.pipe(upstream);
}
