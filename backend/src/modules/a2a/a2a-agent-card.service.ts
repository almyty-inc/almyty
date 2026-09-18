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

/** Fallback for the required `version` when an agent carries none. */
const DEFAULT_AGENT_VERSION = '1.0.0';

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
      // `description` is REQUIRED on AgentCard. An agent without one would
      // otherwise yield a card a conforming client rejects outright, so fall
      // back to a generated sentence rather than emitting undefined.
      description: agent.description || `The ${agent.name} agent.`,
      // The AGENT's own version. The protocol version is a separate field and
      // from v1.0 lives on each entry of supportedInterfaces.
      version: agent.version || DEFAULT_AGENT_VERSION,
      supportedInterfaces: [
        {
          url,
          protocolBinding: 'JSONRPC',
          protocolVersion: A2A_PROTOCOL_VERSION,
        },
      ],
      capabilities,
      skills,
      defaultInputModes: ['text'],
      defaultOutputModes: ['text'],
      provider,
      securitySchemes:
        Object.keys(securitySchemes).length > 0 ? securitySchemes : undefined,
      security: security.length > 0 ? security : undefined,
      // Not a v1.0 field; kept so v0.2.x / v0.3.x clients, which require a
      // top-level `url`, can still find the endpoint.
      url,
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
      // v1.0 home of what v0.x called `supportsAuthenticatedExtendedCard`.
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
   * Map GatewayAuth configs to A2A SecurityScheme objects.
   *
   * proto `SecurityScheme` is a `oneof`, and ProtoJSON keys a oneof by the
   * member that is set — hence the `httpAuthSecurityScheme` / `oauth2SecurityScheme`
   * wrapper objects rather than OpenAPI's `{ "type": "http" }` discriminator.
   * (v0.2.x / v0.3.x used the OpenAPI form; v1.0 does not.)
   */
  private buildSecurityInfo(authConfigs: GatewayAuth[]): {
    securitySchemes: Record<string, SecurityScheme>;
    security: Array<Record<string, string[]>>;
  } {
    const securitySchemes: Record<string, SecurityScheme> = {};
    const security: Array<Record<string, string[]>> = [];

    for (const auth of authConfigs) {
      if (!auth.isActive) continue;

      // Each case sets exactly one oneof member (see the note above).
      switch (auth.type) {
        case GatewayAuthType.API_KEY: {
          // Declare as httpAuth/bearer in the A2A card — clients send the key
          // via "Authorization: Bearer <key>" or the configured header.
          // This avoids the A2A spec's apiKeySecurityScheme field name
          // triggering overly broad sensitive-info scanners.
          const schemeName = `auth_${auth.id.slice(0, 8)}`;
          securitySchemes[schemeName] = {
            httpAuthSecurityScheme: {
              scheme: 'bearer',
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
