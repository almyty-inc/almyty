import { BadRequestException } from '@nestjs/common';

/**
 * Push wakes (docs/always-on.md, "When a service tells it something
 * changed"): a service calls almyty the moment something changes, and the
 * always-on agent wakes within seconds instead of at its next timer.
 *
 * A push wake is data, like a connector: an inbound address per wake
 * source, one way of proving a call came from the service (a shared value
 * in a header, an HMAC signature, or a signed OIDC token), and optional
 * steps run as calls to the connection's own imported tools -- subscribe,
 * renew, stop, and "what changed". Nothing in code names a service; the
 * services almyty knows how to set up are presets (push-wake-presets.ts)
 * that fill these fields, and anyone can write the same for another.
 *
 * Every string below that says "template" may hold `{{path}}` placeholders
 * (push-wake-template.ts). What a template can read:
 *   endpoint.url, endpoint.id   the push address and the wake source's id
 *   secret                      the verification value (shared_token, hmac); never stored here
 *   settings.<key>              what the person filled in (the preset's fields)
 *   state.cursor                the last "what changed" position
 *   state.subscription.<key>    what the subscribe step kept (keep)
 *   uuid, now, nowMs            a fresh id, the time
 *   page                        the next page token while paging
 *   item.<field>                one changed item, in a detail call
 *   body, headers.<name>        the push itself (hmac signedContent only)
 */

export const PUSH_VERIFY_METHODS = ['shared_token', 'hmac', 'oidc_jwt'] as const;
export type PushVerifyMethod = (typeof PUSH_VERIFY_METHODS)[number];

/** The service sends a value almyty (or the person) chose, in a header. */
export interface SharedValueVerification {
  method: 'shared_token';
  /** The header it arrives in, e.g. the channel header a calendar service echoes. */
  headerName: string;
  /** true: almyty makes a random value when the wake source is created; false: the person pastes the service's. */
  generated: boolean;
}

/** The service signs each push with a key both sides hold. */
export interface HmacVerification {
  method: 'hmac';
  headerName: string;
  algorithm: 'sha1' | 'sha256' | 'sha512';
  encoding: 'hex' | 'base64';
  /** What comes before the digest in the header, e.g. "sha256=". */
  prefix?: string | null;
  /** What is signed (template over body and headers.<name>), e.g. "{{body}}" or "v0:{{headers.x-request-timestamp}}:{{body}}". */
  signedContent: string;
  /** A header with the send time in Unix seconds; with it, older pushes are refused. */
  timestampHeader?: string | null;
  /** How old a push may be, with timestampHeader. Default PUSH_WAKE_HMAC_TOLERANCE_SECONDS. */
  toleranceSeconds?: number | null;
}

/** The service sends a signed OIDC token as `Authorization: Bearer`. */
export interface OidcJwtVerification {
  method: 'oidc_jwt';
  /** Accepted `iss` values. */
  issuers: string[];
  /** Where the issuer publishes its signing keys (HTTPS). */
  jwksUrl: string;
  /** The `aud` it must carry (template). Empty: the push address. */
  audience?: string | null;
  /** Claims that must equal these values (templates), e.g. { email: '{{settings.pushServiceAccount}}' }. */
  claims?: Record<string, string>;
}

export type PushVerification = SharedValueVerification | HmacVerification | OidcJwtVerification;

/** A header that must hold one of these values (templates); otherwise the push is acknowledged and ignored. */
export interface PushHeaderRule {
  header: string;
  oneOf: string[];
}

/** One call to a tool of the wake source's API, named by the operation id its description gives. */
export interface PushToolCall {
  operation: string;
  /** Template. The grouped shape { path, query, header, body } is the one every API tool takes. */
  arguments: Record<string, any>;
}

export interface PushSubscribeStep extends PushToolCall {
  /** Where the answer says when the subscription ends (ms or s since 1970, or an ISO time). */
  expiresAtPath?: string | null;
  /** Values of the answer kept as state.subscription.<key> (for stop and for checks). Never a secret. */
  keep?: Record<string, string>;
  /** Where the answer gives a starting cursor; used only when there is none yet. */
  cursorPath?: string | null;
}

export interface PushRenewStep {
  /** Subscribe again this often. */
  everyMinutes?: number | null;
  /** Subscribe again this long before the subscription ends. */
  beforeExpiryMinutes?: number | null;
  /** Stop the previous subscription once the new one is made. */
  stopPrevious?: boolean;
}

export interface PushPagedCall extends PushToolCall {
  /** Where the next page token is in an answer; `page` carries it into the next call. */
  nextPagePath?: string | null;
  /** Most pages read in one go. */
  maxPages?: number | null;
}

export interface PushPrimeStep extends PushPagedCall {
  /** Where the answer gives the cursor to start from. */
  cursorPath: string;
}

export interface PushChangesStep extends PushPagedCall {
  /** The changed items in an answer; `[*]` walks a list, `[key=value]` picks from one. */
  itemsPath: string;
  /** Where the answer (its last page) gives the next cursor. */
  cursorPath: string;
  /** Statuses that mean the cursor is too old: it is started again with `prime`. */
  resetOnStatus?: number[];
  /** How to get a first cursor when there is none (or it was too old). */
  prime?: PushPrimeStep | null;
  /** What the agent is told about each item: field -> path in the item. Keep it to ids, names and times. */
  item: Record<string, string>;
  /** An extra read per item (up to maxDetails), for fields the list does not carry. */
  detail?: (PushToolCall & { fields: Record<string, string> }) | null;
  maxItems?: number | null;
  maxDetails?: number | null;
}

/** Everything a push wake does, as data. */
export interface PushWakeSpec {
  verification: PushVerification;
  checks?: PushHeaderRule[];
  /** Pushes that are acknowledged and never wake it (a "sync" hello, a heartbeat). */
  ignore?: PushHeaderRule[];
  subscribe?: PushSubscribeStep | null;
  renew?: PushRenewStep | null;
  stop?: PushToolCall | null;
  changes?: PushChangesStep | null;
  /**
   * What the subscribe step subscribes to, for sharing (template over
   * settings.<key>). Agents that subscribe the same connection to the same
   * resource with the same spec share one subscription, since a service may
   * allow one per resource (one watch per mailbox). A constant means one per
   * connection. Empty: all the settings.
   */
  resourceKey?: string | null;
  /** The wake's line (template over count, first.<field>, name). */
  summary: string;
}

/** A field the person fills in for a preset; read in templates as settings.<key>. */
export interface PushPresetField {
  key: string;
  label: string;
  placeholder?: string;
  help?: string;
  required?: boolean;
  default?: string;
  /** A pattern the value must match. */
  pattern?: string;
}

/** One setup step shown on the page: words, and optionally a command to copy and where it is in the service's console. */
export interface PushSetupStep {
  text: string;
  /** Template over endpoint.url and settings.<key>. */
  command?: string;
  consolePath?: string;
}

/** A ready-made push wake for a service (catalog data). */
export interface PushWakePreset {
  key: string;
  name: string;
  /** "When something changes in ..." as the wake list says it. */
  description: string;
  /** Operation ids the connection's API has to have; an API missing one is not offered. */
  operations: string[];
  /** Where to import the API from, when none is connected yet. */
  apiHint?: string;
  fields: PushPresetField[];
  setup: PushSetupStep[];
  spec: PushWakeSpec;
  debounceSeconds?: number;
}

/** Where a wake source stands, as the page shows it (the way connections show health). */
export const PUSH_WAKE_HEALTH = ['valid', 'failed', 'expired', 'unknown'] as const;
export type PushWakeHealth = (typeof PUSH_WAKE_HEALTH)[number];

/** Its debounce window when it names none: PUSH_WAKE_DEBOUNCE_SECONDS, else 10. */
export function defaultDebounceSeconds(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.PUSH_WAKE_DEBOUNCE_SECONDS);
  return Number.isInteger(n) && n >= 0 && n <= MAX_DEBOUNCE_SECONDS ? n : 10;
}
export const MAX_DEBOUNCE_SECONDS = 3600;

/** How often subscriptions are looked at for renewal: PUSH_WAKE_RENEW_SWEEP_MINUTES, else 15. */
export function renewSweepMinutes(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.PUSH_WAKE_RENEW_SWEEP_MINUTES);
  return Number.isInteger(n) && n > 0 ? n : 15;
}

/** How old a timestamped HMAC push may be: PUSH_WAKE_HMAC_TOLERANCE_SECONDS, else 300. */
export function hmacToleranceSeconds(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.PUSH_WAKE_HMAC_TOLERANCE_SECONDS);
  return Number.isInteger(n) && n > 0 ? n : 300;
}

/** Most items and detail reads one push turns into, unless the spec says fewer. */
export const MAX_PUSH_ITEMS = 25;
export const MAX_PUSH_DETAILS = 10;
export const MAX_PUSH_PAGES = 50;

const HEADER_RE = /^[A-Za-z0-9-]{1,100}$/;
const OPERATION_RE = /^[A-Za-z0-9_.:/-]{1,200}$/;
const PATH_RE = /^[A-Za-z0-9_$@.\-[\]*=: ]{1,300}$/;

function refuse(message: string): never {
  throw new BadRequestException(message);
}

function str(value: unknown, what: string, max = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) refuse(`${what} is missing or too long.`);
  return value as string;
}

function optionalPath(value: unknown, what: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !PATH_RE.test(value)) refuse(`${what} is not a path like items[*].id.`);
  return value as string;
}

function positive(value: unknown, what: string, max: number): number | null {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) refuse(`${what} has to be a whole number from 1 to ${max}.`);
  return n;
}

function pathMap(value: unknown, what: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) refuse(`${what} has to map names to paths.`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(k)) refuse(`${what}: "${k}" is not a plain name.`);
    out[k] = optionalPath(v, `${what}.${k}`) ?? refuse(`${what}.${k} needs a path.`);
  }
  return out;
}

function toolCall(value: any, what: string): PushToolCall {
  if (!value || typeof value !== 'object') refuse(`${what} needs an operation and its arguments.`);
  if (typeof value.operation !== 'string' || !OPERATION_RE.test(value.operation)) refuse(`${what} needs the operation id of a tool of the connection.`);
  const args = value.arguments ?? {};
  if (typeof args !== 'object' || Array.isArray(args)) refuse(`${what}: arguments have to be an object.`);
  if (JSON.stringify(args).length > 8000) refuse(`${what}: arguments are too long.`);
  return { operation: value.operation, arguments: args };
}

function paged(value: any, what: string): PushPagedCall {
  return {
    ...toolCall(value, what),
    nextPagePath: optionalPath(value.nextPagePath, `${what}: the next page`),
    maxPages: positive(value.maxPages, `${what}: most pages`, MAX_PUSH_PAGES),
  };
}

function headerRules(value: unknown, what: string): PushHeaderRule[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 10) refuse(`${what} has to be a short list.`);
  return (value as any[]).map((r) => {
    if (!r || typeof r.header !== 'string' || !HEADER_RE.test(r.header)) refuse(`${what}: each rule needs a header name.`);
    if (!Array.isArray(r.oneOf) || !r.oneOf.length || r.oneOf.some((v: unknown) => typeof v !== 'string' || v.length > 500)) {
      refuse(`${what}: each rule needs the values it accepts.`);
    }
    return { header: r.header.toLowerCase(), oneOf: r.oneOf };
  });
}

function verification(value: any): PushVerification {
  if (!value || !(PUSH_VERIFY_METHODS as readonly string[]).includes(value.method)) {
    refuse('Choose how a push proves it came from the service: a shared value, an HMAC signature or a signed token.');
  }
  if (value.method === 'shared_token') {
    if (typeof value.headerName !== 'string' || !HEADER_RE.test(value.headerName)) refuse('Name the header the shared value arrives in.');
    return { method: 'shared_token', headerName: value.headerName.toLowerCase(), generated: value.generated !== false };
  }
  if (value.method === 'hmac') {
    if (typeof value.headerName !== 'string' || !HEADER_RE.test(value.headerName)) refuse('Name the header the signature arrives in.');
    if (!['sha1', 'sha256', 'sha512'].includes(value.algorithm)) refuse('The signature algorithm is sha1, sha256 or sha512.');
    if (!['hex', 'base64'].includes(value.encoding)) refuse('The signature is hex or base64.');
    if (value.timestampHeader !== undefined && value.timestampHeader !== null && (typeof value.timestampHeader !== 'string' || !HEADER_RE.test(value.timestampHeader))) {
      refuse('The timestamp header is not a header name.');
    }
    return {
      method: 'hmac',
      headerName: value.headerName.toLowerCase(),
      algorithm: value.algorithm,
      encoding: value.encoding,
      prefix: typeof value.prefix === 'string' ? value.prefix.slice(0, 40) : null,
      signedContent: str(value.signedContent ?? '{{body}}', 'What is signed', 500),
      timestampHeader: value.timestampHeader ? value.timestampHeader.toLowerCase() : null,
      toleranceSeconds: positive(value.toleranceSeconds, 'How old a signed push may be', 86_400),
    };
  }
  const issuers = Array.isArray(value.issuers) ? value.issuers.filter((i: unknown) => typeof i === 'string' && i.trim()) : [];
  if (!issuers.length || issuers.length > 5) refuse('Name the issuer the signed token comes from.');
  let jwks: URL | null = null;
  try {
    jwks = new URL(String(value.jwksUrl ?? ''));
  } catch {
    jwks = null;
  }
  if (!jwks || jwks.protocol !== 'https:') refuse('Enter the HTTPS address of the issuer\'s signing keys.');
  const claims: Record<string, string> = {};
  for (const [k, v] of Object.entries((value.claims ?? {}) as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_.:-]{0,60}$/.test(k) || typeof v !== 'string' || v.length > 500) refuse(`The claim "${k}" is not a name and a value.`);
    claims[k] = v as string;
  }
  return {
    method: 'oidc_jwt',
    issuers,
    jwksUrl: jwks!.toString(),
    audience: typeof value.audience === 'string' && value.audience.trim() ? value.audience.trim() : null,
    claims,
  };
}

/** A spec as a person (or a preset) sent it, checked. */
export function checkSpec(raw: unknown): PushWakeSpec {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) refuse('Describe the push wake.');
  const v = raw as Record<string, any>;
  const spec: PushWakeSpec = {
    verification: verification(v.verification),
    checks: headerRules(v.checks, 'Checks'),
    ignore: headerRules(v.ignore, 'Ignored pushes'),
    subscribe: null,
    renew: null,
    stop: null,
    changes: null,
    summary: str(v.summary ?? 'Something changed', 'The wake line', 300),
    resourceKey: v.resourceKey === undefined || v.resourceKey === null || v.resourceKey === '' ? null : str(v.resourceKey, 'What it subscribes to', 300),
  };
  if (v.subscribe) {
    spec.subscribe = {
      ...toolCall(v.subscribe, 'Subscribe'),
      expiresAtPath: optionalPath(v.subscribe.expiresAtPath, 'Subscribe: when it ends'),
      keep: pathMap(v.subscribe.keep, 'Subscribe: what it keeps'),
      cursorPath: optionalPath(v.subscribe.cursorPath, 'Subscribe: the starting cursor'),
    };
  }
  if (v.renew) {
    if (!spec.subscribe) refuse('Renewing needs a subscribe step.');
    spec.renew = {
      everyMinutes: positive(v.renew.everyMinutes, 'Renew every', 60 * 24 * 30),
      beforeExpiryMinutes: positive(v.renew.beforeExpiryMinutes, 'Renew before it ends', 60 * 24 * 7),
      stopPrevious: v.renew.stopPrevious === true,
    };
    if (!spec.renew.everyMinutes && !spec.renew.beforeExpiryMinutes) refuse('Say when to renew: every so many minutes, or before it ends.');
    if (spec.renew.beforeExpiryMinutes && !spec.subscribe.expiresAtPath) refuse('Renewing before it ends needs to know where the answer says when it ends.');
  }
  if (v.stop) spec.stop = toolCall(v.stop, 'Stop');
  if (v.changes) {
    const c = v.changes;
    const resetOnStatus = Array.isArray(c.resetOnStatus)
      ? c.resetOnStatus.map(Number).filter((n: number) => Number.isInteger(n) && n >= 400 && n < 600)
      : [];
    spec.changes = {
      ...paged(c, 'What changed'),
      itemsPath: optionalPath(c.itemsPath, 'What changed: the items') ?? refuse('What changed needs the path of the items.'),
      cursorPath: optionalPath(c.cursorPath, 'What changed: the cursor') ?? refuse('What changed needs the path of the next cursor.'),
      resetOnStatus,
      prime: c.prime
        ? {
            ...paged(c.prime, 'First cursor'),
            cursorPath: optionalPath(c.prime.cursorPath, 'First cursor: the cursor') ?? refuse('The first cursor step needs the path of the cursor.'),
          }
        : null,
      item: pathMap(c.item, 'What changed: item fields'),
      detail: c.detail ? { ...toolCall(c.detail, 'Item detail'), fields: pathMap(c.detail.fields, 'Item detail: fields') } : null,
      maxItems: positive(c.maxItems, 'Most items', MAX_PUSH_ITEMS),
      maxDetails: positive(c.maxDetails, 'Most detail reads', MAX_PUSH_DETAILS),
    };
    if (!Object.keys(spec.changes.item).length) refuse('Say what the agent is told about each changed item.');
  }
  if (JSON.stringify(spec).length > 32_000) refuse('The push wake is too long.');
  return spec;
}

/** Settings a person filled in, checked against the preset's fields (or free keys for a custom one). */
export function checkSettings(raw: unknown, fields: PushPresetField[] | null): Record<string, string> {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  if (fields) {
    for (const f of fields) {
      const value = typeof input[f.key] === 'string' ? (input[f.key] as string).trim() : '';
      const v = value || f.default || '';
      if (!v && f.required) refuse(`Enter ${f.label.toLowerCase()}.`);
      if (v && v.length > 500) refuse(`${f.label} is too long.`);
      if (v && f.pattern && !new RegExp(f.pattern).test(v)) refuse(`${f.label} does not look right${f.placeholder ? `; it looks like ${f.placeholder}` : ''}.`);
      if (v) out[f.key] = v;
    }
    return out;
  }
  for (const [k, v] of Object.entries(input)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(k)) refuse(`"${k}" is not a plain setting name.`);
    if (typeof v !== 'string' || v.length > 500) refuse(`The setting "${k}" has to be short text.`);
    out[k] = v.trim();
  }
  if (Object.keys(out).length > 20) refuse('Too many settings.');
  return out;
}
