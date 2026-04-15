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
 * Resolve the API URL from (in order): flag > env > config > default.
 */
export function resolveApiUrl(flagValue?: string): string {
  return flagValue
    || process.env.ALMYTY_URL
    || loadConfig().apiUrl
    || 'https://api.almyty.com';
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
