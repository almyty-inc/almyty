/**
 * Restoring an environment variable a spec changed. `process.env.X = saved`
 * is wrong when X was unset: process.env coerces every value to a string, so
 * it stores the four-character string "undefined", which is truthy and
 * leaks into every later spec in the same jest worker (a JWT secret of
 * "undefined", a feature flag that reads as set). Delete the key instead.
 * Pinned by __tests__/env-restore.guard.spec.ts.
 */
export function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** Snapshot `keys` now; the returned function puts each back exactly. */
export function snapshotEnv(...keys: string[]): () => void {
  const saved = keys.map((key) => [key, process.env[key]] as const);
  return () => {
    for (const [key, value] of saved) restoreEnv(key, value);
  };
}
