import {
  CONNECT_METHOD_TYPES,
  CONNECTOR_KINDS,
  ConnectMethod,
  ConnectorDefinition,
  JsonSchemaObject,
  REDIRECT_METHODS,
  VALIDATION_KINDS,
} from './connector.types';

/**
 * The small JSON-schema subset ConnectMethod forms use: flat objects of
 * string / number / boolean properties with `required`, `enum`,
 * `pattern`, length bounds and `x-secret`. Returns human-readable
 * violations; empty when the input is acceptable.
 */
export function schemaViolations(input: unknown, schema: JsonSchemaObject | undefined): string[] {
  if (!schema) return [];
  if (input == null || typeof input !== 'object' || Array.isArray(input)) return ['input must be an object'];
  const values = input as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of schema.required ?? []) {
    const v = values[key];
    if (v === undefined || v === null || v === '') errors.push(`${key} is required`);
  }
  for (const [key, prop] of Object.entries(schema.properties)) {
    const v = values[key];
    if (v === undefined || v === null || v === '') continue;
    if (prop.type === 'string') {
      if (typeof v !== 'string') { errors.push(`${key} must be a string`); continue; }
      if (prop.minLength !== undefined && v.length < prop.minLength) errors.push(`${key} is too short`);
      if (prop.maxLength !== undefined && v.length > prop.maxLength) errors.push(`${key} is too long`);
      if (prop.pattern && !new RegExp(prop.pattern).test(v)) errors.push(`${key} has an unexpected format`);
      if (prop.format === 'uri') {
        try { new URL(v); } catch { errors.push(`${key} must be a URL`); }
      }
    } else if (prop.type === 'integer' || prop.type === 'number') {
      if (typeof v !== 'number' || Number.isNaN(v)) { errors.push(`${key} must be a number`); continue; }
      if (prop.type === 'integer' && !Number.isInteger(v)) errors.push(`${key} must be an integer`);
    } else if (prop.type === 'boolean') {
      if (typeof v !== 'boolean') errors.push(`${key} must be a boolean`);
    }
    if (prop.enum && !prop.enum.includes(v)) errors.push(`${key} must be one of ${prop.enum.join(', ')}`);
  }
  for (const key of Object.keys(values)) {
    if (!(key in schema.properties)) errors.push(`${key} is not a known field`);
  }
  return errors;
}

/** Names of the `x-secret` properties of a form schema. */
export function secretFieldsOf(schema: JsonSchemaObject | undefined): string[] {
  if (!schema) return [];
  return Object.entries(schema.properties).filter(([, p]) => p['x-secret'] === true).map(([k]) => k);
}

/** Splits form values into secret and plain parts according to the schema. */
export function splitSecrets(values: Record<string, unknown>, schema: JsonSchemaObject | undefined): { secrets: Record<string, string>; plain: Record<string, unknown> } {
  const secretKeys = new Set(secretFieldsOf(schema));
  const secrets: Record<string, string> = {};
  const plain: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || v === null || v === '') continue;
    if (secretKeys.has(k)) secrets[k] = String(v);
    else plain[k] = v;
  }
  return { secrets, plain };
}

/** `{{field}}` substitution from non-secret values; unknown fields become empty strings. */
export function interpolate(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_m, name: string) => {
    const v = values[name];
    return v === undefined || v === null ? '' : String(v);
  });
}

/** Reads a dot path (`data.label`, `account.email`) from a JSON value. */
export function readPath(value: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  let cur: any = value;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function schemaShapeViolations(schema: unknown, where: string): string[] {
  if (schema === undefined) return [];
  const errors: string[] = [];
  const s = schema as JsonSchemaObject;
  if (!s || typeof s !== 'object' || s.type !== 'object' || !s.properties || typeof s.properties !== 'object') {
    return [`${where}: schema must be an object schema with properties`];
  }
  for (const [name, prop] of Object.entries(s.properties)) {
    if (!prop || typeof prop !== 'object') { errors.push(`${where}: property ${name} must be an object`); continue; }
    if (!['string', 'integer', 'number', 'boolean'].includes(prop.type)) errors.push(`${where}: property ${name} has unsupported type ${String(prop.type)}`);
    if (prop.pattern) {
      try { new RegExp(prop.pattern); } catch { errors.push(`${where}: property ${name} has an invalid pattern`); }
    }
  }
  for (const r of s.required ?? []) {
    if (!(r in s.properties)) errors.push(`${where}: required field ${r} is not a property`);
  }
  return errors;
}

function isHttpsOrHttp(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function methodViolations(method: ConnectMethod, where: string): string[] {
  const errors: string[] = [];
  if (!method || typeof method !== 'object') return [`${where}: method must be an object`];
  if (!CONNECT_METHOD_TYPES.includes(method.type)) errors.push(`${where}: unknown method type ${String(method.type)}`);
  errors.push(...schemaShapeViolations(method.schema, where));
  if (method.type === 'oauth2_pkce' || method.type === 'oauth2_code') {
    if (!method.oauth) errors.push(`${where}: ${method.type} needs oauth endpoints`);
    else {
      if (!isHttpsOrHttp(method.oauth.authorizeUrl)) errors.push(`${where}: oauth.authorizeUrl must be http(s)`);
      if (!isHttpsOrHttp(method.oauth.tokenUrl)) errors.push(`${where}: oauth.tokenUrl must be http(s)`);
      if (method.type === 'oauth2_pkce' && method.oauth.pkce === false) errors.push(`${where}: oauth2_pkce must keep pkce on`);
    }
  }
  if (!REDIRECT_METHODS.includes(method.type) && !method.schema) {
    errors.push(`${where}: ${method.type} needs a form schema`);
  }
  if (method.type === 'cloud_iam' && method.quickCreate && !isHttpsOrHttp(method.quickCreate.templateUrl)) {
    errors.push(`${where}: quickCreate.templateUrl must be http(s)`);
  }
  return errors;
}

/**
 * Structural check for a connector definition: built-in catalog entries
 * are tested against it, org-defined connectors are rejected on POST
 * /connectors when it reports anything.
 */
export function validateConnectorDefinition(def: unknown): string[] {
  const errors: string[] = [];
  const d = def as ConnectorDefinition;
  if (!d || typeof d !== 'object') return ['connector must be an object'];
  if (typeof d.key !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(d.key)) errors.push('key must be lowercase letters, digits and dashes (2-64 chars)');
  if (!CONNECTOR_KINDS.includes(d.kind)) errors.push(`kind must be one of ${CONNECTOR_KINDS.join(', ')}`);
  if (typeof d.displayName !== 'string' || d.displayName.trim().length === 0 || d.displayName.length > 120) errors.push('displayName is required (max 120 chars)');
  if (!Array.isArray(d.connect) || d.connect.length === 0) errors.push('connect must list at least one method');
  else d.connect.forEach((m, i) => errors.push(...methodViolations(m, `connect[${i}]`)));
  if (!d.validation || typeof d.validation !== 'object' || !(VALIDATION_KINDS as readonly string[]).includes(d.validation.kind)) {
    errors.push(`validation.kind must be one of ${VALIDATION_KINDS.join(', ')}`);
  } else if (d.validation.kind === 'http') {
    if (typeof d.validation.url !== 'string' || d.validation.url.length === 0) errors.push('validation.url is required for http validation');
    else if (!/^\{\{/.test(d.validation.url) && !isHttpsOrHttp(d.validation.url)) errors.push('validation.url must be http(s) or start with a {{field}} template');
  } else if (d.validation.kind === 'oauth2_client_credentials') {
    if (typeof d.validation.tokenUrl !== 'string') errors.push('validation.tokenUrl is required');
    if (typeof d.validation.scope !== 'string') errors.push('validation.scope is required');
  }
  if (d.revoke) {
    if (d.revoke.kind !== 'http' || typeof d.revoke.url !== 'string') errors.push('revoke must be an http probe');
  }
  for (const urlField of ['keyPageUrl', 'docsUrl'] as const) {
    const v = d[urlField];
    if (v !== undefined && v !== null && !isHttpsOrHttp(v)) errors.push(`${urlField} must be http(s)`);
  }
  return errors;
}
