import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { AgentAppsController } from '../../modules/agent-apps/agent-apps.controller';
import { ApisCredentialsController } from '../../modules/apis/apis-credentials.controller';
import { BudgetsController } from '../../modules/budgets/budgets.controller';
import { PromotedSkillsController } from '../../modules/promoted-skills/promoted-skills.controller';
import {
  CreateAppBodyDto,
  RequestBuildBodyDto,
  UpdateAppBodyDto,
} from '../../modules/agent-apps/dto/agent-apps-controller.dto';
import {
  CreateApiCredentialBodyDto,
  UpdateApiCredentialBodyDto,
} from '../../modules/apis/dto/api-credential.dto';
import {
  CreateBudgetBodyDto,
  UpdateBudgetBodyDto,
} from '../../modules/budgets/dto/budgets-controller.dto';
import { PromoteRunBodyDto } from '../../modules/promoted-skills/dto/promote-run.dto';

/**
 * A `@Body()` parameter typed with an interface (or an inline object
 * type, or an intersection of them) erases at compile time. Nest then
 * reads `design:paramtypes` as `Object`, `ValidationPipe` treats the
 * metatype as untypeable and hands the raw body straight through -- so
 * the app-wide `whitelist` / `forbidNonWhitelisted` policy set in
 * main.ts does not apply, and neither does any decorator.
 *
 * These four write endpoints took service-level interfaces as their
 * bodies: POST/PATCH /apps and POST /apps/:slug/builds,
 * POST/PUT /apis/:id/credentials, POST/PATCH /budgets, and
 * POST /promoted-skills. Every one of them was unvalidated.
 *
 * The first block is the real regression guard: it asserts the runtime
 * metatype is the DTO class, which is precisely the thing an interface
 * cannot be.
 */
describe('write endpoints take DTO classes, not interfaces', () => {
  const bodyMetatype = (controller: any, method: string, index: number) =>
    Reflect.getMetadata('design:paramtypes', controller.prototype, method)?.[index];

  it.each([
    ['POST /apps', AgentAppsController, 'create', 0, CreateAppBodyDto],
    ['PATCH /apps/:slug', AgentAppsController, 'update', 1, UpdateAppBodyDto],
    ['POST /apps/:slug/builds', AgentAppsController, 'requestBuild', 1, RequestBuildBodyDto],
    ['POST /apis/:id/credentials', ApisCredentialsController, 'createCredential', 2, CreateApiCredentialBodyDto],
    ['PUT /apis/:id/credentials/:credentialId', ApisCredentialsController, 'updateCredential', 2, UpdateApiCredentialBodyDto],
    ['POST /budgets', BudgetsController, 'create', 0, CreateBudgetBodyDto],
    ['PATCH /budgets/:id', BudgetsController, 'update', 1, UpdateBudgetBodyDto],
    ['POST /promoted-skills', PromotedSkillsController, 'promote', 0, PromoteRunBodyDto],
  ])('%s carries a class metatype', (_route, controller, method, index, expected) => {
    const metatype = bodyMetatype(controller, method as string, index as number);

    expect(metatype).toBe(expected);
    // The failure mode this guards: an erased type reads back as Object.
    expect(metatype).not.toBe(Object);
  });
});

describe('the global validation policy now reaches those bodies', () => {
  // The same options main.ts installs globally.
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
  });
  const meta = (metatype: any) => ({ type: 'body' as const, metatype, data: '' });

  it.each([
    [CreateAppBodyDto, { name: 'Acme', slug: 'acme' }],
    [CreateApiCredentialBodyDto, { name: 'key', type: 'api_key' }],
    [CreateBudgetBodyDto, { limitCents: 5000 }],
    [PromoteRunBodyDto, { runId: '11111111-1111-4111-8111-111111111111' }],
  ])('%p refuses an undeclared property', async (metatype, valid) => {
    await expect(pipe.transform({ ...valid }, meta(metatype))).resolves.toBeDefined();
    await expect(
      pipe.transform({ ...valid, organizationId: 'someone-elses-org' }, meta(metatype)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a POST /apps body with no slug instead of 500ing on slug.trim()', async () => {
    await expect(pipe.transform({ name: 'Acme' }, meta(CreateAppBodyDto))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses a credential with a type that is not a CredentialType', async () => {
    await expect(
      pipe.transform({ name: 'key', type: 'not_a_type' }, meta(CreateApiCredentialBodyDto)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a budget whose agentId is not a uuid', async () => {
    await expect(
      pipe.transform({ limitCents: 100, agentId: 'not-a-uuid' }, meta(CreateBudgetBodyDto)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a promote body whose distill names no provider', async () => {
    await expect(
      pipe.transform(
        { runId: '11111111-1111-4111-8111-111111111111', distill: { model: 'gpt-x' } },
        meta(PromoteRunBodyDto),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('still accepts the bodies the dashboard actually sends', async () => {
    await expect(
      pipe.transform(
        { name: 'Acme', slug: 'acme', description: null, agentIds: [] },
        meta(CreateAppBodyDto),
      ),
    ).resolves.toBeDefined();

    await expect(
      pipe.transform(
        {
          agentId: null,
          periodType: 'month',
          limitCents: 5000,
          behavior: 'warn_log',
          softThresholdPct: 80,
          active: true,
        },
        meta(CreateBudgetBodyDto),
      ),
    ).resolves.toBeDefined();

    await expect(
      pipe.transform({ agentIds: ['11111111-1111-4111-8111-111111111111'] }, meta(UpdateAppBodyDto)),
    ).resolves.toBeDefined();

    await expect(
      pipe.transform(
        { name: 'k', type: 'api_key', config: { apiKey: 'x' } },
        meta(CreateApiCredentialBodyDto),
      ),
    ).resolves.toBeDefined();

    await expect(
      pipe.transform({ isActive: false }, meta(UpdateApiCredentialBodyDto)),
    ).resolves.toBeDefined();

    await expect(
      pipe.transform({ limitCents: 1 }, meta(UpdateBudgetBodyDto)),
    ).resolves.toBeDefined();
  });
});
