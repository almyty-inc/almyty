import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Organization } from '../../entities/organization.entity';
import { User } from '../../entities/user.entity';
import { OrganizationRole } from '../../entities/user-organization.entity';
import { isKnownTimeZone } from '../../common/utils/current-time';

/** How long an organization's time zone is remembered before it is read again. */
const ZONE_TTL_MS = 5 * 60_000;

/**
 * The organization's time zone: the one set on the organization
 * (settings.timezone), else the time zone on its owner's profile, else
 * UTC. A run's models are told the date in it, and a schedule's message
 * values are filled in with it.
 */
@Injectable()
export class OrganizationTimeZoneService {
  private readonly logger = new Logger(OrganizationTimeZoneService.name);
  private readonly cache = new Map<string, { zone: string | null; expiresAt: number }>();

  constructor(
    @InjectRepository(Organization)
    private readonly organizations: Repository<Organization>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
  ) {}

  /** The organization's time zone, UTC when none is set. */
  async zoneOf(organizationId: string | null | undefined): Promise<string> {
    return (await this.configuredZoneOf(organizationId)) ?? 'UTC';
  }

  /** The organization's time zone, or null when neither it nor its owner set one. */
  async configuredZoneOf(organizationId: string | null | undefined): Promise<string | null> {
    if (!organizationId) return null;
    const hit = this.cache.get(organizationId);
    if (hit && hit.expiresAt > Date.now()) return hit.zone;
    let zone: string | null = null;
    try {
      zone = await this.read(organizationId);
    } catch (err: any) {
      this.logger.warn(`Could not read the time zone of organization ${organizationId}: ${err?.message ?? err}`);
    }
    this.cache.set(organizationId, { zone, expiresAt: Date.now() + ZONE_TTL_MS });
    return zone;
  }

  private async read(organizationId: string): Promise<string | null> {
    const org = await this.organizations.findOne({ where: { id: organizationId }, select: { id: true, settings: true } });
    const own = org?.settings?.timezone;
    if (isKnownTimeZone(own)) return own;
    const owner = await this.users
      .createQueryBuilder('u')
      .innerJoin('u.organizationMemberships', 'm', 'm.organizationId = :organizationId AND m.role = :role', {
        organizationId,
        role: OrganizationRole.OWNER,
      })
      .where('u.timezone IS NOT NULL')
      .orderBy('m.joinedAt', 'ASC')
      .select(['u.id', 'u.timezone'])
      .getOne();
    return isKnownTimeZone(owner?.timezone) ? owner!.timezone! : null;
  }
}
