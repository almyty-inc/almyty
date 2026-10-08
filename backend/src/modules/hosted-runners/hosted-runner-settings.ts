import { readFileSync } from 'fs';

/**
 * Every number hosted runners use, as data.
 *
 * Nothing else in the hosted-runners module writes a timeout, a retention
 * period, a pod size or a quota as a literal: it asks these settings. The
 * values below are the shipped defaults (Frane's decisions of 2026-10-08:
 * idle timeout 15 minutes, adjustable 5 to 120; a suspended workspace kept
 * 30 days with a notice on day 23). An install changes any of them without
 * a code change, through `HOSTED_RUNNERS_SETTINGS_FILE` (a JSON file) and
 * `HOSTED_RUNNERS_SETTINGS` (inline JSON), deep-merged over the defaults in
 * that order. `__tests__/no-hardcoded-numbers.guard.spec.ts` keeps the
 * literals out of the rest of the module; docs/hosted-runners.md lists
 * every key.
 *
 * Per-organization capacity (how many runners may run at once, which
 * classes a plan may use) is the capacity provider's
 * (hosted-capacity.provider.ts), which falls back to `capacity` below
 * when no plan data is installed.
 */
export interface ResourceClassSettings {
  /** Kubernetes CPU quantity for requests and limits, e.g. "1" or "500m". */
  cpu: string;
  /** Kubernetes memory quantity, e.g. "2Gi". */
  memory: string;
  /** Ephemeral storage limit for the pod (its root and /tmp). */
  ephemeralStorage: string;
  /** Size of the workspace volume, in GiB. */
  volumeGi: number;
}

export interface HostedRunnerSettings {
  /** Minutes a hosted runner may sit idle before it is scaled to zero. */
  idleTimeoutMinutes: { default: number; min: number; max: number };
  /** What happens to a suspended workspace nobody touches. */
  suspendedRetention: { keepDays: number; noticeDay: number };
  wake: {
    /** How long a caller waits for a waking workspace before the call fails `workspace_unavailable`. */
    budgetSeconds: number;
    /** When an agent run that met a waking workspace tries again. */
    retryAfterSeconds: number;
  };
  enrollment: {
    /** Lifetime of the single-use enrollment token a pod starts with. */
    tokenTtlMinutes: number;
    /** Lifetime of the runner credential the token is exchanged for (renewable). */
    credentialTtlMinutes: number;
  };
  reconcile: {
    /** The sweep's cron, or "off". */
    sweepCron: string;
    /** How long a provisioning claim is honoured before another API pod may take the row over. */
    claimLeaseMinutes: number;
    /** A cluster object no row points at is torn down after this grace. */
    orphanGraceMinutes: number;
    /** Consecutive failed reads before a row is marked failed. */
    maxReadFailures: number;
    /** Rows one sweep looks at. */
    batchSize: number;
    /** How long a started pod may take to enroll before the wake is retried with a new token. */
    enrollWaitMinutes: number;
  };
  /** Pod and volume sizes per class. The class is the billable unit. */
  resourceClasses: Record<string, ResourceClassSettings>;
  /** The class an environment gets when it names none. */
  defaultResourceClass: string;
  /**
   * The curated images, by the name an environment picks (`image.base`).
   * Pin each by digest here (`almyty/runner-env@sha256:...`); an
   * environment records the reference it was saved with, so a version
   * keeps running the bytes it was made with.
   */
  images: Record<string, string>;
  /** Fallback capacity when no plan capacity is installed (the OSS build, a self-hosted pool). */
  capacity: { maxConcurrentRunners: number; maxWorkspaces: number; resourceClasses: string[] | null };
  cluster: {
    /** Prefix of the per-organization namespace. */
    namespacePrefix: string;
    /** StorageClass for workspace volumes; null uses the cluster default. */
    storageClassName: string | null;
    /** Where the workspace volume is mounted in the pod. */
    workspaceMountPath: string;
    /** The uid and gid the runner runs as (never root). */
    runAsUser: number;
    runAsGroup: number;
    /** Where cluster DNS lives, for the one egress rule that is not an SNI rule. */
    dnsNamespace: string;
    dnsPodLabels: Record<string, string>;
    /** TCP ports the SNI allowlist opens (TLS only). */
    tlsPorts: number[];
  };
  /** The almyty API a pod connects to; empty falls back to PUBLIC_API_URL. */
  apiUrl: string;
}

export const DEFAULT_HOSTED_RUNNER_SETTINGS: HostedRunnerSettings = {
  idleTimeoutMinutes: { default: 15, min: 5, max: 120 },
  suspendedRetention: { keepDays: 30, noticeDay: 23 },
  wake: { budgetSeconds: 180, retryAfterSeconds: 10 },
  enrollment: { tokenTtlMinutes: 10, credentialTtlMinutes: 60 },
  reconcile: {
    sweepCron: '* * * * *',
    claimLeaseMinutes: 15,
    orphanGraceMinutes: 30,
    maxReadFailures: 3,
    batchSize: 200,
    enrollWaitMinutes: 5,
  },
  resourceClasses: {
    small: { cpu: '1', memory: '2Gi', ephemeralStorage: '4Gi', volumeGi: 10 },
    medium: { cpu: '2', memory: '4Gi', ephemeralStorage: '8Gi', volumeGi: 20 },
    large: { cpu: '4', memory: '8Gi', ephemeralStorage: '16Gi', volumeGi: 40 },
  },
  defaultResourceClass: 'small',
  // The images CI builds and pushes (images/runner-env), tagged with the
  // runner version they carry; scripts/check-runner-env-images.js keeps
  // these equal to images/runner-env/settings.json.
  images: {
    standard: 'almyty/runner-env:standard-1.5.3',
    'standard-browser': 'almyty/runner-env:standard-browser-1.5.3',
  },
  capacity: { maxConcurrentRunners: 2, maxWorkspaces: 10, resourceClasses: null },
  cluster: {
    namespacePrefix: 'almyty-rt-',
    storageClassName: null,
    workspaceMountPath: '/workspace',
    runAsUser: 1000,
    runAsGroup: 1000,
    dnsNamespace: 'kube-system',
    dnsPodLabels: { 'k8s-app': 'kube-dns' },
    tlsPorts: [443],
  },
  apiUrl: '',
};

/** Whether hosted runners are switched on for this install. Off unless HOSTED_RUNNERS_ENABLED=true. */
export function hostedRunnersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.HOSTED_RUNNERS_ENABLED ?? '').trim().toLowerCase() === 'true';
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Objects merge key by key; arrays and scalars replace. */
export function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(override)) return override as T;
  const out: Record<string, any> = { ...(base as Record<string, any>) };
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in out ? deepMerge(out[key], value) : value;
  }
  return out as T;
}

const POSITIVE = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** Problems with a settings object, in words; empty when it is usable. */
export function settingsProblems(s: HostedRunnerSettings): string[] {
  const problems: string[] = [];
  const idle = s.idleTimeoutMinutes;
  if (![idle?.min, idle?.max, idle?.default].every(POSITIVE)) problems.push('idleTimeoutMinutes.min, .max and .default must be positive numbers');
  else if (!(idle.min <= idle.default && idle.default <= idle.max)) problems.push('idleTimeoutMinutes must satisfy min <= default <= max');
  const keep = s.suspendedRetention;
  if (!POSITIVE(keep?.keepDays) || !POSITIVE(keep?.noticeDay)) problems.push('suspendedRetention.keepDays and .noticeDay must be positive numbers');
  else if (keep.noticeDay >= keep.keepDays) problems.push('suspendedRetention.noticeDay must come before keepDays');
  if (!POSITIVE(s.wake?.budgetSeconds) || !POSITIVE(s.wake?.retryAfterSeconds)) problems.push('wake.budgetSeconds and wake.retryAfterSeconds must be positive numbers');
  if (!POSITIVE(s.enrollment?.tokenTtlMinutes) || !POSITIVE(s.enrollment?.credentialTtlMinutes)) problems.push('enrollment.tokenTtlMinutes and enrollment.credentialTtlMinutes must be positive numbers');
  const r = s.reconcile as unknown as Record<string, unknown> | undefined;
  if (!r || !['claimLeaseMinutes', 'orphanGraceMinutes', 'maxReadFailures', 'batchSize', 'enrollWaitMinutes'].every((k) => POSITIVE(r[k]))) {
    problems.push('reconcile.claimLeaseMinutes, orphanGraceMinutes, maxReadFailures, batchSize and enrollWaitMinutes must be positive numbers');
  }
  const classes = Object.entries(s.resourceClasses ?? {});
  if (classes.length === 0) problems.push('resourceClasses must name at least one class');
  for (const [name, c] of classes) {
    if (!/^[a-z][a-z0-9-]{0,15}$/.test(name)) problems.push(`resource class "${name}" must be lowercase letters, digits and dashes, at most 16 characters`);
    if (!c?.cpu || !c?.memory || !c?.ephemeralStorage || !POSITIVE(c?.volumeGi)) problems.push(`resource class "${name}" needs cpu, memory, ephemeralStorage and a positive volumeGi`);
  }
  if (!s.resourceClasses?.[s.defaultResourceClass]) problems.push(`defaultResourceClass "${s.defaultResourceClass}" is not a resource class`);
  if (Object.keys(s.images ?? {}).length === 0) problems.push('images must name at least one curated image');
  const cap = s.capacity;
  if (!cap || !POSITIVE(cap.maxConcurrentRunners) || !POSITIVE(cap.maxWorkspaces)) problems.push('capacity.maxConcurrentRunners and capacity.maxWorkspaces must be positive numbers');
  const k = s.cluster;
  if (!k?.namespacePrefix || !/^[a-z][a-z0-9-]*-$/.test(k.namespacePrefix)) problems.push('cluster.namespacePrefix must be lowercase and end with a dash');
  if (!k?.workspaceMountPath?.startsWith('/')) problems.push('cluster.workspaceMountPath must be an absolute path');
  if (!POSITIVE(k?.runAsUser) || !POSITIVE(k?.runAsGroup)) problems.push('cluster.runAsUser and cluster.runAsGroup must be positive (the runner never runs as root)');
  if (!Array.isArray(k?.tlsPorts) || k.tlsPorts.length === 0 || !k.tlsPorts.every(POSITIVE)) problems.push('cluster.tlsPorts must list at least one port');
  return problems;
}

function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err: any) {
    throw new Error(`${source} is not valid JSON: ${err?.message ?? err}`);
  }
}

/**
 * The settings in force: the defaults with HOSTED_RUNNERS_SETTINGS_FILE
 * and then HOSTED_RUNNERS_SETTINGS merged over them. Throws on settings
 * that cannot work, so a bad override fails at boot rather than at the
 * first wake.
 */
export function loadHostedRunnerSettings(env: NodeJS.ProcessEnv = process.env): HostedRunnerSettings {
  let settings: HostedRunnerSettings = DEFAULT_HOSTED_RUNNER_SETTINGS;
  const file = env.HOSTED_RUNNERS_SETTINGS_FILE?.trim();
  if (file) settings = deepMerge(settings, parseJson(readFileSync(file, 'utf8'), 'HOSTED_RUNNERS_SETTINGS_FILE'));
  const inline = env.HOSTED_RUNNERS_SETTINGS?.trim();
  if (inline) settings = deepMerge(settings, parseJson(inline, 'HOSTED_RUNNERS_SETTINGS'));
  if (!settings.apiUrl) settings = { ...settings, apiUrl: (env.PUBLIC_API_URL ?? '').trim() };
  const problems = settingsProblems(settings);
  if (problems.length) throw new Error(`hosted runner settings are not usable: ${problems.join('; ')}`);
  return settings;
}

/**
 * The injectable face of the settings, read once. A spec or a dev install
 * hands in its own object.
 */
export class HostedRunnerSettingsService {
  readonly current: HostedRunnerSettings;

  constructor(settings?: HostedRunnerSettings, private readonly env: NodeJS.ProcessEnv = process.env) {
    this.current = settings ?? loadHostedRunnerSettings(env);
  }

  /** HOSTED_RUNNERS_ENABLED, read at call time so a spec can flip it. */
  enabled(): boolean {
    return hostedRunnersEnabled(this.env);
  }

  resourceClass(name: string): ResourceClassSettings | undefined {
    return this.current.resourceClasses[name];
  }

  /** An idle timeout clamped to the configured bounds; absent means the default. */
  idleTimeout(requested?: number | null): number {
    const { min, max, default: fallback } = this.current.idleTimeoutMinutes;
    if (requested === undefined || requested === null) return fallback;
    return Math.min(max, Math.max(min, Math.round(requested)));
  }

  /** The public API origin a pod dials, and its host for the SNI allowlist. */
  apiOrigin(): { url: string; host: string } | null {
    const raw = this.current.apiUrl;
    if (!raw) return null;
    try {
      const u = new URL(raw);
      return { url: u.origin, host: u.hostname };
    } catch {
      return null;
    }
  }

  minutes(n: number): number {
    return n * 60_000;
  }
}
