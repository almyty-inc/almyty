/**
 * Real gRPC executor. Loads the proto file stored on
 * ApiSchema.rawSchema, builds a dynamic @grpc/grpc-js client,
 * dispatches the call, and returns a JSON-safe response.
 *
 * Supported call shapes (selected via the `requestStream` and
 * `responseStream` flags the parser persists on the operation):
 *   - unary               (!req && !res) — single in, single out
 *   - server streaming    (!req &&  res) — single in, collected list out
 *   - client streaming    ( req && !res) — list in, single out
 *   - bidi streaming      ( req &&  res) — list in, collected list out
 *
 * Streaming responses are bounded — `MAX_STREAM_MESSAGES` and the
 * caller's deadline both apply — so a runaway server stream can't
 * exhaust the worker's heap or hang the tool execution.
 *
 * Other things this does:
 *   - resolves host:port from `api.baseUrl` (defaults to :443 for
 *     https, :80 for http, or whatever the URL specifies)
 *   - writes the proto schema to a tmp file (proto-loader requires a
 *     path), keyed by sha256 hash so repeat calls reuse it
 *   - walks the loaded package object recursively to find the
 *     service constructor matching the requested service name
 *   - applies metadata for auth (OAuth2 bearer, API key) and any
 *     extra metadata passed in
 */
import { Injectable, Logger } from '@nestjs/common';
import { credentials, Metadata, loadPackageDefinition, ClientReadableStream, ClientWritableStream, ClientDuplexStream } from '@grpc/grpc-js';
import { loadSync as loadProtoSync } from '@grpc/proto-loader';
import { createHash } from 'crypto';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';

const PROTO_CACHE_DIR = join(tmpdir(), 'almyty-proto-cache');

/**
 * Include directories that proto-loader walks when resolving
 * `import "google/api/...";` and similar references inside the
 * stored proto. Without these, real-world protos (Google Cloud
 * APIs, Envoy, etc.) fail to load because their imports point at
 * well-known proto subtrees that aren't bundled in the schema text.
 */
function resolveProtoIncludeDirs(): string[] {
  const dirs: string[] = [PROTO_CACHE_DIR];
  try {
    // google-proto-files' getProtoPath('.') returns
    // `<install>/google` — the import paths in real protos are of
    // the form `google/api/foo.proto`, so the include dir we want
    // is the parent directory.
    const gpf = require('google-proto-files');
    const base = dirname(gpf.getProtoPath('.'));
    dirs.push(base);
  } catch {
    // package optional — if it's missing, single-file protos still
    // load fine and any proto with cross-file imports will surface a
    // clear error from proto-loader.
  }
  // protobufjs ships its own `google/protobuf/*.proto` (descriptor,
  // any, struct, timestamp, ...). Add the parent of its `google`
  // subtree so those well-known types are always available.
  try {
    const pbjs = require.resolve('protobufjs');
    dirs.push(dirname(pbjs));
  } catch {
    // ignore
  }
  return dirs;
}

const PROTO_INCLUDE_DIRS = resolveProtoIncludeDirs();

/** Hard cap on collected stream messages — protects worker heap. */
const MAX_STREAM_MESSAGES = 100;

export interface GrpcCallInput {
  /** Full proto schema source — typically ApiSchema.rawSchema. */
  protoSource: string;
  /** Host[:port] or full https:// URL. Port defaults: 443 for https, 80 for http. */
  baseUrl: string;
  /** Service name (e.g. "TranslationService"). Namespace optional; we search recursively. */
  serviceName: string;
  /** Method name (e.g. "DetectLanguage"). */
  methodName: string;
  /**
   * Request body. For unary + server-streaming, a single message
   * object. For client-streaming + bidi, an array of messages to
   * send sequentially.
   */
  request: Record<string, any> | Record<string, any>[];
  /** Per-call metadata headers (auth, etc). */
  metadata?: Record<string, string>;
  /** Per-call deadline in ms (added to Date.now()). */
  timeoutMs?: number;
  /** Set by the parser; treat `request` as an array of messages. */
  requestStream?: boolean;
  /** Set by the parser; collect server messages into an array. */
  responseStream?: boolean;
  /**
   * Override the default {@link MAX_STREAM_MESSAGES} cap for this
   * call. Used by the executor when the operation needs more (or
   * fewer) buffered messages than the default.
   */
  maxStreamMessages?: number;
}

export interface GrpcCallResult {
  success: boolean;
  /**
   * Response payload. Single object for unary + client-streaming,
   * an array of messages for server-streaming + bidi (capped at
   * `maxStreamMessages`). Empty array if the server completed
   * without emitting a message.
   */
  data?: any;
  error?: string;
  /** gRPC status code on failure (0 = OK). See @grpc/grpc-js status enum. */
  code?: number;
  /**
   * For streaming responses: how many messages we received before
   * either the stream ended naturally or we hit the cap. Lets the
   * caller surface "we cut you off" without inspecting `.data.length`.
   */
  streamMessageCount?: number;
  /** True if the cap stopped collection before the stream ended. */
  streamTruncated?: boolean;
}

@Injectable()
export class GrpcCallerService {
  private readonly logger = new Logger(GrpcCallerService.name);

  async call(input: GrpcCallInput): Promise<GrpcCallResult> {
    let target: string;
    let useTls: boolean;
    try {
      ({ target, useTls } = this.resolveTarget(input.baseUrl));
    } catch (err: any) {
      return { success: false, error: `Invalid baseUrl: ${err.message}` };
    }

    let protoPath: string;
    try {
      protoPath = this.materializeProto(input.protoSource);
    } catch (err: any) {
      return { success: false, error: `Failed to write proto file: ${err.message}` };
    }

    let packageDef: any;
    try {
      packageDef = loadProtoSync(protoPath, {
        keepCase: true,
        longs: Number,
        enums: String,
        defaults: true,
        oneofs: true,
        includeDirs: PROTO_INCLUDE_DIRS,
      });
    } catch (err: any) {
      return { success: false, error: `Failed to load proto: ${err.message}` };
    }

    const loaded = loadPackageDefinition(packageDef);
    const ServiceCtor = this.findServiceConstructor(loaded, input.serviceName);
    if (!ServiceCtor) {
      return {
        success: false,
        error: `Service "${input.serviceName}" not found in proto file. Check the schema or service name spelling.`,
      };
    }

    const channelCreds = useTls
      ? credentials.createSsl()
      : credentials.createInsecure();
    const client = new ServiceCtor(target, channelCreds);

    if (typeof client[input.methodName] !== 'function') {
      return {
        success: false,
        error: `Method "${input.methodName}" not found on service "${input.serviceName}".`,
      };
    }

    const meta = new Metadata();
    for (const [k, v] of Object.entries(input.metadata || {})) {
      meta.set(k, v);
    }

    const deadline = input.timeoutMs
      ? new Date(Date.now() + input.timeoutMs)
      : undefined;
    const callOptions: any = {};
    if (deadline) callOptions.deadline = deadline;

    const cap = input.maxStreamMessages ?? MAX_STREAM_MESSAGES;
    const reqStream = !!input.requestStream;
    const resStream = !!input.responseStream;

    try {
      if (!reqStream && !resStream) {
        return await this.callUnary(client, input.methodName, input.request ?? {}, meta, callOptions);
      }
      if (!reqStream && resStream) {
        return await this.callServerStreaming(client, input.methodName, input.request ?? {}, meta, callOptions, cap);
      }
      if (reqStream && !resStream) {
        return await this.callClientStreaming(client, input.methodName, this.toMessageArray(input.request), meta, callOptions);
      }
      return await this.callBidi(client, input.methodName, this.toMessageArray(input.request), meta, callOptions, cap);
    } catch (err: any) {
      // Synchronous throw paths — usually means the request payload
      // doesn't match the proto's message shape, or the channel
      // refused to dial.
      return { success: false, error: err.message || String(err) };
    }
  }

  // ── Call shape implementations ────────────────────────────────

  private callUnary(
    client: any,
    method: string,
    request: any,
    meta: Metadata,
    options: any,
  ): Promise<GrpcCallResult> {
    return new Promise<GrpcCallResult>((resolve) => {
      client[method](request, meta, options, (err: any, response: any) => {
        if (err) {
          resolve({
            success: false,
            error: err.details || err.message || String(err),
            code: err.code,
          });
          return;
        }
        resolve({ success: true, data: response, code: 0 });
      });
    });
  }

  private callServerStreaming(
    client: any,
    method: string,
    request: any,
    meta: Metadata,
    options: any,
    cap: number,
  ): Promise<GrpcCallResult> {
    return new Promise<GrpcCallResult>((resolve) => {
      let stream: ClientReadableStream<any>;
      try {
        stream = client[method](request, meta, options);
      } catch (err: any) {
        resolve({ success: false, error: err.message || String(err) });
        return;
      }
      const messages: any[] = [];
      let truncated = false;
      stream.on('data', (msg: any) => {
        if (messages.length >= cap) {
          if (!truncated) {
            truncated = true;
            // Close the stream as soon as we hit the cap so the
            // server stops sending. cancel() is safe to call
            // multiple times; the type definition exposes it.
            try { (stream as any).cancel(); } catch { /* best effort */ }
          }
          return;
        }
        messages.push(msg);
      });
      stream.on('error', (err: any) => {
        // CANCELLED (1) is the expected outcome when we hit the cap
        // and called cancel() ourselves — return what we have.
        if (truncated && err.code === 1) {
          resolve({
            success: true,
            data: messages,
            code: 0,
            streamMessageCount: messages.length,
            streamTruncated: true,
          });
          return;
        }
        resolve({
          success: false,
          error: err.details || err.message || String(err),
          code: err.code,
          data: messages,
          streamMessageCount: messages.length,
          streamTruncated: truncated,
        });
      });
      stream.on('end', () => {
        resolve({
          success: true,
          data: messages,
          code: 0,
          streamMessageCount: messages.length,
          streamTruncated: truncated,
        });
      });
    });
  }

  private callClientStreaming(
    client: any,
    method: string,
    messages: any[],
    meta: Metadata,
    options: any,
  ): Promise<GrpcCallResult> {
    return new Promise<GrpcCallResult>((resolve) => {
      let stream: ClientWritableStream<any>;
      try {
        stream = client[method](meta, options, (err: any, response: any) => {
          if (err) {
            resolve({
              success: false,
              error: err.details || err.message || String(err),
              code: err.code,
            });
            return;
          }
          resolve({ success: true, data: response, code: 0 });
        });
      } catch (err: any) {
        resolve({ success: false, error: err.message || String(err) });
        return;
      }
      // Pump messages serially; backpressure is honored by the
      // grpc-js stream returning false from write(). With a small
      // batch (typical client-streaming use case) we just write
      // everything and call end().
      for (const msg of messages) stream.write(msg);
      stream.end();
    });
  }

  private callBidi(
    client: any,
    method: string,
    messages: any[],
    meta: Metadata,
    options: any,
    cap: number,
  ): Promise<GrpcCallResult> {
    return new Promise<GrpcCallResult>((resolve) => {
      let stream: ClientDuplexStream<any, any>;
      try {
        stream = client[method](meta, options);
      } catch (err: any) {
        resolve({ success: false, error: err.message || String(err) });
        return;
      }
      const responses: any[] = [];
      let truncated = false;
      stream.on('data', (msg: any) => {
        if (responses.length >= cap) {
          if (!truncated) {
            truncated = true;
            try { (stream as any).cancel(); } catch { /* best effort */ }
          }
          return;
        }
        responses.push(msg);
      });
      stream.on('error', (err: any) => {
        if (truncated && err.code === 1) {
          resolve({
            success: true,
            data: responses,
            code: 0,
            streamMessageCount: responses.length,
            streamTruncated: true,
          });
          return;
        }
        resolve({
          success: false,
          error: err.details || err.message || String(err),
          code: err.code,
          data: responses,
          streamMessageCount: responses.length,
          streamTruncated: truncated,
        });
      });
      stream.on('end', () => {
        resolve({
          success: true,
          data: responses,
          code: 0,
          streamMessageCount: responses.length,
          streamTruncated: truncated,
        });
      });
      for (const msg of messages) stream.write(msg);
      stream.end();
    });
  }

  /**
   * Normalize a streaming-request input to an array of messages.
   * Most callers will already pass an array, but tolerate a single
   * object in case the LLM emitted one (a common mistake).
   */
  private toMessageArray(request: any): any[] {
    if (Array.isArray(request)) return request;
    if (request === undefined || request === null) return [];
    return [request];
  }

  /**
   * Pull host:port and TLS flag from a URL like `https://x.example.com`
   * or `x.example.com:50051`. gRPC channels expect `host:port`, not a
   * scheme-prefixed URL, so we normalize.
   */
  private resolveTarget(baseUrl: string): { target: string; useTls: boolean } {
    if (!baseUrl) throw new Error('empty baseUrl');
    if (baseUrl.includes('://')) {
      const u = new URL(baseUrl);
      const useTls = u.protocol === 'https:';
      const port = u.port || (useTls ? '443' : '80');
      const host = u.hostname;
      return { target: `${host}:${port}`, useTls };
    }
    // Bare host[:port] — assume TLS if no port given (most production
    // gRPC servers run TLS), insecure when explicit port suggests
    // local dev.
    const hasPort = /:\d+$/.test(baseUrl);
    return {
      target: hasPort ? baseUrl : `${baseUrl}:443`,
      useTls: hasPort ? false : true,
    };
  }

  /**
   * Write protoSource to a deterministic tmp file the first time we
   * see it. proto-loader.loadSync requires a filesystem path; doing
   * a fresh mkdtemp + write per call is a measurable per-call cost
   * on hot paths. Keying by sha256 of the source is enough — proto
   * files are append-only-ish in practice.
   */
  private materializeProto(protoSource: string): string {
    if (!existsSync(PROTO_CACHE_DIR)) mkdirSync(PROTO_CACHE_DIR, { recursive: true });
    const hash = createHash('sha256').update(protoSource).digest('hex').slice(0, 16);
    const file = join(PROTO_CACHE_DIR, `${hash}.proto`);
    if (!existsSync(file)) writeFileSync(file, protoSource, 'utf-8');
    return file;
  }

  /**
   * Walk the loaded package object recursively until we find a class
   * whose `service` definition has the requested name. proto-loader
   * mirrors the proto's package structure as nested objects, so a
   * service named `google.cloud.translation.v3.TranslationService`
   * lives at `loaded.google.cloud.translation.v3.TranslationService`.
   * We don't force the caller to know the full path.
   */
  private findServiceConstructor(
    pkg: any,
    targetName: string,
  ): any {
    const stack: any[] = [pkg];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      for (const [key, value] of Object.entries(node)) {
        // gRPC service constructors are functions with a `.service`
        // property carrying the service definition. Match by either
        // the property key or the inner serviceName.
        if (typeof value === 'function' && (value as any).service) {
          const def = (value as any).service;
          const inner = def?.serviceName || key;
          if (key === targetName || inner === targetName) return value;
        } else if (value && typeof value === 'object') {
          stack.push(value);
        }
      }
    }
    return null;
  }
}
