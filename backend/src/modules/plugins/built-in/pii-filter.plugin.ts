import {
  Plugin,
  PluginHookType,
  PluginContext,
  PluginResult,
} from '../types/plugin.types';

/**
 * Categorised PII patterns. Each entry is matched against string values only
 * when the corresponding `detect*` setting is enabled — the previous shape
 * iterated a flat array unconditionally and silently ignored the documented
 * feature toggles.
 */
interface PatternEntry {
  setting: keyof DetectSettings;
  pattern: RegExp;
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

export class PiiFilterPlugin {
  private readonly piiPatterns: PatternEntry[] = [
    { setting: 'detectCreditCards',  name: 'credit_card', pattern: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g },
    { setting: 'detectSSN',          name: 'ssn',         pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
    { setting: 'detectEmails',       name: 'email',       pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g },
    { setting: 'detectPhoneNumbers', name: 'phone',       pattern: /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g },
    { setting: 'detectIPAddresses',  name: 'ip',          pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
  ];

  getPluginDefinition(): Omit<Plugin, 'id' | 'metadata'> {
    return {
      name: 'PII Filter',
      version: '1.0.0',
      description: 'Automatically detects and filters personally identifiable information (PII) from requests and responses',
      author: 'almyty',
      isActive: true,
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
          customPatterns: [],
          logDetections: true,
        },
      },
      capabilities: {
        hooks: [
          PluginHookType.PRE_REQUEST,
          PluginHookType.POST_RESPONSE,
          PluginHookType.PRE_TOOL_EXECUTION,
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
  ): any {
    if (typeof obj === 'string') {
      // Track whether the string was actually modified so the caller's
      // parent-key bookkeeping doesn't false-positive on untouched strings.
      const before = obj;
      const after = this.filterPiiFromString(obj, settings, modifications);
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
        const filtered = this.filterPiiFromObject(item, settings, modifications, seen, depth + 1);
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
      const filteredValue = this.filterPiiFromObject(value, settings, modifications, seen, depth + 1);
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

  private filterPiiFromString(text: string, settings: any, modifications: string[]): string {
    let filteredText = text;
    const maskChar = settings.maskCharacter || '*';

    // Honour the per-category detect* toggles. The previous shape iterated
    // a flat pattern array with no lookup, so `detectEmails: false` had
    // zero effect.
    for (const entry of this.piiPatterns) {
      if (settings && settings[entry.setting] === false) continue;

      const matches = filteredText.match(entry.pattern);
      if (!matches) continue;

      for (const match of matches) {
        const masked = maskChar.repeat(Math.max(4, match.length - 4)) + match.slice(-4);
        filteredText = filteredText.replace(match, masked);
        if (modifications.length < MAX_MODIFICATIONS) {
          modifications.push(`PII detected and masked: ${match.slice(0, 2)}...`);
        }
      }
    }

    // Custom patterns with a wall-clock budget per pattern. A user-supplied
    // pathological regex like `(a+)+b` on a long input would previously hang
    // the plugin worker indefinitely. String.match() can't be interrupted
    // from JS, so the best we can do is measure and bail AFTER a match that
    // exceeds the budget — which at least caps the bleed to one slow match
    // per request rather than compounding across every pattern in the list.
    if (settings?.customPatterns && Array.isArray(settings.customPatterns)) {
      for (const customPattern of settings.customPatterns) {
        let regex: RegExp;
        try {
          regex = new RegExp(customPattern, 'g');
        } catch {
          continue; // invalid pattern
        }

        const started = Date.now();
        let matches: RegExpMatchArray | null = null;
        try {
          matches = filteredText.match(regex);
        } catch {
          continue;
        }
        if (Date.now() - started > CUSTOM_PATTERN_BUDGET_MS) {
          // Skip the rest of the custom patterns; a single slow one is a
          // red flag and we'd rather fail open (no further custom masking)
          // than keep burning CPU.
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