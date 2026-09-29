import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { promises as dns } from 'dns';

import { OrgDomain, OrgDomainStatus } from '../../../src/entities/org-domain.entity';
import { isUniqueViolation } from '../../../src/common/utils/unique-violation';
import {
  TXT_RESOLVER,
  TxtResolver,
  checkVerificationTxt,
  customDomainError,
  isReservedDomain,
  newVerificationToken,
  verificationRecord,
} from '../../../src/modules/gateways/channels/custom-domain';
import { hostedChatBaseDomain } from '../../../src/modules/gateways/channels/hosted-chat.config';

export interface OrgDomainView {
  id: string;
  domain: string;
  status: OrgDomainStatus;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  /** The TXT record to publish, ready to copy. */
  record: { type: 'TXT'; name: string; value: string };
}

export const DOMAIN_TAKEN_MESSAGE = 'Another organization has already verified this domain.';

/**
 * Email domains an organization has proven it controls. The proof is the
 * DNS TXT record hosted-chat custom domains use (custom-domain.ts), so
 * one record format and one checker serve both.
 *
 * SSO provisions a new account only for an address on one of the
 * organization's verified domains (coversEmail): an org owner configures
 * the IdP and could otherwise have it assert any address at all, creating
 * an account for someone else's mailbox that the owner's IdP then signs
 * into.
 */
@Injectable()
export class OrgDomainService {
  constructor(
    @InjectRepository(OrgDomain) private readonly repo: Repository<OrgDomain>,
    @Optional() @Inject(TXT_RESOLVER) private readonly resolveTxt: TxtResolver = (name) => dns.resolveTxt(name),
  ) {}

  static view(row: OrgDomain): OrgDomainView {
    return {
      id: row.id,
      domain: row.domain,
      status: row.status,
      verifiedAt: row.verifiedAt ? new Date(row.verifiedAt).toISOString() : null,
      lastCheckedAt: row.lastCheckedAt ? new Date(row.lastCheckedAt).toISOString() : null,
      lastError: row.lastError ?? null,
      record: verificationRecord({ hostname: row.domain, verificationToken: row.verificationToken }),
    };
  }

  async list(organizationId: string): Promise<OrgDomainView[]> {
    const rows = await this.repo.find({ where: { organizationId }, order: { createdAt: 'ASC' } });
    return rows.map(OrgDomainService.view);
  }

  /** Start claiming a domain. It proves nothing until verify finds the TXT record. */
  async add(organizationId: string, rawDomain: unknown): Promise<OrgDomainView> {
    const domain = typeof rawDomain === 'string' ? rawDomain.trim().toLowerCase() : '';
    const problem = customDomainError(domain);
    if (problem) throw new BadRequestException({ code: 'DOMAIN_INVALID', message: problem });
    if (isReservedDomain(domain, hostedChatBaseDomain())) {
      throw new BadRequestException({ code: 'DOMAIN_RESERVED', message: 'That domain belongs to almyty and cannot be claimed.' });
    }
    const existing = await this.repo.findOne({ where: { organizationId, domain } });
    if (existing) return OrgDomainService.view(existing);
    try {
      const saved = await this.repo.save(
        this.repo.create({ organizationId, domain, verificationToken: newVerificationToken(), status: 'pending' }),
      );
      return OrgDomainService.view(saved);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const row = await this.repo.findOne({ where: { organizationId, domain } });
      if (!row) throw err;
      return OrgDomainService.view(row);
    }
  }

  /** Look up the TXT record and, when it matches, mark the domain verified. */
  async verify(organizationId: string, id: string): Promise<OrgDomainView> {
    const row = await this.repo.findOne({ where: { id, organizationId } });
    if (!row) throw new NotFoundException('Domain not found');

    const outcome = await checkVerificationTxt(this.resolveTxt, { hostname: row.domain, verificationToken: row.verificationToken });
    const now = new Date();
    const patch: Partial<OrgDomain> = outcome.verified
      ? { status: 'verified', verifiedAt: row.verifiedAt ?? now, lastCheckedAt: now, lastError: null }
      : {
          // A lookup that merely errored proves nothing either way.
          status: outcome.transient ? row.status : 'failed',
          lastCheckedAt: now,
          lastError: outcome.error,
        };
    try {
      await this.repo.update({ id: row.id, organizationId }, patch);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      await this.repo.update(
        { id: row.id, organizationId },
        { status: 'failed', lastCheckedAt: now, lastError: DOMAIN_TAKEN_MESSAGE },
      );
      throw new ConflictException({ code: 'DOMAIN_ALREADY_VERIFIED', message: DOMAIN_TAKEN_MESSAGE });
    }
    return OrgDomainService.view({ ...row, ...patch } as OrgDomain);
  }

  async remove(organizationId: string, id: string): Promise<void> {
    const result = await this.repo.delete({ id, organizationId });
    if (!result.affected) throw new NotFoundException('Domain not found');
  }

  /**
   * Is this address on one of the organization's verified domains (the
   * domain itself or a subdomain of it)? Anything unparseable is not.
   */
  async coversEmail(organizationId: string, email: string): Promise<boolean> {
    const at = (email || '').lastIndexOf('@');
    if (at < 1) return false;
    const host = email.slice(at + 1).trim().toLowerCase();
    if (!host) return false;
    const verified = await this.repo.find({ where: { organizationId, status: 'verified' } });
    return verified.some((d) => host === d.domain || host.endsWith(`.${d.domain}`));
  }
}
