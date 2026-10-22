import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThanOrEqual, Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { createHash, randomBytes, randomUUID } from 'crypto';

import { Agent } from '../../../../entities/agent.entity';
import { AgentPushWake } from '../../../../entities/agent-push-wake.entity';
import { Api } from '../../../../entities/api.entity';
import { CredentialType } from '../../../../entities/credential.entity';
import { Operation } from '../../../../entities/operation.entity';
import { Tool, ToolStatus } from '../../../../entities/tool.entity';
import type { ExecutionPrincipal } from '../../../../common/authorization/execution-access.service';
import { CredentialRefResolver } from '../../../credentials/credential-ref.resolver';
import { ToolExecutorService } from '../../../tools/tool-executor.service';
import { AgentIdentityService, isLapsed, runUserOf } from '../../agent-identity';
import { agentOwnerUserId } from '../../agent-owner';
import { AlwaysOnService } from '../always-on.service';
import { readAlwaysOn } from '../always-on.types';
import { PUSH_WAKE_PRESETS, pushWakePreset } from './push-wake-presets';
import { parseExpiry, render, renderText, selectAll, selectOne } from './push-wake-template';
import {
  MAX_DEBOUNCE_SECONDS,
  MAX_PUSH_DETAILS,
  MAX_PUSH_ITEMS,
  MAX_PUSH_PAGES,
  type PushPagedCall,
  type PushRenewStep,
  type PushToolCall,
  type PushWakeHealth,
  type PushWakePreset,
  type PushWakeSpec,
  checkSettings,
  checkSpec,
  defaultDebounceSeconds,
  renewSweepMinutes,
} from './push-wake.types';
import { type InboundPush, type KeySetFor, failedRule, ignored, remoteKeySet, verifyPush } from './push-wake-verify';

/** Job names on the agent-runtime queue. */
export const PUSH_WAKE_CHANGES_JOB = 'push-wake-changes';
export const PUSH_WAKE_RENEW_JOB = 'push-wake-renew';

/** Where services send pushes: PUSH_WAKE_PUBLIC_URL, else BASE_URL, else API_BASE_URL (localhost in development). */
export function pushWakeBaseUrl(env: Record<string, string | undefined> = process.env): string {
  let url = env.PUSH_WAKE_PUBLIC_URL || env.BASE_URL || env.API_BASE_URL || 'http://localhost:3000';
  while (url.endsWith('/')) url = url.slice(0, -1);
  return url;
}

export function pushWakeUrl(id: string, env: Record<string, string | undefined> = process.env): string {
  return `${pushWakeBaseUrl(env)}/push-wakes/${id}`;
}

/** When to subscribe again: the earlier of "every N minutes" and "N minutes before it ends". */
export function nextRenewAt(renew: PushRenewStep | null | undefined, now: Date, expiresAt: Date | null): Date | null {
  if (!renew) return null;
  const candidates: number[] = [];
  if (renew.everyMinutes) candidates.push(now.getTime() + renew.everyMinutes * 60_000);
  if (renew.beforeExpiryMinutes && expiresAt) {
    // A subscription shorter than the lead time renews halfway through instead of at once.
    const lead = expiresAt.getTime() - renew.beforeExpiryMinutes * 60_000;
    candidates.push(lead > now.getTime() ? lead : now.getTime() + Math.max(60_000, (expiresAt.getTime() - now.getTime()) / 2));
  }
  return candidates.length ? new Date(Math.min(...candidates)) : null;
}

/** Health as the page shows it: an ended subscription is expired whatever the last write said. */
export function healthOf(row: Pick<AgentPushWake, 'health' | 'subscriptionExpiresAt'>, now = new Date()): PushWakeHealth {
  if (row.health !== 'failed' && row.subscriptionExpiresAt && row.subscriptionExpiresAt.getTime() < now.getTime()) return 'expired';
  return row.health;
}

const managedBy = (id: string) => ({ kind: 'agent_push_wake' as const, id });

function bounded(value: unknown, max: number): string {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export interface PushWakeInput {
  presetKey?: string | null;
  apiId?: string | null;
  name?: string | null;
  settings?: Record<string, string>;
  /** A custom spec (push-wake.types.ts); a preset's is used when presetKey is given. */
  spec?: unknown;
  debounceSeconds?: number | null;
  /** The HMAC key, or a shared value the service chose. Stored as a managed credential. */
  secret?: string | null;
}

/** A setup step with its command filled in. */
export interface PushWakeSetupView {
  text: string;
  command?: string;
  consolePath?: string;
}

export interface PushWakeView {
  id: string;
  name: string;
  presetKey: string | null;
  apiId: string | null;
  apiName: string | null;
  endpointUrl: string;
  settings: Record<string, string>;
  verification: PushWakeSpec['verification']['method'];
  debounceSeconds: number;
  health: { status: PushWakeHealth; checkedAt: string | null; error: string | null };
  lastPushAt: string | null;
  pushCount: number;
  lastWakeAt: string | null;
  lastRenewedAt: string | null;
  subscriptionExpiresAt: string | null;
  renewAt: string | null;
  setup: PushWakeSetupView[];
  spec: PushWakeSpec;
}

type CallResult = { ok: boolean; status: number | null; data: any; error: string | null };

/**
 * Push wakes of always-on agents (push-wake.types.ts, docs/always-on.md).
 *
 * - `receive`: a push arrives at /push-wakes/:id. It is verified as the
 *   spec says, checked and maybe ignored, counted, and a processing job is
 *   queued once per debounce window.
 * - `processPushes` (the job): reads what changed with the connection's
 *   own tool from the stored cursor, and wakes the agent through
 *   AlwaysOnService.pushEvent with the changed items' ids, names and times.
 * - `subscribe` / `renewDue` / `stop`: the connection's subscribe, renew and
 *   stop calls, run as the agent's unattended principal.
 */
@Injectable()
export class PushWakesService implements OnModuleInit {
  private readonly logger = new Logger(PushWakesService.name);
  /** Where OIDC keys come from; specs replace it with a local key set. */
  keySetFor: KeySetFor = remoteKeySet;

  constructor(
    @InjectRepository(AgentPushWake) private readonly rows: Repository<AgentPushWake>,
    @InjectRepository(Agent) private readonly agents: Repository<Agent>,
    @InjectRepository(Api) private readonly apis: Repository<Api>,
    @InjectRepository(Operation) private readonly operations: Repository<Operation>,
    @InjectRepository(Tool) private readonly tools: Repository<Tool>,
    @InjectQueue('agent-runtime') private readonly queue: Queue,
    @InjectRedis() private readonly redis: Redis,
    @Inject(forwardRef(() => ToolExecutorService)) private readonly executor: ToolExecutorService,
    @Inject(forwardRef(() => AlwaysOnService)) private readonly alwaysOn: AlwaysOnService,
    @Optional() private readonly credentialRefs?: CredentialRefResolver,
    @Optional() private readonly identity?: AgentIdentityService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env.DISABLE_ALWAYS_ON === 'true') return;
    try {
      // One repeatable sweep for the whole install; Bull keys it by name and id, so a restart re-adds the same job.
      await this.queue.add(PUSH_WAKE_RENEW_JOB, {}, { jobId: PUSH_WAKE_RENEW_JOB, repeat: { every: renewSweepMinutes() * 60_000 }, removeOnComplete: true, removeOnFail: 20 });
    } catch (err: any) {
      this.logger.warn(`Could not schedule push wake renewals: ${err?.message ?? err}`);
    }
  }

  // ---------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------

  presets(): PushWakePreset[] {
    return PUSH_WAKE_PRESETS;
  }

  /** The connections (APIs) of the organization, and which presets each can run. */
  async options(organizationId: string, userId?: string | null): Promise<{ presets: PushWakePreset[]; apis: Array<{ id: string; name: string; presets: string[] }> }> {
    // Someone else's private API is not offered (the calls would be refused anyway);
    // a team API is, and the team rule is applied when its tools run.
    const apis = (
      await this.apis.find({ where: { organizationId } as any, select: { id: true, name: true, visibility: true, ownerUserId: true } as any, take: 500 })
    ).filter((a: any) => a.visibility !== 'private' || (!!userId && a.ownerUserId === userId));
    const wanted = [...new Set(PUSH_WAKE_PRESETS.flatMap((p) => p.operations))];
    const ops = apis.length
      ? await this.operations.find({ where: { apiId: In(apis.map((a) => a.id)), operationId: In(wanted) } as any, select: { apiId: true, operationId: true } as any })
      : [];
    const byApi = new Map<string, Set<string>>();
    for (const op of ops) {
      if (!byApi.has(op.apiId)) byApi.set(op.apiId, new Set());
      byApi.get(op.apiId)!.add(op.operationId);
    }
    return {
      presets: PUSH_WAKE_PRESETS,
      apis: apis.map((a) => ({
        id: a.id,
        name: a.name,
        presets: PUSH_WAKE_PRESETS.filter((p) => p.operations.every((o) => byApi.get(a.id)?.has(o))).map((p) => p.key),
      })),
    };
  }

  private async loadAgent(agentId: string, organizationId: string): Promise<Agent> {
    const agent = await this.agents.findOne({ where: { id: agentId, organizationId } });
    if (!agent) throw new NotFoundException('Agent not found');
    return agent;
  }

  private async loadRow(id: string, agentId: string, organizationId: string): Promise<AgentPushWake> {
    const row = await this.rows.findOne({ where: { id, agentId, organizationId } });
    if (!row) throw new NotFoundException('That push wake is gone.');
    return row;
  }

  async list(agentId: string, organizationId: string): Promise<PushWakeView[]> {
    await this.loadAgent(agentId, organizationId);
    const rows = await this.rows.find({ where: { agentId, organizationId }, order: { createdAt: 'ASC' } as any });
    const apiIds = [...new Set(rows.map((r) => r.apiId).filter((v): v is string => !!v))];
    const apis = apiIds.length ? await this.apis.find({ where: { id: In(apiIds), organizationId } as any, select: { id: true, name: true } as any }) : [];
    const names = new Map(apis.map((a) => [a.id, a.name]));
    return rows.map((r) => this.view(r, r.apiId ? names.get(r.apiId) ?? null : null));
  }

  /** Whether an agent has any push wake; Always on counts them as something that wakes it. */
  async hasAny(agentId: string, organizationId: string): Promise<boolean> {
    return (await this.rows.count({ where: { agentId, organizationId } })) > 0;
  }

  view(row: AgentPushWake, apiName: string | null = null): PushWakeView {
    const endpointUrl = pushWakeUrl(row.id);
    const preset = pushWakePreset(row.presetKey);
    const ctx = { endpoint: { url: endpointUrl, id: row.id }, settings: row.settings ?? {} };
    const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
    return {
      id: row.id,
      name: row.name,
      presetKey: row.presetKey,
      apiId: row.apiId,
      apiName,
      endpointUrl,
      settings: row.settings ?? {},
      verification: row.spec.verification.method,
      debounceSeconds: row.debounceSeconds,
      health: { status: healthOf(row), checkedAt: iso(row.lastErrorAt && row.health === 'failed' ? row.lastErrorAt : row.lastPushAt ?? row.lastRenewedAt), error: row.lastError },
      lastPushAt: iso(row.lastPushAt),
      pushCount: row.pushCount ?? 0,
      lastWakeAt: iso(row.lastWakeAt),
      lastRenewedAt: iso(row.lastRenewedAt),
      subscriptionExpiresAt: iso(row.subscriptionExpiresAt),
      renewAt: iso(row.renewAt),
      setup: (preset?.setup ?? []).map((s) => ({ text: s.text, ...(s.command ? { command: renderText(s.command, ctx) } : {}), ...(s.consolePath ? { consolePath: s.consolePath } : {}) })),
      spec: row.spec,
    };
  }

  /** The operations a spec calls on the connection. */
  static operationsOf(spec: PushWakeSpec): string[] {
    const calls: Array<PushToolCall | null | undefined> = [spec.subscribe, spec.stop, spec.changes, spec.changes?.prime, spec.changes?.detail];
    return [...new Set(calls.filter((c): c is PushToolCall => !!c).map((c) => c.operation))];
  }

  async create(agentId: string, organizationId: string, input: PushWakeInput, userId: string | null): Promise<PushWakeView> {
    await this.loadAgent(agentId, organizationId);
    const preset = input.presetKey ? pushWakePreset(input.presetKey) : null;
    if (input.presetKey && !preset) throw new BadRequestException(`Unknown push wake: ${input.presetKey}.`);
    const spec = checkSpec(preset ? preset.spec : input.spec);
    const settings = checkSettings(input.settings, preset ? preset.fields : null);
    const debounce = this.debounce(input.debounceSeconds, preset);
    const operations = PushWakesService.operationsOf(spec);

    let api: Api | null = null;
    if (operations.length) {
      if (!input.apiId) throw new BadRequestException('Choose the connection it subscribes with.');
      api = await this.apis.findOne({ where: { id: input.apiId, organizationId } as any });
      if (!api) throw new BadRequestException('That connection is not in this organization.');
      const missing: string[] = [];
      for (const op of operations) if (!(await this.toolFor(api.id, organizationId, op))) missing.push(op);
      if (missing.length) {
        throw new BadRequestException(`"${api.name}" has no active tool for ${missing.join(', ')}. ${preset?.apiHint ?? 'Import the API description that has them.'}`);
      }
    }

    const v = spec.verification;
    const needsSecret = v.method === 'hmac' || (v.method === 'shared_token' && !v.generated);
    const pasted = typeof input.secret === 'string' ? input.secret.trim() : '';
    if (needsSecret && !pasted) throw new BadRequestException(v.method === 'hmac' ? 'Enter the signing key the service gave you.' : 'Enter the value the service sends.');
    if (pasted.length > 4096) throw new BadRequestException('That key is too long.');

    const id = randomUUID();
    let credentialId: string | null = null;
    if (v.method !== 'oidc_jwt') {
      if (!this.credentialRefs) throw new ServiceUnavailableException('The credential store is not available, so the verification value cannot be saved.');
      const created = await this.credentialRefs.createManaged(organizationId, {
        name: `${bounded(input.name || preset?.name || 'Push wake', 80)} push verification`,
        description: `Verifies pushes to always-on agent ${agentId} (push wake ${id})`,
        type: CredentialType.CUSTOM,
        config: { secret: needsSecret ? pasted : randomBytes(32).toString('base64url') },
        secretKeys: ['secret'],
        managedBy: managedBy(id),
      });
      credentialId = created.id;
    }

    const row = this.rows.create({
      id,
      organizationId,
      agentId,
      apiId: api?.id ?? null,
      presetKey: preset?.key ?? null,
      name: bounded(input.name || preset?.name || 'Push wake', 120),
      spec,
      settings,
      verifyCredentialId: credentialId,
      state: {},
      debounceSeconds: debounce,
      health: 'unknown',
      lastError: null,
      lastErrorAt: null,
      lastPushAt: null,
      pushCount: 0,
      lastWakeAt: null,
      lastRenewedAt: null,
      subscriptionExpiresAt: null,
      renewAt: null,
      createdBy: userId,
    } as Partial<AgentPushWake>) as AgentPushWake;
    await this.rows.insert(row);
    // Subscribing can fail on the service's side (a topic without the publisher role): the row
    // stays with the error on it, so the person fixes that and tries again from the page.
    if (spec.subscribe) await this.subscribeNow(row).catch(() => undefined);
    return this.view((await this.rows.findOne({ where: { id } })) ?? row, api?.name ?? null);
  }

  async update(id: string, agentId: string, organizationId: string, input: Pick<PushWakeInput, 'name' | 'debounceSeconds' | 'settings'>): Promise<PushWakeView> {
    const row = await this.loadRow(id, agentId, organizationId);
    const preset = pushWakePreset(row.presetKey);
    const patch: Partial<AgentPushWake> = {};
    if (input.name !== undefined && input.name !== null) patch.name = bounded(input.name, 120) || row.name;
    if (input.debounceSeconds !== undefined) patch.debounceSeconds = this.debounce(input.debounceSeconds, preset);
    const settingsChanged = input.settings !== undefined && JSON.stringify(checkSettings(input.settings, preset ? preset.fields : null)) !== JSON.stringify(row.settings);
    if (settingsChanged) patch.settings = checkSettings(input.settings, preset ? preset.fields : null);
    if (Object.keys(patch).length) await this.rows.update({ id: row.id }, patch as any);
    const next = { ...row, ...patch } as AgentPushWake;
    // New settings (another topic, another calendar) need a new subscription.
    if (settingsChanged && next.spec.subscribe) {
      await this.stopNow(row).catch(() => undefined);
      await this.rows.update({ id: row.id }, { state: {} } as any);
      await this.subscribeNow({ ...next, state: {} }).catch(() => undefined);
    }
    const fresh = (await this.rows.findOne({ where: { id: row.id } })) ?? next;
    return this.view(fresh);
  }

  private debounce(value: unknown, preset: PushWakePreset | null): number {
    if (value === undefined || value === null || value === '') return preset?.debounceSeconds ?? defaultDebounceSeconds();
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > MAX_DEBOUNCE_SECONDS) {
      throw new BadRequestException(`The wait before it wakes is a whole number of seconds, 0 to ${MAX_DEBOUNCE_SECONDS}.`);
    }
    return n;
  }

  /** "Subscribe again" on the page: a fresh subscription now, whatever the schedule says. */
  async resubscribe(id: string, agentId: string, organizationId: string): Promise<PushWakeView> {
    const row = await this.loadRow(id, agentId, organizationId);
    if (!row.spec.subscribe) throw new BadRequestException('This push wake has nothing to subscribe to; the service sends to its address on its own.');
    try {
      await this.subscribeNow(row, true);
    } catch (err: any) {
      throw new BadRequestException(err?.message ?? 'Subscribing failed.');
    }
    return this.view((await this.rows.findOne({ where: { id } })) ?? row);
  }

  /** Remove one: stop the subscription at the service (best effort), drop its secret, delete it. */
  async remove(id: string, agentId: string, organizationId: string): Promise<{ stopped: boolean; error: string | null }> {
    const row = await this.loadRow(id, agentId, organizationId);
    return this.removeRow(row);
  }

  /** Every push wake of an agent, before the agent goes. */
  async removeAllFor(agentId: string, organizationId: string): Promise<number> {
    const rows = await this.rows.find({ where: { agentId, organizationId } });
    for (const row of rows) await this.removeRow(row).catch((err: any) => this.logger.warn(`Could not remove push wake ${row.id}: ${err?.message ?? err}`));
    return rows.length;
  }

  private async removeRow(row: AgentPushWake): Promise<{ stopped: boolean; error: string | null }> {
    let error: string | null = null;
    let stopped = false;
    if (row.spec.stop) {
      try {
        await this.stopNow(row);
        stopped = true;
      } catch (err: any) {
        error = bounded(err?.message ?? err, 300);
        this.logger.warn(`Push wake ${row.id}: stopping at the service failed: ${error}`);
      }
    }
    await this.credentialRefs?.releaseManaged(row.organizationId, row.verifyCredentialId, managedBy(row.id)).catch(() => false);
    await this.rows.delete({ id: row.id });
    await this.redis.del(this.pendingKey(row.id), this.countKey(row.id)).catch(() => 0);
    return { stopped, error };
  }

  // ---------------------------------------------------------------------
  // Calls to the connection's tools
  // ---------------------------------------------------------------------

  private async toolFor(apiId: string, organizationId: string, operationId: string): Promise<Tool | null> {
    const ops = await this.operations.find({ where: { apiId, operationId } as any, select: { id: true } as any });
    if (!ops.length) return null;
    return this.tools.findOne({ where: { apiId, organizationId, operationId: In(ops.map((o) => o.id)), status: ToolStatus.ACTIVE } as any });
  }

  /** Who the calls run as: the agent's unattended principal, the same an always-on run uses. */
  private async principalFor(agent: Agent): Promise<ExecutionPrincipal> {
    if (!this.identity) return { kind: 'user', userId: agentOwnerUserId(agent), source: 'always_on' } as ExecutionPrincipal;
    const resolved = await this.identity.resolve(agent, 'always_on');
    if (isLapsed(resolved)) throw new Error(resolved.reason.message);
    return resolved.principal;
  }

  private async call(row: AgentPushWake, agent: Agent, principal: ExecutionPrincipal, operation: string, args: unknown): Promise<CallResult> {
    if (!row.apiId) return { ok: false, status: null, data: null, error: 'it has no connection to call' };
    const tool = await this.toolFor(row.apiId, row.organizationId, operation);
    if (!tool) return { ok: false, status: null, data: null, error: `the connection has no active tool for ${operation}` };
    const result = await this.executor.executeTool(tool.id, (args ?? {}) as Record<string, any>, {
      userId: (runUserOf(principal) ?? agentOwnerUserId(agent) ?? undefined) as string,
      principal,
      organizationId: row.organizationId,
      agentId: agent.id,
      agentTeamId: agent.teamId ?? null,
      retries: 0,
      skipCache: true,
    });
    const status = typeof result?.metadata?.httpStatus === 'number' ? result.metadata.httpStatus : null;
    return { ok: !!result?.success, status, data: result?.data ?? null, error: result?.success ? null : bounded(result?.error ?? 'failed', 300) };
  }

  private async secretOf(row: AgentPushWake): Promise<string | null> {
    if (!row.verifyCredentialId || !this.credentialRefs) return null;
    const resolved = await this.credentialRefs
      .tryResolve(row.organizationId, row.verifyCredentialId, {
        principal: null,
        context: { purpose: 'push_wake_verify', resourceType: 'agent_push_wake', resourceId: row.id, agentId: row.agentId },
      })
      .catch(() => null);
    const value = resolved?.config?.secret;
    return typeof value === 'string' && value ? value : null;
  }

  private context(row: AgentPushWake, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const now = new Date();
    return {
      endpoint: { url: pushWakeUrl(row.id), id: row.id },
      settings: row.settings ?? {},
      state: { cursor: row.state?.cursor ?? undefined, subscription: row.state?.subscription ?? {} },
      uuid: randomUUID(),
      now: now.toISOString(),
      nowMs: now.getTime(),
      ...extra,
    };
  }

  private lockKey(id: string) {
    return `push-wake:lock:${id}`;
  }
  private pendingKey(id: string) {
    return `push-wake:pending:${id}`;
  }
  private countKey(id: string) {
    return `push-wake:count:${id}`;
  }

  private async lock(id: string, ms = 120_000): Promise<string | null> {
    const token = randomUUID();
    return (await this.redis.set(this.lockKey(id), token, 'PX', ms, 'NX')) === 'OK' ? token : null;
  }

  private async unlock(id: string, token: string): Promise<void> {
    if ((await this.redis.get(this.lockKey(id))) === token) await this.redis.del(this.lockKey(id));
  }

  private async markFailed(row: AgentPushWake, message: string): Promise<void> {
    await this.rows.update({ id: row.id }, { health: 'failed', lastError: bounded(message, 500), lastErrorAt: new Date() } as any);
  }

  private async markValid(row: AgentPushWake, patch: Partial<AgentPushWake> = {}): Promise<void> {
    await this.rows.update({ id: row.id }, { health: 'valid', lastError: null, ...patch } as any);
  }

  /**
   * Subscribe (or subscribe again), keep what the answer says, and work
   * out when to renew. On a renewal with `stopPrevious`, the subscription
   * it replaces is stopped once the new one exists. A first cursor is
   * fetched when there is none, so the first push can say what changed.
   */
  async subscribeNow(row: AgentPushWake, renewal = false): Promise<void> {
    const step = row.spec.subscribe;
    if (!step) return;
    const agent = await this.loadAgent(row.agentId, row.organizationId);
    try {
      const principal = await this.principalFor(agent);
      const secret = await this.secretOf(row);
      const res = await this.call(row, agent, principal, step.operation, render(step.arguments, this.context(row, { secret: secret ?? undefined })));
      if (!res.ok) throw new Error(`Subscribing (${step.operation}) failed: ${res.error}`);
      const now = new Date();
      const previous = row.state?.subscription ?? null;
      const kept: Record<string, string> = {};
      for (const [key, path] of Object.entries(step.keep ?? {})) {
        const value = selectOne(res.data, path);
        if (value !== undefined && value !== null && typeof value !== 'object') kept[key] = String(value).slice(0, 500);
      }
      const startCursor = step.cursorPath ? selectOne(res.data, step.cursorPath) : undefined;
      const state = {
        ...(row.state ?? {}),
        subscription: kept,
        cursor: row.state?.cursor ?? (startCursor !== undefined && startCursor !== null ? String(startCursor) : null),
      };
      const expiresAt = parseExpiry(selectOne(res.data, step.expiresAtPath));
      await this.markValid(row, {
        state,
        lastRenewedAt: now,
        subscriptionExpiresAt: expiresAt,
        renewAt: nextRenewAt(row.spec.renew, now, expiresAt),
      });
      row.state = state;
      if (renewal && row.spec.renew?.stopPrevious && previous && Object.keys(previous).length && row.spec.stop) {
        const stop = await this.call(row, agent, principal, row.spec.stop.operation, render(row.spec.stop.arguments, this.context({ ...row, state: { ...state, subscription: previous } })));
        if (!stop.ok) this.logger.warn(`Push wake ${row.id}: stopping the replaced subscription failed: ${stop.error}`);
      }
      if (!state.cursor && row.spec.changes?.prime) {
        const cursor = await this.prime(row, agent, principal);
        await this.rows.update({ id: row.id }, { state: { ...state, cursor } } as any);
        row.state = { ...state, cursor };
      }
    } catch (err: any) {
      await this.markFailed(row, err?.message ?? String(err));
      throw err;
    }
  }

  /** Stop the subscription at the service. */
  async stopNow(row: AgentPushWake): Promise<void> {
    if (!row.spec.stop) return;
    const agent = await this.loadAgent(row.agentId, row.organizationId);
    const principal = await this.principalFor(agent);
    const res = await this.call(row, agent, principal, row.spec.stop.operation, render(row.spec.stop.arguments, this.context(row)));
    // A subscription the service has already forgotten is stopped.
    if (!res.ok && res.status !== 404) throw new Error(`Stopping (${row.spec.stop.operation}) failed: ${res.error}`);
  }

  /** The renewal sweep: every push wake whose renewAt has come, of an agent that is on. */
  async renewDue(now = new Date()): Promise<{ renewed: number; failed: number; skipped: number }> {
    const due = await this.rows.find({ where: { renewAt: LessThanOrEqual(now) } as any, take: 200 });
    let renewed = 0;
    let failed = 0;
    let skipped = 0;
    for (const row of due) {
      const agent = await this.agents.findOne({ where: { id: row.agentId, organizationId: row.organizationId } });
      // Off, it is renewed by the first sweep after it is turned on again (renewAt stays in the past).
      if (!agent || !readAlwaysOn(agent.alwaysOn)?.enabled) {
        skipped++;
        continue;
      }
      const token = await this.lock(row.id);
      if (!token) {
        skipped++;
        continue;
      }
      try {
        await this.subscribeNow(row, true);
        renewed++;
      } catch {
        failed++;
      } finally {
        await this.unlock(row.id, token);
      }
    }
    return { renewed, failed, skipped };
  }

  // ---------------------------------------------------------------------
  // Pushes
  // ---------------------------------------------------------------------

  /**
   * A push arrived. `rejected` is answered 401 (the service retries, and a
   * forger learns nothing), `ignored` and `accepted` are acknowledged.
   */
  async receive(id: string, push: InboundPush): Promise<'accepted' | 'ignored' | 'rejected' | 'unknown'> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return 'unknown';
    const row = await this.rows.findOne({ where: { id } });
    if (!row) return 'unknown';
    const ctx = this.context(row);
    const secret = row.spec.verification.method === 'oidc_jwt' ? null : await this.secretOf(row);
    const verified = await verifyPush(row.spec.verification, push, { secret, endpointUrl: pushWakeUrl(row.id), templateContext: ctx }, this.keySetFor);
    if (!verified.ok) {
      await this.markFailed(row, `A push was refused: ${verified.reason}.`);
      return 'rejected';
    }
    if (ignored(row.spec, push, ctx)) {
      await this.rows.update({ id: row.id }, { lastPushAt: new Date() } as any);
      return 'ignored';
    }
    const failed = failedRule(row.spec.checks, push, ctx);
    if (failed) {
      // Verified but not for the subscription it has now (a replaced channel still sending): acknowledged, not acted on.
      return 'ignored';
    }
    await this.rows.update({ id: row.id }, { lastPushAt: new Date(), pushCount: (row.pushCount ?? 0) + 1 } as any);
    await this.redis.incr(this.countKey(row.id));
    await this.redis.pexpire(this.countKey(row.id), (row.debounceSeconds + 3600) * 1000);
    // The first push of a window queues the job; the rest of the window rides on it.
    const first = await this.redis.set(this.pendingKey(row.id), '1', 'PX', (row.debounceSeconds + 300) * 1000, 'NX');
    if (first === 'OK') {
      await this.queue.add(
        PUSH_WAKE_CHANGES_JOB,
        { pushWakeId: row.id },
        { jobId: `push-wake:${row.id}:${Date.now()}`, delay: row.debounceSeconds * 1000, removeOnComplete: true, removeOnFail: 50, attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
      );
    }
    return 'accepted';
  }

  /** The debounced job: read what changed and wake the agent with it. */
  async processPushes(id: string): Promise<'woke' | 'quiet' | 'gone' | 'off' | 'busy' | 'failed'> {
    const row = await this.rows.findOne({ where: { id } });
    if (!row) return 'gone';
    const token = await this.lock(row.id);
    if (!token) {
      // A renewal holds it; look again shortly (the pending flag still stands, so pushes keep riding on this).
      await this.queue.add(PUSH_WAKE_CHANGES_JOB, { pushWakeId: row.id }, { jobId: `push-wake:${row.id}:${Date.now()}`, delay: 5000, removeOnComplete: true });
      return 'busy';
    }
    try {
      // Pushes from here on open a new window.
      await this.redis.del(this.pendingKey(row.id));
      const pushes = Number(await this.redis.get(this.countKey(row.id))) || 1;
      await this.redis.del(this.countKey(row.id));
      const agent = await this.agents.findOne({ where: { id: row.agentId, organizationId: row.organizationId } });
      if (!agent || !readAlwaysOn(agent.alwaysOn)?.enabled) return 'off';

      let principal: ExecutionPrincipal;
      try {
        principal = await this.principalFor(agent);
      } catch (err: any) {
        await this.markFailed(row, err?.message ?? String(err));
        return 'failed';
      }

      const name = row.name;
      if (!row.spec.changes) {
        const woke = await this.alwaysOn.pushEvent({
          organizationId: row.organizationId,
          agentId: row.agentId,
          pushWakeId: row.id,
          summary: renderText(row.spec.summary, { count: pushes, name }) || `${name}: something changed`,
          dedupeKey: `push:${row.id}:${Date.now()}`,
          payload: { pushWakeId: row.id, name, pushes },
        });
        await this.markValid(row, woke ? { lastWakeAt: new Date() } : {});
        return woke ? 'woke' : 'quiet';
      }

      const before = row.state?.cursor ?? null;
      const changes = await this.readChanges(row, agent, principal);
      if (changes.error) {
        await this.markFailed(row, `Reading what changed failed: ${changes.error}`);
        const woke = await this.alwaysOn.pushEvent({
          organizationId: row.organizationId,
          agentId: row.agentId,
          pushWakeId: row.id,
          summary: `${name}: something changed, and reading what failed (${bounded(changes.error, 160)})`,
          dedupeKey: `push:${row.id}:error:${Date.now()}`,
          payload: { pushWakeId: row.id, name, pushes, error: bounded(changes.error, 300) },
        });
        if (woke) await this.rows.update({ id: row.id }, { lastWakeAt: new Date() } as any);
        return woke ? 'woke' : 'failed';
      }

      const state = { ...(row.state ?? {}), cursor: changes.cursor ?? before };
      if (!changes.unknown && !changes.items.length) {
        await this.markValid(row, { state });
        return 'quiet';
      }
      const kept = changes.items;
      const summary = changes.unknown
        ? `${name}: something changed (it could not tell what: ${changes.unknown})`
        : renderText(row.spec.summary, { count: changes.total, first: kept[0], last: kept[kept.length - 1], name });
      const digest = createHash('sha256').update(`${before ?? ''}>${changes.cursor ?? ''}>${kept.map((i) => i.id ?? '').join(',')}`).digest('hex').slice(0, 24);
      const woke = await this.alwaysOn.pushEvent({
        organizationId: row.organizationId,
        agentId: row.agentId,
        pushWakeId: row.id,
        summary,
        // The same change read twice (a retried job) is one wake.
        dedupeKey: `push:${row.id}:${digest}`,
        payload: {
          pushWakeId: row.id,
          name,
          pushes,
          changes: kept,
          ...(changes.total > kept.length ? { more: changes.total - kept.length } : {}),
        },
      });
      await this.markValid(row, { state, ...(woke ? { lastWakeAt: new Date() } : {}) });
      return woke ? 'woke' : 'quiet';
    } finally {
      await this.unlock(row.id, token);
    }
  }

  /** Read a paged call until there is no next page, or maxPages. */
  private async readPages(
    row: AgentPushWake,
    agent: Agent,
    principal: ExecutionPrincipal,
    step: PushPagedCall,
    cursor: string | null,
    onPage: (data: any) => void,
  ): Promise<{ ok: boolean; last?: any; status?: number | null; error?: string }> {
    let page: string | undefined;
    const max = step.maxPages ?? 1;
    let last: any = null;
    for (let n = 0; n < Math.min(max, MAX_PUSH_PAGES); n++) {
      const res = await this.call(row, agent, principal, step.operation, render(step.arguments, this.context({ ...row, state: { ...row.state, cursor } }, { page })));
      if (!res.ok) return { ok: false, status: res.status, error: res.error ?? 'failed' };
      last = res.data;
      onPage(res.data);
      const next = step.nextPagePath ? selectOne(res.data, step.nextPagePath) : undefined;
      if (next === undefined || next === null || next === '') break;
      page = String(next);
    }
    return { ok: true, last };
  }

  /** A first cursor, from the prime step (paging through and discarding what it lists). */
  private async prime(row: AgentPushWake, agent: Agent, principal: ExecutionPrincipal): Promise<string | null> {
    const step = row.spec.changes?.prime;
    if (!step) return null;
    let cursor: string | null = null;
    const read = await this.readPages(row, agent, principal, step, null, (data) => {
      const c = selectOne(data, step.cursorPath);
      if (c !== undefined && c !== null && c !== '') cursor = String(c);
    });
    if (!read.ok) throw new Error(`Getting a starting point (${step.operation}) failed: ${read.error}`);
    return cursor;
  }

  /**
   * What changed since the stored cursor: the items, projected to the
   * fields the spec names (ids, names, times; never bodies), deduplicated,
   * newest kept, with detail reads for the newest few.
   */
  async readChanges(
    row: AgentPushWake,
    agent: Agent,
    principal: ExecutionPrincipal,
  ): Promise<{ items: Array<Record<string, string>>; total: number; cursor: string | null; unknown?: string; error?: string }> {
    const step = row.spec.changes!;
    let cursor = row.state?.cursor ?? null;
    if (!cursor) {
      try {
        cursor = await this.prime(row, agent, principal);
      } catch (err: any) {
        return { items: [], total: 0, cursor: null, error: err?.message ?? String(err) };
      }
      return { items: [], total: 0, cursor, unknown: 'it had no starting point yet; it has one now' };
    }
    const raw: unknown[] = [];
    let nextCursor: string | null = null;
    const read = await this.readPages(row, agent, principal, step, cursor, (data) => {
      raw.push(...selectAll(data, step.itemsPath));
      const c = selectOne(data, step.cursorPath);
      if (c !== undefined && c !== null && c !== '') nextCursor = String(c);
    });
    if (!read.ok) {
      if (read.status !== null && (step.resetOnStatus ?? []).includes(read.status)) {
        try {
          const fresh = await this.prime(row, agent, principal);
          return { items: [], total: 0, cursor: fresh, unknown: 'its starting point was too old, so it started again' };
        } catch (err: any) {
          return { items: [], total: 0, cursor: null, error: err?.message ?? String(err) };
        }
      }
      return { items: [], total: 0, cursor: null, error: read.error };
    }

    const projected: Array<Record<string, string>> = [];
    const seen = new Map<string, number>();
    for (const item of raw) {
      const out: Record<string, string> = {};
      for (const [field, path] of Object.entries(step.item)) {
        const value = selectOne(item, path);
        if (value !== undefined && value !== null && typeof value !== 'object') out[field] = bounded(value, 200);
      }
      if (!Object.keys(out).length) continue;
      // The same item twice (two history records for one message): the later one counts.
      if (out.id && seen.has(out.id)) projected.splice(seen.get(out.id)!, 1, out);
      else {
        if (out.id) seen.set(out.id, projected.length);
        projected.push(out);
      }
    }
    const max = Math.min(step.maxItems ?? MAX_PUSH_ITEMS, MAX_PUSH_ITEMS);
    const kept = projected.slice(-max);
    if (step.detail) {
      const detail = step.detail;
      const n = Math.min(step.maxDetails ?? MAX_PUSH_DETAILS, MAX_PUSH_DETAILS);
      for (const item of kept.slice(-n)) {
        const res = await this.call(row, agent, principal, detail.operation, render(detail.arguments, this.context(row, { item })));
        if (!res.ok) continue;
        for (const [field, path] of Object.entries(detail.fields)) {
          const value = selectOne(res.data, path);
          if (value !== undefined && value !== null && typeof value !== 'object') item[field] = bounded(value, 200);
        }
      }
    }
    return { items: kept, total: projected.length, cursor: nextCursor ?? cursor };
  }
}
