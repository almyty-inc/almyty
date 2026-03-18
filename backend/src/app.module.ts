import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { CacheModule } from '@nestjs/cache-manager';
import { BullModule } from '@nestjs/bull';
import { RedisModule } from '@nestjs-modules/ioredis';
import * as redisStore from 'cache-manager-redis-store';

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
import { AgentsModule } from './modules/agents/agents.module';

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

        return {
          type: 'postgres' as const,
          host: configService.get<string>('DATABASE_HOST', 'localhost'),
          port: parseInt(configService.get<string>('DATABASE_PORT', '5432')),
          username: configService.get<string>('DATABASE_USERNAME', 'postgres'),
          password: configService.get<string>('DATABASE_PASSWORD', 'password'),
          database: configService.get<string>('DATABASE_NAME', 'apifai'),
          entities: [__dirname + '/entities/*.entity{.ts,.js}'],
          migrations: [__dirname + '/migrations/*{.ts,.js}'],
          migrationsRun: false,
          synchronize: configService.get('DB_SYNC', 'false') === 'true',
          logging: configService.get('NODE_ENV') === 'development',
          autoLoadEntities: true,
          ssl: dbSsl ? { rejectUnauthorized: false } : false,
          extra: {
            ...(dbSsl && { ssl: { rejectUnauthorized: false } }),
          },
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
    AgentsModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}