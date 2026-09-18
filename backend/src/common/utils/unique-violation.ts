/**
 * Postgres `unique_violation`. Several services follow a
 * find-then-insert shape whose window a second writer can slip
 * through; the unique index is the backstop and this is how the
 * insert path recognises "another writer got there first" instead
 * of surfacing a 500.
 *
 * TypeORM wraps driver errors in QueryFailedError, which copies the
 * driver's `code` onto itself but keeps the original on
 * `driverError`, so check both.
 */
export const PG_UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(err: any, constraint?: string): boolean {
  const code = err?.code ?? err?.driverError?.code;
  if (code !== PG_UNIQUE_VIOLATION) return false;
  if (!constraint) return true;
  const name = err?.constraint ?? err?.driverError?.constraint;
  return name === constraint;
}
