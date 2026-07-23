/**
 * Shared auth/credential application for every HTTP-family tool
 * executor (REST, GraphQL, SOAP, gRPC, structured HTTP). Pulled
 * out of the old tool-executor.service.ts monolith so the per-type
 * executors don't each re-implement the credential resolution
 * order.
 *
 * Resolution order for an API-backed tool:
 *   1. Load the most recent active Credential row for (api, org)
 *      and apply its auth headers + query params.
 *   2. If no credential exists, fall back to api.authentication
 *      (legacy inline config on the Api entity).
 *
 * For an inline (no api) tool, applyInlineToolAuth() can be used
 * to apply `tool.authConfig` directly.
 *
 * Applying a credential also refreshes expired OAuth2 tokens
 * transparently via the credential service.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AxiosRequestConfig } from 'axios';
import { Api } from '../../../entities/api.entity';
import { Credential, CredentialType } from '../../../entities/credential.entity';
import { ToolExecutionOptions } from '../tool-execution.types';
import { EnvelopeCryptoService } from '../../kms/envelope-crypto.service';

@Injectable()
export class ToolAuthService {
  private readonly logger = new Logger(ToolAuthService.name);

  constructor(
    @InjectRepository(Credential)
    private readonly credentialRepository: Repository<Credential>,
    private readonly moduleRef: ModuleRef,
    private readonly envelopeCrypto: EnvelopeCryptoService,
  ) {}

  /**
   * Apply credentials to an outbound axios request for an API-backed
   * tool. Prefers a stored Credential row over the legacy inline
   * api.authentication field.
   */
  async applyApiAuth(
    config: AxiosRequestConfig,
    api: Api,
    options: ToolExecutionOptions,
  ): Promise<void> {
    // 1. Prefer proper Credential entity.
    const credential = await this.credentialRepository.findOne({
      where: {
        apiId: api.id,
        organizationId: options.organizationId,
        isActive: true,
      },
      order: { createdAt: 'DESC' },
    });

    if (credential) {
      await this.applyCredential(config, credential);
      return;
    }

    // 2. Fall back to legacy api.authentication inline config.
    if (!api.authentication) return;

    const authConfig = api.authentication;
    config.headers = config.headers || {};

    switch (authConfig.type) {
      case 'bearer':
        (config.headers as Record<string, string>).Authorization = `Bearer ${authConfig.config.token}`;
        break;

      case 'basic': {
        const basicCreds = Buffer.from(
          `${authConfig.config.username}:${authConfig.config.password}`,
        ).toString('base64');
        (config.headers as Record<string, string>).Authorization = `Basic ${basicCreds}`;
        break;
      }

      case 'api_key': {
        // The api_key shape was never canonicalised: the frontend
        // dialog writes {apiKey, headerName}, OpenAPI imports may
        // populate {parameter, apiKey}, and the original tool
        // executor expected {name, value}. Read all three so a
        // mis-shaped row doesn't silently skip auth — the bug
        // before this was that none of the wild shapes matched
        // and api_key headers never got injected at all.
        const c = authConfig.config || {};
        const headerName: string | undefined =
          c.headerName || c.parameter || c.name;
        const value: string | undefined = c.apiKey || c.value || c.key;
        const location: string = c.location || 'header';
        if (!headerName || !value) break;
        if (location === 'header') {
          (config.headers as Record<string, string>)[headerName] = value;
        } else if (location === 'query') {
          config.params = config.params || {};
          config.params[headerName] = value;
        }
        break;
      }

      case 'oauth2':
        if (authConfig.config.accessToken) {
          (config.headers as Record<string, string>).Authorization =
            `Bearer ${authConfig.config.accessToken}`;
        }
        break;
    }
  }

  /**
   * Apply inline tool.authConfig (used for standalone HTTP tools
   * without an Api relation).
   */
  applyInlineToolAuth(config: AxiosRequestConfig, authConfig: any): void {
    config.headers = config.headers || {};
    const headers = config.headers as Record<string, string>;

    if (authConfig.type === 'bearer' && authConfig.config?.token) {
      headers.Authorization = `Bearer ${authConfig.config.token}`;
    } else if (authConfig.type === 'apiKey' && authConfig.config?.key) {
      headers[authConfig.config.headerName || 'X-API-Key'] = authConfig.config.key;
    }
  }

  /**
   * Apply a Credential entity. Refreshes expired OAuth2 tokens
   * transparently via the shared credential service, then copies
   * the credential's headers and query params onto the axios
   * request config.
   */
  private async applyCredential(
    config: AxiosRequestConfig,
    credential: Credential,
  ): Promise<void> {
    // Refresh expired OAuth2 tokens in-place.
    if (credential.type === CredentialType.OAUTH2 && credential.isExpired()) {
      try {
        const { CredentialService } = await import('../../apis/credential.service');
        const credService = this.moduleRef?.get(CredentialService, { strict: false });
        if (credService) {
          await credService.refreshOAuthToken(credential);
        }
      } catch (e: any) {
        this.logger.warn(
          `OAuth2 token refresh failed for credential ${credential.id}: ${e.message}`,
        );
      }
    }

    config.headers = config.headers || {};
    // Warm the org's DEK before sync getAuthHeaders (no-op for non-KMS orgs).
    await this.envelopeCrypto.warmOrg(credential.organizationId);
    const authHeaders = credential.getAuthHeaders();
    Object.assign(config.headers as Record<string, string>, authHeaders);

    const queryParams = credential.getQueryParams();
    if (Object.keys(queryParams).length > 0) {
      config.params = { ...(config.params || {}), ...queryParams };
    }

    // Mark as used. Fire-and-forget, but the .catch is a swallower
    // with a log so we don't silently hide a real DB outage — the
    // old shape was `.catch(() => {})` which ate the error.
    this.credentialRepository
      .update(credential.id, { lastUsedAt: new Date() })
      .catch((err) => {
        this.logger.warn(
          `Failed to touch lastUsedAt for credential ${credential.id}: ${err.message}`,
        );
      });
  }
}
