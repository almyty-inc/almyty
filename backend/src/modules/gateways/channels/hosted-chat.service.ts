import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { createHash, randomBytes } from 'crypto';

import { Gateway, GatewayType } from '../../../entities/gateway.entity';
import { EndUser } from '../../../entities/end-user.entity';
import { Conversation, ConversationStatus } from '../../../entities/conversation.entity';
import { Message, MessageRole } from '../../../entities/message.entity';
import { AgentRun } from '../../../entities/agent-run.entity';
import {
  HostedChatConfig,
  hostedChatConfigFrom,
} from './hosted-chat.config';
import { AuditAction, AuditResource } from '../../../entities/audit-log.entity';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { OrgLicenseResolver } from '../../licensing/org-license.resolver';
import { EE_ENTITLEMENTS } from '../../licensing/license.constants';
import { isPrivateGateway } from '../private-gateway';

/**
 * The tenant-facing half of the hosted chat app.
 *
 * Everything here runs for an anonymous member of the public, so the
 * rules are stricter than anywhere else in the codebase: resolve a
 * surface only by its public slug, hand back only presentation fields,
 * and never let a caller name a conversation or an end user they do not
 * already hold the cookie for.
 */
/** Turns replayed for one conversation. */
const MESSAGE_PAGE_LIMIT = 500;
/** Conversations included in one visitor export. */
const EXPORT_CONVERSATION_LIMIT = 500;
/**
 * Overall ceiling on the message rows one export loads. The export used to
 * issue one query per conversation with no overall bound; this is what keeps
 * a public endpoint's answer bounded in heap.
 */
const EXPORT_MESSAGE_LIMIT = 25_000;
@Injectable()
export class HostedChatService {
  /** Cookie holding the per-surface session key. */
  static readonly SESSION_COOKIE = 'almyty_chat_session';
  static readonly SESSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

  /** One definition of the visitor cookie, shared by every controller that issues it. */
  static sessionCookieOptions() {
    return {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: process.env.NODE_ENV === 'production',
      maxAge: HostedChatService.SESSION_MAX_AGE_MS,
      path: '/',
    };
  }


  private readonly logger = new Logger(HostedChatService.name);

  constructor(
    @InjectRepository(Gateway)
    private readonly gatewayRepository: Repository<Gateway>,
    @InjectRepository(EndUser)
    private readonly endUserRepository: Repository<EndUser>,
    @InjectRepository(Conversation)
    private readonly conversationRepository: Repository<Conversation>,
    @InjectRepository(Message)
    private readonly messageRepository: Repository<Message>,
    @InjectRepository(AgentRun)
    private readonly runRepository: Repository<AgentRun>,
    @Optional()
    private readonly auditLogService?: AuditLogService,
    @Optional()
    private readonly orgLicense?: OrgLicenseResolver,

  ) {}

  /**
   * Resolve a live hosted chat surface by its subdomain label.
   *
   * 404s rather than 403s for an inactive or non-hosted-chat gateway:
   * the existence of a slug is itself information, and a public endpoint
   * should not confirm that acme.almyty.app is real but switched off.
   */
  async findBySlug(slug: string): Promise<Gateway> {
    const normalized = (slug || '').trim().toLowerCase();
    if (!normalized) throw new NotFoundException('Chat app not found');

    // gateways.configuration is plain `json`, not jsonb: -> and ->> both
    // work on it, but the jsonb-only operators (@>, ?, jsonb_path_*) do
    // not. Match the slug inside the hostedChat block by path.
    // UQ_gateways_hosted_chat_slug indexes this exact expression.
    const gateways = await this.gatewayRepository
      .createQueryBuilder('gateway')
      .where('gateway.type = :type', { type: GatewayType.HOSTED_CHAT })
      .andWhere("gateway.configuration -> 'hostedChat' ->> 'slug' = :slug", { slug: normalized })
      .getMany();

    // Private gateways are never public surfaces (refused at write time);
    // one that exists anyway is not served.
    const active = gateways.filter((gateway) => gateway.isActive() && !isPrivateGateway(gateway));

    // A tenant slug is a global public address. If bad historic data or
    // a concurrent publish ever leaves more than one live claimant,
    // fail closed instead of choosing an arbitrary tenant and exposing
    // its branding, agent, and conversations under somebody else's URL.
    if (active.length > 1) {
      this.logger.error(
        `Refusing ambiguous hosted-chat slug '${normalized}' claimed by gateways ${active
          .map((gateway) => gateway.id)
          .join(', ')}`,
      );
    }

    if (active.length !== 1) throw new NotFoundException('Chat app not found');
    return active[0];
  }

  /**
   * Presentation fields only.
   *
   * The gateway's `configuration` json also holds channel credentials,
   * so this is a strict whitelist rather than a redaction pass: a new
   * secret added to that blob must not become publicly readable by
   * default. Same discipline as sanitizeWidgetConfig.
   */
  async publicBranding(gateway: Gateway): Promise<Record<string, any>> {
    const config: HostedChatConfig = hostedChatConfigFrom(gateway.configuration);

    // The entitlement is re-read here, not trusted from stored config.
    //
    // Publishing gates white label and disclosure removal, but nothing
    // re-checked them afterwards — so an org that bought Enterprise,
    // turned white label on and then downgraded kept the almyty mark off
    // its public page indefinitely, and kept the EU AI Act Art. 50
    // disclosure off with it. A licence that has lapsed has lapsed on
    // the read path too.
    const entitled = this.orgLicense
      ? await this.orgLicense
          .hasForOrg(gateway.organizationId, EE_ENTITLEMENTS.WHITE_LABEL)
          .catch(() => false)
      : false;

    return {
      appName: config.appName,
      primaryColor: config.primaryColor,
      greeting: config.greeting,
      theme: config.theme,
      logoUrl: config.logoUrl,
      suggestedPrompts: config.suggestedPrompts,
      authMode: config.authMode,
      whiteLabel: entitled ? config.whiteLabel : false,
      visitorCanDelete: config.visitorCanDelete,
      visitorCanExport: config.visitorCanExport,

      // Null means "use the default line". An empty string is a
      // deliberate removal, which only an entitled org may have.
      aiDisclosure: entitled ? config.aiDisclosure : config.aiDisclosure || null,
    };
  }

  /** A fresh, unguessable session key for a new visitor. */
  static newSessionKey(): string {
    return randomBytes(32).toString('hex');
  }

  /**
   * Client fingerprint for per-IP limits, hashed rather than stored raw.
   * A public chat surface should not accumulate a plaintext log of every
   * IP that ever used it; the value is only ever compared.
   */
  static hashClient(ip: string | undefined): string | null {
    if (!ip) return null;
    return createHash('sha256').update(ip).digest('hex').slice(0, 32);
  }

  /**
   * Find or create the visitor behind a session cookie.
   *
   * An anonymous visitor is a real row, not a special case: that is what
   * lets public-by-link be a flag rather than a second architecture, and
   * what lets a later sign-in attach to the same person by filling in
   * externalId and authProvider.
   */
  async resolveEndUser(
    gateway: Gateway,
    sessionKey: string | undefined,
    clientIp?: string,
  ): Promise<{ endUser: EndUser; issuedSessionKey: string | null }> {
    const clientHash = HostedChatService.hashClient(clientIp);

    if (sessionKey) {
      const existing = await this.endUserRepository.findOne({
        where: { gatewayId: gateway.id, sessionKey },
      });
      if (existing) {
        existing.lastSeenAt = new Date();
        if (clientHash) existing.clientHash = clientHash;
        await this.endUserRepository.save(existing);
        return { endUser: existing, issuedSessionKey: null };
      }
      // A cookie we do not recognise (rotated database, cleared table,
      // forged value) becomes a new visitor rather than an error.
    }

    const issued = HostedChatService.newSessionKey();
    const endUser = await this.endUserRepository.save(
      this.endUserRepository.create({
        organizationId: gateway.organizationId,
        gatewayId: gateway.id,
        sessionKey: issued,
        externalId: null,
        authProvider: null,
        clientHash,
        lastSeenAt: new Date(),
      }),
    );
    return { endUser, issuedSessionKey: issued };
  }

  // ── Visitor authentication ──────────────────────────────────────────
  //
  // The auth mode on a surface was stored and shown but never enforced:
  // every visitor was admitted anonymously whatever the tenant chose.
  // Core only ever asks "is this visitor signed in the way the surface
  // requires?"; the sign-in flows themselves (email codes in
  // hosted-chat-email-auth.controller.ts, SSO in ee/) attach the identity
  // through bindAuthenticatedVisitor below.

  /** The auth mode this surface is configured with. */
  authMode(gateway: Gateway): HostedChatConfig['authMode'] {
    return hostedChatConfigFrom(gateway.configuration).authMode;
  }

  requiresAuth(gateway: Gateway): boolean {
    return this.authMode(gateway) !== 'public_link';
  }

  /**
   * Signed in with the provider the surface currently requires. Matching
   * the provider (not just "not anonymous") means switching a surface
   * from email codes to SSO invalidates the old sessions instead of
   * grandfathering them.
   */
  isAuthorized(gateway: Gateway, endUser: EndUser): boolean {
    if (!this.requiresAuth(gateway)) return true;
    return !!endUser.authProvider && endUser.authProvider === this.authMode(gateway);
  }

  /**
   * SSO is an enterprise entitlement. A surface set to SSO on an org that
   * lost the entitlement must close, not silently fall back to open.
   */
  async authModeAvailable(gateway: Gateway): Promise<boolean> {
    if (this.authMode(gateway) !== 'sso') return true;
    if (!this.orgLicense) return false;
    return this.orgLicense.hasForOrg(gateway.organizationId, 'sso');
  }

  /**
   * Attach a verified identity to a visitor. If this person has signed in
   * to this surface before, their earlier row (and its conversations) is
   * reused; otherwise the current anonymous row is upgraded in place. The
   * session key is rotated either way so the pre-sign-in cookie never
   * becomes the signed-in one (session fixation).
   */
  async bindAuthenticatedVisitor(
    gateway: Gateway,
    current: EndUser,
    identity: { provider: 'email_otp' | 'oauth' | 'sso'; externalId: string; email?: string | null; displayName?: string | null },
  ): Promise<{ endUser: EndUser; issuedSessionKey: string }> {
    const existing = await this.endUserRepository.findOne({
      where: { gatewayId: gateway.id, externalId: identity.externalId, authProvider: identity.provider },
    });
    const target = existing ?? current;
    target.authProvider = identity.provider;
    target.externalId = identity.externalId;
    if (identity.email !== undefined) target.email = identity.email ?? null;
    if (identity.displayName !== undefined) target.displayName = identity.displayName ?? null;
    target.sessionKey = HostedChatService.newSessionKey();
    target.lastSeenAt = new Date();
    const saved = await this.endUserRepository.save(target);
    if (existing && existing.id !== current.id) {
      // The anonymous row the visitor was using is now orphaned; drop it
      // so it cannot be resumed with the old cookie.
      await this.endUserRepository.delete({ id: current.id }).catch(() => undefined);
    }
    return { endUser: saved, issuedSessionKey: saved.sessionKey };
  }

  // ── Visitor self-service ─────────────────────────────────────────────
  //
  // A visitor owns what they said. These take the visitor resolved from
  // the cookie, never an id from the request, and scope every write
  // through that row so nothing of anyone else's can be touched.

  /** Remove one conversation, its messages, and the runs behind it. */
  async deleteConversation(endUser: EndUser, conversationId: string): Promise<void> {
    const conversation = await this.findConversation(endUser, conversationId);
    // Runs reference the conversation with SET NULL, so delete them first
    // or they outlive the transcript they belong to.
    await this.runRepository.delete({ conversationId: conversation.id, endUserId: endUser.id });
    await this.messageRepository.delete({ conversationId: conversation.id });
    await this.conversationRepository.delete({ id: conversation.id, endUserId: endUser.id });
  }

  /** Erase everything this surface holds about the visitor. The cookie dies with the row. */
  async deleteVisitor(gateway: Gateway, endUser: EndUser): Promise<void> {
    // agent_runs.endUserId has no foreign key; take them out explicitly.
    await this.runRepository.delete({ endUserId: endUser.id });
    // conversations (and their messages) cascade from the visitor row.
    await this.endUserRepository.delete({ id: endUser.id, gatewayId: gateway.id });
    this.audit(gateway, 'visitor.erased', { endUserId: endUser.id });
  }

  /** Everything this surface holds about the visitor, for them to keep. */
  async exportVisitor(gateway: Gateway, endUser: EndUser): Promise<Record<string, unknown>> {
    const conversations = await this.conversationRepository.find({
      where: { endUserId: endUser.id },
      order: { createdAt: 'ASC' },
      take: EXPORT_CONVERSATION_LIMIT,
    });

    // One query for every conversation's messages instead of one per
    // conversation. This was 1 + 500 queries to build a single export, on a
    // public endpoint.
    const byConversation = await this.messagesByConversation(
      conversations.map((c) => c.id),
    );

    const threads = conversations.map((c) => ({
      id: c.id,
      title: c.title,
      status: c.status,
      createdAt: c.createdAt,
      messages: (byConversation.get(c.id) ?? []).map((m) => ({
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
      })),
    }));
    return {
      exportedAt: new Date().toISOString(),
      app: hostedChatConfigFrom(gateway.configuration).appName,
      visitor: {
        id: endUser.id,
        email: endUser.email ?? null,
        displayName: endUser.displayName ?? null,
        signedInWith: endUser.authProvider ?? null,
        firstSeen: endUser.createdAt,
        lastSeen: endUser.lastSeenAt,
      },
      conversations: threads,
    };
  }

  /**
   * Public transcripts for several conversations at once.
   *
   * Same filtering `listMessages` applies — only user and assistant turns,
   * nothing marked internal — and the same per-conversation ceiling, applied
   * after grouping. The overall `take` is what keeps an export bounded in
   * heap regardless of how much the visitor has written.
   */
  private async messagesByConversation(
    conversationIds: string[],
  ): Promise<Map<string, Array<{ id: string; role: string; content: string; createdAt: Date }>>> {
    const grouped = new Map<string, Array<{ id: string; role: string; content: string; createdAt: Date }>>();
    if (!conversationIds.length) return grouped;

    const rows = await this.messageRepository.find({
      where: { conversationId: In(conversationIds) },
      order: { conversationId: 'ASC', createdAt: 'ASC' },
      take: EXPORT_MESSAGE_LIMIT,
    });

    for (const m of rows) {
      if (!this.isPublicTurn(m)) continue;
      const bucket = grouped.get(m.conversationId);
      if (bucket) {
        if (bucket.length < MESSAGE_PAGE_LIMIT) bucket.push(this.toTranscript(m));
      } else {
        grouped.set(m.conversationId, [this.toTranscript(m)]);
      }
    }
    return grouped;
  }

  /** Tool calls and system scaffolding stay out of a public transcript. */
  private isPublicTurn(m: Message): boolean {
    return (
      (m.role === MessageRole.USER || m.role === MessageRole.ASSISTANT) &&
      m.metadata?.internal !== true
    );
  }

  /** The shape a transcript turn is exposed as. */
  private toTranscript(m: Message): { id: string; role: string; content: string; createdAt: Date } {
    return {
      id: m.id,
      role: m.role,
      content: typeof m.getTextContent === 'function' ? m.getTextContent() : m.content,
      createdAt: m.createdAt,
    };
  }

  private audit(gateway: Gateway, action: string, details: Record<string, unknown>): void {
    this.logger.log(`[hosted-chat] ${action} gateway=${gateway.id} ${JSON.stringify(details)}`);
  }

  /** This visitor's conversations, newest first. */
  async listConversations(endUser: EndUser): Promise<Conversation[]> {
    return this.conversationRepository.find({
      where: { endUserId: endUser.id, status: ConversationStatus.ACTIVE },
      order: { createdAt: 'DESC' },
      take: 50,
    });
  }

  /**
   * Load one conversation, scoped to the visitor who owns it. Scoping in
   * the query rather than checking afterwards means a guessed id cannot
   * read someone else's thread even by accident.
   */
  async findConversation(endUser: EndUser, conversationId: string): Promise<Conversation> {
    const conversation = await this.conversationRepository.findOne({
      where: { id: conversationId, endUserId: endUser.id },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    return conversation;
  }

  async startConversation(gateway: Gateway, endUser: EndUser, title?: string): Promise<Conversation> {
    return this.conversationRepository.save(
      this.conversationRepository.create({
        organizationId: gateway.organizationId,
        gatewayId: gateway.id,
        agentId: gateway.agentId,
        endUserId: endUser.id,
        status: ConversationStatus.ACTIVE,
        title: (title || '').slice(0, 120) || 'New chat',
      }),
    );
  }

  /**
   * Whether a run belongs to this visitor.
   *
   * A run id is a UUID, but it still arrives from a caller on a public
   * endpoint. Confirming ownership through the conversation, rather than
   * trusting the id, is what stops one visitor streaming another's
   * reply by guessing or replaying.
   */
  async runBelongsToEndUser(runId: string, endUser: EndUser): Promise<boolean> {
    const run = await this.runRepository.findOne({ where: { id: runId } });
    if (!run?.conversationId) return false;
    const conversation = await this.conversationRepository.findOne({
      where: { id: run.conversationId, endUserId: endUser.id },
    });
    return !!conversation;
  }

  /**
   * Replay a conversation. Only the turns a person should see: tool
   * calls and system scaffolding stay out of a public transcript.
   */
  async listMessages(
    conversation: Conversation,
  ): Promise<Array<{ id: string; role: string; content: string; createdAt: Date }>> {
    const messages = await this.messageRepository.find({
      where: { conversationId: conversation.id },
      order: { createdAt: 'ASC' },
      take: MESSAGE_PAGE_LIMIT,
    });

    return messages.filter((m) => this.isPublicTurn(m)).map((m) => this.toTranscript(m));
  }

  /**
   * Resolve a surface by a customer-owned hostname (Tier 2).
   *
   * Only VERIFIED domains resolve. An unverified row exists so the
   * tenant can see the record they still need to publish, but serving
   * an agent under a hostname nobody proved they own is how you end up
   * hosting someone else's phishing page on your certificate.
   */
  async findByCustomDomain(hostname: string): Promise<Gateway | null> {
    const normalized = (hostname || '').trim().toLowerCase();
    if (!normalized) return null;

    const gateways = await this.gatewayRepository
      .createQueryBuilder('gateway')
      .where('gateway.type = :type', { type: GatewayType.HOSTED_CHAT })
      .andWhere("gateway.configuration -> 'customDomain' ->> 'hostname' = :hostname", {
        hostname: normalized,
      })
      .andWhere("gateway.configuration -> 'customDomain' ->> 'status' = :status", {
        status: 'active',
      })
      .getMany();

    // Private gateways are never public surfaces (refused at write time);
    // one that exists anyway is not served.
    const active = gateways.filter((gateway) => gateway.isActive() && !isPrivateGateway(gateway));

    // Same fail-closed rule as findBySlug. A hostname is a global public
    // address too, and nothing claims one exclusively: the only thing
    // keeping two tenants off the same name is the TXT verification each
    // has to pass. If both somehow did, serving an arbitrary one of them
    // puts a tenant's branding, agent and conversations under somebody
    // else's URL.
    if (active.length > 1) {
      this.logger.error(
        `Refusing ambiguous hosted-chat domain '${normalized}' claimed by gateways ${active
          .map((gateway) => gateway.id)
          .join(', ')}`,
      );
      return null;
    }

    return active[0] ?? null;
  }

  /**
   * Record that a tenant removed the Art. 50 disclosure.
   *
   * Publishing already refuses this without the white-label
   * entitlement, so reaching here means it was allowed. It is still
   * audited: a deployer who later has to show a regulator when their
   * disclosure stopped appearing needs a record with a date on it, and
   * "we checked an entitlement" is not that record.
   */
  async recordDisclosureRemoval(gateway: Gateway, userId: string | null): Promise<void> {
    try {
      await this.auditLogService?.log({
        organizationId: gateway.organizationId,
        userId: userId ?? undefined,
        action: AuditAction.UPDATE,
        resourceType: AuditResource.GATEWAY,
        resourceId: gateway.id,
        resourceName: gateway.name,
        details: {
          change: 'ai_disclosure_removed',
          surface: 'hosted_chat',
          article: 'EU AI Act Art. 50',
        },
      });
    } catch {
      // An audit write must not be why a save fails; the entitlement
      // check that permitted this already happened.
    }
  }
}
