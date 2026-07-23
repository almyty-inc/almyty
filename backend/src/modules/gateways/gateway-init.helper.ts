import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  Gateway,
  GatewayKind,
  GatewayStatus,
  GatewayType,
} from '../../entities/gateway.entity';
import { GatewayAuth, GatewayAuthType } from '../../entities/gateway-auth.entity';

/**
 * Gateway init / configuration helpers extracted from GatewaysService:
 *  - validateGatewayConfiguration (per-type config requirements)
 *  - createDefaultAuth (default API-key auth row created with new
 *    gateways)
 *  - ensureSystemGateway (idempotent system-gateway row + OAuth auth
 *    config used by the almyty platform-management MCP)
 */
@Injectable()
export class GatewayInitHelper {
  private readonly logger = new Logger(GatewayInitHelper.name);

  constructor(
    @InjectRepository(Gateway)
    private readonly gatewayRepository: Repository<Gateway>,
    @InjectRepository(GatewayAuth)
    private readonly gatewayAuthRepository: Repository<GatewayAuth>,
  ) {}

  validateGatewayConfiguration(type: GatewayType, configuration: Record<string, any>): void {
    switch (type) {
      case GatewayType.MCP:
        if (!configuration.transport) {
          throw new BadRequestException('MCP gateway requires transport configuration');
        }
        if (!['http', 'sse', 'websocket'].includes(configuration.transport)) {
          throw new BadRequestException('Invalid MCP transport type');
        }
        break;

      case GatewayType.UTCP:
        if (!configuration.protocol) {
          throw new BadRequestException('UTCP gateway requires protocol configuration');
        }
        if (!['http', 'tcp'].includes(configuration.protocol)) {
          throw new BadRequestException('Invalid UTCP protocol type');
        }
        break;

      case GatewayType.A2A:
      case GatewayType.ACP:
      case GatewayType.OPENAI_CHAT:
        // Agent-kind protocol types — no special config required
        break;

      // Channel types and SKILLS don't require specific configuration validation
    }
  }

  async createDefaultAuth(gateway: Gateway): Promise<void> {
    const defaultAuth = this.gatewayAuthRepository.create({
      gatewayId: gateway.id,
      type: GatewayAuthType.API_KEY,
      isRequired: true,
      isActive: true,
      configuration: {
        keyHeader: 'x-api-key',
        keyQuery: 'api_key',
        defaultScopes: ['gateway:use'],
      },
      validationRules: {
        minKeyLength: 32,
        maxKeyLength: 128,
        keyFormat: '^[a-zA-Z0-9_-]+$',
      },
      errorResponses: {
        unauthorized: { code: 401, message: 'API key is required' },
        invalid: { code: 401, message: 'Invalid API key' },
      },
    });

    await this.gatewayAuthRepository.save(defaultAuth);
  }

  async ensureSystemGateway(organizationId: string): Promise<Gateway> {
    const existing = await this.gatewayRepository.findOne({
      where: { organizationId, isSystem: true, endpoint: '/almyty' },
      relations: { authConfigs: true },
    });

    if (existing) return existing;

    const gateway = this.gatewayRepository.create({
      name: 'almyty',
      description: 'almyty platform management tools',
      type: GatewayType.MCP,
      kind: GatewayKind.TOOL,
      endpoint: '/almyty',
      configuration: { transport: 'http' },
      organizationId,
      status: GatewayStatus.ACTIVE,
      isSystem: true,
      requestTimeout: 30000,
      maxRetries: 3,
      isHealthy: true,
    });

    const saved = await this.gatewayRepository.save(gateway);

    const oauthAuth = this.gatewayAuthRepository.create({
      gatewayId: saved.id,
      type: GatewayAuthType.OAUTH2,
      isRequired: true,
      isActive: true,
      configuration: {},
      validationRules: {},
      errorResponses: {},
    });
    await this.gatewayAuthRepository.save(oauthAuth);

    this.logger.log(`System gateway created for organization ${organizationId}`);

    return saved;
  }
}
