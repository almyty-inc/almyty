import { Injectable, Logger } from '@nestjs/common';
import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

import { ChannelGatewayService } from './channel-gateway.service';
import { HostedChatService } from './hosted-chat.service';
import { allowedOriginsOf, originIsAllowed } from './surface-origins';

/**
 * CORS for the public chat surfaces, decided per gateway.
 *
 * The app-wide policy answers only the platform's own dashboard origins,
 * with credentials. That is right for the dashboard API and wrong for the
 * widget: an embed on a customer's site is cross-origin by design, so it
 * never got an answer and could not work anywhere but on our own pages.
 * Opening the surfaces to every origin would be the opposite mistake.
 *
 * So a request to a public surface is answered from that surface's own
 * `allowedOrigins` list, exact match only, never with credentials. The
 * dashboard origins are answered too (uncredentialed) so the builder's
 * live preview keeps working; they are ours, not a tenant's to grant.
 * Everything else about those paths, and every other path, is unchanged.
 */

export type SurfaceRef =
  | { kind: 'chat_widget'; gatewayId: string }
  | { kind: 'hosted_chat'; slug: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The public surface a request path belongs to, or null for any other
 * route. The ingress may or may not strip an `/api` prefix, so both forms
 * are recognised.
 */
export function publicSurfaceFor(rawPath: string | undefined): SurfaceRef | null {
  if (!rawPath) return null;
  const path = rawPath.split('?')[0].replace(/^\/api(?=\/)/, '');

  const widget = /^\/gateways\/([^/]+)\/(widget\.js|widget-config|widget\/messages)\/?$/.exec(path);
  if (widget) return { kind: 'chat_widget', gatewayId: widget[1] };

  const hosted = /^\/public\/chat\/([^/]+)(?:\/.*)?$/.exec(path);
  if (hosted) {
    // by-host resolves by Host header and has no list of its own: it is
    // the custom-domain page asking about itself, which is same-origin.
    let slug: string | null = null;
    if (hosted[1] !== 'by-host') {
      try {
        slug = decodeURIComponent(hosted[1]).toLowerCase();
      } catch {
        slug = null; // malformed escape: no surface, so no list
      }
    }
    return { kind: 'hosted_chat', slug };
  }
  return null;
}

export interface SurfaceCorsDelegateOptions {
  /** The dashboard origins the app-wide policy already trusts. */
  platformOrigins: ReadonlySet<string>;
  /** The app-wide policy for every non-surface route, minus `origin`. */
  platform: Omit<CorsOptions, 'origin'>;
  /** The surface's own allowed origins; [] when it does not exist. */
  allowedOriginsFor: (ref: SurfaceRef) => Promise<string[]>;
  onLookupError?: (err: unknown) => void;
}

/** What a public surface answers with. No credentials, ever. */
export const SURFACE_CORS: Omit<CorsOptions, 'origin'> = Object.freeze({
  credentials: false,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  maxAge: 600,
});

type Req = { path?: string; url?: string; headers: Record<string, string | string[] | undefined> };

/**
 * The delegate handed to `app.enableCors`. Kept free of Nest so it can be
 * driven directly by a spec, request by request.
 */
export function surfaceCorsDelegate(options: SurfaceCorsDelegateOptions) {
  return (req: Req, callback: (err: Error | null, cors: CorsOptions) => void): void => {
    const header = req.headers?.origin;
    const origin = Array.isArray(header) ? header[0] : header;
    const ref = publicSurfaceFor(req.path ?? req.url);

    if (!ref) {
      // Unchanged app-wide behaviour. No Origin header (server to server,
      // same-origin GET) is not a browser cross-origin request at all.
      callback(null, { ...options.platform, origin: !origin || options.platformOrigins.has(origin) });
      return;
    }

    if (!origin) {
      callback(null, { ...SURFACE_CORS, origin: false });
      return;
    }
    if (options.platformOrigins.has(origin)) {
      callback(null, { ...SURFACE_CORS, origin });
      return;
    }

    options
      .allowedOriginsFor(ref)
      .catch((err) => {
        // A lookup that fails answers like an empty list: closed.
        options.onLookupError?.(err);
        return [] as string[];
      })
      .then((allowed) => {
        callback(null, { ...SURFACE_CORS, origin: originIsAllowed(allowed, origin) ? origin : false });
      });
  };
}

/** Reads a surface's allowed origins. Wired into main.ts's enableCors. */
@Injectable()
export class SurfaceCorsService {
  private readonly logger = new Logger(SurfaceCorsService.name);

  constructor(
    private readonly channelGatewayService: ChannelGatewayService,
    private readonly hostedChat: HostedChatService,
  ) {}

  /**
   * The list for a live surface. A surface that does not exist, is not
   * active, or is not the kind the path names has none: [] rather than an
   * error, so the request itself goes on to its own 404.
   */
  async allowedOriginsFor(ref: SurfaceRef): Promise<string[]> {
    try {
      if (ref.kind === 'chat_widget') {
        if (!UUID.test(ref.gatewayId)) return [];
        const gateway = await this.channelGatewayService.findWidgetGateway(ref.gatewayId);
        return allowedOriginsOf(gateway.configuration);
      }
      if (!ref.slug) return [];
      const gateway = await this.hostedChat.findBySlug(ref.slug);
      return allowedOriginsOf(gateway.configuration);
    } catch (err: any) {
      if (err?.status === 404 || err?.response?.statusCode === 404) return [];
      this.logger.warn(`Surface CORS lookup failed: ${err?.message ?? err}`);
      return [];
    }
  }

  /** The delegate main.ts installs, bound to this service. */
  delegate(platformOrigins: ReadonlySet<string>, platform: Omit<CorsOptions, 'origin'>) {
    return surfaceCorsDelegate({
      platformOrigins,
      platform,
      allowedOriginsFor: (ref) => this.allowedOriginsFor(ref),
    });
  }
}
