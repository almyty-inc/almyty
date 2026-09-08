import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Api } from '../../entities/api.entity';
import { ChannelInstallation } from '../../entities/channel-installation.entity';
import { Credential } from '../../entities/credential.entity';
import { LlmProvider } from '../../entities/llm-provider.entity';
import { McpSource } from '../../entities/mcp-source.entity';
import { ConsumerSecretBackfillService } from './consumer-secret-backfill.service';
import {
  AllowAllConnectionUsePolicy,
  CONNECTION_USE_POLICY,
  CredentialRefResolver,
} from './credential-ref.resolver';

/**
 * Global so every consumer (LLM providers, MCP sources, channel
 * installations, APIs, deployments) injects CredentialRefResolver without
 * an import edge into the credentials tree; the modules involved sit on
 * forwardRef cycles already and one more edge is what crash-looped
 * staging last time. KmsModule is global as well, so the envelope arrives
 * on its own.
 *
 * Gate 2 replaces the use policy by providing CONNECTION_USE_POLICY in
 * its own module or by calling `CredentialRefResolver.usePolicy()`.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Credential, LlmProvider, McpSource, ChannelInstallation, Api])],
  providers: [
    { provide: CONNECTION_USE_POLICY, useClass: AllowAllConnectionUsePolicy },
    CredentialRefResolver,
    ConsumerSecretBackfillService,
  ],
  exports: [CredentialRefResolver, CONNECTION_USE_POLICY, ConsumerSecretBackfillService],
})
export class CredentialRefModule {}
