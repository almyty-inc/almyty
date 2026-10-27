/**
 * Whether an API tool's arguments came grouped by where they go
 * (`{ path: {...}, query: {...}, header: {...}, body: ... }`) or flat, the
 * way a generated tool takes them (`{ projectId, query, useLegacySql }`).
 *
 * A key named `query`, `path`, `header` or `body` alone used to mean
 * grouped. BigQuery's jobs.query takes the SQL in a body field named
 * `query`, and GitHub's create-issue takes the text in one named `body`,
 * so those calls were sent with the SQL spread over the query string one
 * character per parameter. Grouped now means every such key holds an
 * object (or, for the body, an array), and none of them is an input the
 * operation itself declares.
 */
const GROUP_KEYS = ['path', 'query', 'header', 'body'] as const;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

export function isGroupedArguments(
  parameters: Record<string, any>,
  operation: { parameters?: { path?: Record<string, any>; query?: Record<string, any>; header?: Record<string, any>; body?: any } | null } | null | undefined,
): boolean {
  const present = GROUP_KEYS.filter((k) => parameters[k] !== undefined && parameters[k] !== null);
  if (present.length === 0) return false;
  const declared = new Set<string>([
    ...Object.keys(operation?.parameters?.path ?? {}),
    ...Object.keys(operation?.parameters?.query ?? {}),
    ...Object.keys(operation?.parameters?.header ?? {}),
    ...Object.keys(operation?.parameters?.body?.schema?.properties ?? {}),
  ]);
  return present.every(
    (k) => !declared.has(k) && (isPlainObject(parameters[k]) || (k === 'body' && Array.isArray(parameters[k]))),
  );
}
