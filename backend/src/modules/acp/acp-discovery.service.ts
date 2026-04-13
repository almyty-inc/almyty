import { Injectable } from '@nestjs/common';
import { Gateway } from '../../entities/gateway.entity';
import { Agent } from '../../entities/agent.entity';
import { Organization } from '../../entities/organization.entity';
import { GatewayAuth, GatewayAuthType } from '../../entities/gateway-auth.entity';
import type {
  AcpDiscoveryDocument,
  AcpAgentSkill,
  AcpCapabilities,
  AcpProvider,
  SecurityScheme,
} from './types/acp.types';
import { ACP_PROTOCOL_VERSION } from './types/acp.types';

@Injectable()
export class AcpDiscoveryService {
  /**
   * Build an ACP discovery document from a Gateway, its linked Agent, and the org.
   */
  buildDiscoveryDocument(
    gateway: Gateway,
    agent: Agent,
    org: Organization,
    baseUrl: string,
  ): AcpDiscoveryDocument {
    const skills = this.buildSkills(agent);
    const { securitySchemes, security } = this.buildSecurityInfo(
      gateway.authConfigs || [],
    );
    const capabilities = this.buildCapabilities();
    const provider = this.buildProvider(org);
    const url = `${baseUrl}/${org.slug}/${gateway.endpoint.replace(/^\//, '')}`;

    return {
      name: agent.name,
      description: agent.description || undefined,
      url,
      provider,
      version: ACP_PROTOCOL_VERSION,
      skills,
      securitySchemes:
        Object.keys(securitySchemes).length > 0 ? securitySchemes : undefined,
      security: security.length > 0 ? security : undefined,
      capabilities,
      defaultInputModes: ['text'],
      defaultOutputModes: ['text'],
    };
  }

  // -------------------------------------------------------------------

  private buildSkills(agent: Agent): AcpAgentSkill[] {
    return [
      {
        id: `agent-${agent.id}`,
        name: agent.name,
        description: agent.description || `Interact with the ${agent.name} agent`,
        tags: [],
        examples: [],
        inputModes: ['text'],
        outputModes: ['text'],
      },
    ];
  }

  private buildCapabilities(): AcpCapabilities {
    return {
      streaming: true,
      sessions: true,
      pushNotifications: false,
    };
  }

  private buildProvider(org: Organization): AcpProvider {
    return {
      organization: org.name,
      url: org.website || undefined,
    };
  }

  /**
   * Map GatewayAuth configs to OpenAPI-style security schemes.
   */
  private buildSecurityInfo(authConfigs: GatewayAuth[]): {
    securitySchemes: Record<string, SecurityScheme>;
    security: Array<Record<string, string[]>>;
  } {
    const securitySchemes: Record<string, SecurityScheme> = {};
    const security: Array<Record<string, string[]>> = [];

    for (const auth of authConfigs) {
      if (!auth.isActive) continue;

      switch (auth.type) {
        case GatewayAuthType.API_KEY: {
          const schemeName = `apiKey_${auth.id.slice(0, 8)}`;
          securitySchemes[schemeName] = {
            type: 'apiKey',
            name: auth.configuration?.keyHeader || 'x-api-key',
            in: 'header',
          };
          security.push({ [schemeName]: [] });
          break;
        }

        case GatewayAuthType.BEARER_TOKEN: {
          const schemeName = `bearer_${auth.id.slice(0, 8)}`;
          securitySchemes[schemeName] = {
            type: 'http',
            scheme: 'bearer',
          };
          security.push({ [schemeName]: [] });
          break;
        }

        case GatewayAuthType.JWT: {
          const schemeName = `jwt_${auth.id.slice(0, 8)}`;
          securitySchemes[schemeName] = {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          };
          security.push({ [schemeName]: [] });
          break;
        }

        case GatewayAuthType.BASIC_AUTH: {
          const schemeName = `basic_${auth.id.slice(0, 8)}`;
          securitySchemes[schemeName] = {
            type: 'http',
            scheme: 'basic',
          };
          security.push({ [schemeName]: [] });
          break;
        }

        case GatewayAuthType.OAUTH2: {
          const schemeName = `oauth2_${auth.id.slice(0, 8)}`;
          securitySchemes[schemeName] = {
            type: 'oauth2',
            flows: auth.configuration?.flows || {},
          };
          security.push({ [schemeName]: [] });
          break;
        }

        case GatewayAuthType.NONE:
        case GatewayAuthType.CUSTOM:
        default:
          break;
      }
    }

    return { securitySchemes, security };
  }
}
