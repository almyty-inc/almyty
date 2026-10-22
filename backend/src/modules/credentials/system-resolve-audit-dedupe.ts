/**
 * Which CONNECTION_RESOLVE rows a resolve with nobody behind it writes.
 *
 * Background loops (hosted runner reconcile and its processor, a
 * deployment's reconcile, a provider's health check) resolve the same
 * connection every minute. A row per call buries everything else in the
 * audit log, so a system resolve is recorded on first use, whenever its
 * outcome changes (success to failure, a different failure, the
 * connection rotated or its health moved) and again once the heartbeat
 * interval has passed since the last row. Resolves with a user or a run
 * behind them never come through here: they are recorded every time.
 *
 * In memory and per replica: each replica writes its own first row, and
 * the map is capped (least recently recorded key evicted first) so it
 * cannot grow without bound.
 */

/** A fresh row after this long even when nothing changed (24 hours). */
export const DEFAULT_SYSTEM_RESOLVE_AUDIT_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** How many (org, connection, consumer) keys are remembered at once. */
export const DEFAULT_SYSTEM_RESOLVE_AUDIT_MAX_KEYS = 10_000;

export const SYSTEM_RESOLVE_AUDIT_INTERVAL_ENV = 'CREDENTIAL_SYSTEM_RESOLVE_AUDIT_INTERVAL_MS';
export const SYSTEM_RESOLVE_AUDIT_MAX_KEYS_ENV = 'CREDENTIAL_SYSTEM_RESOLVE_AUDIT_MAX_KEYS';

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export interface SystemResolveKey {
  organizationId: string;
  credentialId: string;
  purpose?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
}

export class SystemResolveAuditDedupe {
  private readonly last = new Map<string, { outcome: string; at: number }>();

  constructor(
    readonly intervalMs: number = positiveInt(process.env[SYSTEM_RESOLVE_AUDIT_INTERVAL_ENV], DEFAULT_SYSTEM_RESOLVE_AUDIT_INTERVAL_MS),
    readonly maxKeys: number = positiveInt(process.env[SYSTEM_RESOLVE_AUDIT_MAX_KEYS_ENV], DEFAULT_SYSTEM_RESOLVE_AUDIT_MAX_KEYS),
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * True when this outcome should be written; it is then remembered as
   * the last recorded one for the key. `outcome` is an opaque signature:
   * equal strings mean nothing changed.
   */
  shouldRecord(key: SystemResolveKey, outcome: string): boolean {
    const k = [key.organizationId, key.credentialId, key.purpose ?? '', key.resourceType ?? '', key.resourceId ?? ''].join('\u0000');
    const at = this.now();
    const prev = this.last.get(k);
    if (prev && prev.outcome === outcome && at - prev.at < this.intervalMs) return false;
    // Re-insert so the Map's order is least recently recorded first.
    this.last.delete(k);
    this.last.set(k, { outcome, at });
    while (this.last.size > this.maxKeys) {
      const oldest = this.last.keys().next().value as string;
      this.last.delete(oldest);
    }
    return true;
  }

  /** Remembered keys; for specs. */
  get size(): number {
    return this.last.size;
  }
}
