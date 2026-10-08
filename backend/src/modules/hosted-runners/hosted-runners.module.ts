import { Global, Module, OnModuleInit } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Environment } from '../../entities/environment.entity';
import { HostedRunner } from '../../entities/hosted-runner.entity';
import { RunnerEnrollmentToken } from '../../entities/runner-enrollment-token.entity';
import { RunnerUsageInterval } from '../../entities/runner-usage-interval.entity';
import { Runner } from '../../entities/runner.entity';
import { Workspace } from '../../entities/workspace.entity';
import { Credential } from '../../entities/credential.entity';
import { AuthorizationModule } from '../../common/authorization/authorization.module';
import { RunnerModule } from '../runner/runner.module';
import { HOSTED_DISPATCH } from '../runner/hosted-dispatch';
import { HostedAdapterRegistry } from './adapters/adapter.registry';
import { KubernetesHostedAdapter } from './adapters/kubernetes.adapter';
import { StubHostedAdapter } from './adapters/stub.adapter';
import { HostedRunnerSettingsService } from './hosted-runner-settings';
import { HOSTED_RECONCILE_QUEUE, HostedRunnersService } from './hosted-runners.service';
import { HostedRunnersProcessor } from './hosted-runners.processor';
import { EnrollmentService } from './enrollment.service';
import { HostedUsageService } from './hosted-usage.service';
import { EnvironmentsService } from './environments.service';
import { EnvironmentsController } from './environments.controller';
import { HostedRunnerEnrollmentController } from './hosted-runner-enrollment.controller';
import { HostedModelToken } from '../../entities/hosted-model-token.entity';
import { User } from '../../entities/user.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import { AgentExecution } from '../../entities/agent-execution.entity';
import { HostedModelTokenService } from './hosted-model-token.service';
import { HOSTED_MODEL_TOKENS } from './hosted-model-token.contract';
import { WorkspaceLeaseService } from './workspace-lease.service';
import { EnvironmentHandoverService } from './environment-handover.service';

/**
 * Hosted runners (docs/hosted-runners.md): environments, the persistent
 * workspaces their pods serve, enrollment, usage records, and the
 * reconcile loop that alone talks to a cluster. Apache-licensed; plan
 * capacity and Stripe reporting plug in from `ee` through
 * HOSTED_CAPACITY_PROVIDER (phase 3).
 *
 * Off unless HOSTED_RUNNERS_ENABLED=true: with it off the routes refuse to
 * create or change anything, enrollment refuses every token and the sweep
 * is not scheduled. Global so the tool executor can reach HOSTED_DISPATCH
 * without importing this module.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Environment,
      HostedRunner,
      RunnerEnrollmentToken,
      RunnerUsageInterval,
      Runner,
      Workspace,
      Credential,
      HostedModelToken,
      User,
      // A job's runs, to tell whether it still holds its workspace.
      AgentRun,
      AgentExecution,
    ]),
    BullModule.registerQueue({ name: HOSTED_RECONCILE_QUEUE }),
    AuthorizationModule,
    RunnerModule,
  ],
  providers: [
    { provide: HostedRunnerSettingsService, useFactory: () => new HostedRunnerSettingsService() },
    HostedAdapterRegistry,
    HostedRunnersService,
    HostedRunnersProcessor,
    EnrollmentService,
    HostedUsageService,
    EnvironmentsService,
    HostedModelTokenService,
    WorkspaceLeaseService,
    EnvironmentHandoverService,
    { provide: HOSTED_DISPATCH, useExisting: HostedRunnersService },
    { provide: HOSTED_MODEL_TOKENS, useExisting: HostedModelTokenService },
  ],
  controllers: [EnvironmentsController, HostedRunnerEnrollmentController],
  exports: [
    HostedRunnersService,
    HostedRunnerSettingsService,
    HOSTED_DISPATCH,
    EnvironmentsService,
    HOSTED_MODEL_TOKENS,
    EnvironmentHandoverService,
  ],
})
export class HostedRunnersModule implements OnModuleInit {
  constructor(
    private readonly adapters: HostedAdapterRegistry,
    private readonly settings: HostedRunnerSettingsService,
  ) {}

  onModuleInit(): void {
    this.adapters.register(new KubernetesHostedAdapter(() => this.settings.current.cluster));
    if (process.env.NODE_ENV !== 'production') this.adapters.register(new StubHostedAdapter());
  }
}
