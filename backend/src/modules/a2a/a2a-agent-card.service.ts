import { Injectable } from '@nestjs/common';
import { Gateway } from '../../entities/gateway.entity';
import { Agent } from '../../entities/agent.entity';
import { Organization } from '../../entities/organization.entity';
import { GatewayAuth, GatewayAuthType } from '../../entities/gateway-auth.entity';
import type {
  AgentCard,
  AgentSkill,
  AgentCapabilities,
  AgentProvider,
  SecurityScheme,
} from './types/a2a-spec.types';
import { A2A_PROTOCOL_VERSION } from './types/a2a-spec.types';

@Injectable()
export class A2AAgentCardService {
  /**
   * Build an A2A AgentCard from a Gateway, its linked Agent, and the org.
   */
  buildAgentCard(
    gateway: Gateway,
    agent: Agent,
    org: Organization,
    baseUrl: string,
  ): AgentCard {
    const skills = this.buildSkills(agent);
    const { securitySchemes, security } = this.buildSecurityInfo(
      gateway.authConfigs || [],
    );
    const capabilities = this.buildCapabilities();
    const provider = this.buildProvider(org, baseUrl);
    const url = `${baseUrl}/${org.slug}/${gateway.endpoint.replace(/^\//, '')}`;

    return {
      name: agent.name,
      description: agent.description || undefined,
      url,
      provider,
      version: A2A_PROTOCOL_VERSION,
      skills,
      securitySchemes:
        Object.keys(securitySchemes).length > 0 ? securitySchemes : undefined,
      security: security.length > 0 ? security : undefined,
      capabilities,
      supportedInterfaces: [
        { protocolBinding: 'jsonrpc', url },
      ],
      defaultInputModes: ['text'],
      defaultOutputModes: ['text'],
    };
  }

  // -------------------------------------------------------------------

  private buildSkills(agent: Agent): AgentSkill[] {
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

  private buildCapabilities(): AgentCapabilities {
    return {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
      extendedAgentCard: true,
    };
  }

  private buildProvider(org: Organization, baseUrl: string): AgentProvider {
    return {
      organization: org.name,
      url: org.website || `${baseUrl}/${org.slug}`,
    };
  }

  /**
   * Map GatewayAuth configs to OpenAPI-style security schemes.
   *
   * This mirrors the logic previously in the deleted
   * gateway-a2a.controller, ported here for the new module.
   */
  private buildSecurityInfo(authConfigs: GatewayAuth[]): {
    securitySchemes: Record<string, SecurityScheme>;
    security: Array<Record<string, string[]>>;
  } {
    const securitySchemes: Record<string, SecurityScheme> = {};
    const security: Array<Record<string, string[]>> = [];

    for (const auth of authConfigs) {
      if (!auth.isActive) continue;

      // A2A v1.0 uses typed scheme objects, not OpenAPI format
      switch (auth.type) {
        case GatewayAuthType.API_KEY: {
          const schemeName = `key_${auth.id.slice(0, 8)}`;
          securitySchemes[schemeName] = {
            apiKeySecurityScheme: {
              name: auth.configuration?.keyHeader || 'x-api-key',
              in: 'header',
            },
          };
          security.push({ [schemeName]: [] });
          break;
        }

        case GatewayAuthType.BEARER_TOKEN: {
          const schemeName = `bearer_${auth.id.slice(0, 8)}`;
          securitySchemes[schemeName] = {
            httpAuthSecurityScheme: {
              scheme: 'bearer',
            },
          };
          security.push({ [schemeName]: [] });
          break;
        }

        case GatewayAuthType.JWT: {
          const schemeName = `jwt_${auth.id.slice(0, 8)}`;
          securitySchemes[schemeName] = {
            httpAuthSecurityScheme: {
              scheme: 'bearer',
              bearerFormat: 'JWT',
            },
          };
          security.push({ [schemeName]: [] });
          break;
        }

        case GatewayAuthType.BASIC_AUTH: {
          const schemeName = `basic_${auth.id.slice(0, 8)}`;
          securitySchemes[schemeName] = {
            httpAuthSecurityScheme: {
              scheme: 'basic',
            },
          };
          security.push({ [schemeName]: [] });
          break;
        }

        case GatewayAuthType.OAUTH2: {
          const schemeName = `oauth2_${auth.id.slice(0, 8)}`;
          securitySchemes[schemeName] = {
            oauth2SecurityScheme: {
              flows: auth.configuration?.flows || {},
            },
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
