import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { promises as dns } from 'dns';

import { Gateway, GatewayType } from '../../../entities/gateway.entity';
import { OrganizationRole } from '../../../entities/user-organization.entity';
import { GatewaysService } from '../gateways.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { hostedChatBaseDomain, hostedChatConfigFrom } from './hosted-chat.config';
import {
  CUSTOM_DOMAIN_REFUSALS,
  CustomDomainConfig,
  RECHECK_FAILURES_BEFORE_DEMOTION,
  VERIFICATION_RECORD_PREFIX,
  customDomainError,
  isReservedDomain,
  isVerified,
  newCustomDomain,
  verificationRecord,
} from './custom-domain';

/**
 * Tier 2 of the hosted chat app, end to end: a tenant names a hostname,
 * publishes the TXT record we give them, asks us to check, and only then
 * is the hostname served (HostedChatService.findByCustomDomain reads
 * `status = 'active'` and nothing else).
 *
 * The claim is the `customDomain` column on the gateway, which no TypeORM
 * save writes (the entity marks it `update: false`), so a gateway edit
 * that loaded the row before a verify or a demotion cannot write the old
 * claim back. Every write below is a targeted SQL update of that column.
 *
 * One live owner per hostname, across every organization: a partial
 * unique index (UQ_gateways_custom_domain_active) refuses a second
 * active row. Pending claims may coexist -- only the domain's real owner
 * can publish the record, and a squatter's pending row must not block
 * them. A live claim is not forever either: a daily re-check stops
 * serving a domain whose record has gone, and a new owner who proves the
 * record while the old holder's has gone takes the name over.
 */

/** Looks up TXT records; injectable so specs do not touch real DNS. */
export const TXT_RESOLVER = Symbol('TXT_RESOLVER');
export type TxtResolver = (name: string) => Promise<string[][]>;

/** Where the claim that currently serves a hostname sits. */
export interface ActiveHolder {
  gatewayId: string;
  organizationId: string;
  name: string;
  block: CustomDomainConfig;
}

/** A live claim the daily re-check should look at. */
export interface DueClaim {
  gatewayId: string;
  organizationId: string;
  name: string;
  block: CustomDomainConfig;
}

/** Where custom-domain claims are read and written. The Postgres one is below. */
export interface CustomDomainStore {
  /** Replace (or with null, remove) the claim on one gateway of one org. */
  write(gatewayId: string, organizationId: string, block: CustomDomainConfig | null): Promise<void>;
  /**
   * Write `next` only while the stored claim is still `current` (same
   * hostname and token). 'stale' when the claim changed underneath;
   * 'conflict' when another surface already serves the hostname.
   */
  replaceClaim(
    gatewayId: string,
    organizationId: string,
    current: Pick<CustomDomainConfig, 'hostname' | 'verificationToken'>,
    next: CustomDomainConfig,
  ): Promise<'ok' | 'stale' | 'conflict'>;
  /** The other hosted-chat surface that serves this hostname now, if any. */
  activeHolder(hostname: string, exceptGatewayId: string): Promise<ActiveHolder | null>;
  /**
   * In one transaction: demote the holder's live claim (only while it is
   * still exactly `holder.current` and active) and make the winner's
   * claim live (only while it is still `winner.current`). Neither happens
   * without the other.
   */
  takeOver(
    winner: { gatewayId: string; organizationId: string; current: Pick<CustomDomainConfig, 'hostname' | 'verificationToken'>; next: CustomDomainConfig },
    holder: { gatewayId: string; current: Pick<CustomDomainConfig, 'hostname' | 'verificationToken'>; demoted: CustomDomainConfig },
  ): Promise<'ok' | 'holder_changed' | 'stale' | 'conflict'>;
  /** Live claims last checked before `checkedBefore` (or never), oldest first. */
  dueForRecheck(checkedBefore: string, limit: number): Promise<DueClaim[]>;
  /**
   * Record a re-check, only while the claim is still the live one that was
   * checked (same hostname, token and lastCheckedAt). Two workers that
   * pick the same row cannot both count a failure.
   */
  recordRecheck(
    gatewayId: string,
    current: Pick<CustomDomainConfig, 'hostname' | 'verificationToken' | 'lastCheckedAt'>,
    next: CustomDomainConfig,
  ): Promise<'ok' | 'stale'>;
}

export const CUSTOM_DOMAIN_STORE = Symbol('CUSTOM_DOMAIN_STORE');

/** node-postgres through TypeORM answers an UPDATE ... RETURNING with [rows, count]. */
function returnedRows(result: any): any[] {
  const rows = Array.isArray(result?.[0]) ? result[0] : result;
  return Array.isArray(rows) ? rows : [];
}

function uniqueViolation(err: any): boolean {
  return (err?.code ?? err?.driverError?.code) === '23505';
}

class Rollback extends Error {
  constructor(readonly outcome: 'holder_changed' | 'stale') {
    super(outcome);
  }
}

/** The Postgres store: targeted jsonb updates, and the unique index as the arbiter. */
@Injectable()
export class PgCustomDomainStore implements CustomDomainStore {
  constructor(@InjectRepository(Gateway) private readonly gateways: Repository<Gateway>) {}

  async write(gatewayId: string, organizationId: string, block: CustomDomainConfig | null): Promise<void> {
    await this.gateways.query(
      `UPDATE "gateways" SET "customDomain" = $3::jsonb WHERE "id" = $1 AND "organizationId" = $2`,
      [gatewayId, organizationId, block ? JSON.stringify(block) : null],
    );
  }

  async replaceClaim(
    gatewayId: string,
    organizationId: string,
    current: Pick<CustomDomainConfig, 'hostname' | 'verificationToken'>,
    next: CustomDomainConfig,
  ): Promise<'ok' | 'stale' | 'conflict'> {
    try {
      const result = await this.gateways.query(
        `UPDATE "gateways" SET "customDomain" = $3::jsonb
          WHERE "id" = $1 AND "organizationId" = $2
            AND ("customDomain" ->> 'hostname') = $4
            AND ("customDomain" ->> 'verificationToken') = $5
          RETURNING "id"`,
        [gatewayId, organizationId, JSON.stringify(next), current.hostname, current.verificationToken],
      );
      return returnedRows(result).length > 0 ? 'ok' : 'stale';
    } catch (err: any) {
      if (uniqueViolation(err)) return 'conflict';
      throw err;
    }
  }

  async activeHolder(hostname: string, exceptGatewayId: string): Promise<ActiveHolder | null> {
    const rows = await this.gateways.query(
      `SELECT "id", "organizationId", "name", "customDomain" FROM "gateways"
        WHERE "type" = 'hosted_chat'
          AND ("customDomain" ->> 'status') = 'active'
          AND ("customDomain" ->> 'hostname') = $1
          AND "id" <> $2
        LIMIT 1`,
      [hostname, exceptGatewayId],
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    return row ? { gatewayId: row.id, organizationId: row.organizationId, name: row.name, block: row.customDomain } : null;
  }

  async takeOver(
    winner: { gatewayId: string; organizationId: string; current: Pick<CustomDomainConfig, 'hostname' | 'verificationToken'>; next: CustomDomainConfig },
    holder: { gatewayId: string; current: Pick<CustomDomainConfig, 'hostname' | 'verificationToken'>; demoted: CustomDomainConfig },
  ): Promise<'ok' | 'holder_changed' | 'stale' | 'conflict'> {
    try {
      await this.gateways.manager.transaction(async (em) => {
        const demoted = await em.query(
          `UPDATE "gateways" SET "customDomain" = $2::jsonb
            WHERE "id" = $1
              AND ("customDomain" ->> 'status') = 'active'
              AND ("customDomain" ->> 'hostname') = $3
              AND ("customDomain" ->> 'verificationToken') = $4
            RETURNING "id"`,
          [holder.gatewayId, JSON.stringify(holder.demoted), holder.current.hostname, holder.current.verificationToken],
        );
        if (returnedRows(demoted).length === 0) throw new Rollback('holder_changed');
        const won = await em.query(
          `UPDATE "gateways" SET "customDomain" = $3::jsonb
            WHERE "id" = $1 AND "organizationId" = $2
              AND ("customDomain" ->> 'hostname') = $4
              AND ("customDomain" ->> 'verificationToken') = $5
            RETURNING "id"`,
          [winner.gatewayId, winner.organizationId, JSON.stringify(winner.next), winner.current.hostname, winner.current.verificationToken],
        );
        if (returnedRows(won).length === 0) throw new Rollback('stale');
      });
      return 'ok';
    } catch (err: any) {
      if (err instanceof Rollback) return err.outcome;
      if (uniqueViolation(err)) return 'conflict';
      throw err;
    }
  }

  async dueForRecheck(checkedBefore: string, limit: number): Promise<DueClaim[]> {
    const rows = await this.gateways.query(
      `SELECT "id", "organizationId", "name", "customDomain" FROM "gateways"
        WHERE "type" = 'hosted_chat'
          AND ("customDomain" ->> 'status') = 'active'
          AND (("customDomain" ->> 'lastCheckedAt') IS NULL OR ("customDomain" ->> 'lastCheckedAt') < $1)
        ORDER BY ("customDomain" ->> 'lastCheckedAt') ASC NULLS FIRST
        LIMIT $2`,
      [checkedBefore, limit],
    );
    return (Array.isArray(rows) ? rows : []).map((row: any) => ({
      gatewayId: row.id,
      organizationId: row.organizationId,
      name: row.name,
      block: row.customDomain,
    }));
  }

  async recordRecheck(
    gatewayId: string,
    current: Pick<CustomDomainConfig, 'hostname' | 'verificationToken' | 'lastCheckedAt'>,
    next: CustomDomainConfig,
  ): Promise<'ok' | 'stale'> {
    const result = await this.gateways.query(
      `UPDATE "gateways" SET "customDomain" = $2::jsonb
        WHERE "id" = $1
          AND ("customDomain" ->> 'status') = 'active'
          AND ("customDomain" ->> 'hostname') = $3
          AND ("customDomain" ->> 'verificationToken') = $4
          AND ("customDomain" ->> 'lastCheckedAt') IS NOT DISTINCT FROM $5::text
        RETURNING "id"`,
      [gatewayId, JSON.stringify(next), current.hostname, current.verificationToken, current.lastCheckedAt ?? null],
    );
    return returnedRows(result).length > 0 ? 'ok' : 'stale';
  }
}

export interface CustomDomainView {
  hostname: string;
  status: CustomDomainConfig['status'];
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  /** The records the tenant publishes: TXT proves ownership, CNAME routes traffic. */
  records: {
    txt: { type: 'TXT'; name: string; value: string };
    cname: { type: 'CNAME'; name: string; value: string };
  };
}

/** How often the daily re-check wakes up to look for due claims. */
const RECHECK_TICK_MS = 60 * 60 * 1000;
/** A live claim is re-checked once it is this old. */
export const RECHECK_AFTER_MS = 24 * 60 * 60 * 1000;
/** Claims looked at per tick, so one tick stays short. */
const RECHECK_BATCH = 200;

export const DOMAIN_DEMOTED_MESSAGE =
  'The TXT record was not found on several daily checks, so this domain is no longer served. Publish the record again and check.';
export const DOMAIN_TAKEN_OVER_MESSAGE =
  'Another surface proved control of this domain after your TXT record stopped resolving, so this domain is no longer served here.';

@Injectable()
export class CustomDomainService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CustomDomainService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly gatewaysService: GatewaysService,
    @Inject(CUSTOM_DOMAIN_STORE) private readonly store: CustomDomainStore,
    @Optional() @Inject(TXT_RESOLVER) private readonly resolveTxt: TxtResolver = (name) => dns.resolveTxt(name),
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      this.recheckDue().catch((err) => this.logger.warn(`Custom domain re-check failed: ${err?.message ?? err}`));
    }, RECHECK_TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** What the CNAME should point at: the surface's own subdomain unless the deployment says otherwise. */
  static cnameTarget(gateway: Pick<Gateway, 'configuration'>, env: Record<string, any> = process.env): string {
    const configured = String(env.HOSTED_CHAT_CUSTOM_DOMAIN_TARGET ?? '').trim().toLowerCase();
    if (configured) return configured;
    const slug = hostedChatConfigFrom(gateway.configuration).slug;
    return slug ? `${slug}.${hostedChatBaseDomain(env)}` : hostedChatBaseDomain(env);
  }

  static view(gateway: Pick<Gateway, 'configuration'>, block: CustomDomainConfig | null | undefined): CustomDomainView | null {
    if (!block?.hostname) return null;
    return {
      hostname: block.hostname,
      status: block.status,
      verifiedAt: block.verifiedAt ?? null,
      lastCheckedAt: block.lastCheckedAt ?? null,
      lastError: block.lastError ?? null,
      records: {
        txt: verificationRecord(block),
        cname: { type: 'CNAME', name: block.hostname, value: CustomDomainService.cnameTarget(gateway) },
      },
    };
  }

  async get(gatewayId: string, organizationId: string, userId: string): Promise<CustomDomainView | null> {
    const gateway = await this.hostedChatSurface(gatewayId, organizationId, userId);
    return CustomDomainService.view(gateway, gateway.customDomain);
  }

  /**
   * Claim a hostname for a surface. A new or changed hostname always
   * starts unverified with a fresh token, so changing the domain means
   * proving the new one; the old hostname stops being served at once.
   * Setting the hostname a surface already holds changes nothing.
   *
   * A hostname another surface serves can still be claimed: the claim is
   * pending and serves nothing, and verify decides whether it may go live.
   */
  async set(gatewayId: string, organizationId: string, userId: string, rawHostname: unknown): Promise<CustomDomainView> {
    const gateway = await this.hostedChatSurface(gatewayId, organizationId, userId);
    const hostname = typeof rawHostname === 'string' ? rawHostname.trim().toLowerCase() : '';
    const problem = customDomainError(hostname);
    if (problem) throw new BadRequestException({ code: 'DOMAIN_INVALID', message: problem });
    if (isReservedDomain(hostname, hostedChatBaseDomain())) {
      throw new BadRequestException({ code: 'DOMAIN_RESERVED', message: CUSTOM_DOMAIN_REFUSALS.DOMAIN_RESERVED });
    }

    const current = gateway.customDomain;
    if (current?.hostname === hostname) return CustomDomainService.view(gateway, current)!;

    const block = newCustomDomain(hostname);
    await this.store.write(gateway.id, organizationId, block);
    return CustomDomainService.view(gateway, block)!;
  }

  /** Stop using a custom domain. It stops being served immediately. */
  async remove(gatewayId: string, organizationId: string, userId: string): Promise<void> {
    const gateway = await this.hostedChatSurface(gatewayId, organizationId, userId);
    await this.store.write(gateway.id, organizationId, null);
  }

  /**
   * Look up the TXT record and, if it proves control, make the hostname
   * live. The flip is a compare-and-set on the claim that was checked, so
   * a hostname changed mid-check is never activated on the old proof, and
   * the unique index decides between two surfaces racing for one name.
   *
   * When another surface already serves the name, its own TXT record is
   * looked up too. Still there: two parties both prove control, the
   * current holder keeps it. Gone (a definite answer, not a lookup that
   * errored): the domain changed hands, and this claim takes it over in
   * one transaction that also demotes the holder.
   */
  async verify(gatewayId: string, organizationId: string, userId: string): Promise<CustomDomainView> {
    const gateway = await this.hostedChatSurface(gatewayId, organizationId, userId);
    const current = gateway.customDomain;
    if (!current?.hostname || !current.verificationToken) {
      throw new BadRequestException({ code: 'DOMAIN_NOT_SET', message: 'Set a custom domain first.' });
    }

    const checkedAt = new Date().toISOString();
    const outcome = await this.checkTxt(current);
    const next: CustomDomainConfig = outcome.verified
      ? { ...current, status: 'active', verifiedAt: current.verifiedAt ?? checkedAt, lastCheckedAt: checkedAt, lastError: null, consecutiveFailures: 0 }
      : {
          ...current,
          // A record that is missing or wrong is a failed proof, and a
          // live domain whose record has gone stops being served. A DNS
          // lookup that merely errored proves nothing either way, so it
          // leaves the status where it was.
          status: outcome.transient ? current.status : 'failed',
          lastCheckedAt: checkedAt,
          lastError: outcome.error,
        };

    const result = await this.store.replaceClaim(gateway.id, organizationId, current, next);
    if (result === 'stale') throw this.changedWhileChecking();
    if (result === 'conflict') {
      return this.contest(gateway, organizationId, current, next, checkedAt);
    }
    if (!outcome.verified) {
      this.logger.log(`Custom domain ${current.hostname} not verified for gateway ${gateway.id}: ${outcome.error}`);
    }
    return CustomDomainService.view(gateway, next)!;
  }

  /** This claim proved the record, but another surface serves the name. */
  private async contest(
    gateway: Gateway,
    organizationId: string,
    current: CustomDomainConfig,
    next: CustomDomainConfig,
    checkedAt: string,
  ): Promise<CustomDomainView> {
    const holder = await this.store.activeHolder(current.hostname, gateway.id);
    const holderProof = holder ? await this.checkTxt(holder.block) : null;

    // The holder's record still resolves, or DNS could not say: two
    // parties prove control, and the one serving keeps it.
    if (!holder || !holderProof || holderProof.verified || holderProof.transient) {
      const refused: CustomDomainConfig = {
        ...current,
        status: 'failed',
        lastCheckedAt: checkedAt,
        lastError: CUSTOM_DOMAIN_REFUSALS.DOMAIN_ALREADY_CLAIMED,
      };
      await this.store.replaceClaim(gateway.id, organizationId, current, refused);
      throw new ConflictException({ code: 'DOMAIN_ALREADY_CLAIMED', message: CUSTOM_DOMAIN_REFUSALS.DOMAIN_ALREADY_CLAIMED });
    }

    const demoted: CustomDomainConfig = {
      ...holder.block,
      status: 'failed',
      lastCheckedAt: checkedAt,
      lastError: DOMAIN_TAKEN_OVER_MESSAGE,
    };
    const result = await this.store.takeOver(
      { gatewayId: gateway.id, organizationId, current, next },
      { gatewayId: holder.gatewayId, current: holder.block, demoted },
    );
    if (result === 'stale') throw this.changedWhileChecking();
    if (result !== 'ok') {
      throw new ConflictException({ code: 'DOMAIN_ALREADY_CLAIMED', message: CUSTOM_DOMAIN_REFUSALS.DOMAIN_ALREADY_CLAIMED });
    }
    this.logger.warn(
      `Custom domain ${current.hostname} moved from gateway ${holder.gatewayId} to ${gateway.id}: the holder's TXT record no longer resolves`,
    );
    await this.notifyDemoted(holder, DOMAIN_TAKEN_OVER_MESSAGE);
    return CustomDomainService.view(gateway, next)!;
  }

  /**
   * The daily re-check of live domains. A claim whose record is found is
   * refreshed; one whose record is definitely gone counts a failure, and
   * after RECHECK_FAILURES_BEFORE_DEMOTION of them in a row stops being
   * served and its organization's admins are told. A lookup that errored
   * counts nothing. Every write is conditional on the claim still being
   * the one that was checked.
   */
  async recheckDue(now: Date = new Date()): Promise<{ checked: number; demoted: number }> {
    const cutoff = new Date(now.getTime() - RECHECK_AFTER_MS + RECHECK_TICK_MS).toISOString();
    const due = await this.store.dueForRecheck(cutoff, RECHECK_BATCH);
    let checked = 0;
    let demoted = 0;
    for (const claim of due) {
      try {
        const outcome = await this.checkTxt(claim.block);
        const checkedAt = now.toISOString();
        const failures = claim.block.consecutiveFailures ?? 0;
        let next: CustomDomainConfig;
        if (outcome.verified) {
          next = { ...claim.block, lastCheckedAt: checkedAt, lastError: null, consecutiveFailures: 0 };
        } else if (outcome.transient) {
          next = { ...claim.block, lastCheckedAt: checkedAt, lastError: outcome.error };
        } else if (failures + 1 >= RECHECK_FAILURES_BEFORE_DEMOTION) {
          next = { ...claim.block, status: 'failed', lastCheckedAt: checkedAt, lastError: DOMAIN_DEMOTED_MESSAGE, consecutiveFailures: failures + 1 };
        } else {
          next = { ...claim.block, lastCheckedAt: checkedAt, lastError: outcome.error, consecutiveFailures: failures + 1 };
        }
        const result = await this.store.recordRecheck(claim.gatewayId, claim.block, next);
        if (result !== 'ok') continue;
        checked++;
        if (next.status !== 'active') {
          demoted++;
          this.logger.warn(`Custom domain ${claim.block.hostname} of gateway ${claim.gatewayId} is no longer served: TXT record gone`);
          await this.notifyDemoted(claim, DOMAIN_DEMOTED_MESSAGE);
        }
      } catch (err: any) {
        this.logger.warn(`Custom domain re-check of gateway ${claim.gatewayId} failed: ${err?.message ?? err}`);
      }
    }
    return { checked, demoted };
  }

  private async notifyDemoted(claim: Pick<DueClaim, 'gatewayId' | 'organizationId' | 'name' | 'block'>, reason: string): Promise<void> {
    await this.notifications?.emit({
      type: 'domains.unverified',
      organizationId: claim.organizationId,
      roleTarget: { orgRoles: [OrganizationRole.OWNER, OrganizationRole.ADMIN] },
      title: `${claim.block.hostname} is no longer served`,
      body: reason,
      link: `/gateways/${claim.gatewayId}`,
      email: {
        template: 'domains.unverified',
        params: { hostname: claim.block.hostname, gatewayName: claim.name, reason },
      },
    });
  }

  private changedWhileChecking(): ConflictException {
    return new ConflictException({ code: 'DOMAIN_CHANGED', message: 'The domain changed while it was being checked. Check again.' });
  }

  /**
   * Look for the tenant's verification TXT record. "Not published yet" is
   * the expected state for most of a domain's life, so it is an outcome,
   * not an error.
   */
  async checkTxt(
    domain: Pick<CustomDomainConfig, 'hostname' | 'verificationToken'>,
  ): Promise<{ verified: boolean; error: string | null; transient?: boolean }> {
    const name = `${VERIFICATION_RECORD_PREFIX}.${domain.hostname}`;
    try {
      // A long TXT value arrives split into chunks; join each record.
      const records = (await this.resolveTxt(name)).map((chunks) => chunks.join(''));
      if (isVerified(records, domain)) return { verified: true, error: null };
      return { verified: false, error: 'The TXT record was found but did not match. Check you copied the whole value.' };
    } catch (err: any) {
      if (err?.code === 'ENOTFOUND' || err?.code === 'ENODATA') {
        return { verified: false, error: 'No TXT record found at that name yet.' };
      }
      return { verified: false, error: 'Could not read DNS right now. Try again in a minute.', transient: true };
    }
  }

  private async hostedChatSurface(gatewayId: string, organizationId: string, userId: string): Promise<Gateway> {
    const gateway = await this.gatewaysService.findManageable(gatewayId, organizationId, userId);
    if (gateway.type !== GatewayType.HOSTED_CHAT) {
      throw new BadRequestException({ code: 'NOT_A_HOSTED_CHAT', message: 'Custom domains are for hosted chat apps.' });
    }
    return gateway;
  }
}
