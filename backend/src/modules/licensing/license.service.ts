import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  COMMUNITY_ENTITLEMENTS,
  COMMUNITY_LIMITS,
  DEFAULT_LICENSE_PUBLIC_KEY,
  EDITION_COMMUNITY,
  EDITION_ENTERPRISE,
  LICENSE_PUBLIC_KEY_ENV,
  LICENSE_TOKEN_ENV,
  LICENSE_TOKEN_ENV_ALT,
  UNLIMITED,
} from './license.constants';
import { LicensePayload, verifyLicense } from './license-token';

export interface EntitlementSnapshot {
  edition: string;
  entitlements: string[];
  limits: Record<string, number>;
  expiresAt: string | null;
  issuedTo?: string;
}

export interface LoadOptions {
  /** Raw or base64 PEM public key. Defaults to env / built-in key. */
  publicKeyPem?: string;
  /** Signed license token. Defaults to env; empty → community. */
  token?: string;
}

/**
 * Runtime entitlement source of truth. Resolves the active feature set from a
 * signed license token (EE) or falls back to the community set (OSS). This — not
 * `organization.plan` — is the enforceable boundary that gates EE features.
 */
@Injectable()
export class LicenseService implements OnModuleInit {
  private readonly logger = new Logger(LicenseService.name);

  private edition: string = EDITION_COMMUNITY;
  private entitlements: Set<string> = new Set(COMMUNITY_ENTITLEMENTS);
  private limits: Record<string, number> = { ...COMMUNITY_LIMITS };
  private expiresAt: string | null = null;
  private issuedTo?: string;

  onModuleInit(): void {
    this.load();
  }

  /**
   * (Re)resolve entitlements from the given options or process env. Always
   * fails safe to the community set on any missing/invalid/expired token.
   */
  load(opts: LoadOptions = {}): void {
    // Start from the community baseline every time.
    this.edition = EDITION_COMMUNITY;
    this.entitlements = new Set(COMMUNITY_ENTITLEMENTS);
    this.limits = { ...COMMUNITY_LIMITS };
    this.expiresAt = null;
    this.issuedTo = undefined;

    const publicKey =
      opts.publicKeyPem ??
      process.env[LICENSE_PUBLIC_KEY_ENV] ??
      DEFAULT_LICENSE_PUBLIC_KEY;

    const token =
      opts.token ??
      process.env[LICENSE_TOKEN_ENV] ??
      process.env[LICENSE_TOKEN_ENV_ALT] ??
      '';

    if (!token) {
      this.logger.log('No license token present — running community edition.');
      return;
    }

    const result = verifyLicense(token, publicKey);
    if (!result.valid) {
      this.logger.warn(
        `License token rejected (${result.reason}) — falling back to community edition.`,
      );
      return;
    }

    this.applyPayload(result.payload);
    this.logger.log(
      `Enterprise license loaded (issuedTo=${this.issuedTo ?? 'n/a'}, ` +
        `entitlements=${result.payload.entitlements.length}, ` +
        `expiresAt=${this.expiresAt ?? 'never'}).`,
    );
  }

  private applyPayload(payload: LicensePayload): void {
    this.edition = EDITION_ENTERPRISE;
    // EE tokens union the community baseline — a licensed deployment keeps every
    // core feature and gains the EE ones.
    this.entitlements = new Set([...COMMUNITY_ENTITLEMENTS, ...payload.entitlements]);
    this.limits = { ...COMMUNITY_LIMITS, ...payload.limits };
    this.expiresAt = payload.expiresAt ?? null;
    this.issuedTo = payload.issuedTo;
  }

  /**
   * Pure, per-request entitlement resolution from a stored token string — the
   * per-org path. Takes a token (NOT an org entity: licensing stays free of any
   * organizations/billing dependency), verifies it against the same public key
   * `load()` uses, and returns a snapshot. Fall-back order when the passed token
   * is absent/invalid/expired: (a) the process-global env token, then
   * (b) the community set. Does NOT mutate the singleton's global state.
   */
  resolveToken(token: string | null | undefined): EntitlementSnapshot {
    const publicKey =
      process.env[LICENSE_PUBLIC_KEY_ENV] ?? DEFAULT_LICENSE_PUBLIC_KEY;

    const fromToken = token ? this.snapshotFromToken(token, publicKey) : null;
    if (fromToken) return fromToken;

    // Passed token absent/invalid/expired → try the global env token.
    const envToken =
      process.env[LICENSE_TOKEN_ENV] ?? process.env[LICENSE_TOKEN_ENV_ALT] ?? '';
    const fromEnv = envToken ? this.snapshotFromToken(envToken, publicKey) : null;
    if (fromEnv) return fromEnv;

    // Nothing valid → community.
    return this.communitySnapshot();
  }

  /**
   * Verify a single token and, if valid, return the enterprise snapshot it
   * grants (unioned with community). Returns null on any missing/invalid/expired
   * token so callers can fall through. Never mutates instance state.
   */
  private snapshotFromToken(
    token: string,
    publicKey: string,
  ): EntitlementSnapshot | null {
    const result = verifyLicense(token, publicKey);
    if (!result.valid) return null;
    const payload = result.payload;
    return {
      edition: EDITION_ENTERPRISE,
      entitlements: [
        ...new Set([...COMMUNITY_ENTITLEMENTS, ...payload.entitlements]),
      ].sort(),
      limits: { ...COMMUNITY_LIMITS, ...payload.limits },
      expiresAt: payload.expiresAt ?? null,
      issuedTo: payload.issuedTo,
    };
  }

  /** The unconditional community snapshot (no license). */
  private communitySnapshot(): EntitlementSnapshot {
    return {
      edition: EDITION_COMMUNITY,
      entitlements: [...COMMUNITY_ENTITLEMENTS].sort(),
      limits: { ...COMMUNITY_LIMITS },
      expiresAt: null,
      issuedTo: undefined,
    };
  }

  /** True if the active license grants the given feature. */
  has(feature: string): boolean {
    return this.entitlements.has(feature);
  }

  /** Numeric limit for a key, or UNLIMITED (-1) when uncapped. */
  limit(key: string): number {
    const value = this.limits[key];
    return typeof value === 'number' ? value : UNLIMITED;
  }

  getEdition(): string {
    return this.edition;
  }

  isCommunity(): boolean {
    return this.edition === EDITION_COMMUNITY;
  }

  getEntitlements(): string[] {
    return [...this.entitlements].sort();
  }

  getLimits(): Record<string, number> {
    return { ...this.limits };
  }

  getExpiresAt(): string | null {
    return this.expiresAt;
  }

  /** Serializable snapshot for the `/licensing/entitlements` endpoint. */
  snapshot(): EntitlementSnapshot {
    return {
      edition: this.edition,
      entitlements: this.getEntitlements(),
      limits: this.getLimits(),
      expiresAt: this.expiresAt,
      issuedTo: this.issuedTo,
    };
  }
}
