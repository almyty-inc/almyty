import {
  ConnectionPolicyKind,
  ConnectionPolicyRule,
  ConnectorListRule,
  ExpiryRule,
  RotationRule,
  ScopePrincipalKind,
  ScopeRule,
} from '../../../src/entities/connection-policy.entity';
import { isConnectorListRule, isExpiryRule, isRotationRule, isScopeRule } from './connection-policy.rules';

/**
 * Pure policy decisions for the Connections governance module. No I/O:
 * the service loads the org's policies and the rows, this module
 * answers. Every function ignores disabled policies.
 */

export interface PolicyLike {
  id?: string;
  kind: ConnectionPolicyKind;
  rule: ConnectionPolicyRule;
  enabled: boolean;
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  /** The policy that carried a deny, when denied by one. */
  policyId?: string | null;
}

/** The subset of a Credential row the evaluator reads. */
export interface GovernedConnection {
  id: string;
  connectorKey?: string | null;
  ownerUserId?: string | null;
  healthStatus?: string | null;
  createdAt?: Date | string | null;
  metadata?: Record<string, any> | null;
  name?: string | null;
  organizationId?: string;
}

/** Who is resolving: the request user plus the run it happens in. */
export interface UsePrincipal {
  userId?: string;
  agentId?: string;
  workspaceId?: string;
}

export interface UseContext {
  agentId?: string;
  workspaceId?: string;
  /** The run's environment, for example `production`; compared case-insensitively. */
  environment?: string | null;
  /** How the grant check allowed the use; a team or role grant adds that kind. */
  via?: { principalType?: string } | null;
  /** Explicit override of the derived principal kinds. */
  principalKinds?: ScopePrincipalKind[];
}

export interface ExpiryAction {
  connectionId: string;
  connectorKey: string | null;
  ownerUserId: string | null;
  ageDays: number;
  maxAgeDays: number;
  /** When the secret reaches maxAgeDays. */
  expiresOn: Date;
  policyId: string | null;
}

export interface ExpiryActions {
  warn: ExpiryAction[];
  expire: ExpiryAction[];
  /** Whether the governing rule revokes grants on expiry. */
  enforce: boolean;
}

export interface RotationCandidate {
  connectionId: string;
  connectorKey: string | null;
  ownerUserId: string | null;
  ageDays: number;
  everyDays: number;
  policyId: string | null;
}

export interface RotationDue {
  /** Rotate through the provider API now. */
  due: RotationCandidate[];
  /** Due, but the connector has no API rotation: the owner must rotate by hand. */
  manual: RotationCandidate[];
}

/** Does this connector support rotation through the provider's API? */
export type RotationCapabilities = Record<string, boolean> | ((connectorKey: string) => boolean);

const DAY_MS = 24 * 60 * 60 * 1000;

const allow = (reason: string): PolicyDecision => ({ allowed: true, reason });
const deny = (reason: string, policy?: PolicyLike): PolicyDecision => ({ allowed: false, reason, policyId: policy?.id ?? null });

function enabled<T extends PolicyLike>(policies: T[], kind: ConnectionPolicyKind): T[] {
  return policies.filter((p) => p.enabled && p.kind === kind);
}

function listRules(policies: PolicyLike[], kind: 'connector_allowlist' | 'connector_denylist'): Array<{ policy: PolicyLike; rule: ConnectorListRule }> {
  return enabled(policies, kind)
    .filter((p) => isConnectorListRule(p.rule))
    .map((policy) => ({ policy, rule: policy.rule as ConnectorListRule }));
}

function appliesToOwner(rule: ConnectorListRule, owner: 'org' | 'user'): boolean {
  return !rule.owners || rule.owners.includes(owner);
}

/** Connector keys on any enabled allowlist, or null when the org has no allowlist. */
export function approvedConnectors(policies: PolicyLike[], owner?: 'org' | 'user'): Set<string> | null {
  const lists = listRules(policies, 'connector_allowlist').filter(({ rule }) => !owner || appliesToOwner(rule, owner));
  if (lists.length === 0) return null;
  return new Set(lists.flatMap(({ rule }) => rule.connectorKeys));
}

/**
 * May a connection to `connectorKey` be created (or rotated in place)
 * with this owner? A denylist hit wins; otherwise, when at least one
 * allowlist applies to the owner, the key must be on one of them.
 */
export function evaluateConnect(policies: PolicyLike[], connectorKey: string, owner: 'org' | 'user'): PolicyDecision {
  for (const { policy, rule } of listRules(policies, 'connector_denylist')) {
    if (appliesToOwner(rule, owner) && rule.connectorKeys.includes(connectorKey)) {
      return deny(`connector ${connectorKey} is on a deny list for ${owner} connections`, policy);
    }
  }
  const lists = listRules(policies, 'connector_allowlist').filter(({ rule }) => appliesToOwner(rule, owner));
  if (lists.length === 0) return allow('no connector allow list applies');
  const hit = lists.find(({ rule }) => rule.connectorKeys.includes(connectorKey));
  if (hit) return allow(`connector ${connectorKey} is on an allow list`);
  return deny(`connector ${connectorKey} is not on the organization's allow list for ${owner} connections`, lists[0].policy);
}

/** The principal kinds a use counts as, from the run context and the grant that allowed it. */
export function principalKindsOf(principal: UsePrincipal, context: UseContext = {}): ScopePrincipalKind[] {
  if (context.principalKinds?.length) return [...new Set(context.principalKinds)];
  const kinds = new Set<ScopePrincipalKind>();
  if (context.agentId ?? principal.agentId) kinds.add('agent');
  if (context.workspaceId ?? principal.workspaceId) kinds.add('workspace');
  const via = context.via?.principalType;
  if (via === 'team' || via === 'role') kinds.add(via);
  if (kinds.size === 0) kinds.add('user');
  return [...kinds];
}

function scopeApplies(rule: ScopeRule, kinds: ScopePrincipalKind[], environment: string | null | undefined): boolean {
  if (!rule.principalKinds.some((k) => kinds.includes(k))) return false;
  if (!rule.environments?.length) return true;
  if (!environment) return false;
  return rule.environments.includes(environment.trim().toLowerCase());
}

/**
 * May this connection be resolved for this principal in this run? Meant
 * to run right after the grant check allowed the use: a scope rule can
 * only narrow, never widen, what grants permit.
 */
export function evaluateUse(policies: PolicyLike[], connection: GovernedConnection, principal: UsePrincipal, context: UseContext = {}): PolicyDecision {
  const kinds = principalKindsOf(principal, context);
  const rules = enabled(policies, 'scope_rule').filter((p) => isScopeRule(p.rule));
  for (const policy of rules) {
    const rule = policy.rule as ScopeRule;
    if (!scopeApplies(rule, kinds, context.environment)) continue;
    const where = rule.environments?.length ? ` in ${rule.environments.join('/')}` : '';
    if (rule.requireOwner === 'org' && connection.ownerUserId) {
      return deny(`${kinds.join('/')} principals${where} may only use organization-scoped connections`, policy);
    }
    if (rule.approvedConnectorsOnly) {
      const approved = approvedConnectors(policies, 'org');
      const key = connection.connectorKey ?? '';
      if (!approved) return deny(`${kinds.join('/')} principals${where} may only use approved connectors, and no connector allow list is configured`, policy);
      if (!approved.has(key)) return deny(`connector ${key} is not on the organization's allow list`, policy);
    }
  }
  return allow(rules.length ? 'no scope rule refuses this use' : 'no scope rule applies');
}

function asDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const at = value instanceof Date ? value : new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** When the current secret was set: the last rotation, else creation. */
export function secretSetAt(connection: GovernedConnection): Date | null {
  const meta = connection.metadata ?? {};
  return asDate(meta.secretRotatedAt) ?? asDate(meta.rotatedAt) ?? asDate(connection.createdAt);
}

export function secretAgeDays(connection: GovernedConnection, now: Date): number | null {
  const at = secretSetAt(connection);
  if (!at) return null;
  return Math.floor((now.getTime() - at.getTime()) / DAY_MS);
}

/** The strictest enabled expiry rule (smallest maxAgeDays), or null. */
export function effectiveExpiryRule(policies: PolicyLike[]): { policy: PolicyLike; rule: ExpiryRule } | null {
  const rules = enabled(policies, 'expiry_rule').filter((p) => isExpiryRule(p.rule));
  if (!rules.length) return null;
  const policy = rules.reduce((best, p) => ((p.rule as ExpiryRule).maxAgeDays < (best.rule as ExpiryRule).maxAgeDays ? p : best));
  return { policy, rule: policy.rule as ExpiryRule };
}

/**
 * Which connections are past the org's maximum secret age (`expire`)
 * and which are inside the warning window (`warn`). Rows already
 * marked `expired` are left alone so a nightly run does not notify
 * twice.
 */
export function expiryActions(policies: PolicyLike[], connections: GovernedConnection[], now: Date = new Date()): ExpiryActions {
  const effective = effectiveExpiryRule(policies);
  if (!effective) return { warn: [], expire: [], enforce: false };
  const { policy, rule } = effective;
  const warn: ExpiryAction[] = [];
  const expire: ExpiryAction[] = [];
  for (const connection of connections) {
    if (connection.healthStatus === 'expired') continue;
    const setAt = secretSetAt(connection);
    if (!setAt) continue;
    const ageDays = Math.floor((now.getTime() - setAt.getTime()) / DAY_MS);
    const action: ExpiryAction = {
      connectionId: connection.id,
      connectorKey: connection.connectorKey ?? null,
      ownerUserId: connection.ownerUserId ?? null,
      ageDays,
      maxAgeDays: rule.maxAgeDays,
      expiresOn: new Date(setAt.getTime() + rule.maxAgeDays * DAY_MS),
      policyId: policy.id ?? null,
    };
    if (ageDays >= rule.maxAgeDays) expire.push(action);
    else if (ageDays >= rule.maxAgeDays - rule.warnDays) warn.push(action);
  }
  return { warn, expire, enforce: rule.enforce };
}

function rotationRuleFor(policies: PolicyLike[], connectorKey: string): { policy: PolicyLike; rule: RotationRule } | null {
  const rules = enabled(policies, 'rotation_rule')
    .filter((p) => isRotationRule(p.rule))
    .filter((p) => {
      const keys = (p.rule as RotationRule).connectorKeys;
      return !keys?.length || keys.includes(connectorKey);
    });
  if (!rules.length) return null;
  const policy = rules.reduce((best, p) => ((p.rule as RotationRule).everyDays < (best.rule as RotationRule).everyDays ? p : best));
  return { policy, rule: policy.rule as RotationRule };
}

function canRotateViaApi(capabilities: RotationCapabilities, connectorKey: string): boolean {
  if (typeof capabilities === 'function') return !!capabilities(connectorKey);
  return !!capabilities[connectorKey];
}

/**
 * Which connections are due for rotation under the strictest matching
 * rotation rule, split by whether the connector can rotate through the
 * provider's API (`due`) or the owner must do it by hand (`manual`).
 */
export function rotationDue(policies: PolicyLike[], connections: GovernedConnection[], capabilities: RotationCapabilities, now: Date = new Date()): RotationDue {
  const due: RotationCandidate[] = [];
  const manual: RotationCandidate[] = [];
  for (const connection of connections) {
    const connectorKey = connection.connectorKey ?? '';
    if (!connectorKey) continue;
    const match = rotationRuleFor(policies, connectorKey);
    if (!match) continue;
    const ageDays = secretAgeDays(connection, now);
    if (ageDays === null || ageDays < match.rule.everyDays) continue;
    const candidate: RotationCandidate = {
      connectionId: connection.id,
      connectorKey,
      ownerUserId: connection.ownerUserId ?? null,
      ageDays,
      everyDays: match.rule.everyDays,
      policyId: match.policy.id ?? null,
    };
    (canRotateViaApi(capabilities, connectorKey) ? due : manual).push(candidate);
  }
  return { due, manual };
}
