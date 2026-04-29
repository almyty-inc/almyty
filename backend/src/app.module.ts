import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { CacheModule } from '@nestjs/cache-manager';
import { BullModule } from '@nestjs/bull';
import { RedisModule } from '@nestjs-modules/ioredis';
import * as redisStore from 'cache-manager-redis-store';
import { versionsConfig } from 'typeorm-versions';
import { CustomVersionSubscriber } from './common/custom-version-subscriber';
import { VersionContextInterceptor } from './common/interceptors/version-context.interceptor';

// Import entities
import { User } from './entities/user.entity';
import { Organization } from './entities/organization.entity';
import { UserOrganization } from './entities/user-organization.entity';
import { Team } from './entities/team.entity';
import { UserTeam } from './entities/user-team.entity';
import { ApiKey } from './entities/api-key.entity';
import { Api } from './entities/api.entity';
import { ApiSchema } from './entities/api-schema.entity';
import { JsonSchema } from './entities/json-schema.entity';
import { Operation } from './entities/operation.entity';
import { Resource } from './entities/resource.entity';
import { Credential } from './entities/credential.entity';
import { Tool } from './entities/tool.entity';
import { ToolVersion } from './entities/tool-version.entity';
import { ToolCategory } from './entities/tool-category.entity';
import { Gateway } from './entities/gateway.entity';
import { GatewayTool } from './entities/gateway-tool.entity';
import { GatewayAuth } from './entities/gateway-auth.entity';
import { UsageMetric } from './entities/usage-metric.entity';
import { RequestLog } from './entities/request-log.entity';
import { Agent } from './entities/agent.entity';
import { AgentExecution } from './entities/agent-execution.entity';
import { AgentRun } from './entities/agent-run.entity';
import { CanonicalMemory } from './modules/memory/canonical/canonical-memory.entity';
import { CanonicalMemoryWorkspaceConfig } from './modules/memory/canonical/canonical-memory-config.entity';
import { CanonicalMemorySoftcapWarning } from './modules/memory/canonical/canonical-memory-softcap-warning.entity';
import { Conversation } from './entities/conversation.entity';
import { Message } from './entities/message.entity';
import { AgentFile } from './entities/file.entity';
import { AuditLog } from './entities/audit-log.entity';
import { ToolTemplate } from './entities/tool-template.entity';
import { ExternalAgent } from './entities/external-agent.entity';

// Import modules
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { ApisModule } from './modules/apis/apis.module';
import { ToolsModule } from './modules/tools/tools.module';
import { GatewaysModule } from './modules/gateways/gateways.module';
// import { MonitoringModule } from './modules/monitoring/monitoring.module'; // TODO: Create this module
import { SchemaParserModule } from './modules/schema-parser/schema-parser.module';
import { JsonSchemaTranslatorModule } from './modules/json-schema-translator/json-schema-translator.module';
import { LlmProvidersModule } from './modules/llm-providers/llm-providers.module';
import { McpModule } from './modules/mcp/mcp.module';
import { PluginsModule } from './modules/plugins/plugins.module';
import { MonitoringModule } from './modules/monitoring/monitoring.module';
import { HealthModule } from './modules/health/health.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { CredentialsModule } from './modules/credentials/credentials.module';
import { AgentsModule } from './modules/agents/agents.module';
import { MemoryModule } from './modules/memory/memory.module';
import { FilesModule } from './modules/files/files.module';
import { AuditLogModule } from './modules/audit-log/audit-log.module';
import { ToolHubModule } from './modules/tool-hub/tool-hub.module';
import { A2AModule } from './modules/a2a/a2a.module';
import { AcpModule } from './modules/acp/acp.module';
import { UnifiedEndpointModule } from './modules/gateways/unified-endpoint.module';
import { MailModule } from './modules/mail/mail.module';
import { VersionsModule } from './modules/versions/versions.module';

// Configuration
import { databaseConfig } from './config/database.config';

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),

    // Database — use individual params (not URL) for proper SSL control
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const dbSsl = configService.get('DB_SSL', 'false') === 'true';

        const config = versionsConfig({
            type: 'postgres' as const,
            host: configService.get<string>('DATABASE_HOST', 'localhost'),
            port: parseInt(configService.get<string>('DATABASE_PORT', '5432')),
            username: configService.get<string>('DATABASE_USERNAME', 'postgres'),
            password: configService.get<string>('DATABASE_PASSWORD', 'password'),
            database: configService.get<string>('DATABASE_NAME', 'almyty'),
            entities: [__dirname + '/entities/*.entity{.ts,.js}'],
            migrations: [__dirname + '/migrations/*{.ts,.js}'],
            migrationsRun: true,
            synchronize: false,
            logging: configService.get('NODE_ENV') === 'development',
            ssl: dbSsl ? { rejectUnauthorized: false } : false,
            extra: {
              // Default pool 10 → 30. Tool generation now batches 20
              // saves in flight per import (was 5); 30 gives the
              // import worker its full batch + spare connections for
              // the rest of the app's concurrent request handling.
              // Postgres default max_connections is 100; one pod
              // taking 30 leaves plenty for sibling pods + admin.
              max: parseInt(configService.get<string>('DB_POOL_SIZE', '30')),
              ...(dbSsl && { ssl: { rejectUnauthorized: false } }),
            },
          });
        // Replace default subscriber with our custom one that tracks the user
        (config as any).subscribers = [CustomVersionSubscriber];
        return {
          ...config,
          autoLoadEntities: true,
        };
      },
    }),

    // Entities registration
    TypeOrmModule.forFeature([
      User,
      Organization,
      UserOrganization,
      Team,
      UserTeam,
      ApiKey,
      Api,
      ApiSchema,
      JsonSchema,
      Operation,
      Resource,
      Credential,
      Tool,
      ToolVersion,
      ToolCategory,
      Gateway,
      GatewayTool,
      GatewayAuth,
      UsageMetric,
      RequestLog,
      Agent,
      AgentExecution,
      AgentRun,
      CanonicalMemory,
      CanonicalMemoryWorkspaceConfig,
      CanonicalMemorySoftcapWarning,
      Conversation,
      Message,
      AgentFile,
      AuditLog,
      ToolTemplate,
      ExternalAgent,
    ]),

    // Rate limiting
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        throttlers: [{
          ttl: configService.get('RATE_LIMIT_TTL', 60),
          limit: configService.get('RATE_LIMIT_MAX', 100),
        }],
      }),
    }),

    // Caching
    CacheModule.register({
      isGlobal: true,
      ttl: 300000, // 5 minutes in milliseconds
      max: 1000,
    }),

    // Redis configuration
    RedisModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'single',
        url: `redis://${configService.get('REDIS_HOST', 'localhost')}:${configService.get('REDIS_PORT', 6379)}`,
      }),
    }),

    // Job queues
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        redis: {
          host: configService.get('REDIS_HOST', 'localhost'),
          port: configService.get('REDIS_PORT', 6379),
        },
      }),
    }),

    // Application modules
    AuthModule,
    UsersModule,
    OrganizationsModule,
    SchemaParserModule,
    JsonSchemaTranslatorModule,
    ToolsModule,
    GatewaysModule,
    LlmProvidersModule,
    ApisModule,
    McpModule,
    JobsModule,
    PluginsModule,
    MonitoringModule,
    HealthModule,
    MailModule,
    CredentialsModule,
    AgentsModule,
    MemoryModule,
    FilesModule,
    AuditLogModule,
    VersionsModule,
    ToolHubModule,
    A2AModule,
    AcpModule,
    // MUST be last — wildcard /:orgSlug/:resourceSlug catches everything
    UnifiedEndpointModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: VersionContextInterceptor,
    },
  ],
})
export class AppModule {}