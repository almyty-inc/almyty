/**
 * Real gRPC executor — replaces the previous "POST with content-type
 * application/grpc+proto via axios" stub. Loads the proto file
 * stored on ApiSchema.rawSchema, builds a dynamic @grpc/grpc-js
 * client, makes the unary call, returns the response as plain JSON.
 *
 * Things this does:
 *   - resolves host:port from `api.baseUrl` (defaults to :443 for
 *     https, :80 for http, or whatever the URL specifies)
 *   - writes the proto schema to a tmp file (proto-loader requires a
 *     path), keyed by sha256 hash so repeat calls reuse it
 *   - loads the package definition with permissive options
 *     (keepCase, longs as Number, defaults true) — same shape the
 *     parser expects
 *   - walks the loaded package object recursively to find the
 *     service constructor matching the requested service name —
 *     handles namespaced services (`google.cloud...TranslationService`)
 *     without forcing the caller to know the full path
 *   - applies metadata for auth (OAuth2 bearer, API key) and any
 *     extra metadata passed in
 *   - returns response.toJSON() so the gateway response stays
 *     structured-clone safe
 *
 * Things this does NOT do (yet):
 *   - server streaming, client streaming, bidirectional streaming
 *   - load balancing config beyond the default channel picker
 *   - protobuf field validation (the gRPC client itself enforces it)
 */
import { Injectable, Logger } from '@nestjs/common';
import { credentials, Metadata, loadPackageDefinition } from '@grpc/grpc-js';
import { loadSync as loadProtoSync } from '@grpc/proto-loader';
import { createHash } from 'crypto';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const PROTO_CACHE_DIR = join(tmpdir(), 'almyty-proto-cache');

export interface GrpcCallInput {
  /** Full proto schema source — typically ApiSchema.rawSchema. */
  protoSource: string;
  /** Host[:port] or full https:// URL. Port defaults: 443 for https, 80 for http. */
  baseUrl: string;
  /** Service name (e.g. "TranslationService"). Namespace optional; we search recursively. */
  serviceName: string;
  /** Method name (e.g. "DetectLanguage"). */
  methodName: string;
  /** Request message body. Will be passed through to the gRPC client as-is. */
  request: Record<string, any>;
  /** Per-call metadata headers (auth, etc). */
  metadata?: Record<string, string>;
  /** Per-call deadline in ms (added to Date.now()). */
  timeoutMs?: number;
}

export interface GrpcCallResult {
  success: boolean;
  data?: any;
  error?: string;
  /** gRPC status code on failure (0 = OK). See @grpc/grpc-js status enum. */
  code?: number;
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

    return await new Promise<GrpcCallResult>((resolve) => {
      const callOptions: any = {};
      if (deadline) callOptions.deadline = deadline;
      try {
        client[input.methodName](
          input.request ?? {},
          meta,
          callOptions,
          (err: any, response: any) => {
            if (err) {
              resolve({
                success: false,
                error: err.details || err.message || String(err),
                code: err.code,
              });
              return;
            }
            // The dynamic client returns a plain JS object already
            // matching the response message; passing it through is
            // safe for JSON serialization.
            resolve({ success: true, data: response, code: 0 });
          },
        );
      } catch (err: any) {
        // Synchronous throw paths — usually means the request
        // payload doesn't match the proto's message shape.
        resolve({
          success: false,
          error: err.message || String(err),
        });
      }
    });
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
