/**
 * Credential access for the skills CLI.
 *
 * Thin re-export of the shared resolver in @almyty/client, so there is
 * one credential file and one way to read it.
 *
 * `resolveCredentialsOrExit` is not re-exported. index.ts does the check
 * itself in `requireAuth` — it predates the shared helper exiting 3, and
 * either route is correct now. Both answer a missing credential with 3,
 * which is what a script branches on.
 */

export {
  resolveCredentials,
  loadCredentials,
  CREDENTIALS_FILE,
} from '@almyty/client';
export type { StoredCredentials } from '@almyty/client';
