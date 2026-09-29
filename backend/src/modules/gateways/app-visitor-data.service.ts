import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, EntityManager, In, Repository, SelectQueryBuilder } from 'typeorm';

import { AgentRun } from '../../entities/agent-run.entity';
import { ChannelEvent } from '../../entities/channel-event.entity';
import { Conversation } from '../../entities/conversation.entity';
import { EndUser } from '../../entities/end-user.entity';
import { AgentFile } from '../../entities/file.entity';
import type { Gateway } from '../../entities/gateway.entity';
import { Message } from '../../entities/message.entity';
import { StorageService } from '../files/storage.service';
import { TranscriptTurn, groupTranscripts } from './visitor-transcript';

/** Which kind of place a person reached the app through; decides what identifies them. */
export type VisitorPlaceKind = 'web' | 'widget' | 'channel' | 'a2a';

/** A place of an app, as far as finding a person on it goes. */
export type VisitorPlace = Pick<Gateway, 'id' | 'organizationId'>;

/**
 * Everything one person left on an app's place, as row ids.
 *
 * Every id was found under one organization and the place's gateway, so
 * erasing a footprint cannot reach a row outside them: the runs, the
 * conversations behind them, the web-chat visitor rows, and the widget
 * threads whose stored replies are found by thread as well as by run.
 */
export interface VisitorFootprint {
  organizationId: string;
  gatewayIds: string[];
  endUserIds: string[];
  runIds: string[];
  conversationIds: string[];
  widgetThreads: Array<{ gatewayId: string; threadId: string }>;
}

/** What is held for a person, in counts and dates. No content. */
export interface VisitorDataSummary {
  found: boolean;
  conversations: number;
  messages: number;
  firstAt: string | null;
  lastAt: string | null;
  memories: number;
  storedReplies: number;
  files: number;
  runs: number;
  /** The most recent conversations, newest first, as counts and dates. */
  recent: Array<{ id: string; title: string | null; messages: number; firstAt: string | null; lastAt: string | null }>;
}

/** What an erasure removed, per kind of row. */
export interface VisitorErasure {
  conversations: number;
  messages: number;
  runs: number;
  memories: number;
  storedReplies: number;
  files: number;
  visitors: number;
}

/** Ceiling on the runs one footprint collects, child runs included. */
const FOOTPRINT_RUN_LIMIT = 5_000;
/** How deep child runs are followed: the runtime's own hard ceiling on nesting. */
const CHILD_RUN_DEPTH = 10;
/** Rows of one kind an export loads, like the visitor's own download. */
const EXPORT_ROW_LIMIT = 25_000;
/** Conversations listed in a summary. */
const SUMMARY_RECENT = 20;

/** Channels whose sender id is a phone number, matched on its digits. */
const PHONE_TARGETS = new Set(['sms', 'whatsapp', 'whatsapp_cloud', 'signal']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A uuid nothing has, for an IN list that must match nothing. */
const NONE = '00000000-0000-0000-0000-000000000000';

/**
 * An A2A caller as the operator may know them: the stamped form
 * (`key:<id>`, `oauth:<client>`, `jwt:<sub>`, `user:<id>`) or the bare id.
 */
export function a2aCallerCandidates(value: string): string[] {
  const v = (value || '').trim();
  if (!v) return [];
  if (/^(key|oauth|jwt|user):./.test(v)) return [v];
  return ['key', 'oauth', 'jwt', 'user'].map((prefix) => `${prefix}:${v}`);
}

/** An empty footprint on a place: nothing found. */
export function emptyFootprint(place: VisitorPlace): VisitorFootprint {
  return {
    organizationId: place.organizationId,
    gatewayIds: [place.id],
    endUserIds: [],
    runIds: [],
    conversationIds: [],
    widgetThreads: [],
  };
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * What almyty holds about one person on an app's place, and removing it.
 *
 * One scope for every way a person's data is reached: the web chat's own
 * "delete my data", the widget's, and an owner answering a data request
 * for someone on a messaging channel or A2A. Each finds the person its own
 * way (a visitor row, a widget thread, a channel sender id, an A2A
 * credential) and gets a footprint; the footprint is read, exported and
 * erased here, so the self-service and operator paths cannot drift apart
 * on what "everything" means.
 *
 * In scope: the runs filed under the person on the place and the child
 * runs they started, the conversations and messages behind them, the
 * memories those runs wrote, the files they produced, the stored widget
 * replies and channel deliveries, and the web-chat visitor rows.
 */
@Injectable()
export class AppVisitorDataService {
  private readonly logger = new Logger(AppVisitorDataService.name);

  constructor(
    @InjectRepository(AgentRun)
    private readonly runRepository: Repository<AgentRun>,
    // Removes the stored object behind a file row. Optional only so
    // positional unit specs can build this; Nest always injects it
    // (app-visitor-data.guard.spec.ts).
    @Optional() private readonly storage?: StorageService,
  ) {}

  private get manager(): EntityManager {
    return this.runRepository.manager;
  }

  // -- Finding a person ----------------------------------------------------

  /** Web-chat visitor rows on this place matching an email, a visitor id or a sign-in id. */
  async findWebVisitors(place: VisitorPlace, identifier: string): Promise<string[]> {
    const value = (identifier || '').trim();
    if (!value) return [];
    const rows = await this.manager
      .getRepository(EndUser)
      .createQueryBuilder('eu')
      .select('eu.id', 'id')
      .where('eu.gatewayId = :gatewayId', { gatewayId: place.id })
      .andWhere('eu.organizationId = :organizationId', { organizationId: place.organizationId })
      .andWhere(
        new Brackets((w) => {
          w.where('lower(eu.email) = :email', { email: value.toLowerCase() }).orWhere('eu.externalId = :value', { value });
          if (UUID.test(value)) w.orWhere('eu.id = :id', { id: value });
        }),
      )
      .getRawMany<{ id: string }>();
    return rows.map((r) => r.id);
  }

  /** Web-chat visitors' footprint on their place. */
  async forWebVisitors(place: VisitorPlace, endUserIds: string[]): Promise<VisitorFootprint> {
    const users = endUserIds.length
      ? await this.manager.getRepository(EndUser).find({
          where: { id: In(endUserIds), gatewayId: place.id, organizationId: place.organizationId },
          select: { id: true },
        })
      : [];
    const ids = users.map((u) => u.id);
    if (!ids.length) return emptyFootprint(place);
    const runs = await this.runsWhere(place.organizationId, (qb) => qb.andWhere('run.endUserId IN (:...ids)', { ids }));
    const conversations = await this.manager.getRepository(Conversation).find({
      where: { endUserId: In(ids), organizationId: place.organizationId },
      select: { id: true },
    });
    return this.complete(place, runs, { endUserIds: ids, conversationIds: conversations.map((c) => c.id) });
  }

  /** A widget visitor is their thread: every run filed under the place with that thread id. */
  async forWidgetThread(place: VisitorPlace, threadId: string): Promise<VisitorFootprint> {
    const value = (threadId || '').trim();
    if (!value) return emptyFootprint(place);
    const runs = await this.runsWhere(place.organizationId, (qb) =>
      qb
        .andWhere("run.metadata->>'gatewayId' = :gatewayId", { gatewayId: place.id })
        .andWhere("run.metadata->>'threadId' = :threadId", { threadId: value }),
    );
    return this.complete(place, runs, { widgetThreads: [{ gatewayId: place.id, threadId: value }] });
  }

  /**
   * A messaging-channel sender: the platform's id for them, as the channel
   * adapter recorded it on the run. Phone-number channels match on the
   * digits ("+1 415 555 0100" finds "whatsapp:+14155550100"); email matches
   * the address inside a "Name <address>" sender too.
   */
  async forChannelSender(place: VisitorPlace, target: string, senderId: string): Promise<VisitorFootprint> {
    const value = (senderId || '').trim();
    if (!value) return emptyFootprint(place);
    const digits = value.replace(/\D/g, '');
    const address = value.toLowerCase();
    const runs = await this.runsWhere(place.organizationId, (qb) =>
      qb.andWhere("run.metadata->>'gatewayId' = :gatewayId", { gatewayId: place.id }).andWhere(
        new Brackets((w) => {
          w.where("run.metadata->>'channelUserId' = :sender", { sender: value });
          if (PHONE_TARGETS.has(target) && digits.length >= 5) {
            w.orWhere("regexp_replace(run.metadata->>'channelUserId', '[^0-9]', '', 'g') = :digits", { digits });
          }
          if (target === 'email') {
            w.orWhere("lower(run.metadata->>'channelUserId') = :address", { address }).orWhere(
              "position(:bracketed in lower(run.metadata->>'channelUserId')) > 0",
              { bracketed: `<${address}>` },
            );
          }
        }),
      ),
    );
    return this.complete(place, runs);
  }

  /** An A2A caller: the credential the app's A2A place stamped on each run it started for them. */
  async forA2ACaller(place: VisitorPlace, callerId: string): Promise<VisitorFootprint> {
    const callers = a2aCallerCandidates(callerId);
    if (!callers.length) return emptyFootprint(place);
    const runs = await this.runsWhere(place.organizationId, (qb) =>
      qb
        .andWhere("run.metadata->>'gatewayId' = :gatewayId", { gatewayId: place.id })
        .andWhere("run.metadata->>'a2aCaller' IN (:...callers)", { callers }),
    );
    return this.complete(place, runs);
  }

  private runsWhere(
    organizationId: string,
    scope: (qb: SelectQueryBuilder<AgentRun>) => SelectQueryBuilder<AgentRun>,
  ): Promise<Array<Pick<AgentRun, 'id' | 'conversationId'>>> {
    const qb = this.runRepository
      .createQueryBuilder('run')
      .select(['run.id', 'run.conversationId'])
      .where('run.organizationId = :organizationId', { organizationId });
    return scope(qb).orderBy('run.createdAt', 'ASC').limit(FOOTPRINT_RUN_LIMIT).getMany();
  }

  /** The runs found, the child runs they started, and the conversations behind all of them. */
  private async complete(
    place: VisitorPlace,
    runs: Array<Pick<AgentRun, 'id' | 'conversationId'>>,
    extra: Partial<Pick<VisitorFootprint, 'endUserIds' | 'conversationIds' | 'widgetThreads'>> = {},
  ): Promise<VisitorFootprint> {
    const all = new Map(runs.map((r) => [r.id, r]));
    let frontier = runs.map((r) => r.id);
    for (let depth = 0; depth < CHILD_RUN_DEPTH && frontier.length && all.size < FOOTPRINT_RUN_LIMIT; depth++) {
      const children = await this.runRepository.find({
        where: { parentRunId: In(frontier), organizationId: place.organizationId },
        select: { id: true, conversationId: true },
        take: FOOTPRINT_RUN_LIMIT,
      });
      frontier = children.filter((c) => !all.has(c.id)).map((c) => c.id);
      for (const child of children) all.set(child.id, child);
    }
    const conversationIds = new Set(extra.conversationIds ?? []);
    for (const r of all.values()) if (r.conversationId) conversationIds.add(r.conversationId);
    return {
      ...emptyFootprint(place),
      endUserIds: extra.endUserIds ?? [],
      runIds: [...all.keys()],
      conversationIds: [...conversationIds],
      widgetThreads: extra.widgetThreads ?? [],
    };
  }

  // -- Reading -------------------------------------------------------------

  /** What is held, in counts and dates. */
  async summarize(footprint: VisitorFootprint): Promise<VisitorDataSummary> {
    const [perConversation, memories, storedReplies, files, conversations] = await Promise.all([
      this.messageStats(footprint),
      this.countMemories(footprint),
      this.storedRepliesQuery(footprint).getCount(),
      this.filesOf(footprint).then((f) => f.length),
      footprint.conversationIds.length
        ? this.manager.getRepository(Conversation).find({
            where: { id: In(footprint.conversationIds), organizationId: footprint.organizationId },
            select: { id: true, title: true, createdAt: true },
          })
        : Promise.resolve([] as Conversation[]),
    ]);
    const byId = new Map(perConversation.map((c) => [c.conversationId, c]));
    const recent = conversations
      .map((c) => {
        const stats = byId.get(c.id);
        return {
          id: c.id,
          title: c.title ?? null,
          messages: stats?.messages ?? 0,
          firstAt: stats?.firstAt ?? toIso(c.createdAt),
          lastAt: stats?.lastAt ?? toIso(c.createdAt),
        };
      })
      .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
    const dates = recent.flatMap((c) => [c.firstAt, c.lastAt]).filter((d): d is string => !!d).sort();
    const found =
      footprint.runIds.length + conversations.length + footprint.endUserIds.length + memories + storedReplies + files > 0;
    return {
      found,
      conversations: conversations.length,
      messages: recent.reduce((n, c) => n + c.messages, 0),
      firstAt: dates[0] ?? null,
      lastAt: dates[dates.length - 1] ?? null,
      memories,
      storedReplies,
      files,
      runs: footprint.runIds.length,
      recent: recent.slice(0, SUMMARY_RECENT),
    };
  }

  /** Public transcripts of several conversations, in one query. */
  async transcripts(conversationIds: string[]): Promise<Map<string, TranscriptTurn[]>> {
    if (!conversationIds.length) return new Map();
    const rows = await this.manager.getRepository(Message).find({
      where: { conversationId: In(conversationIds) },
      order: { conversationId: 'ASC', createdAt: 'ASC' },
      take: EXPORT_ROW_LIMIT,
    });
    return groupTranscripts(rows);
  }

  /** Everything held, for the person to keep. */
  async export(footprint: VisitorFootprint): Promise<Record<string, unknown>> {
    const conversations = footprint.conversationIds.length
      ? await this.manager.getRepository(Conversation).find({
          where: { id: In(footprint.conversationIds), organizationId: footprint.organizationId },
          order: { createdAt: 'ASC' },
        })
      : [];
    const [byConversation, memories, replies, files, runs] = await Promise.all([
      this.transcripts(conversations.map((c) => c.id)),
      this.memoriesOf(footprint),
      this.storedRepliesQuery(footprint).orderBy('event.createdAt', 'ASC').limit(EXPORT_ROW_LIMIT).getMany(),
      this.filesOf(footprint),
      footprint.runIds.length
        ? this.runRepository.find({
            where: { id: In(footprint.runIds), organizationId: footprint.organizationId },
            select: { id: true, status: true, createdAt: true, updatedAt: true },
            order: { createdAt: 'ASC' },
          })
        : Promise.resolve([] as AgentRun[]),
    ]);
    return {
      exportedAt: new Date().toISOString(),
      conversations: conversations.map((c) => ({
        id: c.id,
        title: c.title ?? null,
        startedAt: c.createdAt,
        messages: (byConversation.get(c.id) ?? []).map(({ role, content, createdAt }) => ({ role, content, createdAt })),
      })),
      memories: memories.map((m) => ({ id: m.id, content: m.content, createdAt: m.created_at })),
      // What was said to the person. An inbound delivery's raw platform
      // body also carries the operator's workspace and bot ids, so it is
      // listed by date, not reproduced.
      storedReplies: replies.map((e) => ({
        createdAt: e.createdAt,
        direction: e.direction,
        ...(e.direction === 'outbound' && typeof e.payload?.message === 'string' ? { message: e.payload.message } : {}),
      })),
      files: files.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, size: f.size, createdAt: f.createdAt })),
      runs: runs.map((r) => ({ id: r.id, status: r.status, startedAt: r.createdAt, lastActiveAt: r.updatedAt })),
    };
  }

  // -- Erasing -------------------------------------------------------------

  /**
   * Remove everything in the footprint. Stored file objects go first (an
   * object whose row is gone could never be found again), then every row
   * in one transaction, with `withinTransaction` run last inside it.
   */
  async erase(
    footprint: VisitorFootprint,
    withinTransaction?: (tx: EntityManager, removed: VisitorErasure) => Promise<void>,
  ): Promise<VisitorErasure> {
    const out: VisitorErasure = { conversations: 0, messages: 0, runs: 0, memories: 0, storedReplies: 0, files: 0, visitors: 0 };
    const files = await this.filesOf(footprint);
    for (const file of files) {
      if (!this.storage || !file.storageKey) continue;
      try {
        await this.storage.delete(file.storageKey);
      } catch (err: any) {
        this.logger.warn(`Could not remove stored file ${file.id}: ${err?.message ?? err}`);
      }
    }
    const { runIds, conversationIds, endUserIds, organizationId } = footprint;
    await this.manager.transaction(async (tx) => {
      if (files.length) {
        const removed = await tx.getRepository(AgentFile).delete({ id: In(files.map((f) => f.id)), organizationId });
        out.files = removed.affected ?? files.length;
      }
      if (runIds.length) {
        const removed: unknown = await tx.query(
          `DELETE FROM memories WHERE provenance->>'session_id' = ANY($1::text[]) RETURNING id`,
          [runIds],
        );
        out.memories = deletedCount(removed);
      }
      const replies = await this.storedRepliesQuery(footprint, tx).select('event.id').getMany();
      if (replies.length) {
        const removed = await tx.getRepository(ChannelEvent).delete({ id: In(replies.map((r) => r.id)) });
        out.storedReplies = removed.affected ?? replies.length;
      }
      if (runIds.length) {
        const removed = await tx.getRepository(AgentRun).delete({ id: In(runIds), organizationId });
        out.runs = removed.affected ?? runIds.length;
      }
      if (conversationIds.length) {
        const messages = await tx.getRepository(Message).delete({ conversationId: In(conversationIds) });
        out.messages = messages.affected ?? 0;
        const conversations = await tx.getRepository(Conversation).delete({ id: In(conversationIds), organizationId });
        out.conversations = conversations.affected ?? 0;
      }
      if (endUserIds.length) {
        const visitors = await tx
          .getRepository(EndUser)
          .delete({ id: In(endUserIds), organizationId, gatewayId: In(footprint.gatewayIds) });
        out.visitors = visitors.affected ?? 0;
      }
      // Whatever must commit with the erasure or not at all: the audit row
      // of an owner's data request.
      if (withinTransaction) await withinTransaction(tx, out);
    });
    return out;
  }

  // -- Parts ---------------------------------------------------------------

  private async messageStats(
    footprint: VisitorFootprint,
  ): Promise<Array<{ conversationId: string; messages: number; firstAt: string | null; lastAt: string | null }>> {
    if (!footprint.conversationIds.length) return [];
    const rows = await this.manager
      .getRepository(Message)
      .createQueryBuilder('m')
      .select('m.conversationId', 'conversationId')
      .addSelect('COUNT(*)', 'messages')
      .addSelect('MIN(m.createdAt)', 'firstAt')
      .addSelect('MAX(m.createdAt)', 'lastAt')
      .where('m.conversationId IN (:...ids)', { ids: footprint.conversationIds })
      .groupBy('m.conversationId')
      .getRawMany<{ conversationId: string; messages: string; firstAt: Date | null; lastAt: Date | null }>();
    return rows.map((r) => ({
      conversationId: r.conversationId,
      messages: Number(r.messages) || 0,
      firstAt: toIso(r.firstAt),
      lastAt: toIso(r.lastAt),
    }));
  }

  /** Memories the person's runs wrote: a run writes itself as the memory's session. */
  private async countMemories(footprint: VisitorFootprint): Promise<number> {
    if (!footprint.runIds.length) return 0;
    const rows: Array<{ n: string }> = await this.manager.query(
      `SELECT COUNT(*)::text AS n FROM memories WHERE provenance->>'session_id' = ANY($1::text[]) AND deleted_at IS NULL`,
      [footprint.runIds],
    );
    return Number(rows[0]?.n ?? 0);
  }

  private memoriesOf(footprint: VisitorFootprint): Promise<Array<{ id: string; content: string; created_at: Date }>> {
    if (!footprint.runIds.length) return Promise.resolve([]);
    return this.manager.query(
      `SELECT id, content, created_at FROM memories
        WHERE provenance->>'session_id' = ANY($1::text[]) AND deleted_at IS NULL
        ORDER BY created_at ASC LIMIT ${EXPORT_ROW_LIMIT}`,
      [footprint.runIds],
    );
  }

  private filesOf(footprint: VisitorFootprint): Promise<AgentFile[]> {
    if (!footprint.runIds.length) return Promise.resolve([]);
    return this.manager.getRepository(AgentFile).find({
      where: { runId: In(footprint.runIds), organizationId: footprint.organizationId },
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * Stored widget replies and channel deliveries on the footprint's place:
   * those linked to one of its runs, and a widget thread's replies.
   */
  private storedRepliesQuery(footprint: VisitorFootprint, manager: EntityManager = this.manager): SelectQueryBuilder<ChannelEvent> {
    const gatewayIds = footprint.gatewayIds.length ? footprint.gatewayIds : [NONE];
    return manager
      .getRepository(ChannelEvent)
      .createQueryBuilder('event')
      .where('event.organizationId = :organizationId', { organizationId: footprint.organizationId })
      .andWhere('event.gatewayId IN (:...gatewayIds)', { gatewayIds })
      .andWhere(
        new Brackets((w) => {
          w.where('1 = 0');
          if (footprint.runIds.length) w.orWhere('event.runId IN (:...runIds)', { runIds: footprint.runIds });
          footprint.widgetThreads.forEach((t, i) =>
            w.orWhere(
              new Brackets((one) =>
                one
                  .where(`event.gatewayId = :threadGateway${i}`, { [`threadGateway${i}`]: t.gatewayId })
                  .andWhere(`event.payload->>'threadId' = :threadId${i}`, { [`threadId${i}`]: t.threadId }),
              ),
            ),
          );
        }),
      );
  }
}

/** Rows a raw DELETE ... RETURNING removed; the driver answers [rows, count] or rows. */
function deletedCount(result: unknown): number {
  if (Array.isArray(result) && result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') {
    return result[1];
  }
  return Array.isArray(result) ? result.length : 0;
}
