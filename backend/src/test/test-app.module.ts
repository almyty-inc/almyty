/**
 * Lightweight test module for integration tests that need real HTTP
 * endpoints but NOT the full app (no BullMQ, no Redis, no background jobs).
 *
 * Usage:
 *   const module = await Test.createTestingModule({
 *     imports: [TestAppModule],
 *   }).compile();
 *   const app = module.createNestApplication();
 *   app.use(cookieParser());
 *   await app.init();
 *
 * Includes: Auth, MCP (OAuth + gateway), Gateways, Organizations, Users
 * Mocks: BullMQ queues, Redis, MailService
 */
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import { CacheModule } from '@nestjs/cache-manager';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { BullModule } from '@nestjs/bull';

// Entities
import { User } from '../entities/user.entity';
import { Organization } from '../entities/organization.entity';
import { UserOrganization } from '../entities/user-organization.entity';
import { Team } from '../entities/team.entity';
import { UserTeam } from '../entities/user-team.entity';
import { ApiKey } from '../entities/api-key.entity';
import { Gateway } from '../entities/gateway.entity';
import { GatewayTool } from '../entities/gateway-tool.entity';
import { GatewayAuth } from '../entities/gateway-auth.entity';
import { Tool } from '../entities/tool.entity';
import { Api } from '../entities/api.entity';
import { Operation } from '../entities/operation.entity';
import { Resource } from '../entities/resource.entity';
import { ToolCategory } from '../entities/tool-category.entity';
import { OAuthClient } from '../entities/oauth-client.entity';
import { OAuthAuthorizationCode } from '../entities/oauth-authorization-code.entity';
import { OAuthAccessToken } from '../entities/oauth-access-token.entity';
import { Credential } from '../entities/credential.entity';
import { LlmProvider } from '../entities/llm-provider.entity';
import { Conversation } from '../entities/conversation.entity';
import { Message } from '../entities/message.entity';
import { AuditLog } from '../entities/audit-log.entity';
import { UsageMetric } from '../entities/usage-metric.entity';
import { RequestLog } from '../entities/request-log.entity';
import { ToolVersion } from '../entities/tool-version.entity';
import { ToolExecution } from '../entities/tool-execution.entity';
import { Agent } from '../entities/agent.entity';
import { AgentExecution } from '../entities/agent-execution.entity';
import { AgentRun } from '../entities/agent-run.entity';
import { Memory } from '../entities/memory.entity';
import { AgentFile } from '../entities/file.entity';
import { ExternalAgent } from '../entities/external-agent.entity';
import { ToolTemplate } from '../entities/tool-template.entity';
import { JsonSchema } from '../entities/json-schema.entity';
import { ApiSchema } from '../entities/api-schema.entity';

// Auth
import { AuthController } from '../modules/auth/auth.controller';
import { AuthService } from '../modules/auth/auth.service';
import { JwtStrategy } from '../modules/auth/strategies/jwt.strategy';
import { ApiKeyStrategy } from '../modules/auth/strategies/api-key.strategy';
import { LocalStrategy } from '../modules/auth/strategies/local.strategy';

// MCP
import { McpOAuthController } from '../modules/mcp/controllers/mcp-oauth.controller';
import { McpOAuthDiscoveryController } from '../modules/mcp/controllers/mcp-oauth-discovery.controller';
import { GatewayMcpController } from '../modules/mcp/gateway-mcp.controller';
import { McpOAuthService } from '../modules/mcp/services/mcp-oauth.service';
import { GatewayResolverService } from '../modules/mcp/services/gateway-resolver.service';
import { GatewayAuthService } from '../modules/gateways/gateway-auth.service';
import { McpService } from '../modules/mcp/mcp.service';
import { AlmytyMcpService } from '../modules/mcp/almyty-mcp.service';
import { McpSessionService } from '../modules/mcp/mcp-session.service';

// Gateways
import { GatewaysService } from '../modules/gateways/gateways.service';

// Organizations
import { OrganizationsService } from '../modules/organizations/organizations.service';

// Audit
import { AuditLogService } from '../modules/audit-log/audit-log.service';

// Mail
import { MailService } from '../modules/mail/mail.service';

// Services needed by AlmytyMcpService via ModuleRef.get
import { ApisService } from '../modules/apis/apis.service';
import { ToolsService } from '../modules/tools/tools.service';
import { AgentsService } from '../modules/agents/agents.service';
import { LlmProvidersService } from '../modules/llm-providers/llm-providers.service';

// Mock Redis
const mockRedis = {
  get: () => null,
  set: () => 'OK',
  setex: () => 'OK',
  del: () => 1,
  keys: () => [],
  lpush: () => 1,
  ltrim: () => 'OK',
  llen: () => 0,
  lrange: () => [],
  expire: () => 1,
  exists: () => 0,
  incr: () => 1,
  ttl: () => -1,
  multi: () => ({ exec: () => [] }),
  pipeline: () => ({ exec: () => [] }),
  subscribe: () => {},
  on: () => {},
};

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.test', '.env.local', '.env'],
    }),

    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        return {
          type: 'postgres',
          host: config.get<string>('DATABASE_HOST', 'localhost'),
          port: parseInt(config.get<string>('DATABASE_PORT', '5432')),
          username: config.get<string>('DATABASE_USERNAME', 'postgres'),
          password: config.get<string>('DATABASE_PASSWORD', 'password'),
          database: config.get<string>('DATABASE_NAME', 'almyty_test'),
          entities: [__dirname + '/../entities/*.entity{.ts,.js}'],
          synchronize: true,
          logging: false,
        } as any;
      },
    }),

    TypeOrmModule.forFeature([
      User, Organization, UserOrganization, Team, UserTeam, ApiKey,
      Gateway, GatewayTool, GatewayAuth, Tool, Api, Operation, Resource,
      ToolCategory, OAuthClient, OAuthAuthorizationCode, OAuthAccessToken,
      Credential, LlmProvider, Conversation, Message, AuditLog,
      UsageMetric, RequestLog, ToolVersion, ToolExecution,
      Agent, AgentExecution, AgentRun, Memory, AgentFile, ExternalAgent,
      ToolTemplate, JsonSchema, ApiSchema,
    ]),

    ThrottlerModule.forRoot({ throttlers: [{ ttl: 60, limit: 1000 }] }),
    CacheModule.register({ isGlobal: true }),
    PassportModule.register({ defaultStrategy: 'jwt' }),

    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get('JWT_SECRET', 'test-jwt-secret'),
        signOptions: { expiresIn: '1h', issuer: 'almyty', audience: 'almyty-api' },
        verifyOptions: { issuer: 'almyty', audience: 'almyty-api' },
      }),
    }),
  ],

  controllers: [
    AuthController,
    McpOAuthDiscoveryController,
    McpOAuthController,
    GatewayMcpController,
  ],

  providers: [
    // Auth
    AuthService,
    JwtStrategy,
    ApiKeyStrategy,
    LocalStrategy,

    // MCP
    McpOAuthService,
    GatewayResolverService,
    GatewayAuthService,
    AlmytyMcpService,
    McpSessionService,

    // McpService has deep dependency chain (ToolsService, ToolExecutorService, etc.)
    // Mock it — system gateway uses AlmytyMcpService instead.
    {
      provide: McpService,
      useValue: {
        handleJsonRpc: () => ({ jsonrpc: '2.0', id: 0, error: { code: -32601, message: 'Not available in test' } }),
      },
    },

    // Gateways
    GatewaysService,

    // Organizations
    OrganizationsService,

    // Audit (mock — just needs to exist)
    {
      provide: AuditLogService,
      useValue: {
        log: () => {},
        logCreate: () => {},
        logUpdate: () => {},
        logDelete: () => {},
      },
    },

    // Mail (mock)
    {
      provide: MailService,
      useValue: { sendInvitation: () => {}, sendEmail: () => {} },
    },

    // Services used by AlmytyMcpService via ModuleRef.get({ strict: false })
    { provide: ApisService, useValue: { findAllByOrganization: () => ({ apis: [], total: 0 }), create: () => ({ id: 'api-1' }), remove: () => {} } },
    { provide: ToolsService, useValue: { getTools: () => ({ tools: [], total: 0 }), deleteTool: () => {} } },
    { provide: AgentsService, useValue: { getAgents: () => ({ agents: [], total: 0 }), createAgent: () => ({ id: 'agent-1' }) } },
    { provide: LlmProvidersService, useValue: { getProviders: () => [], createProvider: () => ({ id: 'prov-1' }) } },

    // Redis mock
    { provide: 'default_IORedisModuleConnectionToken', useValue: mockRedis },
  ],
})
export class TestAppModule {}
