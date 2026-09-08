import { Injectable, Logger, Optional } from '@nestjs/common';

import { AuditAction, AuditResource } from '../../../entities/audit-log.entity';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { DecryptedSecrets, KeyDescription, RotationError, RotationErrorCode } from './rotation.interface';
import { RotationRegistry } from './rotation.registry';

/**
 * Rotation, revocation and expiry reminders over connections.
 *
 * This service never touches the Credential repository or the vault.
 * The caller (gate 1's ConnectionsService, later the EE scheduler)
 * hands it the decrypted secrets and two callbacks: `validate(next)`
 * runs the connector's validation on the candidate secrets, and
 * `persist(next, meta)` writes them. The seam keeps the rotation
 * mechanics testable with fixtures alone and keeps one writer of
 * Credential rows. Audit rows are written here when an AuditLogService
 * is available, so every rotate and revoke leaves a trace whether it
 * succeeded or not.
 */

export interface RotationConnection {
  id: string;
  organizationId: string;
  connectorKey: string;
  name?: string;
  /** Decrypted Credential.config: secrets and plain fields together. */
  secrets: DecryptedSecrets;
  /** Where the user creates a key by hand; returned with a manual outcome. */
  keyPageUrl?: string | null;
}

export interface RotateSeams {
  /** Gate 1's validation of the candidate secrets; a failed check aborts the rotation before anything is persisted. */
  validate(next: DecryptedSecrets): Promise<{ ok: boolean; error?: string; accountLabel?: string }>;
  /** Writes the new secrets (encrypting them) with the label and expiry the provider reported. */
  persist(next: DecryptedSecrets, meta: { label?: string; expiresAt: Date | null; rotatedAt: Date; accountLabel?: string }): Promise<void>;
  /** Actor for the audit row. */
  userId?: string;
  /** Name the provider gives the new key; defaults to `almyty <id> <date>`. */
  label?: string;
  now?: Date;
}

export type RotateOutcome =
  | { manual: true; reason: string; keyPageUrl: string | null }
  | { manual: false; label?: string; accountLabel?: string; expiresAt: Date | null; previousRevoked: boolean; revokeError?: string };

export interface RevokeOutcome {
  /** False when the connector has no provider-side revoke; the caller just deletes the row. */
  supported: boolean;
  revoked: boolean;
  error?: string;
  code?: RotationErrorCode;
}

export interface DescribeOutcome {
  supported: boolean;
  description?: KeyDescription;
  error?: string;
  code?: RotationErrorCode;
}

export interface ReminderInput {
  id: string;
  connectorKey?: string;
  expiresAt?: Date | null;
  createdAt?: Date | null;
  /** When the secret was last replaced; falls back to createdAt. */
  rotatedAt?: Date | null;
}

export interface ReminderOptions {
  /** Connections expiring within this many days are reported (default 7). */
  expiryWindowDays?: number;
  /** Connections whose secret is older than this many days are reported; null or absent turns the check off. */
  maxAgeDays?: number | null;
}

export interface Reminders {
  expired: Array<{ id: string; connectorKey?: string; expiresAt: Date }>;
  expiring: Array<{ id: string; connectorKey?: string; expiresAt: Date; daysLeft: number }>;
  stale: Array<{ id: string; connectorKey?: string; issuedAt: Date; ageDays: number }>;
}

export const DEFAULT_EXPIRY_WINDOW_DAYS = 7;
export const DEFAULT_MAX_AGE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The org setting `connections.maxSecretAgeDays`: off by default, `true` means the 90-day default, a positive number is explicit. */
export function maxAgeDaysFromSetting(value: unknown): number | null {
  if (value === true) return DEFAULT_MAX_AGE_DAYS;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === 'string' && /^\d+$/.test(value) && Number(value) > 0) return Number(value);
  return null;
}

/** Pure: which connections need attention at `now`. Neither list mentions a connection twice. */
export function remindersFor(connections: ReminderInput[], now: Date, options: ReminderOptions = {}): Reminders {
  const windowDays = options.expiryWindowDays ?? DEFAULT_EXPIRY_WINDOW_DAYS;
  const maxAge = options.maxAgeDays ?? null;
  const out: Reminders = { expired: [], expiring: [], stale: [] };
  for (const c of connections) {
    const expiresAt = c.expiresAt ? new Date(c.expiresAt) : null;
    if (expiresAt && !Number.isNaN(expiresAt.getTime())) {
      const msLeft = expiresAt.getTime() - now.getTime();
      if (msLeft <= 0) {
        out.expired.push({ id: c.id, connectorKey: c.connectorKey, expiresAt });
        continue;
      }
      if (msLeft <= windowDays * DAY_MS) {
        out.expiring.push({ id: c.id, connectorKey: c.connectorKey, expiresAt, daysLeft: Math.ceil(msLeft / DAY_MS) });
        continue;
      }
      // A dated secret is governed by its expiry, not by age.
      continue;
    }
    if (maxAge === null) continue;
    const issued = c.rotatedAt ?? c.createdAt;
    if (!issued) continue;
    const issuedAt = new Date(issued);
    if (Number.isNaN(issuedAt.getTime())) continue;
    const ageDays = Math.floor((now.getTime() - issuedAt.getTime()) / DAY_MS);
    if (ageDays > maxAge) out.stale.push({ id: c.id, connectorKey: c.connectorKey, issuedAt, ageDays });
  }
  return out;
}

@Injectable()
export class RotationService {
  private readonly logger = new Logger(RotationService.name);

  constructor(
    private readonly registry: RotationRegistry,
    @Optional() private readonly auditLog?: AuditLogService,
  ) {}

  private missingFields(connectorKey: string, secrets: DecryptedSecrets): string[] {
    const required = this.registry.get(connectorKey)?.requires?.() ?? [];
    return required.filter((f) => typeof secrets[f] !== 'string' || !secrets[f].trim());
  }

  /** Merge the provider's changed fields over the current config; an empty string drops a field. */
  static merge(current: DecryptedSecrets, next: Record<string, string>): DecryptedSecrets {
    const out: DecryptedSecrets = { ...current };
    for (const [k, v] of Object.entries(next)) {
      if (v === '') delete out[k];
      else out[k] = v;
    }
    return out;
  }

  private audit(action: AuditAction, connection: RotationConnection, userId: string | undefined, details: Record<string, unknown>): void {
    if (!this.auditLog) return;
    void this.auditLog.log({
      organizationId: connection.organizationId, userId, action, resourceType: AuditResource.CONNECTION,
      resourceId: connection.id, resourceName: connection.name, details: { connectorKey: connection.connectorKey, ...details },
    }).catch((e) => this.logger.warn(`audit write failed for ${connection.id}: ${e?.message ?? e}`));
  }

  /**
   * Mint a replacement secret, validate it, persist it, then retire the
   * previous one. Returns `manual: true` when the provider cannot mint
   * (no provider, no create capability, a missing admin field, or a
   * connection shape it cannot rotate) so the API re-runs the connect
   * method instead. Throws RotationError for a provider failure, after
   * writing the audit row.
   */
  async rotate(connection: RotationConnection, seams: RotateSeams): Promise<RotateOutcome> {
    const provider = this.registry.get(connection.connectorKey);
    const keyPageUrl = connection.keyPageUrl ?? null;
    if (!provider || !provider.capabilities().create) {
      return { manual: true, reason: provider ? `${connection.connectorKey} has no key-creation API` : `${connection.connectorKey} has no rotation provider`, keyPageUrl };
    }
    const missing = this.missingFields(connection.connectorKey, connection.secrets);
    if (missing.length) return { manual: true, reason: `rotation needs ${missing.join(', ')} on the connection`, keyPageUrl };

    const now = seams.now ?? new Date();
    const ctx = { organizationId: connection.organizationId, connectionId: connection.id, label: seams.label, now };
    const fail = (stage: string, e: any): never => {
      const code: RotationErrorCode = e instanceof RotationError ? e.code : 'ROTATION_FAILED';
      this.audit(AuditAction.CONNECTION_ROTATE, connection, seams.userId, { ok: false, stage, code, error: String(e?.message ?? e) });
      throw e instanceof RotationError ? e : new RotationError('ROTATION_FAILED', `${stage}: ${e?.message ?? e}`);
    };

    let minted;
    try {
      minted = await provider.rotate!(connection.secrets, ctx);
    } catch (e: any) {
      if (e instanceof RotationError && e.code === 'ROTATION_UNSUPPORTED') return { manual: true, reason: e.message, keyPageUrl };
      return fail('create', e);
    }
    const next = RotationService.merge(connection.secrets, minted.next);

    let verdict: { ok: boolean; error?: string; accountLabel?: string };
    try {
      verdict = await seams.validate(next);
    } catch (e: any) {
      verdict = { ok: false, error: String(e?.message ?? e) };
    }
    if (!verdict.ok) {
      // Do not leave a key the org never saw lying around at the provider.
      let cleanup: string | undefined;
      if (provider.capabilities().revoke) {
        try {
          await provider.revoke!(next, ctx);
        } catch (e: any) {
          cleanup = String(e?.message ?? e);
        }
      }
      return fail('validate', new RotationError('ROTATION_FAILED', `the new secret failed validation: ${verdict.error ?? 'unknown'}${cleanup ? ` (and could not be revoked: ${cleanup})` : ''}`));
    }

    const expiresAt = minted.expiresAt ?? null;
    try {
      await seams.persist(next, { label: minted.label, expiresAt, rotatedAt: now, accountLabel: verdict.accountLabel });
    } catch (e: any) {
      return fail('persist', e);
    }

    let previousRevoked = false;
    let revokeError: string | undefined;
    if (provider.capabilities().revoke) {
      try {
        await provider.revoke!(connection.secrets, { ...ctx, successor: next });
        previousRevoked = true;
      } catch (e: any) {
        revokeError = String(e?.message ?? e);
        this.logger.warn(`previous secret of ${connection.id} (${connection.connectorKey}) not revoked: ${revokeError}`);
      }
    }
    this.audit(AuditAction.CONNECTION_ROTATE, connection, seams.userId, {
      ok: true, provider: provider.key, label: minted.label ?? null, expiresAt: expiresAt ? expiresAt.toISOString() : null, previousRevoked, revokeError: revokeError ?? null,
    });
    return { manual: false, label: minted.label, accountLabel: verdict.accountLabel, expiresAt, previousRevoked, revokeError };
  }

  /** Provider-side revoke on disconnect. Never throws: the row is deleted either way and the outcome is audited. */
  async revoke(connection: RotationConnection, opts: { userId?: string; now?: Date } = {}): Promise<RevokeOutcome> {
    const provider = this.registry.get(connection.connectorKey);
    if (!provider || !provider.capabilities().revoke) return { supported: false, revoked: false };
    const missing = this.missingFields(connection.connectorKey, connection.secrets);
    let outcome: RevokeOutcome;
    if (missing.length) {
      outcome = { supported: true, revoked: false, code: 'ROTATION_UNSUPPORTED', error: `revoke needs ${missing.join(', ')} on the connection` };
    } else {
      try {
        await provider.revoke!(connection.secrets, { organizationId: connection.organizationId, connectionId: connection.id, now: opts.now });
        outcome = { supported: true, revoked: true };
      } catch (e: any) {
        outcome = { supported: true, revoked: false, code: e instanceof RotationError ? e.code : 'ROTATION_FAILED', error: String(e?.message ?? e) };
      }
    }
    this.audit(AuditAction.CONNECTION_REVOKE, connection, opts.userId, { ok: outcome.revoked, provider: provider.key, code: outcome.code ?? null, error: outcome.error ?? null });
    return outcome;
  }

  /** Key metadata for the account label and health; never throws. */
  async describe(connection: RotationConnection, opts: { now?: Date } = {}): Promise<DescribeOutcome> {
    const provider = this.registry.get(connection.connectorKey);
    if (!provider || !provider.capabilities().metadata) return { supported: false };
    const missing = this.missingFields(connection.connectorKey, connection.secrets);
    if (missing.length) return { supported: true, code: 'ROTATION_UNSUPPORTED', error: `describe needs ${missing.join(', ')} on the connection` };
    try {
      const description = await provider.describe!(connection.secrets, { organizationId: connection.organizationId, connectionId: connection.id, now: opts.now });
      return { supported: true, description };
    } catch (e: any) {
      return { supported: true, code: e instanceof RotationError ? e.code : 'ROTATION_FAILED', error: String(e?.message ?? e) };
    }
  }

  remindersFor(connections: ReminderInput[], now: Date, options: ReminderOptions = {}): Reminders {
    return remindersFor(connections, now, options);
  }
}
