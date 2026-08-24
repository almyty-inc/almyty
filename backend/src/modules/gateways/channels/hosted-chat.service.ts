import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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

/**
 * The tenant-facing half of the hosted chat app.
 *
 * Everything here runs for an anonymous member of the public, so the
 * rules are stricter than anywhere else in the codebase: resolve a
 * surface only by its public slug, hand back only presentation fields,
 * and never let a caller name a conversation or an end user they do not
 * already hold the cookie for.
 */
@Injectable()
export class HostedChatService {
  /** Cookie holding the per-surface session key. */
  static readonly SESSION_COOKIE = 'almyty_chat_session';

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

    // configuration is jsonb; match the slug inside the hostedChat block.
    const gateway = await this.gatewayRepository
      .createQueryBuilder('gateway')
      .where('gateway.type = :type', { type: GatewayType.HOSTED_CHAT })
      .andWhere("gateway.configuration -> 'hostedChat' ->> 'slug' = :slug", { slug: normalized })
      .getOne();

    if (!gateway || !gateway.isActive()) throw new NotFoundException('Chat app not found');
    return gateway;
  }

  /**
   * Presentation fields only.
   *
   * The gateway's `configuration` jsonb also holds channel credentials,
   * so this is a strict whitelist rather than a redaction pass: a new
   * secret added to that blob must not become publicly readable by
   * default. Same discipline as sanitizeWidgetConfig.
   */
  publicBranding(gateway: Gateway): Record<string, any> {
    const config: HostedChatConfig = hostedChatConfigFrom(gateway.configuration);
    return {
      appName: config.appName,
      primaryColor: config.primaryColor,
      greeting: config.greeting,
      theme: config.theme,
      logoUrl: config.logoUrl,
      suggestedPrompts: config.suggestedPrompts,
      authMode: config.authMode,
      whiteLabel: config.whiteLabel,
      // Null means "use the default line". An empty string is a
      // deliberate removal, which publishing already gated on the
      // white-label entitlement.
      aiDisclosure: config.aiDisclosure,
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
      take: 500,
    });

    return messages
      .filter((m) => m.role === MessageRole.USER || m.role === MessageRole.ASSISTANT)
      .map((m) => ({
        id: m.id,
        role: m.role,
        content: typeof m.getTextContent === 'function' ? m.getTextContent() : m.content,
        createdAt: m.createdAt,
      }));
  }
}
