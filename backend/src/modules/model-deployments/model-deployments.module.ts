import { Module, OnModuleInit } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ModelDeployment } from '../../entities/model-deployment.entity';
import { ModelVersion } from '../../entities/model-version.entity';
import { Model } from '../../entities/model.entity';
import { SpendBudget } from '../../entities/spend-budget.entity';
import { Credential } from '../../entities/credential.entity';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { KmsModule } from '../kms/kms.module';
import { ModelRegistryModule } from '../model-registry/model-registry.module';
import { AdapterRegistry } from './adapters/adapter.registry';
import { StubAdapter } from './adapters/stub.adapter';
import { HuggingFaceEndpointsAdapter } from './adapters/huggingface-endpoints.adapter';
import { ModalAdapter } from './adapters/modal.adapter';
import { OllamaAdapter } from './adapters/ollama.adapter';
import { CustomEndpointAdapter } from './adapters/custom-endpoint.adapter';


import { ModelDeploymentsController } from './model-deployments.controller';
import { MODEL_RECONCILE_QUEUE, ModelDeploymentsService } from './model-deployments.service';
import { ModelDeploymentsProcessor } from './model-deployments.processor';

/**
 * Deployments: desired state through the API, provider mutations only
 * through the reconcile queue. Adapters register themselves here as data;
 * the stub is registered only outside production so the flow can be
 * exercised without an account anywhere.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([ModelDeployment, ModelVersion, Model, SpendBudget, Credential]),
    BullModule.registerQueue({ name: MODEL_RECONCILE_QUEUE }),
    AuditLogModule,
    KmsModule,
    ModelRegistryModule,
  ],
  providers: [AdapterRegistry, ModelDeploymentsService, ModelDeploymentsProcessor],
  controllers: [ModelDeploymentsController],
  exports: [AdapterRegistry, ModelDeploymentsService],
})
export class ModelDeploymentsModule implements OnModuleInit {
  constructor(private readonly adapters: AdapterRegistry) {}

  onModuleInit(): void {
    this.adapters.register(new HuggingFaceEndpointsAdapter());
    this.adapters.register(new ModalAdapter());
    this.adapters.register(new OllamaAdapter());
    this.adapters.register(new CustomEndpointAdapter());


    if (process.env.NODE_ENV !== 'production' || process.env.MODEL_STUB_ADAPTER === 'true') {
      this.adapters.register(new StubAdapter({ architectures: 'any' }));
    }
  }
}
