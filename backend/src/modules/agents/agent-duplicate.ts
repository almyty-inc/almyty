import type { Agent } from '../../entities/agent.entity';
import { readAlwaysOn, type AlwaysOnConfig } from './always-on/always-on.types';

/**
 * What a duplicate of an agent is made of (POST /agents/:id/duplicate).
 *
 * A duplicate behaves like its original: same mode, instructions,
 * personality, models, memory settings, agent config (the answer check
 * included), tools, graph, variables, settings and the policy its
 * channels follow (branding, visitor rules). It is a new agent, so it
 * does not take the original's identity or anything that hangs off it:
 * its name, API keys and gateway, published channels, run history,
 * statistics, version history and memories. It starts as a draft.
 *
 * Every column of `agents` is named once below, in COPIED or NOT_COPIED;
 * a guard test fails when a column is added without a decision here.
 */
export const DUPLICATE_COPIED = [
  'description',
  'visibility',
  'teamId',
  'pipeline',
  'variables',
  'settings',
  'mode',
  'instructions',
  'personality',
  'alwaysOn',
  'toolIds',
  'modelConfig',
  'memoryConfig',
  'agentConfig',
  'collaboration',
  'models',
  'branding',
  'visitorRules',
] as const;

export const DUPLICATE_NOT_COPIED = [
  // Identity.
  'id',
  'name',
  'organizationId',
  'createdBy',
  'createdAt',
  'updatedAt',
  // Keys and publishing: the API gateway and who may call it, the webhook
  // results are posted to.
  'apiGatewayId',
  'apiAccessScope',
  'apiAccessTeamId',
  'webhookUrl',
  // A copy starts as a draft at 1.0.0 with no history of its own.
  'status',
  'version',
  'metadata',
  // Temporary agents belong to one run.
  'isTemporary',
  'parentRunId',
  // Run statistics.
  'totalExecutions',
  'successfulExecutions',
  'checkedExecutions',
  'passedCheckExecutions',
  'totalCost',
  'averageExecutionTime',
  'lastExecutedAt',
] as const;

const clone = <T>(v: T): T => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));

/**
 * The schedule a copy keeps: its timing and input, off. Where the
 * original posts its results (`deliverTo`) is the original's channel, and
 * `pausedReason`/`createdAt` are its history.
 */
function copySettings(settings: Record<string, any> | null | undefined): Record<string, any> {
  const out: Record<string, any> = clone(settings ?? {}) ?? {};
  // A broken-model banner is the original's state, not a setting.
  delete out.modelIssue;
  if (out.schedule && typeof out.schedule === 'object') {
    const { deliverTo: _d, pausedReason: _p, createdAt: _c, ...timing } = out.schedule;
    out.schedule = { ...timing, enabled: false };
  }
  return out;
}

/**
 * The always-on settings a copy keeps: the brief, wake timer, connection
 * events, act mode, ask-first tools and reporting, turned off. The
 * original's channels (wake channels, owner channel, report channel) and
 * its standing thread are not the copy's.
 */
function copyAlwaysOn(raw: unknown): AlwaysOnConfig | null {
  const read = readAlwaysOn(clone(raw));
  if (!read) return null;
  const {
    standingConversationId: _s,
    liveRunId: _l,
    pausedReason: _p,
    enabledAt: _e,
    home: _h,
    ...rest
  } = read;
  return {
    ...rest,
    enabled: false,
    wakeOn: { ...rest.wakeOn, channelIds: [] },
    ownerChannel: null,
    reportTo: null,
  };
}

/** The new agent's fields, from the original. `name` is the copy's own, already free. */
export function duplicateAgentFields(original: Agent, name: string): Partial<Agent> {
  return {
    name,
    status: 'draft' as Agent['status'],
    description: original.description,
    visibility: original.visibility,
    teamId: original.teamId,
    mode: original.mode,
    pipeline: clone(original.pipeline) ?? { nodes: [], edges: [] },
    variables: clone(original.variables) ?? {},
    settings: copySettings(original.settings),
    instructions: original.instructions ?? null,
    personality: original.personality ?? null,
    alwaysOn: copyAlwaysOn(original.alwaysOn),
    toolIds: [...(original.toolIds ?? [])],
    modelConfig: clone(original.modelConfig) ?? null,
    memoryConfig: clone(original.memoryConfig) ?? null,
    agentConfig: clone(original.agentConfig) ?? null,
    collaboration: clone(original.collaboration) ?? null,
    models: clone(original.models) ?? null,
    branding: clone(original.branding) ?? null,
    visitorRules: clone(original.visitorRules) ?? null,
  } as Partial<Agent>;
}
