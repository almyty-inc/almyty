/**
 * The limits of `run_code` (docs/design/code-mode.md, decision 10), every
 * one configurable. The environment sets them for the install (the
 * defaults below are the design's numbers); an organization may set any of
 * them lower in `settings.codeMode`, never higher, because the CPU and the
 * workers are the install's.
 *
 *   CODE_MODE_MAX_CALLS        100     brokered calls per script (run, staged or refused)
 *   CODE_MODE_MAX_IN_FLIGHT    4       calls running at once; one more is refused, not queued
 *   CODE_MODE_TIMEOUT_MS       30000   wall time of a script that asks for none
 *   CODE_MODE_MAX_TIMEOUT_MS   120000  the most a script may ask for
 *   CODE_MODE_MEMORY_MB        128     heap of the sandbox worker
 *   CODE_MODE_LOG_CAP          16384   characters of log() output the model gets back
 *   CODE_MODE_RESULT_CAP       16384   characters of the return value the model gets back
 *   CODE_MODE_MAX_CODE_CHARS   50000   length of a script
 *   CODE_MODE_CPU_MS           10000   CPU time a gateway script may spend computing (QuickJS)
 *
 * The sandbox pool is set apart from JavaScript tools by SANDBOX_CODE_*
 * (node-sandbox.service.ts).
 */
export interface CodeModeLimits {
  maxCalls: number;
  maxInFlight: number;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  memoryMb: number;
  logCapChars: number;
  resultCapChars: number;
  maxCodeChars: number;
  /** CPU time a script may spend computing (the QuickJS runtime for gateway scripts). */
  cpuBudgetMs: number;
}

type Env = Record<string, string | undefined>;

const ENV_NAMES: Record<keyof CodeModeLimits, [string, number]> = {
  maxCalls: ['CODE_MODE_MAX_CALLS', 100],
  maxInFlight: ['CODE_MODE_MAX_IN_FLIGHT', 4],
  defaultTimeoutMs: ['CODE_MODE_TIMEOUT_MS', 30_000],
  maxTimeoutMs: ['CODE_MODE_MAX_TIMEOUT_MS', 120_000],
  memoryMb: ['CODE_MODE_MEMORY_MB', 128],
  logCapChars: ['CODE_MODE_LOG_CAP', 16_384],
  resultCapChars: ['CODE_MODE_RESULT_CAP', 16_384],
  maxCodeChars: ['CODE_MODE_MAX_CODE_CHARS', 50_000],
  cpuBudgetMs: ['CODE_MODE_CPU_MS', 10_000],
};

function positiveInt(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** The install's limits, from the environment. */
export function codeModeEnvLimits(env: Env = process.env): CodeModeLimits {
  const out = {} as CodeModeLimits;
  for (const [key, [name, fallback]] of Object.entries(ENV_NAMES) as Array<[keyof CodeModeLimits, [string, number]]>) {
    out[key] = positiveInt(env[name]) ?? fallback;
  }
  out.defaultTimeoutMs = Math.min(out.defaultTimeoutMs, out.maxTimeoutMs);
  return out;
}

/** The limits for one organization: the install's, lowered by its `settings.codeMode` where it sets a number. */
export function codeModeLimits(orgSettings?: Partial<Record<keyof CodeModeLimits, unknown>> | null, env: Env = process.env): CodeModeLimits {
  const base = codeModeEnvLimits(env);
  if (!orgSettings || typeof orgSettings !== 'object') return base;
  const out = { ...base };
  for (const key of Object.keys(base) as Array<keyof CodeModeLimits>) {
    const value = positiveInt(orgSettings[key]);
    if (value !== null) out[key] = Math.min(value, base[key]);
  }
  out.defaultTimeoutMs = Math.min(out.defaultTimeoutMs, out.maxTimeoutMs);
  return out;
}

/** The wall time a script gets: what it asked for, within the limits. */
export function scriptTimeoutMs(requested: unknown, limits: CodeModeLimits): number {
  const n = positiveInt(requested);
  return Math.min(n ?? limits.defaultTimeoutMs, limits.maxTimeoutMs);
}
