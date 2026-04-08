import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';

import { Credential, CredentialType } from '../../entities/credential.entity';
import { Api } from '../../entities/api.entity';
import { validateUrl } from '../../common/security/url-validator';

export interface CreateCredentialDto {
  name: string;
  description?: string;
  type: CredentialType;
  config?: Record<string, any>;
  headerName?: string;
  headerValue?: string;
  username?: string;
  password?: string;
  token?: string;
  keyName?: string;
  keyLocation?: string;
  scopes?: string[];
  expiresAt?: string;
}

export interface UpdateCredentialDto {
  name?: string;
  description?: string;
  config?: Record<string, any>;
  keyName?: string;
  keyLocation?: string;
  scopes?: string[];
  isActive?: boolean;
  expiresAt?: string;
}

@Injectable()
export class CredentialService {
  private readonly logger = new Logger(CredentialService.name);
  private refreshLocks = new Map<string, Promise<Credential>>();

  constructor(
    @InjectRepository(Credential)
    private credentialRepository: Repository<Credential>,
    @InjectRepository(Api)
    private apiRepository: Repository<Api>,
  ) {}

  /**
   * Create a new credential for an API, encrypting sensitive fields.
   */
  async createCredential(
    apiId: string,
    organizationId: string,
    dto: CreateCredentialDto,
  ): Promise<Credential> {
    // Scope the lookup directly rather than loading unscoped and
    // then checking — it's the same number of SQL statements and
    // removes the possibility of forgetting the post-load check.
    // A cross-org lookup surfaces as NotFound (not Forbidden) so
    // the endpoint can't be used as a cross-tenant existence
    // oracle for api ids.
    const api = await this.apiRepository.findOne({
      where: { id: apiId, organizationId },
    });
    if (!api) throw new NotFoundException('API not found');

    // Build config from DTO fields if not provided directly
    const config = dto.config || {
      ...(dto.headerName && { headerName: dto.headerName }),
      ...(dto.headerValue && { headerValue: dto.headerValue }),
      ...(dto.username && { username: dto.username }),
      ...(dto.password && { password: dto.password }),
      ...(dto.token && { token: dto.token }),
    };

    const credential = this.credentialRepository.create({
      name: dto.name,
      description: dto.description,
      type: dto.type,
      config: Object.keys(config).length > 0 ? config : { type: dto.type },
      keyName: dto.keyName,
      keyLocation: dto.keyLocation,
      scopes: dto.scopes,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
      apiId,
      organizationId,
    });

    // Encrypt before saving
    credential.encryptSensitiveData();

    const saved = await this.credentialRepository.save(credential);

    // Return masked version
    return this.maskCredential(saved);
  }

  /**
   * List all credentials for an API (sensitive fields masked).
   */
  async getCredentials(apiId: string, organizationId: string): Promise<Credential[]> {
    const credentials = await this.credentialRepository.find({
      where: { apiId, organizationId },
      order: { createdAt: 'DESC' },
    });

    return credentials.map(c => this.maskCredential(c));
  }

  /**
   * Get a single credential (with decrypted config for internal use).
   */
  async getCredentialForExecution(apiId: string, organizationId: string): Promise<Credential | null> {
    return this.credentialRepository.findOne({
      where: { apiId, organizationId, isActive: true },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Update a credential, re-encrypting if config changed.
   */
  async updateCredential(
    credentialId: string,
    organizationId: string,
    dto: UpdateCredentialDto,
  ): Promise<Credential> {
    const credential = await this.credentialRepository.findOne({
      where: { id: credentialId, organizationId },
    });

    if (!credential) throw new NotFoundException('Credential not found');

    if (dto.name !== undefined) credential.name = dto.name;
    if (dto.description !== undefined) credential.description = dto.description;
    if (dto.keyName !== undefined) credential.keyName = dto.keyName;
    if (dto.keyLocation !== undefined) credential.keyLocation = dto.keyLocation;
    if (dto.scopes !== undefined) credential.scopes = dto.scopes;
    if (dto.isActive !== undefined) credential.isActive = dto.isActive;
    // Treat empty string and falsy as "clear the expiry"; only construct
    // a Date when there's an actual value. Previously `new Date('')`
    // produced an Invalid Date that TypeORM persisted as garbage.
    if (dto.expiresAt !== undefined) {
      credential.expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    }

    if (dto.config) {
      credential.config = dto.config;
      credential.encryptSensitiveData();
    }

    const saved = await this.credentialRepository.save(credential);
    return this.maskCredential(saved);
  }

  /**
   * Delete a credential.
   */
  async deleteCredential(credentialId: string, organizationId: string): Promise<void> {
    const credential = await this.credentialRepository.findOne({
      where: { id: credentialId, organizationId },
    });

    if (!credential) throw new NotFoundException('Credential not found');

    await this.credentialRepository.remove(credential);
  }

  /**
   * Test a credential by making a lightweight request to the API.
   */
  async testCredential(credentialId: string, organizationId: string): Promise<{ success: boolean; message: string }> {
    const credential = await this.credentialRepository.findOne({
      where: { id: credentialId, organizationId },
      relations: ['api'],
    });

    if (!credential) throw new NotFoundException('Credential not found');

    if (!credential.isValid()) {
      return { success: false, message: 'Credential is inactive or expired' };
    }

    // SSRF guard on the stored API base URL. api.baseUrl is
    // @Matches(/^https?:\/\/.+/) at create time, which blocks
    // non-http schemes but NOT internal IPs or the metadata service.
    // Without this an admin could create an Api with baseUrl pointing
    // at 169.254.169.254 / localhost / link-local, then invoke
    // /credentials/:id/test and exfil the auth headers straight into
    // the internal network. Same validator already protects the
    // refresh path a few lines below.
    const urlCheck = validateUrl(credential.api.baseUrl);
    if (!urlCheck.valid) {
      return { success: false, message: `Unsafe API base URL: ${urlCheck.error}` };
    }

    try {
      const headers = credential.getAuthHeaders();
      const params = credential.getQueryParams();

      const response = await axios({
        method: 'GET',
        url: credential.api.baseUrl,
        headers: { ...headers, 'User-Agent': 'almyty-credential-test/1.0' },
        params,
        timeout: 10000,
        maxContentLength: 5 * 1024 * 1024,
        maxBodyLength: 5 * 1024 * 1024,
        maxRedirects: 0,
        validateStatus: (status) => status < 500, // 4xx is OK (means API responded)
      });

      if (response.status === 401 || response.status === 403) {
        return { success: false, message: `Authentication failed: HTTP ${response.status}` };
      }

      return { success: true, message: `API responded with HTTP ${response.status}` };
    } catch (error) {
      return { success: false, message: `Connection failed: ${error.message}` };
    }
  }

  /**
   * Refresh an OAuth2 token using the stored refresh token.
   * Called automatically before tool execution when the access token is expired.
   * Uses an in-memory lock to prevent concurrent refreshes for the same credential.
   */
  async refreshOAuthToken(credential: Credential): Promise<Credential> {
    // Check if a refresh is already in progress for this credential
    const existing = this.refreshLocks.get(credential.id);
    if (existing) {
      return existing; // Wait for the in-flight refresh
    }

    const promise = this.refreshOAuthTokenInternal(credential);
    this.refreshLocks.set(credential.id, promise);
    try {
      return await promise;
    } finally {
      this.refreshLocks.delete(credential.id);
    }
  }

  private async refreshOAuthTokenInternal(credential: Credential): Promise<Credential> {
    if (credential.type !== CredentialType.OAUTH2) {
      throw new BadRequestException('Only OAuth2 credentials support token refresh');
    }

    // Re-read from DB to check if another process already refreshed it.
    // From this point on we operate exclusively on `freshCredential` —
    // the parameter `credential` may be stale and any writes to it would
    // overwrite concurrent updates from other processes.
    const freshCredential = await this.credentialRepository.findOne({ where: { id: credential.id } });
    if (!freshCredential) {
      throw new NotFoundException('Credential not found');
    }

    // Check if already refreshed by another process
    if (freshCredential.expiresAt && freshCredential.expiresAt.getTime() > Date.now() + 60000) {
      return freshCredential;
    }

    const config = freshCredential.getDecryptedConfig();
    const refreshToken = config.refreshToken;
    const tokenEndpoint = config.tokenEndpoint;

    if (!refreshToken || !tokenEndpoint) {
      throw new BadRequestException('Missing refreshToken or tokenEndpoint in credential config');
    }

    // SSRF guard. `tokenEndpoint` is user-supplied at credential
    // creation time — an attacker who creates a credential with
    // tokenEndpoint=http://169.254.169.254/... would otherwise have
    // the backend POST the refresh token + client secret to that
    // internal host on every refresh cycle, leaking the full
    // credential material.
    const validation = validateUrl(tokenEndpoint);
    if (!validation.valid) {
      throw new BadRequestException(
        `Refused to refresh OAuth token against unsafe endpoint: ${validation.error}`,
      );
    }

    try {
      const response = await axios.post(tokenEndpoint, new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: config.clientId || '',
        client_secret: config.clientSecret || '',
      }).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
        maxContentLength: 256 * 1024,
        maxBodyLength: 256 * 1024,
        maxRedirects: 0,
      });

      const { access_token, refresh_token, expires_in } = response.data;

      // Build updated config
      const updatedConfig: Record<string, any> = {
        ...config,
        accessToken: access_token,
        refreshToken: refreshToken, // Default: keep old
        tokenEndpoint,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
      };

      // Refresh token rotation: save the new one if returned
      if (refresh_token) {
        updatedConfig.refreshToken = refresh_token;
        // The old refreshToken is now invalid
      }

      freshCredential.config = updatedConfig;

      if (expires_in) {
        freshCredential.expiresAt = new Date(Date.now() + expires_in * 1000);
      }

      freshCredential.encryptSensitiveData();
      await this.credentialRepository.save(freshCredential);

      this.logger.log(`OAuth2 token refreshed for credential ${freshCredential.id}`);
      return freshCredential;
    } catch (error) {
      this.logger.error(`OAuth2 token refresh failed for credential ${freshCredential.id}: ${error.message}`);
      freshCredential.isActive = false;
      await this.credentialRepository.save(freshCredential);
      throw new BadRequestException(`Token refresh failed: ${error.message}`);
    }
  }

  /**
   * Mark credential as recently used.
   */
  async markUsed(credentialId: string): Promise<void> {
    await this.credentialRepository.update(credentialId, { lastUsedAt: new Date() });
  }

  /**
   * Mask sensitive fields for API responses.
   */
  private maskCredential(credential: Credential): Credential {
    if (credential.config) {
      const maskedConfig = { ...credential.config };
      const sensitiveFields = ['password', 'secret', 'token', 'key', 'client_secret', 'apiKey', 'accessToken', 'refreshToken', 'headerValue', 'clientSecret'];
      for (const field of sensitiveFields) {
        if (maskedConfig[field] && typeof maskedConfig[field] === 'string') {
          const val = maskedConfig[field];
          if (val.startsWith('encrypted:')) {
            maskedConfig[field] = '••••••••';
          } else if (val.length > 8) {
            maskedConfig[field] = val.substring(0, 4) + '••••••••';
          } else {
            maskedConfig[field] = '••••••••';
          }
        }
      }
      credential.config = maskedConfig;
    }
    return credential;
  }
}
