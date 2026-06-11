/**
 * Config file at ~/.almyty/config.json.
 *
 * Stores URL overrides so you don't need env vars every time.
 * Created automatically on first login, or manually:
 *
 *   echo '{"apiUrl":"https://api.staging.almyty.com","frontendUrl":"https://app.staging.almyty.com"}' > ~/.almyty/config.json
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { CREDENTIALS_DIR } from './credentials';

export const CONFIG_FILE = join(CREDENTIALS_DIR, 'config.json');

export interface AlmytyConfig {
  apiUrl?: string;
  frontendUrl?: string;
}

export function loadConfig(): AlmytyConfig {
  try {
    if (!existsSync(CONFIG_FILE)) return {};
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

export function saveConfig(config: AlmytyConfig): void {
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * Refuse an insecure (http://) backend URL for a remote host: the JWT
 * crosses this connection, so plaintext to anything but loopback would
 * leak it. http is allowed only for localhost (local dev).
 */
export function assertSecureBackendUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid backend URL: ${url}`);
  }
  const host = parsed.hostname;
  const isLoopback =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.localhost');
  if (parsed.protocol !== 'https:' && !isLoopback) {
    throw new Error(
      `Refusing an insecure ${parsed.protocol}// backend URL for a remote host: ${url}. ` +
        'Use https:// (http is only allowed for localhost).',
    );
  }
}

/**
 * Resolve the API URL from (in order): flag > env > config > default.
 */
export function resolveApiUrl(flagValue?: string): string {
  const url =
    flagValue ||
    process.env.ALMYTY_URL ||
    loadConfig().apiUrl ||
    'https://api.almyty.com';
  assertSecureBackendUrl(url);
  return url;
}

/**
 * Resolve the frontend URL from (in order): flag > env > config > default.
 */
export function resolveFrontendUrl(flagValue?: string): string {
  return flagValue
    || process.env.ALMYTY_FRONTEND_URL
    || loadConfig().frontendUrl
    || 'https://app.almyty.com';
}
