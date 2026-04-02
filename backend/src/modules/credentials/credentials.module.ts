import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Credential } from '../../entities/credential.entity';
import { ApiKey } from '../../entities/api-key.entity';
import { LlmProvider } from '../../entities/llm-provider.entity';
import { Api } from '../../entities/api.entity';
import { Gateway } from '../../entities/gateway.entity';
import { Agent } from '../../entities/agent.entity';
import { CredentialsController } from './credentials.controller';
import { CredentialsService } from './credentials.service';
import { OAuth2Controller } from './oauth2.controller';
import { OAuth2Service } from './oauth2.service';

@Module({
  imports: [TypeOrmModule.forFeature([Credential, ApiKey, LlmProvider, Api, Gateway, Agent])],
  controllers: [CredentialsController, OAuth2Controller],
  providers: [CredentialsService, OAuth2Service],
  exports: [CredentialsService, OAuth2Service],
})
export class CredentialsModule {}
