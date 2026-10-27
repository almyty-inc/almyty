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
import { PushSubscription } from '../../../../entities/push-subscription.entity';
import { Api } from '../../../../entities/api.entity';
import { CredentialType } from '../../../../entities/credential.entity';
import { Operation } from '../../../../entities/operation.entity';
import { Tool, ToolStatus } from '../../../../entities/tool.entity';
import { ExecutionAccessService, type ExecutionPrincipal } from '../../../../common/authorization/execution-access.service';
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

/** Where services send pushes: PUSH_WAKE_PUBLIC_URL, else PUBLIC_API_URL (the channels' public address), else BASE_URL, else API_BASE_URL (localhost in development). */
export function pushWakeBaseUrl(env: Record<string, string | undefined> = process.env): string {
  let url = env.PUSH_WAKE_PUBLIC_URL || env.PUBLIC_API_URL || env.BASE_URL || env.API_BASE_URL || 'http://localhost:3000';
  while (url.endsWith('/')) url = url.slice(0, -1);
  return url;
}

/** A subscription's push address. */
export function pushWakeUrl(subscriptionId: string, env: Record<string, string | undefined> = process.env): string {
  return `${pushWakeBaseUrl(env)}/push-wakes/${subscriptionId}`;
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
export function healthOf(row: Pick<PushSubscription, 'health' | 'subscriptionExpiresAt'>, now = new Date()): PushWakeHealth {
  if (row.health !== 'failed' && row.subscriptionExpiresAt && row.subscriptionExpiresAt.getTime() < now.getTime()) return 'expired';
  return row.health;
}

/** JSON with its keys sorted, so the same settings always hash the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Who may share a subscription: the same connection, the same preset (or the
 * same spec), and the same resource (the spec's resourceKey rendered over the
 * settings; all the settings when it names none). Only a spec with a
 * subscribe step is shared: without one the service is set up by hand, and
 * each push wake keeps its own address and secret.
 */
export function subscriptionKeyOf(input: { organizationId: string; apiId: string | null; presetKey: string | null; spec: PushWakeSpec; settings: Record<string, string> }): string | null {
  if (!input.spec.subscribe) return null;
  const what = input.presetKey ? `preset:${input.presetKey}` : `spec:${createHash('sha256').update(canonical(input.spec)).digest('hex')}`;
  const resource = input.spec.resourceKey ? renderText(input.spec.resourceKey, { settings: input.settings }) : canonical(input.settings);
  return createHash('sha256').update(`${input.organizationId}\n${input.apiId ?? ''}\n${what}\n${resource}`).digest('hex');
}

/**
 * Arguments as an imported API's tool takes them: one flat object, which the
 * executor routes to the path, the query or the body by the operation's own
 * description. A spec may group them by where they go ({ path, query,
 * header, body }) for readability; the groups are merged here. Sent grouped,
 * a tool whose description has required parameters refuses the call as
 * missing them.
 */
export function flattenArgs(args: unknown): Record<string, any> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  const groups = ['path', 'query', 'header', 'body'];
  const input = args as Record<string, any>;
  if (!groups.some((g) => g in input)) return input;
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(input)) {
    if (groups.includes(key) && value && typeof value === 'object' && !Array.isArray(value)) Object.assign(out, value);
    else out[key] = value;
  }
  return out;
}
const managedBy = (subscriptionId: string) => ({ kind: 'push_subscription' as const, id: subscriptionId });

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
  /** The agent's push wake (its membership); the routes take this id. */
  id: string;
  subscriptionId: string;
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
  /** When this agent was last woken by it. */
  lastWakeAt: string | null;
  lastRenewedAt: string | null;
  subscriptionExpiresAt: string | null;
  renewAt: string | null;
  /** Other agents on the same subscription. */
  sharedWith: number;
  setup: PushWakeSetupView[];
  spec: PushWakeSpec;
}

type CallResult = { ok: boolean; status: number | null; data: any; error: string | null };

/**
 * Push wakes of always-on agents (push-wake.types.ts, docs/always-on.md).
 *
 * A push subscription (push_subscriptions) is one subscription at a
 * service; agents join it (agent_push_wakes). Agents that subscribe the
 * same connection to the same resource share one, because a service may
 * allow only one per resource (Gmail: one watch per mailbox).
 *
 * - `receive`: a push arrives at /push-wakes/:subscriptionId. It is
 *   verified as the spec says, checked and maybe ignored, counted, and a
 *   processing job is queued once per debounce window.
 * - `processPushes` (the job): reads what changed once, with the
 *   connection's own tool from the subscription's cursor, and wakes every
 *   member agent that is on through AlwaysOnService.pushEvent.
 * - `subscribeNow` / `renewDue` / `stopNow`: the connection's subscribe,
 *   renew and stop calls, run as a member agent's unattended principal.
 *   The subscription is stopped when its last agent leaves.
 */
@Injectable()
export class PushWakesService implements OnModuleInit {
  private readonly logger = new Logger(PushWakesService.name);
  /** Where OIDC keys come from; specs replace it with a local key set. */
  keySetFor: KeySetFor = remoteKeySet;

  constructor(
    @InjectRepository(AgentPushWake) private readonly members: Repository<AgentPushWake>,
    @InjectRepository(PushSubscription) private readonly subs: Repository<PushSubscription>,
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
    // Joining a shared subscription runs nothing, so the joining agent's use of the connection is checked here.
    @Optional() private readonly executionAccess?: ExecutionAccessService,
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

  /** The connections (APIs) of the organization, which presets each can run, and the push address prefix. */
  async options(
    organizationId: string,
    userId?: string | null,
  ): Promise<{ presets: PushWakePreset[]; apis: Array<{ id: string; name: string; presets: string[] }>; addressPrefix: string }> {
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
      addressPrefix: `${pushWakeBaseUrl()}/push-wakes/`,
    };
  }

  /** The operations of a connection that have an active tool: what a custom push wake's steps can call. */
  async operationsOf(apiId: string, organizationId: string): Promise<Array<{ operationId: string; name: string; method: string | null; path: string | null }>> {
    const api = await this.apis.findOne({ where: { id: apiId, organizationId } as any });
    if (!api) throw new NotFoundException('That connection is not in this organization.');
    const tools = await this.tools.find({ where: { apiId, organizationId, status: ToolStatus.ACTIVE } as any, take: 1000 });
    const ids = [...new Set(tools.map((t) => t.operationId).filter((v): v is string => !!v))];
    if (!ids.length) return [];
    const ops = await this.operations.find({ where: { id: In(ids), apiId } as any });
    return ops
      .filter((o) => !!o.operationId)
      .map((o) => ({ operationId: o.operationId, name: o.name ?? o.operationId, method: o.method ?? null, path: o.endpoint ?? null }))
      .sort((a, b) => a.operationId.localeCompare(b.operationId));
  }

  private async loadAgent(agentId: string, organizationId: string): Promise<Agent> {
    const agent = await this.agents.findOne({ where: { id: agentId, organizationId } });
    if (!agent) throw new NotFoundException('Agent not found');
    return agent;
  }

  private async loadMember(id: string, agentId: string, organizationId: string): Promise<{ member: AgentPushWake; sub: PushSubscription }> {
    const member = await this.members.findOne({ where: { id, agentId, organizationId } });
    const sub = member ? await this.subs.findOne({ where: { id: member.subscriptionId, organizationId } }) : null;
    if (!member || !sub) throw new NotFoundException('That push wake is gone.');
    return { member, sub };
  }

  async list(agentId: string, organizationId: string): Promise<PushWakeView[]> {
    await this.loadAgent(agentId, organizationId);
    const members = await this.members.find({ where: { agentId, organizationId }, order: { createdAt: 'ASC' } as any });
    if (!members.length) return [];
    const subs = await this.subs.find({ where: { id: In(members.map((m) => m.subscriptionId)), organizationId } as any });
    const byId = new Map(subs.map((s) => [s.id, s]));
    const apiIds = [...new Set(subs.map((r) => r.apiId).filter((v): v is string => !!v))];
    const apis = apiIds.length ? await this.apis.find({ where: { id: In(apiIds), organizationId } as any, select: { id: true, name: true } as any }) : [];
    const names = new Map(apis.map((a) => [a.id, a.name]));
    const out: PushWakeView[] = [];
    for (const m of members) {
      const sub = byId.get(m.subscriptionId);
      if (!sub) continue;
      const others = (await this.members.count({ where: { subscriptionId: sub.id } })) - 1;
      out.push(this.view(m, sub, sub.apiId ? names.get(sub.apiId) ?? null : null, others));
    }
    return out;
  }

  view(member: AgentPushWake, sub: PushSubscription, apiName: string | null = null, sharedWith = 0): PushWakeView {
    const endpointUrl = pushWakeUrl(sub.id);
    const preset = pushWakePreset(sub.presetKey);
    const ctx = { endpoint: { url: endpointUrl, id: sub.id }, settings: sub.settings ?? {} };
    const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
    return {
      id: member.id,
      subscriptionId: sub.id,
      name: sub.name,
      presetKey: sub.presetKey,
      apiId: sub.apiId,
      apiName,
      endpointUrl,
      settings: sub.settings ?? {},
      verification: sub.spec.verification.method,
      debounceSeconds: sub.debounceSeconds,
      health: { status: healthOf(sub), checkedAt: iso(sub.lastErrorAt && sub.health === 'failed' ? sub.lastErrorAt : sub.lastPushAt ?? sub.lastRenewedAt), error: sub.lastError },
      lastPushAt: iso(sub.lastPushAt),
      pushCount: sub.pushCount ?? 0,
      lastWakeAt: iso(member.lastWakeAt),
      lastRenewedAt: iso(sub.lastRenewedAt),
      subscriptionExpiresAt: iso(sub.subscriptionExpiresAt),
      renewAt: iso(sub.renewAt),
      sharedWith: Math.max(0, sharedWith),
      setup: (preset?.setup ?? []).map((s) => ({ text: s.text, ...(s.command ? { command: renderText(s.command, ctx) } : {}), ...(s.consolePath ? { consolePath: s.consolePath } : {}) })),
      spec: sub.spec,
    };
  }

  private async viewOf(member: AgentPushWake): Promise<PushWakeView> {
    const sub = await this.subs.findOne({ where: { id: member.subscriptionId } });
    if (!sub) throw new NotFoundException('That push wake is gone.');
    const api = sub.apiId ? await this.apis.findOne({ where: { id: sub.apiId } as any, select: { id: true, name: true } as any }) : null;
    const others = (await this.members.count({ where: { subscriptionId: sub.id } })) - 1;
    return this.view(member, sub, api?.name ?? null, others);
  }

  /** The operations a spec calls on the connection. */
  static operationsOf(spec: PushWakeSpec): string[] {
    const calls: Array<PushToolCall | null | undefined> = [spec.subscribe, spec.stop, spec.changes, spec.changes?.prime, spec.changes?.detail];
    return [...new Set(calls.filter((c): c is PushToolCall => !!c).map((c) => c.operation))];
  }

  /**
   * Add a push wake to an agent: join the subscription other agents already
   * have on the same connection and resource, or make one and subscribe it.
   */
  async create(agentId: string, organizationId: string, input: PushWakeInput, userId: string | null): Promise<PushWakeView> {
    const agent = await this.loadAgent(agentId, organizationId);
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
      // The agent's own use of the connection: joining a shared subscription hands it what the others read.
      if (this.executionAccess) {
        const principal = await this.principalFor(agent);
        if (!(await this.executionAccess.canExecute(principal, api as any)).allowed) {
          throw new BadRequestException(`This agent cannot use "${api.name}", so it cannot be woken by it.`);
        }
      }
    }

    const key = subscriptionKeyOf({ organizationId, apiId: api?.id ?? null, presetKey: preset?.key ?? null, spec, settings });
    const existing = key ? await this.subs.findOne({ where: { organizationId, subscriptionKey: key } }) : null;
    if (existing) {
      if (canonical(existing.settings) !== canonical(settings)) {
        throw new BadRequestException(
          `"${existing.name}" on this connection is already watched for another agent, with other settings (${Object.entries(existing.settings)
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ')}). The service allows one, so use the same settings to share it.`,
        );
      }
      if (await this.members.findOne({ where: { agentId, subscriptionId: existing.id } })) {
        throw new BadRequestException('This agent already wakes on it.');
      }
      const member = await this.join(existing.id, agentId, organizationId, userId);
      return this.viewOf(member);
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
        description: `Verifies pushes to push subscription ${id}`,
        type: CredentialType.CUSTOM,
        config: { secret: needsSecret ? pasted : randomBytes(32).toString('base64url') },
        secretKeys: ['secret'],
        managedBy: managedBy(id),
      });
      credentialId = created.id;
    }

    const sub = this.subs.create({
      id,
      organizationId,
      apiId: api?.id ?? null,
      presetKey: preset?.key ?? null,
      // Unshared ones get a key of their own, so the unique index never joins them.
      subscriptionKey: key ?? createHash('sha256').update(`own:${id}`).digest('hex'),
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
      lastRenewedAt: null,
      subscriptionExpiresAt: null,
      renewAt: null,
      createdBy: userId,
    } as Partial<PushSubscription>) as PushSubscription;
    try {
      await this.subs.insert(sub);
    } catch (err: any) {
      // Another agent made the same subscription a moment ago: join it instead.
      if (key && (String(err?.code) === '23505' || /duplicate key/i.test(String(err?.message)))) {
        await this.credentialRefs?.releaseManaged(organizationId, credentialId, managedBy(id)).catch(() => false);
        const winner = await this.subs.findOne({ where: { organizationId, subscriptionKey: key } });
        if (winner) return this.viewOf(await this.join(winner.id, agentId, organizationId, userId));
      }
      throw err;
    }
    const member = await this.join(id, agentId, organizationId, userId);
    // Subscribing can fail on the service's side (a topic without the publisher role): the row
    // stays with the error on it, so the person fixes that and tries again from the page.
    if (spec.subscribe) await this.subscribeNow(sub, agent).catch(() => undefined);
    return this.viewOf(member);
  }

  private async join(subscriptionId: string, agentId: string, organizationId: string, userId: string | null): Promise<AgentPushWake> {
    const member = this.members.create({ id: randomUUID(), organizationId, agentId, subscriptionId, lastWakeAt: null, createdBy: userId } as Partial<AgentPushWake>) as AgentPushWake;
    await this.members.insert(member);
    return member;
  }

  /**
   * Change a push wake. The wait and the name belong to the subscription,
   * so they change for every agent on it. New settings are another resource:
   * the agent moves to that subscription (joining or making it) and leaves
   * this one, which stops it if nobody else is on it.
   */
  async update(id: string, agentId: string, organizationId: string, input: Pick<PushWakeInput, 'name' | 'debounceSeconds' | 'settings'>): Promise<PushWakeView> {
    const { member, sub } = await this.loadMember(id, agentId, organizationId);
    const preset = pushWakePreset(sub.presetKey);
    const settings = input.settings !== undefined ? checkSettings(input.settings, preset ? preset.fields : null) : null;
    if (settings && canonical(settings) !== canonical(sub.settings)) {
      const moved = await this.create(
        agentId,
        organizationId,
        {
          presetKey: sub.presetKey,
          spec: sub.presetKey ? undefined : sub.spec,
          apiId: sub.apiId,
          name: input.name ?? sub.name,
          settings,
          debounceSeconds: input.debounceSeconds ?? sub.debounceSeconds,
        },
        member.createdBy,
      );
      await this.leave(member, sub);
      return moved;
    }
    const patch: Partial<PushSubscription> = {};
    if (input.name !== undefined && input.name !== null) patch.name = bounded(input.name, 120) || sub.name;
    if (input.debounceSeconds !== undefined) patch.debounceSeconds = this.debounce(input.debounceSeconds, preset);
    if (Object.keys(patch).length) await this.subs.update({ id: sub.id }, patch as any);
    return this.viewOf(member);
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
    const { member, sub } = await this.loadMember(id, agentId, organizationId);
    if (!sub.spec.subscribe) throw new BadRequestException('This push wake has nothing to subscribe to; the service sends to its address on its own.');
    try {
      await this.subscribeNow(sub, await this.loadAgent(agentId, organizationId), true);
    } catch (err: any) {
      throw new BadRequestException(err?.message ?? 'Subscribing failed.');
    }
    return this.viewOf(member);
  }

  /** Remove an agent's push wake. The subscription is stopped only when its last agent leaves. */
  async remove(id: string, agentId: string, organizationId: string): Promise<{ stopped: boolean; error: string | null; shared: boolean }> {
    const { member, sub } = await this.loadMember(id, agentId, organizationId);
    return this.leave(member, sub);
  }

  /** Every push wake of an agent, before the agent goes. */
  async removeAllFor(agentId: string, organizationId: string): Promise<number> {
    const members = await this.members.find({ where: { agentId, organizationId } });
    for (const member of members) {
      const sub = await this.subs.findOne({ where: { id: member.subscriptionId } });
      if (!sub) {
        await this.members.delete({ id: member.id });
        continue;
      }
      await this.leave(member, sub).catch((err: any) => this.logger.warn(`Could not remove push wake ${member.id}: ${err?.message ?? err}`));
    }
    return members.length;
  }

  private async leave(member: AgentPushWake, sub: PushSubscription): Promise<{ stopped: boolean; error: string | null; shared: boolean }> {
    const leaving = await this.agents.findOne({ where: { id: member.agentId, organizationId: member.organizationId } });
    await this.members.delete({ id: member.id });
    if ((await this.members.count({ where: { subscriptionId: sub.id } })) > 0) return { stopped: false, error: null, shared: true };
    let error: string | null = null;
    let stopped = false;
    if (sub.spec.stop) {
      try {
        // The last agent is gone; it is stopped as that agent, the one that last used it.
        await this.stopNow(sub, leaving);
        stopped = true;
      } catch (err: any) {
        error = bounded(err?.message ?? err, 300);
        this.logger.warn(`Push subscription ${sub.id}: stopping at the service failed: ${error}`);
      }
    }
    await this.credentialRefs?.releaseManaged(sub.organizationId, sub.verifyCredentialId, managedBy(sub.id)).catch(() => false);
    await this.subs.delete({ id: sub.id });
    await this.redis.del(this.pendingKey(sub.id), this.countKey(sub.id)).catch(() => 0);
    return { stopped, error, shared: false };
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

  /** The member agents of a subscription, oldest first, with whether each is on. */
  private async memberAgents(sub: PushSubscription): Promise<Array<{ member: AgentPushWake; agent: Agent; on: boolean }>> {
    const members = await this.members.find({ where: { subscriptionId: sub.id }, order: { createdAt: 'ASC' } as any });
    const out: Array<{ member: AgentPushWake; agent: Agent; on: boolean }> = [];
    for (const member of members) {
      const agent = await this.agents.findOne({ where: { id: member.agentId, organizationId: sub.organizationId } });
      if (agent) out.push({ member, agent, on: !!readAlwaysOn(agent.alwaysOn)?.enabled });
    }
    return out;
  }

  private async call(sub: PushSubscription, agent: Agent, principal: ExecutionPrincipal, operation: string, args: unknown): Promise<CallResult> {
    if (!sub.apiId) return { ok: false, status: null, data: null, error: 'it has no connection to call' };
    const tool = await this.toolFor(sub.apiId, sub.organizationId, operation);
    if (!tool) return { ok: false, status: null, data: null, error: `the connection has no active tool for ${operation}` };
    const result = await this.executor.executeTool(tool.id, flattenArgs(args), {
      userId: (runUserOf(principal) ?? agentOwnerUserId(agent) ?? undefined) as string,
      principal,
      organizationId: sub.organizationId,
      agentId: agent.id,
      agentTeamId: agent.teamId ?? null,
      retries: 0,
      skipCache: true,
    });
    const status = typeof result?.metadata?.httpStatus === 'number' ? result.metadata.httpStatus : null;
    return { ok: !!result?.success, status, data: result?.data ?? null, error: result?.success ? null : bounded(result?.error ?? 'failed', 300) };
  }

  private async secretOf(sub: PushSubscription): Promise<string | null> {
    if (!sub.verifyCredentialId || !this.credentialRefs) return null;
    const resolved = await this.credentialRefs
      .tryResolve(sub.organizationId, sub.verifyCredentialId, {
        principal: null,
        context: { purpose: 'push_wake_verify', resourceType: 'push_subscription', resourceId: sub.id },
      })
      .catch(() => null);
    const value = resolved?.config?.secret;
    return typeof value === 'string' && value ? value : null;
  }

  private context(sub: PushSubscription, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const now = new Date();
    return {
      endpoint: { url: pushWakeUrl(sub.id), id: sub.id },
      settings: sub.settings ?? {},
      state: { cursor: sub.state?.cursor ?? undefined, subscription: sub.state?.subscription ?? {} },
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

  private async markFailed(sub: PushSubscription, message: string): Promise<void> {
    await this.subs.update({ id: sub.id }, { health: 'failed', lastError: bounded(message, 500), lastErrorAt: new Date() } as any);
  }

  private async markValid(sub: PushSubscription, patch: Partial<PushSubscription> = {}): Promise<void> {
    await this.subs.update({ id: sub.id }, { health: 'valid', lastError: null, ...patch } as any);
  }

  /**
   * Subscribe (or subscribe again) as `agent`, keep what the answer says, and
   * work out when to renew. On a renewal with `stopPrevious`, the
   * subscription it replaces is stopped once the new one exists. A first
   * cursor is fetched when there is none, so the first push can say what changed.
   */
  async subscribeNow(sub: PushSubscription, agent: Agent, renewal = false): Promise<void> {
    const step = sub.spec.subscribe;
    if (!step) return;
    try {
      const principal = await this.principalFor(agent);
      const secret = await this.secretOf(sub);
      const res = await this.call(sub, agent, principal, step.operation, render(step.arguments, this.context(sub, { secret: secret ?? undefined })));
      if (!res.ok) throw new Error(`Subscribing (${step.operation}) failed: ${res.error}`);
      const now = new Date();
      const previous = sub.state?.subscription ?? null;
      const kept: Record<string, string> = {};
      for (const [key, path] of Object.entries(step.keep ?? {})) {
        const value = selectOne(res.data, path);
        if (value !== undefined && value !== null && typeof value !== 'object') kept[key] = String(value).slice(0, 500);
      }
      const startCursor = step.cursorPath ? selectOne(res.data, step.cursorPath) : undefined;
      const state = {
        ...(sub.state ?? {}),
        subscription: kept,
        cursor: sub.state?.cursor ?? (startCursor !== undefined && startCursor !== null ? String(startCursor) : null),
      };
      const expiresAt = parseExpiry(selectOne(res.data, step.expiresAtPath));
      await this.markValid(sub, {
        state,
        lastRenewedAt: now,
        subscriptionExpiresAt: expiresAt,
        renewAt: nextRenewAt(sub.spec.renew, now, expiresAt),
      });
      sub.state = state;
      if (renewal && sub.spec.renew?.stopPrevious && previous && Object.keys(previous).length && sub.spec.stop) {
        const stop = await this.call(sub, agent, principal, sub.spec.stop.operation, render(sub.spec.stop.arguments, this.context({ ...sub, state: { ...state, subscription: previous } })));
        if (!stop.ok) this.logger.warn(`Push subscription ${sub.id}: stopping the replaced subscription failed: ${stop.error}`);
      }
      if (!state.cursor && sub.spec.changes?.prime) {
        const cursor = await this.prime(sub, agent, principal);
        await this.subs.update({ id: sub.id }, { state: { ...state, cursor } } as any);
        sub.state = { ...state, cursor };
      }
    } catch (err: any) {
      await this.markFailed(sub, err?.message ?? String(err));
      throw err;
    }
  }

  /** Stop the subscription at the service, as `agent` (or its first member). */
  async stopNow(sub: PushSubscription, agent?: Agent | null): Promise<void> {
    if (!sub.spec.stop) return;
    const as = agent ?? (await this.memberAgents(sub))[0]?.agent;
    if (!as) throw new Error('no agent to stop it as');
    const principal = await this.principalFor(as);
    const res = await this.call(sub, as, principal, sub.spec.stop.operation, render(sub.spec.stop.arguments, this.context(sub)));
    // A subscription the service has already forgotten is stopped.
    if (!res.ok && res.status !== 404) throw new Error(`Stopping (${sub.spec.stop.operation}) failed: ${res.error}`);
  }

  /** The renewal sweep: every subscription whose renewAt has come, with an agent on it that is on. */
  async renewDue(now = new Date()): Promise<{ renewed: number; failed: number; skipped: number }> {
    const due = await this.subs.find({ where: { renewAt: LessThanOrEqual(now) } as any, take: 200 });
    let renewed = 0;
    let failed = 0;
    let skipped = 0;
    for (const sub of due) {
      // With every agent on it off, it is renewed by the first sweep after one is on again (renewAt stays in the past).
      const as = (await this.memberAgents(sub)).find((m) => m.on);
      if (!as) {
        skipped++;
        continue;
      }
      const token = await this.lock(sub.id);
      if (!token) {
        skipped++;
        continue;
      }
      try {
        await this.subscribeNow(sub, as.agent, true);
        renewed++;
      } catch {
        failed++;
      } finally {
        await this.unlock(sub.id, token);
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
    const sub = await this.subs.findOne({ where: { id } });
    if (!sub) return 'unknown';
    const ctx = this.context(sub);
    const secret = sub.spec.verification.method === 'oidc_jwt' ? null : await this.secretOf(sub);
    const verified = await verifyPush(sub.spec.verification, push, { secret, endpointUrl: pushWakeUrl(sub.id), templateContext: ctx }, this.keySetFor);
    if (!verified.ok) {
      await this.markFailed(sub, `A push was refused: ${verified.reason}.`);
      return 'rejected';
    }
    if (ignored(sub.spec, push, ctx)) {
      await this.subs.update({ id: sub.id }, { lastPushAt: new Date() } as any);
      return 'ignored';
    }
    // Verified but not for the subscription it has now (a replaced channel still sending): acknowledged, not acted on.
    if (failedRule(sub.spec.checks, push, ctx)) return 'ignored';
    await this.subs.update({ id: sub.id }, { lastPushAt: new Date(), pushCount: (sub.pushCount ?? 0) + 1 } as any);
    await this.redis.incr(this.countKey(sub.id));
    await this.redis.pexpire(this.countKey(sub.id), (sub.debounceSeconds + 3600) * 1000);
    // The first push of a window queues the job; the rest of the window rides on it.
    const first = await this.redis.set(this.pendingKey(sub.id), '1', 'PX', (sub.debounceSeconds + 300) * 1000, 'NX');
    if (first === 'OK') {
      await this.queue.add(
        PUSH_WAKE_CHANGES_JOB,
        { pushWakeId: sub.id },
        { jobId: `push-wake:${sub.id}:${Date.now()}`, delay: sub.debounceSeconds * 1000, removeOnComplete: true, removeOnFail: 50, attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
      );
    }
    return 'accepted';
  }

  /** Wake every member agent that is on; returns how many woke. Each agent's wakes dedupe on their own. */
  private async fanOut(
    sub: PushSubscription,
    targets: Array<{ member: AgentPushWake; agent: Agent }>,
    wake: { summary: string; dedupeKey: string; payload: Record<string, any> },
  ): Promise<number> {
    let woke = 0;
    for (const { member, agent } of targets) {
      const row = await this.alwaysOn.pushEvent({
        organizationId: sub.organizationId,
        agentId: agent.id,
        pushWakeId: member.id,
        summary: wake.summary,
        dedupeKey: wake.dedupeKey,
        payload: { ...wake.payload, pushWakeId: member.id },
      });
      if (row) {
        woke++;
        await this.members.update({ id: member.id }, { lastWakeAt: new Date() } as any);
      }
    }
    return woke;
  }

  /** The debounced job: read what changed once and wake every agent on the subscription with it. */
  async processPushes(id: string): Promise<'woke' | 'quiet' | 'gone' | 'off' | 'busy' | 'failed'> {
    const sub = await this.subs.findOne({ where: { id } });
    if (!sub) return 'gone';
    const token = await this.lock(sub.id);
    if (!token) {
      // A renewal holds it; look again shortly (the pending flag still stands, so pushes keep riding on this).
      await this.queue.add(PUSH_WAKE_CHANGES_JOB, { pushWakeId: sub.id }, { jobId: `push-wake:${sub.id}:${Date.now()}`, delay: 5000, removeOnComplete: true });
      return 'busy';
    }
    try {
      // Pushes from here on open a new window.
      await this.redis.del(this.pendingKey(sub.id));
      const pushes = Number(await this.redis.get(this.countKey(sub.id))) || 1;
      await this.redis.del(this.countKey(sub.id));
      const targets = (await this.memberAgents(sub)).filter((m) => m.on);
      if (!targets.length) return 'off';
      // Read as the agent that has been on it longest.
      const reader = targets[0].agent;

      let principal: ExecutionPrincipal;
      try {
        principal = await this.principalFor(reader);
      } catch (err: any) {
        await this.markFailed(sub, err?.message ?? String(err));
        return 'failed';
      }

      const name = sub.name;
      if (!sub.spec.changes) {
        const woke = await this.fanOut(sub, targets, {
          summary: renderText(sub.spec.summary, { count: pushes, name }) || `${name}: something changed`,
          dedupeKey: `push:${sub.id}:${Date.now()}`,
          payload: { name, pushes },
        });
        await this.markValid(sub);
        return woke ? 'woke' : 'quiet';
      }

      const before = sub.state?.cursor ?? null;
      const changes = await this.readChanges(sub, reader, principal);
      if (changes.error) {
        await this.markFailed(sub, `Reading what changed failed: ${changes.error}`);
        const woke = await this.fanOut(sub, targets, {
          summary: `${name}: something changed, and reading what failed (${bounded(changes.error, 160)})`,
          dedupeKey: `push:${sub.id}:error:${Date.now()}`,
          payload: { name, pushes, error: bounded(changes.error, 300) },
        });
        return woke ? 'woke' : 'failed';
      }

      const state = { ...(sub.state ?? {}), cursor: changes.cursor ?? before };
      if (!changes.unknown && !changes.items.length) {
        await this.markValid(sub, { state });
        return 'quiet';
      }
      const kept = changes.items;
      const summary = changes.unknown
        ? `${name}: something changed (it could not tell what: ${changes.unknown})`
        : renderText(sub.spec.summary, { count: changes.total, first: kept[0], last: kept[kept.length - 1], name });
      const digest = createHash('sha256').update(`${before ?? ''}>${changes.cursor ?? ''}>${kept.map((i) => i.id ?? '').join(',')}`).digest('hex').slice(0, 24);
      const woke = await this.fanOut(sub, targets, {
        summary,
        // The same change read twice (a retried job) is one wake for each agent.
        dedupeKey: `push:${sub.id}:${digest}`,
        payload: { name, pushes, changes: kept, ...(changes.total > kept.length ? { more: changes.total - kept.length } : {}) },
      });
      await this.markValid(sub, { state });
      return woke ? 'woke' : 'quiet';
    } finally {
      await this.unlock(sub.id, token);
    }
  }

  /** Read a paged call until there is no next page, or maxPages. */
  private async readPages(
    sub: PushSubscription,
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
      const res = await this.call(sub, agent, principal, step.operation, render(step.arguments, this.context({ ...sub, state: { ...sub.state, cursor } }, { page })));
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
  private async prime(sub: PushSubscription, agent: Agent, principal: ExecutionPrincipal): Promise<string | null> {
    const step = sub.spec.changes?.prime;
    if (!step) return null;
    let cursor: string | null = null;
    const read = await this.readPages(sub, agent, principal, step, null, (data) => {
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
    sub: PushSubscription,
    agent: Agent,
    principal: ExecutionPrincipal,
  ): Promise<{ items: Array<Record<string, string>>; total: number; cursor: string | null; unknown?: string; error?: string }> {
    const step = sub.spec.changes!;
    let cursor = sub.state?.cursor ?? null;
    if (!cursor) {
      try {
        cursor = await this.prime(sub, agent, principal);
      } catch (err: any) {
        return { items: [], total: 0, cursor: null, error: err?.message ?? String(err) };
      }
      return { items: [], total: 0, cursor, unknown: 'it had no starting point yet; it has one now' };
    }
    const raw: unknown[] = [];
    let nextCursor: string | null = null;
    const read = await this.readPages(sub, agent, principal, step, cursor, (data) => {
      raw.push(...selectAll(data, step.itemsPath));
      const c = selectOne(data, step.cursorPath);
      if (c !== undefined && c !== null && c !== '') nextCursor = String(c);
    });
    if (!read.ok) {
      if (read.status !== null && read.status !== undefined && (step.resetOnStatus ?? []).includes(read.status)) {
        try {
          const fresh = await this.prime(sub, agent, principal);
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
        const res = await this.call(sub, agent, principal, detail.operation, render(detail.arguments, this.context(sub, { item })));
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
