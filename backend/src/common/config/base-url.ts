import { ConfigService } from '@nestjs/config';

/**
 * Resolve the base URL for the API. Throws if not configured —
 * never silently fall back to localhost or staging.
 */
export function getBaseUrl(configService: ConfigService): string {
  const url = configService.get<string>('BASE_URL') || configService.get<string>('API_BASE_URL');
  if (!url) {
    // In development, default to localhost. In other environments, fail.
    const nodeEnv = configService.get<string>('NODE_ENV', 'development');
    if (nodeEnv === 'development' || nodeEnv === 'test') {
      return 'http://localhost:3000';
    }
    throw new Error('BASE_URL environment variable is required in non-development environments');
  }
  return url.replace(/\/$/, '');
}

/**
 * Resolve the frontend URL.
 */
export function getFrontendUrl(configService: ConfigService): string {
  const url = configService.get<string>('FRONTEND_URL');
  if (!url) {
    const nodeEnv = configService.get<string>('NODE_ENV', 'development');
    if (nodeEnv === 'development' || nodeEnv === 'test') {
      return 'http://localhost:3002';
    }
    throw new Error('FRONTEND_URL environment variable is required in non-development environments');
  }
  return url.replace(/\/$/, '');
}
