import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { promises as dns } from 'dns';

import { Gateway, GatewayType } from '../../../entities/gateway.entity';
import { GatewaysService } from '../gateways.service';
import { hostedChatBaseDomain, hostedChatConfigFrom } from './hosted-chat.config';
import {
  CUSTOM_DOMAIN_REFUSALS,
  CustomDomainConfig,
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
 * The `customDomain` block on a gateway is written only here.
 * keepServerOwnedCustomDomain stops the generic gateway update from
 * writing it, and every write below touches that one key with a
 * targeted SQL update rather than saving the whole configuration.
 *
 * One live owner per hostname, across every organization: a partial
 * unique index (UQ_gateways_custom_domain_active) refuses a second
 * active row, so two tenants who both somehow pass the TXT check cannot
 * both be served. Pending claims may coexist -- only the domain's real
 * owner can publish the record, and a squatter's pending row must not
 * block them.
 */

/** Looks up TXT records; injectable so specs do not touch real DNS. */
export const TXT_RESOLVER = Symbol('TXT_RESOLVER');
export type TxtResolver = (name: string) => Promise<string[][]>;

/** Where custom-domain rows are read and written. The Postgres one is below. */
export interface CustomDomainStore {
  /** Replace (or with null, remove) the block on one gateway of one org. */
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
  /** Whether some other hosted-chat surface serves this hostname now. */
  activeElsewhere(hostname: string, exceptGatewayId: string): Promise<boolean>;
}

export const CUSTOM_DOMAIN_STORE = Symbol('CUSTOM_DOMAIN_STORE');

/** The Postgres store: targeted jsonb updates, and the unique index as the arbiter. */
@Injectable()
export class PgCustomDomainStore implements CustomDomainStore {
  constructor(@InjectRepository(Gateway) private readonly gateways: Repository<Gateway>) {}

  async write(gatewayId: string, organizationId: string, block: CustomDomainConfig | null): Promise<void> {
    if (block) {
      await this.gateways.query(
        `UPDATE "gateways"
            SET "configuration" = (COALESCE("configuration"::jsonb, '{}'::jsonb)
                                   || jsonb_build_object('customDomain', $3::jsonb))::json
          WHERE "id" = $1 AND "organizationId" = $2`,
        [gatewayId, organizationId, JSON.stringify(block)],
      );
    } else {
      await this.gateways.query(
        `UPDATE "gateways"
            SET "configuration" = (COALESCE("configuration"::jsonb, '{}'::jsonb) - 'customDomain')::json
          WHERE "id" = $1 AND "organizationId" = $2`,
        [gatewayId, organizationId],
      );
    }
  }

  async replaceClaim(
    gatewayId: string,
    organizationId: string,
    current: Pick<CustomDomainConfig, 'hostname' | 'verificationToken'>,
    next: CustomDomainConfig,
  ): Promise<'ok' | 'stale' | 'conflict'> {
    try {
      const rows = await this.gateways.query(
        `UPDATE "gateways"
            SET "configuration" = (COALESCE("configuration"::jsonb, '{}'::jsonb)
                                   || jsonb_build_object('customDomain', $3::jsonb))::json
          WHERE "id" = $1 AND "organizationId" = $2
            AND ("configuration" -> 'customDomain' ->> 'hostname') = $4
            AND ("configuration" -> 'customDomain' ->> 'verificationToken') = $5
          RETURNING "id"`,
        [gatewayId, organizationId, JSON.stringify(next), current.hostname, current.verificationToken],
      );
      // node-postgres through TypeORM answers an UPDATE ... RETURNING with
      // [rows, count]; a plain array on other drivers.
      const updated = Array.isArray(rows?.[0]) ? rows[0] : rows;
      return Array.isArray(updated) && updated.length > 0 ? 'ok' : 'stale';
    } catch (err: any) {
      const code = err?.code ?? err?.driverError?.code;
      if (code === '23505') return 'conflict';
      throw err;
    }
  }

  async activeElsewhere(hostname: string, exceptGatewayId: string): Promise<boolean> {
    const rows = await this.gateways.query(
      `SELECT 1 FROM "gateways"
        WHERE "type" = 'hosted_chat'
          AND ("configuration" -> 'customDomain' ->> 'status') = 'active'
          AND ("configuration" -> 'customDomain' ->> 'hostname') = $1
          AND "id" <> $2
        LIMIT 1`,
      [hostname, exceptGatewayId],
    );
    return Array.isArray(rows) && rows.length > 0;
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

@Injectable()
export class CustomDomainService {
  private readonly logger = new Logger(CustomDomainService.name);

  constructor(
    private readonly gatewaysService: GatewaysService,
    @Inject(CUSTOM_DOMAIN_STORE) private readonly store: CustomDomainStore,
    @Optional() @Inject(TXT_RESOLVER) private readonly resolveTxt: TxtResolver = (name) => dns.resolveTxt(name),
  ) {}

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
    return CustomDomainService.view(gateway, gateway.configuration?.customDomain);
  }

  /**
   * Claim a hostname for a surface. A new or changed hostname always
   * starts unverified with a fresh token, so changing the domain means
   * proving the new one; the old hostname stops being served at once.
   * Setting the hostname a surface already holds changes nothing.
   */
  async set(gatewayId: string, organizationId: string, userId: string, rawHostname: unknown): Promise<CustomDomainView> {
    const gateway = await this.hostedChatSurface(gatewayId, organizationId, userId);
    const hostname = typeof rawHostname === 'string' ? rawHostname.trim().toLowerCase() : '';
    const problem = customDomainError(hostname);
    if (problem) throw new BadRequestException({ code: 'DOMAIN_INVALID', message: problem });
    if (isReservedDomain(hostname, hostedChatBaseDomain())) {
      throw new BadRequestException({ code: 'DOMAIN_RESERVED', message: CUSTOM_DOMAIN_REFUSALS.DOMAIN_RESERVED });
    }

    const current: CustomDomainConfig | undefined = gateway.configuration?.customDomain;
    if (current?.hostname === hostname) return CustomDomainService.view(gateway, current)!;

    if (await this.store.activeElsewhere(hostname, gateway.id)) {
      throw new ConflictException({ code: 'DOMAIN_ALREADY_CLAIMED', message: CUSTOM_DOMAIN_REFUSALS.DOMAIN_ALREADY_CLAIMED });
    }
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
   */
  async verify(gatewayId: string, organizationId: string, userId: string): Promise<CustomDomainView> {
    const gateway = await this.hostedChatSurface(gatewayId, organizationId, userId);
    const current: CustomDomainConfig | undefined = gateway.configuration?.customDomain;
    if (!current?.hostname || !current.verificationToken) {
      throw new BadRequestException({ code: 'DOMAIN_NOT_SET', message: 'Set a custom domain first.' });
    }

    const checkedAt = new Date().toISOString();
    const outcome = await this.checkTxt(current);
    const next: CustomDomainConfig = outcome.verified
      ? { ...current, status: 'active', verifiedAt: current.verifiedAt ?? checkedAt, lastCheckedAt: checkedAt, lastError: null }
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
    if (result === 'stale') {
      throw new ConflictException({ code: 'DOMAIN_CHANGED', message: 'The domain changed while it was being checked. Check again.' });
    }
    if (result === 'conflict') {
      const refused: CustomDomainConfig = {
        ...current,
        status: 'failed',
        lastCheckedAt: checkedAt,
        lastError: CUSTOM_DOMAIN_REFUSALS.DOMAIN_ALREADY_CLAIMED,
      };
      await this.store.replaceClaim(gateway.id, organizationId, current, refused);
      throw new ConflictException({ code: 'DOMAIN_ALREADY_CLAIMED', message: CUSTOM_DOMAIN_REFUSALS.DOMAIN_ALREADY_CLAIMED });
    }
    if (!outcome.verified) {
      this.logger.log(`Custom domain ${current.hostname} not verified for gateway ${gateway.id}: ${outcome.error}`);
    }
    return CustomDomainService.view(gateway, next)!;
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
