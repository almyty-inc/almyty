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

export interface CreateCredentialDto {
  name: string;
  description?: string;
  type: CredentialType;
  config: Record<string, any>;
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
    const api = await this.apiRepository.findOne({ where: { id: apiId } });
    if (!api) throw new NotFoundException('API not found');
    if (api.organizationId !== organizationId) throw new ForbiddenException('Access denied');

    const credential = this.credentialRepository.create({
      name: dto.name,
      description: dto.description,
      type: dto.type,
      config: dto.config,
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
    if (dto.expiresAt !== undefined) credential.expiresAt = new Date(dto.expiresAt);

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

    try {
      const headers = credential.getAuthHeaders();
      const params = credential.getQueryParams();

      const response = await axios({
        method: 'GET',
        url: credential.api.baseUrl,
        headers: { ...headers, 'User-Agent': 'almyty-credential-test/1.0' },
        params,
        timeout: 10000,
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
   */
  async refreshOAuthToken(credential: Credential): Promise<Credential> {
    if (credential.type !== CredentialType.OAUTH2) {
      throw new BadRequestException('Only OAuth2 credentials support token refresh');
    }

    const config = credential.getDecryptedConfig();
    const refreshToken = config.refreshToken;
    const tokenEndpoint = config.tokenEndpoint;

    if (!refreshToken || !tokenEndpoint) {
      throw new BadRequestException('Missing refreshToken or tokenEndpoint in credential config');
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
      });

      const { access_token, refresh_token, expires_in } = response.data;

      // Update credential with new tokens
      credential.config = {
        ...config,
        accessToken: access_token,
        refreshToken: refresh_token || refreshToken, // Keep old if not returned
        tokenEndpoint,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
      };

      if (expires_in) {
        credential.expiresAt = new Date(Date.now() + expires_in * 1000);
      }

      credential.encryptSensitiveData();
      await this.credentialRepository.save(credential);

      this.logger.log(`OAuth2 token refreshed for credential ${credential.id}`);
      return credential;
    } catch (error) {
      this.logger.error(`OAuth2 token refresh failed for credential ${credential.id}: ${error.message}`);
      credential.isActive = false;
      await this.credentialRepository.save(credential);
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
