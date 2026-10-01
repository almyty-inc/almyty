import { Injectable, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, EntityManager, In, Repository, SelectQueryBuilder } from 'typeorm';

import { AgentRun } from '../../entities/agent-run.entity';
import { ChannelEvent } from '../../entities/channel-event.entity';
import { Conversation } from '../../entities/conversation.entity';
import { EndUser } from '../../entities/end-user.entity';
import { AgentFile } from '../../entities/file.entity';
import type { Gateway } from '../../entities/gateway.entity';
import { Message } from '../../entities/message.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import { FilesService } from '../files/files.service';
import { visitorScopeId } from '../memory/canonical/canonical-memory.helpers';
import { MemoryAccountsService, memoryAccountName, NATIVE_MEMORY_ACCOUNT } from '../memory/canonical/memory-accounts.service';
import { TranscriptTurn, groupTranscripts } from './visitor-transcript';

/** A channel's gateway, as far as finding a person on it goes. */
export type VisitorChannel = Pick<Gateway, 'id' | 'organizationId'>;

/**
 * Everything one person left on an agent's channels, as row ids.
 *
 * Every id was found under one organization and the channels' gateways,
 * so erasing a footprint cannot reach a row outside them: the runs, the
 * conversations behind them, the web chat visitor rows, and the widget
 * threads whose stored replies and unsent uploads are found by thread.
 */
export interface VisitorFootprint {
  organizationId: string;
  gatewayIds: string[];
  endUserIds: string[];
  runIds: string[];
  conversationIds: string[];
  widgetThreads: Array<{ gatewayId: string; threadId: string }>;
  /**
   * Messages the person sent on a messaging channel that never became a
   * run (their sender was over the message limit, the spend limit was
   * reached, the run was refused): the inbound delivery rows, found by the
   * sender the channel recorded on them.
   */
  unansweredEventIds: string[];
}

/** What is held for a person, in counts and dates. No content. */
export interface VisitorDataSummary {
  found: boolean;
  conversations: number;
  messages: number;
  firstAt: string | null;
  lastAt: string | null;
  memories: number;
  files: number;
  storedReplies: number;
  /** Messages they sent that the agent never answered. */
  unanswered: number;
  runs: number;
  /** The most recent conversations, newest first, as counts and dates. */
  recent: Array<{ id: string; title: string | null; messages: number; firstAt: string | null; lastAt: string | null }>;
}

/** What an erasure removed, per kind of row. */
export interface VisitorErasure {
  conversations: number;
  messages: number;
  runs: number;
  toolCalls: number;
  memories: number;
  files: number;
  storedReplies: number;
  /** Messages they sent that the agent never answered. */
  unanswered: number;
  visitors: number;
  /**
   * Memories kept in an outside memory service that did not answer the
   * delete. They are handed to the hourly memory sweep, which keeps trying.
   */
  memoriesPending: number;
}

/** What one person's export holds. */
export interface VisitorDataExport {
  exportedAt: string;
  conversations: Array<{
    id: string;
    title: string | null;
    startedAt: Date;
    messages: Array<{ role: string; content: string; createdAt: Date }>;
  }>;
  memories: Array<{ id: string; keptIn: string; content?: string; note?: string; createdAt: Date | string }>;
  files: Array<{ id: string; name: string; mimeType: string; size: number; createdAt: Date }>;
  storedReplies: Array<{ createdAt: Date; direction: string; message?: string }>;
  /** Messages they sent that the agent never answered, by date and why. */
  unanswered: Array<{ receivedAt: Date; reason: string | null }>;
  runs: Array<{ id: string; status: string; startedAt: Date; lastActiveAt: Date }>;
}

/** Ceiling on the runs one footprint collects, child runs included. */
const FOOTPRINT_RUN_LIMIT = 5_000;
/** How deep child runs are followed: the runtime's own ceiling on nesting. */
const CHILD_RUN_DEPTH = 10;
/** Rows of one kind an export loads. */
const EXPORT_ROW_LIMIT = 25_000;
/** Conversations listed in a summary. */
const SUMMARY_RECENT = 20;

/** Channels whose sender id is a phone number, matched on its digits. */
const PHONE_CHANNELS = new Set(['sms', 'whatsapp', 'whatsapp_cloud', 'signal', 'imessage_sendblue', 'imessage_loopmessage']);
/** Channels whose sender id may be an email address, matched without case and inside "Name <address>". */
const ADDRESS_CHANNELS = new Set(['email', 'imessage_sendblue', 'imessage_loopmessage']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An A2A caller as the owner may know them: the stamped form
 * (`key:<id>`, `oauth:<client>`, `jwt:<sub>`, `user:<id>`) or the bare id.
 */
export function a2aCallerCandidates(value: string): string[] {
  const v = (value || '').trim();
  if (!v) return [];
  if (/^(key|oauth|jwt|user):./.test(v)) return [v];
  return ['key', 'oauth', 'jwt', 'user'].map((prefix) => `${prefix}:${v}`);
}

/** An empty footprint: nothing found. */
export function emptyFootprint(organizationId: string, gatewayIds: string[] = []): VisitorFootprint {
  return { organizationId, gatewayIds, endUserIds: [], runIds: [], conversationIds: [], widgetThreads: [], unansweredEventIds: [] };
}

/** Several footprints in one organization as one, each id once. Another organization's are dropped. */
export function mergeFootprints(organizationId: string, parts: VisitorFootprint[]): VisitorFootprint {
  const uniq = (values: string[]) => [...new Set(values)];
  const own = parts.filter((p) => p.organizationId === organizationId);
  const threads = new Map<string, { gatewayId: string; threadId: string }>();
  for (const p of own) for (const t of p.widgetThreads) threads.set(`${t.gatewayId}\u0000${t.threadId}`, t);
  return {
    organizationId,
    gatewayIds: uniq(own.flatMap((p) => p.gatewayIds)),
    endUserIds: uniq(own.flatMap((p) => p.endUserIds)),
    runIds: uniq(own.flatMap((p) => p.runIds)),
    conversationIds: uniq(own.flatMap((p) => p.conversationIds)),
    widgetThreads: [...threads.values()],
    unansweredEventIds: uniq(own.flatMap((p) => p.unansweredEventIds)),
  };
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** One memory a person's conversations left, wherever it is kept. */
interface HeldMemory {
  id: string;
  content: string | null;
  createdAt: Date | string;
  keptIn: string;
  /** Why an outside memory's text is missing from a download. */
  note?: string;
}

/**
 * What almyty holds about one person on an agent's channels, and removing it.
 *
 * One scope for every way a person's data is reached: the web chat's own
 * "Download my data" and "Delete everything about me", the widget's
 * "Download my chat" and "Delete my chat", and an owner answering a data
 * request for someone on any channel (web chat, widget, a messaging
 * platform, A2A). Each finds the person its own way (a visitor row, a
 * widget thread, a channel sender id, an A2A credential) and gets a
 * footprint; the footprint is read, exported and erased here, so the
 * self-service and owner paths cannot drift apart on what "everything"
 * means.
 *
 * In scope: the runs filed under the person on the channel and the child
 * runs they started, with their tool calls; the conversations and messages
 * behind them; the files sent in those conversations, uploaded and not
 * sent yet, or produced by those runs; the memories in the visitor's own
 * memory and those their runs wrote anywhere else, in almyty's store or
 * an outside memory service; the stored widget replies and channel
 * deliveries, including the messages that never became a run; and the
 * web chat visitor rows.
 */
@Injectable()
export class VisitorDataService {
  constructor(
    @InjectRepository(AgentRun)
    private readonly runRepository: Repository<AgentRun>,
    // Removes a file's stored object with its row. Required: Nest always
    // injects it (visitor-data.guard.spec.ts); an erasure that left the
    // stored objects behind would not be one.
    private readonly files: FilesService,
    // Memories kept in an outside memory service are deleted through it.
    // Looked up at run time: GatewaysModule does not import MemoryModule.
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  private get manager(): EntityManager {
    return this.runRepository.manager;
  }

  // -- Finding a person ----------------------------------------------------

  /** Web chat visitor rows on this channel matching an email, a sign-in id or a visitor id. */
  async findWebVisitors(channel: VisitorChannel, identifier: string): Promise<string[]> {
    const value = (identifier || '').trim();
    if (!value) return [];
    const rows = await this.manager
      .getRepository(EndUser)
      .createQueryBuilder('eu')
      .select('eu.id', 'id')
      .where('eu.gatewayId = :gatewayId', { gatewayId: channel.id })
      .andWhere('eu.organizationId = :organizationId', { organizationId: channel.organizationId })
      .andWhere(
        new Brackets((w) => {
          w.where('lower(eu.email) = :email', { email: value.toLowerCase() }).orWhere('eu.externalId = :value', { value });
          if (UUID.test(value)) w.orWhere('eu.id = :id', { id: value });
        }),
      )
      .getRawMany<{ id: string }>();
    return rows.map((r) => r.id);
  }

  /** Web chat visitors' footprint on their channel. Ids that are not this channel's visitors are dropped. */
  async forWebVisitors(channel: VisitorChannel, endUserIds: string[]): Promise<VisitorFootprint> {
    const users = endUserIds.length
      ? await this.manager.getRepository(EndUser).find({
          where: { id: In(endUserIds), gatewayId: channel.id, organizationId: channel.organizationId },
          select: { id: true },
        })
      : [];
    const ids = users.map((u) => u.id);
    if (!ids.length) return emptyFootprint(channel.organizationId, [channel.id]);
    const runs = await this.runsWhere(channel.organizationId, (qb) => qb.andWhere('run.endUserId IN (:...ids)', { ids }));
    const conversations = await this.manager.getRepository(Conversation).find({
      where: { endUserId: In(ids), organizationId: channel.organizationId },
      select: { id: true },
    });
    return this.complete(channel, runs, { endUserIds: ids, conversationIds: conversations.map((c) => c.id) });
  }

  /**
   * One web chat conversation of a visitor and what came of it: the runs
   * behind it (the visitor's own), their child runs, and the conversation.
   * Not the visitor row nor their own memory: they keep their other
   * conversations.
   */
  async forVisitorConversation(
    endUser: Pick<EndUser, 'id' | 'organizationId' | 'gatewayId'>,
    conversationId: string,
  ): Promise<VisitorFootprint> {
    const channel = { id: endUser.gatewayId, organizationId: endUser.organizationId };
    const conversation = await this.manager.getRepository(Conversation).findOne({
      where: { id: conversationId, endUserId: endUser.id, organizationId: endUser.organizationId },
      select: { id: true },
    });
    if (!conversation) return emptyFootprint(channel.organizationId, [channel.id]);
    const runs = await this.runsWhere(channel.organizationId, (qb) =>
      qb.andWhere('run.conversationId = :conversationId', { conversationId: conversation.id }).andWhere('run.endUserId = :endUserId', {
        endUserId: endUser.id,
      }),
    );
    return this.complete(channel, runs, { conversationIds: [conversation.id] });
  }

  /** A widget visitor is their thread: every run filed under the channel with that thread id. */
  async forWidgetThread(channel: VisitorChannel, threadId: string): Promise<VisitorFootprint> {
    const value = (threadId || '').trim();
    if (!value) return emptyFootprint(channel.organizationId, [channel.id]);
    const runs = await this.runsWhere(channel.organizationId, (qb) =>
      qb
        .andWhere("run.metadata->>'gatewayId' = :gatewayId", { gatewayId: channel.id })
        .andWhere("run.metadata->>'threadId' = :threadId", { threadId: value }),
    );
    return this.complete(channel, runs, { widgetThreads: [{ gatewayId: channel.id, threadId: value }] });
  }

  /**
   * A messaging-channel sender: the platform's id for them, as the channel
   * recorded it on each run, and on each delivery of theirs that never
   * became one. Phone-number channels match on the digits ("+1 415 555
   * 0100" finds "whatsapp:+14155550100"); email matches the address inside
   * a "Name <address>" sender too.
   */
  async forChannelSender(channel: VisitorChannel, type: string, senderId: string): Promise<VisitorFootprint> {
    const value = (senderId || '').trim();
    if (!value) return emptyFootprint(channel.organizationId, [channel.id]);
    const runs = await this.runsWhere(channel.organizationId, (qb) =>
      qb
        .andWhere("run.metadata->>'gatewayId' = :gatewayId", { gatewayId: channel.id })
        .andWhere(senderMatches("run.metadata->>'channelUserId'", type, value)),
    );
    const unanswered = await this.manager
      .getRepository(ChannelEvent)
      .createQueryBuilder('event')
      .select('event.id')
      .where('event.organizationId = :organizationId', { organizationId: channel.organizationId })
      .andWhere('event.gatewayId = :gatewayId', { gatewayId: channel.id })
      .andWhere("event.direction = 'inbound'")
      .andWhere('event.runId IS NULL')
      .andWhere(senderMatches('event.senderId', type, value))
      .take(EXPORT_ROW_LIMIT)
      .getMany();
    return this.complete(channel, runs, { unansweredEventIds: unanswered.map((e) => e.id) });
  }

  /** An A2A caller: the credential the A2A channel stamped on each run it started for them. */
  async forA2ACaller(channel: VisitorChannel, callerId: string): Promise<VisitorFootprint> {
    const callers = a2aCallerCandidates(callerId);
    if (!callers.length) return emptyFootprint(channel.organizationId, [channel.id]);
    const runs = await this.runsWhere(channel.organizationId, (qb) =>
      qb
        .andWhere("run.metadata->>'gatewayId' = :gatewayId", { gatewayId: channel.id })
        .andWhere("run.metadata->>'a2aCaller' IN (:...callers)", { callers }),
    );
    return this.complete(channel, runs);
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
    channel: VisitorChannel,
    runs: Array<Pick<AgentRun, 'id' | 'conversationId'>>,
    extra: Partial<Pick<VisitorFootprint, 'endUserIds' | 'conversationIds' | 'widgetThreads' | 'unansweredEventIds'>> = {},
  ): Promise<VisitorFootprint> {
    const all = new Map(runs.map((r) => [r.id, r]));
    let frontier = runs.map((r) => r.id);
    for (let depth = 0; depth < CHILD_RUN_DEPTH && frontier.length && all.size < FOOTPRINT_RUN_LIMIT; depth++) {
      const children = await this.runRepository.find({
        where: { parentRunId: In(frontier), organizationId: channel.organizationId },
        select: { id: true, conversationId: true },
        take: FOOTPRINT_RUN_LIMIT,
      });
      frontier = children.filter((c) => !all.has(c.id)).map((c) => c.id);
      for (const child of children) all.set(child.id, child);
    }
    const conversationIds = new Set(extra.conversationIds ?? []);
    for (const r of all.values()) if (r.conversationId) conversationIds.add(r.conversationId);
    return {
      ...emptyFootprint(channel.organizationId, [channel.id]),
      endUserIds: extra.endUserIds ?? [],
      runIds: [...all.keys()],
      conversationIds: [...conversationIds],
      widgetThreads: extra.widgetThreads ?? [],
      unansweredEventIds: extra.unansweredEventIds ?? [],
    };
  }

  // -- Reading -------------------------------------------------------------

  /** What is held, in counts and dates. */
  async summarize(footprint: VisitorFootprint): Promise<VisitorDataSummary> {
    const [perConversation, memories, storedReplies, unanswered, files, conversations] = await Promise.all([
      this.messageStats(footprint),
      this.memoriesOf(footprint).then((m) => m.length),
      this.storedRepliesQuery(footprint).getCount(),
      this.unansweredQuery(footprint).getCount(),
      this.filesOf(footprint).then((f) => f.length),
      this.conversationsOf(footprint),
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
      footprint.runIds.length + conversations.length + footprint.endUserIds.length + memories + storedReplies + unanswered + files > 0;
    return {
      found,
      conversations: conversations.length,
      messages: recent.reduce((n, c) => n + c.messages, 0),
      firstAt: dates[0] ?? null,
      lastAt: dates[dates.length - 1] ?? null,
      memories,
      files,
      storedReplies,
      unanswered,
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
  async export(footprint: VisitorFootprint): Promise<VisitorDataExport> {
    const conversations = await this.conversationsOf(footprint);
    const [byConversation, held, replies, unanswered, runs] = await Promise.all([
      this.transcripts(conversations.map((c) => c.id)),
      this.memoriesAndFiles(footprint),
      this.storedRepliesQuery(footprint).orderBy('event.createdAt', 'ASC').limit(EXPORT_ROW_LIMIT).getMany(),
      this.unansweredQuery(footprint).orderBy('event.createdAt', 'ASC').limit(EXPORT_ROW_LIMIT).getMany(),
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
      ...held,
      // What was said to the person. An inbound delivery's raw platform
      // body also carries the owner's workspace and bot ids, so it is
      // listed by date, not reproduced.
      storedReplies: replies.map((e) => ({
        createdAt: e.createdAt,
        direction: e.direction,
        ...(e.direction === 'outbound' && typeof e.payload?.message === 'string' ? { message: e.payload.message } : {}),
      })),
      // The platform's raw delivery also carries the owner's workspace and
      // bot ids, so these are listed by date and why, not reproduced.
      unanswered: unanswered.map((e) => ({ receivedAt: e.createdAt, reason: e.errorMessage ?? null })),
      runs: runs.map((r) => ({ id: r.id, status: r.status, startedAt: r.createdAt, lastActiveAt: r.updatedAt })),
    };
  }

  /**
   * The memories and files held for the person, as their download lists
   * them. The web chat's and the widget's own downloads add these to the
   * conversations they already show.
   */
  async memoriesAndFiles(footprint: VisitorFootprint): Promise<Pick<VisitorDataExport, 'memories' | 'files'>> {
    const [memories, files] = await Promise.all([this.memoriesOf(footprint, { readOutside: true }), this.filesOf(footprint)]);
    return {
      // A memory in an outside service is read from that service. When it
      // cannot be (it is down, or has no way to read one memory back), the
      // memory is listed by id and service with a note saying so.
      memories: memories.map((m) => ({
        id: m.id,
        keptIn: m.keptIn,
        ...(m.content !== null ? { content: m.content } : {}),
        ...(m.note ? { note: m.note } : {}),
        createdAt: m.createdAt,
      })),
      files: files.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, size: f.size, createdAt: f.createdAt })),
    };
  }

  // -- Erasing -------------------------------------------------------------

  /**
   * Remove everything in the footprint.
   *
   * What lives outside the database goes first, because a stored object
   * or an outside memory whose row is gone could never be found again:
   * the files (stored object and row together) and the memories kept in
   * an outside memory service. Then every row in one transaction, with
   * `withinTransaction` run last inside it, so an audit row commits with
   * the erasure or not at all.
   */
  async erase(
    footprint: VisitorFootprint,
    withinTransaction?: (tx: EntityManager, removed: VisitorErasure) => Promise<void>,
  ): Promise<VisitorErasure> {
    const out: VisitorErasure = {
      conversations: 0,
      messages: 0,
      runs: 0,
      toolCalls: 0,
      memories: 0,
      files: 0,
      storedReplies: 0,
      unanswered: 0,
      visitors: 0,
      memoriesPending: 0,
    };
    const { runIds, conversationIds, endUserIds, organizationId } = footprint;

    const files = await this.filesOf(footprint);
    if (files.length) out.files = await this.files.removeMany(organizationId, files.map((f) => f.id));

    const outside = await this.outsideMemoryRows(footprint);
    if (outside.length) {
      const accounts = this.memoryAccounts();
      const result = accounts ? await accounts.forget(organizationId, outside.map((r) => r.id)) : { deleted: 0, pending: outside.length };
      out.memories += result.deleted;
      out.memoriesPending = result.pending;
    }

    await this.manager.transaction(async (tx) => {
      const native = this.nativeMemoryFilter(footprint);
      if (native) {
        const removed: unknown = await tx.query(`DELETE FROM memories WHERE ${native.where} RETURNING id`, native.params);
        out.memories += deletedCount(removed);
      }
      const replies = await this.storedRepliesQuery(footprint, tx).select('event.id').getMany();
      if (replies.length) {
        const removed = await tx.getRepository(ChannelEvent).delete({ id: In(replies.map((r) => r.id)) });
        out.storedReplies = removed.affected ?? replies.length;
      }
      const unanswered = await this.unansweredQuery(footprint, tx).select('event.id').getMany();
      if (unanswered.length) {
        const removed = await tx.getRepository(ChannelEvent).delete({ id: In(unanswered.map((e) => e.id)) });
        out.unanswered = removed.affected ?? unanswered.length;
      }
      if (runIds.length) {
        const calls = await tx.getRepository(ToolExecution).delete({ runId: In(runIds), organizationId });
        out.toolCalls = calls.affected ?? 0;
        const removed = await tx.getRepository(AgentRun).delete({ id: In(runIds), organizationId });
        out.runs = removed.affected ?? runIds.length;
      }
      if (conversationIds.length) {
        // Only conversations of this organization: the ids came from it,
        // and the filter says so again where the rows are removed.
        const own = await tx.getRepository(Conversation).find({
          where: { id: In(conversationIds), organizationId },
          select: { id: true },
        });
        const ids = own.map((c) => c.id);
        if (ids.length) {
          const messages = await tx.getRepository(Message).delete({ conversationId: In(ids) });
          out.messages = messages.affected ?? 0;
          const conversations = await tx.getRepository(Conversation).delete({ id: In(ids), organizationId });
          out.conversations = conversations.affected ?? 0;
        }
      }
      if (endUserIds.length) {
        const visitors = await tx
          .getRepository(EndUser)
          .delete({ id: In(endUserIds), organizationId, gatewayId: In(footprint.gatewayIds) });
        out.visitors = visitors.affected ?? 0;
      }
      if (withinTransaction) await withinTransaction(tx, out);
    });
    return out;
  }

  // -- Parts ---------------------------------------------------------------

  private conversationsOf(footprint: VisitorFootprint): Promise<Conversation[]> {
    if (!footprint.conversationIds.length) return Promise.resolve([]);
    return this.manager.getRepository(Conversation).find({
      where: { id: In(footprint.conversationIds), organizationId: footprint.organizationId },
      select: { id: true, title: true, createdAt: true },
      order: { createdAt: 'ASC' },
    });
  }

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

  /** The visitor's own memory scopes: one per web chat visitor row. */
  private visitorScopes(footprint: VisitorFootprint): string[] {
    return footprint.endUserIds.map((id) => visitorScopeId(footprint.organizationId, id));
  }

  /**
   * The memories in almyty's own store that are the person's: everything in
   * their own memory, and what their runs wrote to any other memory of this
   * organization (a run writes itself as the memory's session).
   */
  private nativeMemoryFilter(footprint: VisitorFootprint): { where: string; params: unknown[] } | null {
    const scopes = this.visitorScopes(footprint);
    if (!scopes.length && !footprint.runIds.length) return null;
    return {
      where: `((scope_type = 'user' AND scope_id = ANY($1::text[]))
          OR (provenance->>'session_id' = ANY($2::text[]) AND (scope_id = $3 OR scope_id LIKE $4)))`,
      params: [scopes, footprint.runIds, footprint.organizationId, `${footprint.organizationId}:%`],
    };
  }

  /** Memories kept for the person in an outside memory service (memory_expiries rows). */
  private async outsideMemoryRows(
    footprint: VisitorFootprint,
  ): Promise<Array<{ id: string; memory_id: string; backend_id: string; created_at: Date }>> {
    const scopes = this.visitorScopes(footprint);
    if (!scopes.length && !footprint.runIds.length) return [];
    return this.manager.query(
      `SELECT id, memory_id, backend_id, created_at FROM memory_expiries
        WHERE organization_id = $1 AND (scope_id = ANY($2::text[]) OR run_id = ANY($3::text[]))
        ORDER BY created_at ASC LIMIT ${EXPORT_ROW_LIMIT}`,
      [footprint.organizationId, scopes, footprint.runIds],
    );
  }

  private async memoriesOf(footprint: VisitorFootprint, opts: { readOutside?: boolean } = {}): Promise<HeldMemory[]> {
    const native = this.nativeMemoryFilter(footprint);
    const [own, outside] = await Promise.all([
      native
        ? (this.manager.query(
            `SELECT id, content, created_at FROM memories WHERE ${native.where} ORDER BY created_at ASC LIMIT ${EXPORT_ROW_LIMIT}`,
            native.params,
          ) as Promise<Array<{ id: string; content: string; created_at: Date }>>)
        : Promise.resolve([] as Array<{ id: string; content: string; created_at: Date }>),
      this.outsideMemoryRows(footprint),
    ]);
    const accounts = opts.readOutside && outside.length ? this.memoryAccounts() : null;
    const read = accounts ? await accounts.read(footprint.organizationId, outside.map((m) => m.id)) : new Map<string, string | null>();
    return [
      ...own.map((m) => ({ id: m.id, content: m.content, createdAt: m.created_at, keptIn: memoryAccountName(NATIVE_MEMORY_ACCOUNT) })),
      ...outside.map((m) => {
        const content = read.get(m.id) ?? null;
        const keptIn = memoryAccountName(m.backend_id);
        return {
          id: m.memory_id,
          content,
          createdAt: m.created_at,
          keptIn,
          ...(opts.readOutside && content === null
            ? { note: `Kept in ${keptIn}, which could not give its text back just now. It is deleted with the rest when their data is deleted.` }
            : {}),
        };
      }),
    ];
  }

  /**
   * The files that are the person's: sent in their conversations, produced
   * by their runs, or uploaded on their channel and not sent yet.
   */
  private filesOf(footprint: VisitorFootprint): Promise<AgentFile[]> {
    const { organizationId, conversationIds, runIds, endUserIds, widgetThreads, gatewayIds } = footprint;
    const unsentVisitor = endUserIds.length > 0 && gatewayIds.length > 0;
    if (!conversationIds.length && !runIds.length && !unsentVisitor && !widgetThreads.length) return Promise.resolve([]);
    return this.manager
      .getRepository(AgentFile)
      .createQueryBuilder('file')
      .where('file.organizationId = :organizationId', { organizationId })
      .andWhere(
        new Brackets((w) => {
          w.where('1 = 0');
          if (conversationIds.length) w.orWhere('file.conversationId IN (:...conversationIds)', { conversationIds });
          if (runIds.length) w.orWhere('file.runId IN (:...runIds)', { runIds });
          if (unsentVisitor) {
            w.orWhere(
              new Brackets((one) =>
                one
                  .where('file.conversationId IS NULL')
                  .andWhere(`file.metadata->>'gatewayId' IN (:...gatewayIds)`, { gatewayIds })
                  .andWhere(`file.metadata->>'endUserId' IN (:...endUserIds)`, { endUserIds }),
              ),
            );
          }
          widgetThreads.forEach((t, i) =>
            w.orWhere(
              new Brackets((one) =>
                one
                  .where('file.conversationId IS NULL')
                  .andWhere(`file.metadata->>'gatewayId' = :fileGateway${i}`, { [`fileGateway${i}`]: t.gatewayId })
                  .andWhere(`file.metadata->>'threadId' = :fileThread${i}`, { [`fileThread${i}`]: t.threadId }),
              ),
            ),
          );
        }),
      )
      .orderBy('file.createdAt', 'ASC')
      .take(EXPORT_ROW_LIMIT)
      .getMany();
  }

  /**
   * Stored widget replies and channel deliveries on the footprint's
   * channels: those linked to one of its runs, and a widget thread's.
   */
  private storedRepliesQuery(footprint: VisitorFootprint, manager: EntityManager = this.manager): SelectQueryBuilder<ChannelEvent> {
    const qb = manager
      .getRepository(ChannelEvent)
      .createQueryBuilder('event')
      .where('event.organizationId = :organizationId', { organizationId: footprint.organizationId });
    if (!footprint.gatewayIds.length) return qb.andWhere('1 = 0');
    return qb.andWhere('event.gatewayId IN (:...gatewayIds)', { gatewayIds: footprint.gatewayIds }).andWhere(
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

  /** The person's inbound deliveries that never became a run, on the footprint's channels. */
  private unansweredQuery(footprint: VisitorFootprint, manager: EntityManager = this.manager): SelectQueryBuilder<ChannelEvent> {
    const qb = manager
      .getRepository(ChannelEvent)
      .createQueryBuilder('event')
      .where('event.organizationId = :organizationId', { organizationId: footprint.organizationId })
      .andWhere("event.direction = 'inbound'")
      .andWhere('event.runId IS NULL');
    if (!footprint.unansweredEventIds.length || !footprint.gatewayIds.length) return qb.andWhere('1 = 0');
    return qb
      .andWhere('event.gatewayId IN (:...gatewayIds)', { gatewayIds: footprint.gatewayIds })
      .andWhere('event.id IN (:...unansweredIds)', { unansweredIds: footprint.unansweredEventIds });
  }

  private memoryAccounts(): Pick<MemoryAccountsService, 'forget' | 'read'> | null {
    if (!this.moduleRef) return null;
    try {
      return this.moduleRef.get(MemoryAccountsService, { strict: false });
    } catch {
      return null;
    }
  }
}

/** Rows a raw DELETE ... RETURNING removed; the driver answers [rows, count] or rows. */
function deletedCount(result: unknown): number {
  if (Array.isArray(result) && result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') {
    return result[1];
  }
  return Array.isArray(result) ? result.length : 0;
}

/**
 * Whether the sender id in `column` is the one the owner typed, by the
 * channel's rules: the exact id; on a phone channel, the same digits; on
 * an address channel, the address with any case, or inside "Name <address>".
 */
export function senderMatches(column: string, type: string, value: string): Brackets {
  const digits = value.replace(/\D/g, '');
  const address = value.toLowerCase();
  return new Brackets((w) => {
    w.where(`${column} = :sender`, { sender: value });
    if (PHONE_CHANNELS.has(type) && digits.length >= 5 && !value.includes('@')) {
      w.orWhere(`regexp_replace(${column}, '[^0-9]', '', 'g') = :digits`, { digits });
    }
    if (ADDRESS_CHANNELS.has(type) && value.includes('@')) {
      w.orWhere(`lower(${column}) = :address`, { address }).orWhere(`position(:bracketed in lower(${column})) > 0`, {
        bracketed: `<${address}>`,
      });
    }
  });
}
