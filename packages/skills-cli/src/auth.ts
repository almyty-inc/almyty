/**
 * Thin re-export from the shared @almyty/client credential resolver.
 * Keeps `./auth.js` imports working across the skills-cli codebase.
 */

export {
  resolveCredentials,
  resolveCredentialsOrExit,
  resolveCredentialsOrExit as resolveAuth,
  loadCredentials,
  CREDENTIALS_FILE,
} from '@almyty/client';
export type { StoredCredentials } from '@almyty/client';
