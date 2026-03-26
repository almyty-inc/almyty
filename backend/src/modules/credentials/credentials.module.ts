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

@Module({
  imports: [TypeOrmModule.forFeature([Credential, ApiKey, LlmProvider, Api, Gateway, Agent])],
  controllers: [CredentialsController],
  providers: [CredentialsService],
  exports: [CredentialsService],
})
export class CredentialsModule {}
