import { BadRequestException } from '@nestjs/common';

import {
  CONNECTION_POLICY_KINDS,
  ConnectionPolicyKind,
  ConnectionPolicyRule,
  ConnectorListRule,
  ExpiryRule,
  RotationRule,
  SCOPE_PRINCIPAL_KINDS,
  ScopePrincipalKind,
  ScopeRule,
} from '../../../src/entities/connection-policy.entity';

/**
 * Per-kind validation of a `connection_policies.rule` blob. Throws a
 * 400 with `code: CONNECTION_POLICY_INVALID` and the list of problems;
 * returns the normalised rule (trimmed, deduplicated keys, defaults
 * filled) so the stored shape is always canonical.
 */
export function validatePolicyRule(kind: ConnectionPolicyKind, rule: unknown): ConnectionPolicyRule {
  if (!CONNECTION_POLICY_KINDS.includes(kind)) {
    throw invalid([`kind must be one of ${CONNECTION_POLICY_KINDS.join(', ')}`]);
  }
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw invalid(['rule must be an object']);
  const input = rule as Record<string, unknown>;
  switch (kind) {
    case 'connector_allowlist':
    case 'connector_denylist':
      return connectorList(input);
    case 'scope_rule':
      return scopeRule(input);
    case 'expiry_rule':
      return expiryRule(input);
    case 'rotation_rule':
      return rotationRule(input);
    default:
      throw invalid([`unknown kind ${String(kind)}`]);
  }
}

export function isConnectorListRule(rule: ConnectionPolicyRule): rule is ConnectorListRule {
  return Array.isArray((rule as ConnectorListRule).connectorKeys) && !('everyDays' in rule);
}

export function isScopeRule(rule: ConnectionPolicyRule): rule is ScopeRule {
  return Array.isArray((rule as ScopeRule).principalKinds);
}

export function isExpiryRule(rule: ConnectionPolicyRule): rule is ExpiryRule {
  return typeof (rule as ExpiryRule).maxAgeDays === 'number';
}

export function isRotationRule(rule: ConnectionPolicyRule): rule is RotationRule {
  return typeof (rule as RotationRule).everyDays === 'number';
}

function invalid(errors: string[]): BadRequestException {
  return new BadRequestException({ code: 'CONNECTION_POLICY_INVALID', message: errors.join('; '), errors });
}

function keyList(value: unknown, field: string, errors: string[], required: boolean): string[] | undefined {
  if (value === undefined || value === null) {
    if (required) errors.push(`${field} is required`);
    return undefined;
  }
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array of connector keys`);
    return undefined;
  }
  const trimmed = value.map((v) => (typeof v === 'string' ? v.trim() : ''));
  if (trimmed.some((v) => v.length === 0)) errors.push(`${field} must contain non-empty unique strings`);
  const keys = [...new Set(trimmed.filter((v) => v.length > 0))];
  if (required && keys.length === 0) errors.push(`${field} must name at least one connector`);
  return keys;
}

function connectorList(input: Record<string, unknown>): ConnectorListRule {
  const errors: string[] = [];
  const connectorKeys = keyList(input.connectorKeys, 'connectorKeys', errors, true) ?? [];
  let owners: Array<'org' | 'user'> | undefined;
  if (input.owners !== undefined) {
    if (!Array.isArray(input.owners) || input.owners.some((o) => o !== 'org' && o !== 'user') || input.owners.length === 0) {
      errors.push("owners must be a non-empty array of 'org' | 'user'");
    } else {
      owners = [...new Set(input.owners as Array<'org' | 'user'>)];
    }
  }
  if (errors.length) throw invalid(errors);
  return owners ? { connectorKeys, owners } : { connectorKeys };
}

function scopeRule(input: Record<string, unknown>): ScopeRule {
  const errors: string[] = [];
  const kinds = input.principalKinds;
  let principalKinds: ScopePrincipalKind[] = [];
  if (!Array.isArray(kinds) || kinds.length === 0) {
    errors.push(`principalKinds must be a non-empty array of ${SCOPE_PRINCIPAL_KINDS.join(', ')}`);
  } else {
    const bad = kinds.filter((k) => !SCOPE_PRINCIPAL_KINDS.includes(k));
    if (bad.length) errors.push(`principalKinds contains unknown kinds: ${bad.join(', ')}`);
    principalKinds = [...new Set(kinds.filter((k) => SCOPE_PRINCIPAL_KINDS.includes(k)))] as ScopePrincipalKind[];
  }
  let environments: string[] | undefined;
  if (input.environments !== undefined) {
    if (!Array.isArray(input.environments) || input.environments.some((e) => typeof e !== 'string' || !e.trim())) {
      errors.push('environments must be an array of non-empty strings');
    } else {
      environments = [...new Set((input.environments as string[]).map((e) => e.trim().toLowerCase()))];
      if (environments.length === 0) errors.push('environments must name at least one environment when set');
    }
  }
  if (input.requireOwner !== 'org') errors.push("requireOwner must be 'org'");
  if (input.approvedConnectorsOnly !== undefined && typeof input.approvedConnectorsOnly !== 'boolean') {
    errors.push('approvedConnectorsOnly must be a boolean');
  }
  if (errors.length) throw invalid(errors);
  const out: ScopeRule = { principalKinds, requireOwner: 'org' };
  if (environments) out.environments = environments;
  if (input.approvedConnectorsOnly === true) out.approvedConnectorsOnly = true;
  return out;
}

function positiveInt(value: unknown, field: string, errors: string[], min = 1): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    errors.push(`${field} must be an integer >= ${min}`);
    return 0;
  }
  return value;
}

function expiryRule(input: Record<string, unknown>): ExpiryRule {
  const errors: string[] = [];
  const maxAgeDays = positiveInt(input.maxAgeDays, 'maxAgeDays', errors);
  const warnDays = positiveInt(input.warnDays, 'warnDays', errors, 0);
  if (!errors.length && warnDays >= maxAgeDays) errors.push('warnDays must be smaller than maxAgeDays');
  if (typeof input.enforce !== 'boolean') errors.push('enforce must be a boolean');
  if (errors.length) throw invalid(errors);
  return { maxAgeDays, warnDays, enforce: input.enforce as boolean };
}

function rotationRule(input: Record<string, unknown>): RotationRule {
  const errors: string[] = [];
  const everyDays = positiveInt(input.everyDays, 'everyDays', errors);
  const connectorKeys = keyList(input.connectorKeys, 'connectorKeys', errors, false);
  if (input.requireProviderApi !== true) errors.push('requireProviderApi must be true');
  if (errors.length) throw invalid(errors);
  const out: RotationRule = { everyDays, requireProviderApi: true };
  if (connectorKeys && connectorKeys.length) out.connectorKeys = connectorKeys;
  return out;
}
