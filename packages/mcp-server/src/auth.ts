/**
 * Thin re-export from the shared @almyty/client credential resolver.
 * Keeps `./auth.js` imports working across the mcp-server codebase.
 */

export {
  resolveCredentials,
  resolveCredentialsOrExit,
  loadCredentials,
  CREDENTIALS_FILE,
} from '@almyty/client';
export type { StoredCredentials } from '@almyty/client';
