import { BadRequestException } from '@nestjs/common';

/** Fields that would hold a secret on a tool's `authConfig.config`. */
const SECRET_FIELDS = ['token', 'key', 'apiKey', 'value', 'password', 'accessToken', 'refreshToken', 'secret', 'clientSecret'];

/**
 * A tool keeps no key of its own: `authConfig` says how the tool signs its
 * calls (`type`, `headerName`) and which credential it uses
 * (`config.credentialId`). A secret sent here is refused rather than
 * stored beside the tool, where nothing would send it.
 */
export function assertToolAuthHoldsNoSecret(authConfig: unknown): void {
  const config = (authConfig as { config?: Record<string, unknown> } | null | undefined)?.config;
  if (!config || typeof config !== 'object') return;
  const found = SECRET_FIELDS.filter((field) => typeof config[field] === 'string' && config[field] !== '');
  if (found.length > 0) {
    throw new BadRequestException({
      code: 'TOOL_SECRET_INLINE',
      message: `A tool keeps no key of its own. Pick a credential for it (authConfig.config.credentialId) instead of sending ${found.join(', ')}.`,
    });
  }
}

/**
 * The same for a private npm registry: its token is a credential the
 * registry names (`credentialId`), never a field of the registry itself.
 */
export function assertRegistryHoldsNoSecret(registry: unknown): void {
  if (!registry || typeof registry !== 'object') return;
  const found = ['token', 'authToken', 'password'].filter((field) => typeof (registry as Record<string, unknown>)[field] === 'string');
  if (found.length > 0) {
    throw new BadRequestException({
      code: 'REGISTRY_SECRET_INLINE',
      message: `A registry keeps no token of its own. Pick a credential for it (npmRegistry.credentialId) instead of sending ${found.join(', ')}.`,
    });
  }
}
