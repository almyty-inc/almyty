import { assertExtensionsInPublic } from './integration/test-db-extensions';

/**
 * Jest globalTeardown: runs once, after every worker has finished.
 *
 * For a DB-integration run, the extensions the migrations need must still be
 * in `public` (see test-db-extensions.ts). Checked here rather than after
 * each spec file: placement is database-wide, and a per-file check in
 * parallel workers read other workers' DDL mid-flight and failed whichever
 * spec was finishing. A plain unit run does nothing here.
 */
export default async function globalTeardown(): Promise<void> {
  if (process.env.RUN_DB_INTEGRATION !== '1') return;
  await assertExtensionsInPublic();
}
