import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectRedis } from '@nestjs-modules/ioredis';
import * as Redis from 'ioredis';
import * as crypto from 'crypto';
import { Repository } from 'typeorm';

import { OAuthClient } from '../../../entities/oauth-client.entity';
import { readCappedText, safeFetch } from '../../../common/security/safe-fetch';
import { CimdSettings, cimdSettings, inferApplicationType } from '../core/mcp-settings';
import {
  OAuthApplicationType,
  allLoopbackRedirects,
  isApplicationType,
  isMetadataDocumentClientId,
  validateRedirectUri,
} from './mcp-oauth-helpers.helper';
import { MCP_OAUTH_SCOPES } from './mcp-oauth-scopes';

/** What one metadata fetch returned. */
export interface CimdFetchResult {
  status: number;
  cacheControl: string | null;
  body: string;
}

/**
 * Fetches a metadata document. The default is `safeFetch`; a test hands in
 * its own to serve a document from a local server, which the SSRF gate
 * would (rightly) refuse.
 */
export type CimdFetcher = (url: string, limits: { timeoutMs: number; maxBytes: number }) => Promise<CimdFetchResult>;

export const MCP_CIMD_FETCHER = Symbol('MCP_CIMD_FETCHER');

/**
 * The guarded fetch, with nothing relaxed.
 *
 * The URL arrives from an anonymous browser redirect, so it gets the full
 * gate of safe-fetch.ts: the string check, the DNS pin on the connection
 * (a public name resolving to 127.0.0.1 or 169.254.169.254 is refused
 * before a socket opens), no redirects, a total deadline and a size cap.
 * `MCP_ALLOW_PRIVATE_URLS` does not apply: that flag is for MCP servers an
 * org admin connects, not for URLs a stranger names.
 */
export const safeCimdFetcher: CimdFetcher = async (url, { timeoutMs, maxBytes }) => {
  const res = await safeFetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    timeoutMs,
    maxBytes,
    maxRedirects: 0,
  });
  return {
    status: res.status,
    cacheControl: res.headers.get('cache-control'),
    body: await readCappedText(res, maxBytes),
  };
};

const MAX_CLIENT_NAME_LENGTH = 255;
const MAX_URI_LENGTH = 2048;
const MAX_REDIRECT_URIS = 20;
const ALLOWED_GRANT_TYPES = ['authorization_code', 'refresh_token'];

/** The parts of a metadata document this server keeps. */
interface CimdDocument {
  clientId: string;
  clientName: string;
  clientUri: string | null;
  logoUri: string | null;
  redirectUris: string[];
  grantTypes: string[];
  applicationType: OAuthApplicationType;
}

function refuse(reason: string): never {
  throw new BadRequestException(`invalid_client: ${reason}`);
}

function boundedUri(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > MAX_URI_LENGTH || !/^https:\/\//i.test(value)) {
    refuse(`${field} must be an https URL of at most ${MAX_URI_LENGTH} characters`);
  }
  return value;
}

/**
 * Validate a fetched document against the URL it came from. MCP 2025-11-25
 * authorization, "Client ID Metadata Documents": the document's client_id
 * must equal the URL exactly; client_name and redirect_uris are required.
 */
export function parseCimdDocument(url: string, body: string): CimdDocument {
  let doc: any;
  try {
    doc = JSON.parse(body);
  } catch {
    refuse('the client metadata document is not JSON');
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) refuse('the client metadata document is not a JSON object');
  if (doc.client_id !== url) refuse('client_id in the metadata document does not match its URL');

  if (typeof doc.client_name !== 'string' || !doc.client_name.trim()) refuse('client_name is required');
  if (doc.client_name.length > MAX_CLIENT_NAME_LENGTH) refuse(`client_name exceeds ${MAX_CLIENT_NAME_LENGTH} characters`);

  const redirectUris = doc.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) refuse('redirect_uris is required');
  if (redirectUris.length > MAX_REDIRECT_URIS) refuse(`too many redirect_uris (max ${MAX_REDIRECT_URIS})`);
  if (!redirectUris.every((u: unknown) => typeof u === 'string' && u.length > 0 && u.length <= MAX_URI_LENGTH)) {
    refuse('every redirect_uri must be a non-empty string');
  }

  // Public clients only: a metadata document cannot carry a secret, and
  // private_key_jwt (the one confidential method the draft allows) is not
  // supported here yet.
  const authMethod = doc.token_endpoint_auth_method ?? 'none';
  if (authMethod !== 'none') refuse(`token_endpoint_auth_method ${String(authMethod).slice(0, 40)} is not supported`);

  const grantTypes: string[] = doc.grant_types ?? ['authorization_code', 'refresh_token'];
  if (!Array.isArray(grantTypes) || !grantTypes.includes('authorization_code') || grantTypes.some((g) => !ALLOWED_GRANT_TYPES.includes(g))) {
    refuse('grant_types must be authorization_code, optionally with refresh_token');
  }
  const responseTypes: unknown = doc.response_types ?? ['code'];
  if (!Array.isArray(responseTypes) || responseTypes.some((r) => r !== 'code')) refuse('response_types must be ["code"]');

  let applicationType: OAuthApplicationType;
  if (doc.application_type === undefined) {
    applicationType = inferApplicationType() && allLoopbackRedirects(redirectUris) ? 'native' : 'web';
  } else if (isApplicationType(doc.application_type)) {
    applicationType = doc.application_type;
  } else {
    refuse('application_type must be "web" or "native"');
  }
  for (const uri of redirectUris) {
    try {
      validateRedirectUri(uri, applicationType);
    } catch (e: any) {
      refuse(`${e?.message ?? 'invalid redirect_uri'}: ${uri.slice(0, 200)}`);
    }
  }

  return {
    clientId: url,
    clientName: doc.client_name.trim(),
    clientUri: boundedUri(doc.client_uri, 'client_uri'),
    logoUri: boundedUri(doc.logo_uri, 'logo_uri'),
    redirectUris,
    grantTypes: [...new Set(grantTypes)],
    applicationType,
  };
}

/** Seconds to keep a document: its Cache-Control max-age, inside the configured floor and ceiling. */
export function cimdCacheSeconds(cacheControl: string | null, settings: CimdSettings): number {
  const directives = (cacheControl ?? '').toLowerCase();
  let seconds = settings.cacheMinSeconds;
  const maxAge = /(?:^|[,\s])(?:s-maxage|max-age)\s*=\s*(\d+)/.exec(directives);
  if (maxAge && !/no-store|no-cache/.test(directives)) seconds = Number(maxAge[1]);
  return Math.min(settings.cacheMaxSeconds, Math.max(settings.cacheMinSeconds, seconds));
}

/**
 * Client ID Metadata Documents: an MCP client names itself by an https URL
 * and this server reads the client's metadata from it instead of asking it
 * to register first (MCP 2025-11-25 authorization, SEP-991).
 *
 * The document is fetched behind the SSRF guard, validated, cached in Redis
 * for its Cache-Control lifetime (inside MCP_CIMD_CACHE_MIN/MAX_SECONDS),
 * and upserted as an `oauth_clients` row keyed by the URL (owner decision
 * 9), so codes, tokens and revocation work exactly as for a registered
 * client. Fetches are rate-limited per host (MCP_CIMD_FETCHES_PER_HOST per
 * MCP_CIMD_FETCH_WINDOW_SECONDS). An expired entry whose refresh fails is
 * refused; there is no serving stale metadata.
 */
@Injectable()
export class McpOAuthCimdService {
  private readonly logger = new Logger(McpOAuthCimdService.name);

  constructor(
    @InjectRepository(OAuthClient)
    private readonly clients: Repository<OAuthClient>,
    @InjectRedis() private readonly redis: Redis.Redis,
    @Optional() @Inject(MCP_CIMD_FETCHER) private readonly fetcher: CimdFetcher = safeCimdFetcher,
  ) {
    this.fetcher = fetcher ?? safeCimdFetcher;
  }

  static isMetadataDocumentClientId(clientId: unknown): clientId is string {
    return isMetadataDocumentClientId(clientId);
  }

  /** The client a metadata URL names, fetched or from cache, as a stored row. */
  async resolveClient(url: string): Promise<OAuthClient> {
    const settings = cimdSettings();
    if (!settings.enabled) refuse('Client ID Metadata Documents are not accepted by this server');
    if (!isMetadataDocumentClientId(url)) refuse('client_id is not a metadata document URL');

    const key = `mcp:cimd:doc:${crypto.createHash('sha256').update(url).digest('hex')}`;
    let doc: CimdDocument | null = null;
    try {
      const cached = await this.redis.get(key);
      if (cached) doc = JSON.parse(cached) as CimdDocument;
    } catch {
      doc = null;
    }

    if (!doc) {
      await this.assertWithinHostLimit(new URL(url).hostname, settings);
      let fetched: CimdFetchResult;
      try {
        fetched = await this.fetcher(url, { timeoutMs: settings.fetchTimeoutMs, maxBytes: settings.maxBytes });
      } catch (error: any) {
        this.logger.warn(`Client metadata fetch refused or failed for ${new URL(url).host}: ${error?.message}`);
        refuse('the client metadata document could not be fetched');
      }
      if (fetched.status !== 200) refuse(`the client metadata document answered HTTP ${fetched.status}`);
      doc = parseCimdDocument(url, fetched.body);
      try {
        await this.redis.setex(key, cimdCacheSeconds(fetched.cacheControl, settings), JSON.stringify(doc));
      } catch {
        // Without the cache the next authorization fetches again; nothing else depends on it.
      }
    }

    return this.upsert(doc, new URL(url).host);
  }

  private async assertWithinHostLimit(host: string, settings: CimdSettings): Promise<void> {
    const key = `mcp:cimd:rate:${host.toLowerCase()}`;
    let count = 0;
    try {
      count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, settings.fetchWindowSeconds);
    } catch {
      // A Redis outage does not turn the limit into a free-for-all: refuse.
      refuse('client metadata documents cannot be fetched right now');
    }
    if (count > settings.fetchesPerHost) {
      refuse(`too many client metadata fetches for ${host}; try again later`);
    }
  }

  private async upsert(doc: CimdDocument, host: string): Promise<OAuthClient> {
    const fields: Partial<OAuthClient> = {
      clientName: doc.clientName,
      clientUri: doc.clientUri as any,
      redirectUris: doc.redirectUris,
      grantTypes: doc.grantTypes,
      responseTypes: ['code'],
      tokenEndpointAuthMethod: 'none',
      applicationType: doc.applicationType,
      metadataFetchedAt: new Date(),
      metadata: { cimd: { host, logoUri: doc.logoUri } },
    };

    const existing = await this.clients.findOne({ where: { clientId: doc.clientId } });
    if (existing) {
      if (!existing.isMetadataDocument) refuse('client_id is already registered');
      if (!existing.isActive) refuse('this client has been disabled');
      await this.clients.update({ id: existing.id }, fields as any);
      return Object.assign(existing, fields);
    }

    const row = this.clients.create({
      ...fields,
      clientId: doc.clientId,
      clientSecretHash: null as any,
      scope: MCP_OAUTH_SCOPES.join(' '),
      gatewayId: null as any,
      organizationId: null,
      isActive: true,
      isMetadataDocument: true,
    });
    try {
      return await this.clients.save(row);
    } catch (error: any) {
      // Two authorizations racing on a new URL: the other one stored it.
      const stored = await this.clients.findOne({ where: { clientId: doc.clientId, isMetadataDocument: true } });
      if (stored) return stored;
      throw error;
    }
  }
}
