import { ApiType, ApiStatus } from '../../../entities/api.entity';
import { SchemaFormat } from '../../../entities/api-schema.entity';

export interface CreateApiData {
  name: string;
  description?: string;
  baseUrl: string;
  version?: string;
  type: ApiType;
  organizationId: string;
  headers?: Record<string, string>;
  authentication?: {
    type: 'none' | 'api_key' | 'bearer' | 'basic' | 'oauth2';
    config: Record<string, any>;
  };
  rateLimits?: {
    requestsPerSecond?: number;
    requestsPerMinute?: number;
    requestsPerHour?: number;
  };
  timeoutMs?: number;
  retryAttempts?: number;
  metadata?: Record<string, any>;
}

export interface UpdateApiData {
  name?: string;
  description?: string;
  baseUrl?: string;
  version?: string;
  headers?: Record<string, string>;
  authentication?: {
    type: 'none' | 'api_key' | 'bearer' | 'basic' | 'oauth2';
    config: Record<string, any>;
  };
  rateLimits?: {
    requestsPerSecond?: number;
    requestsPerMinute?: number;
    requestsPerHour?: number;
  };
  timeoutMs?: number;
  retryAttempts?: number;
  metadata?: Record<string, any>;
}

export interface FindApisOptions {
  type?: ApiType;
  status?: ApiStatus;
  page?: number;
  limit?: number;
}

export interface ImportSchemaOptions {
  fileName?: string;
  description?: string;
  generateTools?: boolean;
}

