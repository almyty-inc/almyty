import {
  Plugin,
  PluginHookType,
  PluginContext,
  PluginResult,
} from '../types/plugin.types';
import { compileSafeRegex, boundRegexInput } from '../../../common/security/regex-safety';
import { matchEmailAddresses } from './pii-filter.matchers';

/**
 * Categorised PII patterns. Each entry is matched against string values only
 * when the corresponding `detect*` setting is enabled — the previous shape
 * iterated a flat array unconditionally and silently ignored the documented
 * feature toggles.
 */
interface PatternEntry {
  setting: keyof DetectSettings;
  /** A regex, or a linear matcher returning what `text.match(regex)` would. */
  pattern: RegExp | ((text: string) => string[] | null);
  name: string;
}

interface DetectSettings {
  detectCreditCards: boolean;
  detectSSN: boolean;
  detectEmails: boolean;
  detectPhoneNumbers: boolean;
  detectIPAddresses: boolean;
}

/** Upper bound on modifications array + recursion depth. */
const MAX_MODIFICATIONS = 500;
const MAX_DEPTH = 100;

/** ReDoS bound: if a single custom-pattern match() takes longer than this, bail. */
const CUSTOM_PATTERN_BUDGET_MS = 50;

/**
 * Field names that hold a time: `created`, `arrival_date`, `available_on`,
 * `period_start`, `createdAt`, `expires`, `ts`. A ten-digit number in one
 * is a Unix time, not a phone number. Settable per organization as
 * `timestampFieldPattern`; `keepUnixTimestamps: false` masks them again.
 */
export const DEFAULT_TIMESTAMP_FIELD_PATTERN =
  '(^|[_.-])(date|time|timestamp|ts|at|on|created|updated|modified|deleted|expires?|expiry|start|end|since|until|from|to)$|(At|On|Date|Time|Timestamp|Start|End|Since|Until)$';

/** Unix seconds a phone-shaped number may be read as: 2001-09-09 to 2100-01-01. */
const UNIX_TIME_MIN = 1_000_000_000;
const UNIX_TIME_MAX = 4_102_444_800;

/** How far before a number its key is looked for in text (`"created": 1696204800`). */
const KEY_LOOKBEHIND = 64;

const ISO_DATE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

function timestampFieldRegex(settings: any): RegExp | null {
  const source = typeof settings?.timestampFieldPattern === 'string' && settings.timestampFieldPattern
    ? settings.timestampFieldPattern
    : DEFAULT_TIMESTAMP_FIELD_PATTERN;
  return compileSafeRegex(source).regex ?? null;
}

/**
 * True when `match` (a phone-pattern hit at `offset` in `text`) is a
 * plausible Unix time where a time is meant: ten bare digits in range,
 * and either the field it sits in, the key written just before it, or an
 * ISO date next to it says it is a time. A number with separators
 * (555-123-4567) or under a key like `phone` is never one.
 */
export function isUnixTimeInContext(match: string, text: string, offset: number, field: string | undefined, settings: any): boolean {
  if (settings?.keepUnixTimestamps === false) return false;
  if (!/^\d{10}$/.test(match)) return false;
  const n = Number(match);
  if (n < UNIX_TIME_MIN || n > UNIX_TIME_MAX) return false;
  const timeField = timestampFieldRegex(settings);
  if (!timeField) return false;
  if (field && text.trim() === match && timeField.test(field)) return true;
  const before = text.slice(Math.max(0, offset - KEY_LOOKBEHIND), offset);
  const key = /["']?([A-Za-z0-9_.-]+)["']?\s*[:=]\s*["']?$/.exec(before)?.[1];
  if (key) return timeField.test(key);
  const around = text.slice(Math.max(0, offset - KEY_LOOKBEHIND), offset + match.length + KEY_LOOKBEHIND);
  return ISO_DATE.test(around);
}

export class PiiFilterPlugin {
  private readonly piiPatterns: PatternEntry[] = [
    { setting: 'detectCreditCards',  name: 'credit_card', pattern: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g },
    { setting: 'detectSSN',          name: 'ssn',         pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
    // Linear matcher for the regex /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    // which took seconds on 100 KB of `a.a.a.` (pii-filter.matchers.ts).
    { setting: 'detectEmails',       name: 'email',       pattern: matchEmailAddresses },
    { setting: 'detectPhoneNumbers', name: 'phone',       pattern: /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g },
    { setting: 'detectIPAddresses',  name: 'ip',          pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
  ];

  getPluginDefinition(): Omit<Plugin, 'id' | 'metadata'> {
    return {
      name: 'PII Filter',
      version: '1.0.0',
      description: 'Automatically detects and filters personally identifiable information (PII) from requests and responses',
      author: 'almyty',
      // Off by default, unlike the other built-ins. With the
      // PRE_TOOL_EXECUTION hook registered, an active PII filter rewrites
      // tool PARAMETERS -- so `send_email(to: 'alice@example.com')` would
      // deliver to '****@example.com' and `lookup_by_ip` would be handed a
      // masked address. The tool call still succeeds, which makes it worse:
      // the failure is silent and looks like the tool misbehaving.
      //
      // An organization that wants it turns it on, and a compliance policy
      // that enforces it runs it regardless -- executeHook's enforcement
      // gate is `!plugin.isActive && enforcedSettings === undefined`, so
      // enforcement overrides this. Masking outbound requests and responses
      // is the uncontroversial case; masking inputs the caller chose is not,
      // and is not a default anyone opted into.
      isActive: false,
      configuration: {
        enabled: true,
        priority: 90, // High priority for security
        settings: {
          maskCharacter: '*',
          detectEmails: true,
          detectCreditCards: true,
          detectSSN: true,
          detectPhoneNumbers: true,
          detectIPAddresses: true,
          // A ten-digit Unix time in a time-named field is not a phone number.
          keepUnixTimestamps: true,
          timestampFieldPattern: DEFAULT_TIMESTAMP_FIELD_PATTERN,
          customPatterns: [],
          logDetections: true,
        },
      },
      capabilities: {
        hooks: [
          PluginHookType.PRE_REQUEST,
          PluginHookType.POST_RESPONSE,
          PluginHookType.DATA_FILTER,
        ],
        protocols: ['mcp', 'utcp', 'a2a', 'http'],
        dataFormats: ['json', 'xml', 'yaml'],
        operations: ['read', 'transform'],
      },
      hooks: [
        {
          type: PluginHookType.PRE_REQUEST,
          handler: 'filterPiiFromRequest',
          async: false,
          timeout: 5000,
        },
        {
          type: PluginHookType.POST_RESPONSE,
          handler: 'filterPiiFromResponse',
          async: false,
          timeout: 5000,
        },
        {
          // No PRE_TOOL_EXECUTION entry: a tool gets the real values it is
          // called with (a calendar id, an address to search mail for), or
          // it works on the wrong thing. Personal data is hidden in what is
          // kept and what goes out -- execution records, the audit log,
          // answers to outside callers -- through DATA_FILTER, which
          // ToolExecutorService.hidePersonalData runs.
          type: PluginHookType.DATA_FILTER,
          handler: 'filterPiiFromData',
          async: false,
          timeout: 5000,
        },
      ],
    };
  }

  async filterPiiFromRequest(context: PluginContext, settings: any): Promise<PluginResult> {
    const startTime = Date.now();
    const modifications: string[] = [];
    // Cycle-detection set: previously a self-referencing object would
    // infinite-loop the recursive walker and tank the plugin worker.
    const seen = new WeakSet<object>();

    try {
      const filteredData = this.filterPiiFromObject(context.data, settings, modifications, seen, 0);

      const logs =
        settings?.logDetections !== false && modifications.length > 0
          ? [
              {
                level: 'info' as const,
                message: `Filtered ${modifications.length} PII instances from request`,
                timestamp: new Date().toISOString(),
              },
            ]
          : [];

      return {
        success: true,
        data: filteredData,
        metadata: {
          executionTime: Date.now() - startTime,
          // Honour logDetections: false by dropping the per-match breadcrumbs
          // from the modifications array. Previously the setting was
          // documented but never read.
          modifications: settings?.logDetections !== false ? modifications : [],
          logs,
        },
      };

    } catch (error) {
      return {
        success: false,
        data: context.data,
        error: {
          code: 'PII_FILTER_ERROR',
          message: error.message,
        },
        metadata: {
          executionTime: Date.now() - startTime,
          modifications: [],
        },
      };
    }
  }

  async filterPiiFromResponse(context: PluginContext, settings: any): Promise<PluginResult> {
    return this.filterPiiFromRequest(context, settings); // Same logic
  }

  async filterPiiFromData(context: PluginContext, settings: any): Promise<PluginResult> {
    return this.filterPiiFromRequest(context, settings); // Same logic
  }

  private filterPiiFromObject(
    obj: any,
    settings: any,
    modifications: string[],
    seen: WeakSet<object>,
    depth: number,
    /** The key the value sits under, if any: a time-named field keeps its Unix times. */
    field?: string,
  ): any {
    if (typeof obj === 'string') {
      // Track whether the string was actually modified so the caller's
      // parent-key bookkeeping doesn't false-positive on untouched strings.
      const before = obj;
      const after = this.filterPiiFromString(obj, settings, modifications, field);
      if (after !== before) {
        // The per-match breadcrumbs have already been pushed by
        // filterPiiFromString; we don't double-count here.
      }
      return after;
    }

    // Primitives (number/boolean/null/undefined/bigint/symbol) pass through.
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }

    // Depth bound. filterPiiFromObject recurses arbitrarily deep into nested
    // data, which on a pathological input could blow the stack. 100 levels
    // is well beyond realistic API payloads.
    if (depth >= MAX_DEPTH) {
      return obj;
    }

    // Cycle guard. A self-referencing object (or diamond) would otherwise
    // infinite-loop the walker — not theoretical: tool parameters can
    // round-trip ORM entities with back-references.
    if (seen.has(obj)) {
      return obj;
    }
    seen.add(obj);

    if (Array.isArray(obj)) {
      let anyChanged = false;
      const out = obj.map((item, index) => {
        const filtered = this.filterPiiFromObject(item, settings, modifications, seen, depth + 1, field);
        // For primitives the reference check is a correct "was it
        // modified" signal; for objects/arrays we always allocated a new
        // container, so this SAME check used to false-positive. Gate the
        // parent-key push on a real string-level change.
        if (typeof item === 'string' && filtered !== item) {
          anyChanged = true;
          if (modifications.length < MAX_MODIFICATIONS) {
            modifications.push(`array[${index}]`);
          }
        } else if (typeof item !== 'string' && filtered !== item) {
          anyChanged = true;
        }
        return filtered;
      });
      return anyChanged ? out : obj;
    }

    let anyChanged = false;
    const filtered: any = {};
    for (const [key, value] of Object.entries(obj)) {
      const filteredValue = this.filterPiiFromObject(value, settings, modifications, seen, depth + 1, key);
      if (typeof value === 'string' && filteredValue !== value) {
        anyChanged = true;
        if (modifications.length < MAX_MODIFICATIONS) {
          modifications.push(key);
        }
      } else if (typeof value !== 'string' && filteredValue !== value) {
        anyChanged = true;
      }
      filtered[key] = filteredValue;
    }
    return anyChanged ? filtered : obj;
  }

  private filterPiiFromString(text: string, settings: any, modifications: string[], field?: string): string {
    let filteredText = text;
    const maskChar = settings.maskCharacter || '*';
    const mask = (match: string) => {
      if (modifications.length < MAX_MODIFICATIONS) {
        modifications.push(`PII detected and masked: ${match.slice(0, 2)}...`);
      }
      return maskChar.repeat(Math.max(4, match.length - 4)) + match.slice(-4);
    };

    // Honour the per-category detect* toggles. The previous shape iterated
    // a flat pattern array with no lookup, so `detectEmails: false` had
    // zero effect.
    for (const entry of this.piiPatterns) {
      if (settings && settings[entry.setting] === false) continue;

      if (entry.pattern instanceof RegExp) {
        // A ten-digit Unix time where a time is meant (a `created` field,
        // `"arrival_date": 1696204800` in a tool's text, next to an ISO
        // date) reads like a phone number to the pattern but is not one.
        filteredText = filteredText.replace(entry.pattern, (match: string, offset: number, whole: string) =>
          entry.name === 'phone' && isUnixTimeInContext(match, whole, offset, field, settings) ? match : mask(match),
        );
        continue;
      }

      const matches = entry.pattern(filteredText);
      if (!matches) continue;

      for (const match of matches) {
        filteredText = filteredText.replace(match, mask(match));
      }
    }

    // Custom patterns with layered ReDoS defenses. Previously this had
    // only a wall-clock budget that measured AFTER the match, so a
    // single pathological `(a+)+b` against a long input could still
    // hang the plugin worker for the duration of that first match —
    // the bail just prevented the *next* patterns from making it
    // worse. That's not good enough.
    //
    // We now route every custom pattern through the shared regex-safety
    // helper (same one gateway-auth uses) which does three things
    // synchronously before the engine ever runs:
    //
    //  1) caps the pattern source length
    //  2) rejects known catastrophic-backtracking shapes (nested
    //     quantifiers, overlapping alternations in a quantified group)
    //  3) bounds the probed input length
    //
    // The post-match wall-clock budget stays as a final belt-and-braces
    // guard in case a pattern that slipped past the heuristic is still
    // slow — bail out of the rest of the custom-patterns loop rather
    // than keep burning CPU.
    if (settings?.customPatterns && Array.isArray(settings.customPatterns)) {
      const probe = boundRegexInput(filteredText);
      for (const customPattern of settings.customPatterns) {
        const compiled = compileSafeRegex(customPattern, { flags: 'g' });
        if (!compiled.regex) {
          continue; // refused up front — keep going with the next pattern
        }

        const started = Date.now();
        let matches: RegExpMatchArray | null = null;
        try {
          matches = probe.match(compiled.regex);
        } catch {
          continue;
        }
        if (Date.now() - started > CUSTOM_PATTERN_BUDGET_MS) {
          // Final fallback: something slow got through anyway. Bail
          // from the rest of the loop and fail open on the remaining
          // custom patterns for this request.
          break;
        }
        if (!matches) continue;

        for (const match of matches) {
          const masked = maskChar.repeat(match.length);
          filteredText = filteredText.replace(match, masked);
          if (modifications.length < MAX_MODIFICATIONS) {
            modifications.push(`Custom PII pattern matched: ${customPattern}`);
          }
        }
      }
    }

    return filteredText;
  }
}