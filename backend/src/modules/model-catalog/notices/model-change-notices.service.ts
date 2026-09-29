import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, MoreThan, Repository } from 'typeorm';

import { ModelChangeEvent } from '../../../entities/model-change-event.entity';
import { LlmProvider } from '../../../entities/llm-provider.entity';
import { Model } from '../../../entities/model.entity';
import { Agent } from '../../../entities/agent.entity';
import { AgentRole } from '../../../entities/agent-role.entity';
import { User } from '../../../entities/user.entity';
import { OrganizationRole, UserOrganization } from '../../../entities/user-organization.entity';
import { NotificationsService } from '../../notifications/notifications.service';
import { MailService } from '../../mail/mail.service';
import { AccessPolicyService } from '../../../common/authorization/access-policy.service';
import { isEffectiveMembership } from '../../../common/authorization/membership';
import { canRead } from '../../../common/authorization/read-rule';
import { collectModelReferences } from '../../agents/agent-references';
import { agentOwnerUserId } from '../../agents/agent-owner';
import { providerAllowsModel } from '../../llm-providers/allowed-models';
import { providerUsableByUser } from '../../llm-providers/private-provider';
import { GONE_REASONS, ModelChange, ModelChangeListener } from './model-change';

/**
 * A model that stops being usable is announced at most once a day per
 * connection and model. A provider that drops a model from its list and
 * lists it again (or refuses a key and takes it back) on every sync would
 * otherwise mail everyone on every sweep.
 */
export const UNAVAILABLE_NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How long the catalog marks a model "New". */
export const NEW_MODEL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Change rows kept this long after their email went out. */
export const MODEL_CHANGE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** How many model names a notice lists before "and N more". */
const LISTED = 8;

/** Why a model an agent names is not usable now, for the banner on the agent. */
export interface AgentModelIssueView {
  model: string;
  modelName: string;
  providerId: string;
  /** Null when the viewer may not see the connection. */
  connectionName: string | null;
  reason: string;
  /** Where in the agent it is named. */
  where: string[];
  since: string | null;
}

interface Person {
  id: string;
  email?: string | null;
  firstName?: string | null;
}

function frontendUrl(path: string): string {
  let base = process.env.FRONTEND_URL || 'https://app.staging.almyty.com';
  while (base.endsWith('/')) base = base.slice(0, -1);
  return `${base}${path}`;
}

function listNames(names: string[]): string {
  const shown = names.slice(0, LISTED);
  const more = names.length - shown.length;
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ');
}

/**
 * Tells people when models appear on a provider connection or stop being
 * usable.
 *
 * Who hears: the connection's owner and the organization's owners and
 * admins (the connection's owner only, when it is private), plus, for a
 * model that stopped being usable, the owner of every agent that names it.
 * Each person gets one message per change.
 *
 * When: in the app at once, always. By email at once for a model an agent
 * uses that stopped being usable; everything else (new models, and models
 * no agent uses) goes into one email a day (sendDigest). Each person turns
 * either email off in their own notification settings.
 */
@Injectable()
export class ModelChangeNoticesService implements ModelChangeListener {
  private readonly logger = new Logger(ModelChangeNoticesService.name);

  constructor(
    @InjectRepository(ModelChangeEvent) private readonly events: Repository<ModelChangeEvent>,
    @InjectRepository(LlmProvider) private readonly providers: Repository<LlmProvider>,
    @InjectRepository(Model) private readonly models: Repository<Model>,
    @InjectRepository(Agent) private readonly agents: Repository<Agent>,
    @InjectRepository(AgentRole) private readonly agentRoles: Repository<AgentRole>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(UserOrganization) private readonly memberships: Repository<UserOrganization>,
    private readonly dataSource: DataSource,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly mail?: MailService,
    @Optional() private readonly accessPolicy?: AccessPolicyService,
  ) {}

  // ── Recording a change ───────────────────────────────────────────

  async modelsChanged(change: ModelChange): Promise<void> {
    try {
      if (change.appeared.length === 0 && change.gone.length === 0) return;
      const provider = await this.providers.findOne({ where: { id: change.providerId, organizationId: change.organizationId } });
      if (!provider) return;
      // A model the connection does not allow is not new to anyone using it.
      const appeared = change.appeared.filter((card) => providerAllowsModel(provider, card.vendorModelId));
      const { added, gone } = await this.recordRows(provider, appeared, change.gone);
      if (added.length > 0) await this.announceNew(provider, added);
      if (gone.length > 0) await this.announceGone(provider, gone);
    } catch (err: any) {
      this.logger.warn(`model change notice for connection ${change.providerId} failed: ${err?.message ?? err}`);
    }
  }

  /**
   * Write the rows, skipping what was already said: a model is new once
   * per connection, and unavailable at most once a day. Serialized per
   * connection, so two syncs of one connection never both write a row.
   */
  private async recordRows(
    provider: LlmProvider,
    appeared: Model[],
    gone: Array<{ card: Model; reason: string }>,
  ): Promise<{ added: ModelChangeEvent[]; gone: ModelChangeEvent[] }> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`model-change:${provider.id}`]);
      const repo = manager.getRepository(ModelChangeEvent);
      const base = { organizationId: provider.organizationId, providerId: provider.id };
      const added: ModelChangeEvent[] = [];
      if (appeared.length > 0) {
        const known = await repo.find({ where: { ...base, kind: 'new', vendorModelId: In(appeared.map((c) => c.vendorModelId)) }, select: { vendorModelId: true } });
        const said = new Set(known.map((e) => e.vendorModelId));
        for (const card of appeared) {
          if (said.has(card.vendorModelId)) continue;
          said.add(card.vendorModelId);
          added.push(await repo.save(repo.create({ ...base, providerName: provider.name, modelId: card.id, vendorModelId: card.vendorModelId, modelName: card.name || card.vendorModelId, kind: 'new', reason: null, agentIds: [] })));
        }
      }
      const goneRows: ModelChangeEvent[] = [];
      if (gone.length > 0) {
        const since = new Date(Date.now() - UNAVAILABLE_NOTICE_WINDOW_MS);
        const recent = await repo.find({ where: { ...base, kind: 'unavailable', vendorModelId: In(gone.map((g) => g.card.vendorModelId)), createdAt: MoreThan(since) }, select: { vendorModelId: true } });
        const said = new Set(recent.map((e) => e.vendorModelId));
        const using = await this.agentsUsing(provider.organizationId, provider.id, gone.map((g) => g.card));
        for (const { card, reason } of gone) {
          if (said.has(card.vendorModelId)) continue;
          said.add(card.vendorModelId);
          goneRows.push(await repo.save(repo.create({ ...base, providerName: provider.name, modelId: card.id, vendorModelId: card.vendorModelId, modelName: card.name || card.vendorModelId, kind: 'unavailable', reason, agentIds: using.get(card.vendorModelId) ?? [] })));
        }
      }
      return { added, gone: goneRows };
    });
  }

  /** For each vendor model id, the agents of the org that name it on this connection. */
  private async agentsUsing(organizationId: string, providerId: string, cards: Model[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (cards.length === 0) return out;
    const wanted = new Set(cards.map((c) => c.vendorModelId));
    const add = (vendorModelId: string, agentId: string) => {
      const list = out.get(vendorModelId) ?? [];
      if (!list.includes(agentId)) list.push(agentId);
      out.set(vendorModelId, list);
    };
    const agents = await this.agents.find({
      where: { organizationId, isTemporary: false },
      select: { id: true, modelConfig: true, pipeline: true, agentConfig: true, collaboration: true, models: true },
    });
    for (const agent of agents) {
      for (const ref of collectModelReferences(agent)) {
        if (ref.providerId === providerId && wanted.has(ref.model)) add(ref.model, agent.id);
      }
    }
    // Roles bound to a model card (agent_roles).
    const cardIds = new Map(cards.map((c) => [c.id, c.vendorModelId]));
    const roles = await this.agentRoles.find({ where: { organizationId } });
    for (const role of roles) {
      const binding = role.binding as { mode?: string; modelId?: string } | null | undefined;
      const vendorModelId = binding?.mode === 'pinned' && binding.modelId ? cardIds.get(binding.modelId) : undefined;
      if (vendorModelId) add(vendorModelId, role.agentId);
    }
    return out;
  }

  // ── In the app, and the immediate email ─────────────────────────

  private async announceNew(provider: LlmProvider, rows: ModelChangeEvent[]): Promise<void> {
    const audience = await this.connectionAudience(provider);
    if (audience.length === 0 || !this.notifications) return;
    const names = rows.map((r) => r.modelName);
    await this.notifications.emit({
      type: 'models.new',
      organizationId: provider.organizationId,
      userIds: audience,
      title: rows.length === 1 ? `New model on ${provider.name}: ${names[0]}` : `${rows.length} new models on ${provider.name}`,
      body: `${listNames(names)}. ${rows.length === 1 ? 'It shows' : 'They show'} up in every model chooser.`,
      link: `/models?connection=${provider.id}&show=new`,
    });
  }

  private async announceGone(provider: LlmProvider, rows: ModelChangeEvent[]): Promise<void> {
    const audience = new Set(await this.connectionAudience(provider));
    const agentIds = [...new Set(rows.flatMap((r) => r.agentIds))];
    const agents = agentIds.length
      ? await this.agents.find({ where: { id: In(agentIds), organizationId: provider.organizationId }, select: { id: true, name: true, createdBy: true, visibility: true } })
      : [];
    const ownerOf = new Map(agents.map((a) => [a.id, agentOwnerUserId(a)]));
    const recipients = new Set(audience);
    for (const owner of ownerOf.values()) if (owner) recipients.add(owner);
    const current = await this.currentMembers(provider.organizationId, [...recipients]);

    const used = rows.filter((r) => r.agentIds.length > 0);
    const emailNow = used.length > 0 ? new Set(await this.withEmailOn('models.unavailable', [...current])) : new Set<string>();
    const people = emailNow.size > 0 ? await this.people([...emailNow]) : new Map<string, Person>();

    for (const userId of current) {
      // An agent is named only to its owner; everyone else hears how many.
      const mine = agents.filter((a) => ownerOf.get(a.id) === userId);
      const others = agents.filter((a) => ownerOf.get(a.id) !== userId && a.visibility !== 'private').length;
      const title = rows.length === 1 ? `${rows[0].modelName} is no longer available from ${provider.name}` : `${rows.length} models are no longer available from ${provider.name}`;
      const it = rows.length === 1 ? 'it' : 'them';
      const agentLine = [
        mine.length === 1 ? `Your agent ${mine[0].name} uses ${it}. Pick another model for it.` : '',
        mine.length > 1 ? `Your agents that use ${it}: ${mine.map((a) => a.name).join(', ')}. Pick another model for each.` : '',
        others ? `${others === 1 ? '1 other agent uses' : `${others} other agents use`} ${it}.` : '',
      ].filter(Boolean).join(' ');
      const reasons = [...new Set(rows.map((r) => r.reason).filter(Boolean))].join(' ');
      const body = [rows.length > 1 ? `${listNames(rows.map((r) => r.modelName))}.` : '', reasons, agentLine].filter(Boolean).join(' ');
      const link = mine.length === 1 ? `/agents/${mine[0].id}` : `/models?connection=${provider.id}&status=unavailable`;
      await this.notifications?.emit({ type: 'models.unavailable', organizationId: provider.organizationId, userIds: [userId], title, body, link });

      const person = people.get(userId);
      if (used.length > 0 && person?.email && this.mail) {
        void this.mail
          .sendTemplate(person.email, 'models.unavailable', {
            firstName: person.firstName,
            connectionName: provider.name,
            models: used.map((r) => ({ name: r.modelName, reason: r.reason })),
            yourAgents: mine.map((a) => ({ name: a.name, url: frontendUrl(`/agents/${a.id}`) })),
            otherAgents: others,
            url: frontendUrl(link),
          })
          .catch((err) => this.logger.warn(`model unavailable email failed: ${err?.message ?? err}`));
      }
    }
    // The used ones are mailed now; the rest wait for the digest.
    if (used.length > 0) {
      const now = new Date();
      await this.events.update({ id: In(used.map((r) => r.id)) }, { notifiedAt: now, digestedAt: now });
    }
  }

  // ── The daily digest ─────────────────────────────────────────────

  /**
   * One email per person with what changed since the last digest: the new
   * models, and the models no agent used that stopped being usable. Rows
   * are claimed with a skip-locked update, so two instances running it at
   * once never mail the same row twice. Old rows are pruned here too.
   */
  async sendDigest(now = new Date()): Promise<{ rows: number; emails: number }> {
    const claimed: ModelChangeEvent[] = await this.dataSource.query(
      `UPDATE "model_change_events" SET "digestedAt" = $1
        WHERE "id" IN (
          SELECT "id" FROM "model_change_events"
           WHERE "digestedAt" IS NULL AND "createdAt" <= $1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING *`,
      [now],
    ).then((result: any) => (Array.isArray(result?.[0]) ? result[0] : result) as ModelChangeEvent[]);
    let emails = 0;
    const byOrg = new Map<string, ModelChangeEvent[]>();
    for (const row of claimed) byOrg.set(row.organizationId, [...(byOrg.get(row.organizationId) ?? []), row]);
    for (const [organizationId, rows] of byOrg) {
      try {
        emails += await this.digestForOrg(organizationId, rows);
      } catch (err: any) {
        this.logger.warn(`model digest for org ${organizationId} failed: ${err?.message ?? err}`);
      }
    }
    await this.events
      .createQueryBuilder()
      .delete()
      .where('"digestedAt" IS NOT NULL AND "createdAt" < :cutoff', { cutoff: new Date(now.getTime() - MODEL_CHANGE_RETENTION_MS) })
      .execute()
      .catch((err) => this.logger.warn(`model change prune failed: ${err?.message ?? err}`));
    return { rows: claimed.length, emails };
  }

  private async digestForOrg(organizationId: string, rows: ModelChangeEvent[]): Promise<number> {
    if (!this.mail) return 0;
    const providerIds = [...new Set(rows.map((r) => r.providerId))];
    const providers = await this.providers.find({ where: { organizationId, id: In(providerIds) } });
    const perUser = new Map<string, { fresh: Array<{ connection: string; names: string[] }>; gone: Array<{ connection: string; names: string[]; reasons: string[] }> }>();
    for (const provider of providers) {
      const mine = rows.filter((r) => r.providerId === provider.id);
      // A new model the connection hides by now is not news any more.
      const fresh = mine.filter((r) => r.kind === 'new' && providerAllowsModel(provider, r.vendorModelId)).map((r) => r.modelName);
      const gone = mine.filter((r) => r.kind === 'unavailable');
      const audience = await this.connectionAudience(provider);
      const freshTo = fresh.length ? await this.withEmailOn('models.new', audience) : [];
      const goneTo = gone.length ? await this.withEmailOn('models.unavailable', audience) : [];
      for (const userId of new Set([...freshTo, ...goneTo])) {
        const entry = perUser.get(userId) ?? { fresh: [], gone: [] };
        if (freshTo.includes(userId)) entry.fresh.push({ connection: provider.name, names: fresh });
        if (goneTo.includes(userId)) entry.gone.push({ connection: provider.name, names: gone.map((r) => r.modelName), reasons: [...new Set(gone.map((r) => r.reason ?? '').filter(Boolean))] });
        perUser.set(userId, entry);
      }
    }
    const people = await this.people([...perUser.keys()]);
    let sent = 0;
    for (const [userId, entry] of perUser) {
      const person = people.get(userId);
      if (!person?.email) continue;
      sent++;
      void this.mail
        .sendTemplate(person.email, 'models.digest', {
          firstName: person.firstName,
          fresh: entry.fresh.map((e) => ({ connection: e.connection, models: listNames(e.names), count: e.names.length })),
          gone: entry.gone.map((e) => ({ connection: e.connection, models: listNames(e.names), count: e.names.length, reason: e.reasons.join(' ') })),
          url: frontendUrl('/models'),
        })
        .catch((err) => this.logger.warn(`model digest email failed: ${err?.message ?? err}`));
    }
    return sent;
  }

  // ── What the pages read ──────────────────────────────────────────

  /** Card ids that appeared on their connection within the last week, for the catalog's "New". */
  async recentlyNew(organizationId: string, now = Date.now()): Promise<Set<string>> {
    const rows = await this.events.find({
      where: { organizationId, kind: 'new', createdAt: MoreThan(new Date(now - NEW_MODEL_WINDOW_MS)) },
      select: { modelId: true },
    });
    return new Set(rows.map((r) => r.modelId).filter((id): id is string => !!id));
  }

  /**
   * The models an agent names that are not usable now, with why: the
   * banner on the agent reads this. Worked out from the cards as they are,
   * not from the change rows, so it is right however the model stopped
   * being usable and clears itself once it is usable again.
   */
  async agentModelIssues(organizationId: string, agentId: string, viewerId: string): Promise<AgentModelIssueView[]> {
    const agent = await this.agents.findOne({ where: { id: agentId, organizationId } });
    if (!agent || !(this.accessPolicy ? await canRead(this.accessPolicy, { id: viewerId }, agent) : (agent.visibility ?? 'org') === 'org')) {
      throw new NotFoundException('Agent not found');
    }
    const refs = collectModelReferences(agent);
    const roles = await this.agentRoles.find({ where: { organizationId, agentId } });
    const pinnedCardIds = roles
      .map((r) => r.binding as { mode?: string; modelId?: string } | null)
      .filter((b): b is { mode: string; modelId: string } => b?.mode === 'pinned' && !!b.modelId)
      .map((b) => b.modelId);
    const pinnedCards = pinnedCardIds.length ? await this.models.find({ where: { organizationId, id: In(pinnedCardIds) } }) : [];
    for (const card of pinnedCards) if (card.providerId) refs.push({ providerId: card.providerId, model: card.vendorModelId, where: 'role' });
    if (refs.length === 0) return [];

    const providerIds = [...new Set(refs.map((r) => r.providerId))];
    const providers = new Map((await this.providers.find({ where: { organizationId, id: In(providerIds) } })).map((p) => [p.id, p]));
    const cards = await this.models.find({ where: { organizationId, providerId: In(providerIds) } });
    const cardOf = (providerId: string, model: string) => cards.find((c) => c.providerId === providerId && c.vendorModelId === model);

    const issues = new Map<string, AgentModelIssueView>();
    for (const ref of refs) {
      const key = `${ref.providerId}::${ref.model}`;
      const existing = issues.get(key);
      if (existing) {
        if (!existing.where.includes(ref.where)) existing.where.push(ref.where);
        continue;
      }
      const provider = providers.get(ref.providerId);
      const card = cardOf(ref.providerId, ref.model);
      const reason = this.unusableReason(provider, card, ref.model);
      if (!reason) continue;
      const visible = provider ? await providerUsableByUser(this.accessPolicy, provider, viewerId) : false;
      issues.set(key, {
        model: ref.model,
        modelName: card?.name || ref.model,
        providerId: ref.providerId,
        connectionName: visible ? provider!.name : null,
        reason,
        where: [ref.where],
        since: card?.lastValidatedAt?.toISOString?.() ?? (card?.metadata?.retiredAt as string | undefined) ?? null,
      });
    }
    return [...issues.values()];
  }

  /** Why this model cannot be used through this connection now, or null when it can. */
  private unusableReason(provider: LlmProvider | undefined, card: Model | undefined, model: string): string | null {
    if (!provider) return 'Its connection was removed.';
    if (!providerAllowsModel(provider, model)) return 'It is turned off on the connection.';
    // A model the catalog has no card for is one the vendor serves without
    // listing (your own server, a provider with no list): nothing to judge.
    if (!card) return null;
    if (card.status === 'inactive') return card.metadata?.retiredAt ? GONE_REASONS.notListed : 'It is switched off in the catalog.';
    if (card.validationStatus === 'failed') return GONE_REASONS.modelNotFound;
    if (card.validationStatus === 'never' && card.lastValidationError) return GONE_REASONS.keyRejected;
    return null;
  }

  // ── Who ──────────────────────────────────────────────────────────

  /**
   * The connection's owner and the organization's owners and admins; the
   * owner alone for a private connection, whose existence is nobody
   * else's business (resource-audience.ts applies the same rule).
   */
  private async connectionAudience(provider: LlmProvider): Promise<string[]> {
    if (provider.visibility === 'private') return provider.ownerUserId ? await this.currentMembers(provider.organizationId, [provider.ownerUserId]) : [];
    const admins = await this.memberships.find({
      where: { organizationId: provider.organizationId, role: In([OrganizationRole.OWNER, OrganizationRole.ADMIN]), isActive: true },
      select: { userId: true, isActive: true, inviteAccepted: true, inviteToken: true },
    });
    const ids = new Set(admins.filter((m) => isEffectiveMembership(m)).map((m) => m.userId));
    if (provider.ownerUserId) ids.add(provider.ownerUserId);
    return this.currentMembers(provider.organizationId, [...ids]);
  }

  /** The ones of `userIds` who are members of the organization now. */
  private async currentMembers(organizationId: string, userIds: string[]): Promise<string[]> {
    if (userIds.length === 0) return [];
    const rows = await this.memberships.find({
      where: { organizationId, userId: In(userIds), isActive: true },
      select: { userId: true, isActive: true, inviteAccepted: true, inviteToken: true },
    });
    const current = new Set(rows.filter((m) => isEffectiveMembership(m)).map((m) => m.userId));
    return userIds.filter((id, i) => current.has(id) && userIds.indexOf(id) === i);
  }

  private async withEmailOn(type: 'models.new' | 'models.unavailable', userIds: string[]): Promise<string[]> {
    if (!this.notifications) return [];
    return this.notifications.filterUsersWithEmailEnabled(type, userIds);
  }

  private async people(userIds: string[]): Promise<Map<string, Person>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.users.find({ where: { id: In(userIds) }, select: { id: true, email: true, firstName: true } });
    return new Map(rows.map((u) => [u.id, u]));
  }
}
