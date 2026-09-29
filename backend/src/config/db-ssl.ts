/**
 * Whether the Postgres connection uses TLS. DB_SSL decides, for the app and
 * for the typeorm CLI (the db-migration job) alike: "true" for a managed
 * database, anything else (the default "false") for local dev. NODE_ENV has
 * no say -- a production build pointed at a local database must not demand
 * TLS, and a staging pod pointed at a managed one must not skip it.
 *
 * Managed Postgres presents a certificate chained to its provider's own
 * CA, which the pods do not carry, hence rejectUnauthorized: false.
 */
export type DbSslOption = { rejectUnauthorized: false } | false;

export function dbSslOption(get: (key: string) => string | undefined): DbSslOption {
  return (get('DB_SSL') ?? 'false') === 'true' ? { rejectUnauthorized: false } : false;
}
