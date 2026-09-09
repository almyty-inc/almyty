import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { LlmProvider } from '../../entities/llm-provider.entity';
import { EndpointProviderHelper } from './endpoint-provider.helper';
import { LlmProviderSecretsHelper } from './llm-provider-secrets.helper';

/**
 * Writing the provider row behind a model card needs nothing from the
 * chat stack: a repository and the credential store, both of which stand
 * on their own. Keeping it in its own module lets the catalog and the
 * deployment reconciler use it without importing LlmProvidersModule,
 * which would drag them into the providers/tools/agents dependency cycle.
 */
@Module({
  imports: [TypeOrmModule.forFeature([LlmProvider])],
  providers: [EndpointProviderHelper, LlmProviderSecretsHelper],
  exports: [EndpointProviderHelper],
})
export class EndpointProviderModule {}
