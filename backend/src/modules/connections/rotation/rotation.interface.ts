/**
 * Connections gate 5: rotation and revocation per connector.
 *
 * A ConnectorRotation knows how one provider's key-management API
 * mints, revokes and describes credentials. It is pure provider
 * mechanics: it receives decrypted secrets as arguments, returns the
 * next secrets, and never touches a repository, the catalog or another
 * provider. What each provider can do was verified against vendor docs
 * on 2026-09-08; the fact table lives in
 * docs/design/connections-rotation.md and every `capabilities()` here
 * mirrors a row of it.
 */

export type RotationErrorCode = 'ROTATION_UNSUPPORTED' | 'ROTATION_AUTH' | 'ROTATION_FAILED';

/** The one error class providers throw; callers branch on `code`. Messages never carry secret values. */
export class RotationError extends Error {
  constructor(readonly code: RotationErrorCode, message: string, readonly status?: number) {
    super(message);
    this.name = 'RotationError';
  }
}

export interface RotationCapabilities {
  /** Can mint a replacement secret through the provider's API. */
  create: boolean;
  /** Can invalidate a secret through the provider's API. */
  revoke: boolean;
  /** Can read key metadata (name, created, last used, expiry) for the account label and health. */
  metadata: boolean;
  /** The connect method is OAuth and the provider has a token refresh endpoint we call. */
  refresh: boolean;
}

/** The decrypted Credential.config of a connection: secret and plain fields side by side. */
export type DecryptedSecrets = Record<string, any>;

export interface RotationContext {
  organizationId: string;
  connectionId: string;
  /** Human name the provider should give the new key when it accepts one. */
  label?: string;
  /**
   * On the revoke that follows a rotation: the secrets that replaced the
   * ones being revoked. A provider whose revoke endpoint takes the key
   * being revoked as its own bearer (Perplexity) authenticates with the
   * successor instead, so the call still works once the old key is dead.
   */
  successor?: DecryptedSecrets;
  now?: Date;
}

export interface RotateResult {
  /**
   * Fields that change. The service merges these over the current config
   * so plain fields (project ids, admin keys) survive; an empty string
   * removes a field (a session token that no longer applies).
   */
  next: Record<string, string>;
  /** Provider-side name of the new key, for the account label. */
  label?: string;
  expiresAt?: Date;
}

export interface KeyDescription {
  label?: string;
  createdAt?: Date;
  lastUsedAt?: Date;
  expiresAt?: Date;
  scopes?: string[];
}

/**
 * The outbound HTTP call every provider uses; specs bind a fixture here.
 * Same shape as gate 1's ConnectionsHttp so one fixture serves both.
 */
export type RotationHttp = (url: string, init: RequestInit) => Promise<Response>;
export const ROTATION_HTTP = Symbol('ROTATION_HTTP');

export interface ConnectorRotation {
  /** The connector key this rotation serves (catalog key, not a display name). */
  readonly key: string;
  capabilities(): RotationCapabilities;
  /**
   * Config fields, beyond the connection's own secret, that the provider
   * needs before it can rotate or revoke (an admin key, a project id).
   * The service reports a missing one as a manual rotation instead of
   * calling the provider.
   */
  requires?(): string[];
  rotate?(current: DecryptedSecrets, ctx: RotationContext): Promise<RotateResult>;
  revoke?(current: DecryptedSecrets, ctx: RotationContext): Promise<void>;
  describe?(current: DecryptedSecrets, ctx: RotationContext): Promise<KeyDescription>;
}

/** Capabilities and methods must agree: a claimed capability without a method is a registry bug, not a runtime surprise. */
export function assertRotationContract(rotation: ConnectorRotation): void {
  if (!rotation.key || !/^[a-z][a-z0-9_-]*$/.test(rotation.key)) {
    throw new Error(`${rotation.key}: key must be a lowercase connector key`);
  }
  const caps = rotation.capabilities();
  if (caps.create && typeof rotation.rotate !== 'function') throw new Error(`${rotation.key}: create capability without rotate()`);
  if (caps.revoke && typeof rotation.revoke !== 'function') throw new Error(`${rotation.key}: revoke capability without revoke()`);
  if (caps.metadata && typeof rotation.describe !== 'function') throw new Error(`${rotation.key}: metadata capability without describe()`);
  if (!caps.create && !caps.revoke && !caps.metadata && !caps.refresh) throw new Error(`${rotation.key}: registers no capability`);
}
