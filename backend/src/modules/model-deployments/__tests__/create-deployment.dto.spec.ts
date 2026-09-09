import { ValidationPipe } from '@nestjs/common';

import { CreateModelDeploymentBodyDto } from '../dto/model-deployments-controller.dto';

/**
 * The controller's validation, driven the way Nest drives it.
 *
 * This exists because the service, the entity, the migration and the
 * source matrix all shipped correct while this DTO still demanded a
 * `modelVersionId`, so every request the new API is meant to accept was
 * rejected before any of that logic ran. Unit tests on the service cannot
 * see that: they call the service directly and never cross the pipe.
 */
describe('CreateModelDeploymentBodyDto through the validation pipe', () => {
  const pipe = new ValidationPipe();
  const meta = { type: 'body' as const, metatype: CreateModelDeploymentBodyDto };
  const run = (body: Record<string, unknown>) => pipe.transform(body, meta);

  it('accepts a model named as configuration, with no version anywhere', async () => {
    await expect(run({ model: 'hf://Qwen/Qwen3-0.6B@main', providerType: 'huggingface-endpoints' })).resolves.toMatchObject({
      model: 'hf://Qwen/Qwen3-0.6B@main',
      providerType: 'huggingface-endpoints',
    });
  });

  it('accepts a model that already lives on a provider', async () => {
    await expect(run({ model: 'fireworks://accounts/acme/models/qwen3', providerType: 'fireworks' })).resolves.toMatchObject({
      model: 'fireworks://accounts/acme/models/qwen3',
    });
  });

  it('accepts a base alongside the model, for a reference with no manifest', async () => {
    await expect(run({ model: 'hf://Qwen/Qwen3-0.6B@main', base: 'qwen3-0.6b', providerType: 'modal' })).resolves.toMatchObject({ base: 'qwen3-0.6b' });
  });

  it('still accepts a registered version, which is now optional rather than required', async () => {
    await expect(
      run({ modelVersionId: '3f1b6a24-6c1e-4f77-9a1a-0f2f0a1d9c11', providerType: 'modal' }),
    ).resolves.toMatchObject({ modelVersionId: '3f1b6a24-6c1e-4f77-9a1a-0f2f0a1d9c11' });
  });

  it('refuses a version id that is not a uuid, and a missing provider', async () => {
    await expect(run({ modelVersionId: 'not-a-uuid', providerType: 'modal' })).rejects.toThrow();
    await expect(run({ model: 'hf://Qwen/Qwen3-0.6B@main' })).rejects.toThrow();
  });

  it('lets a body with neither reference through the pipe, so the service answers MODEL_REQUIRED', async () => {
    // Which of the two is present is not a shape question: the service
    // decides it and says so with a code the form can render.
    await expect(run({ providerType: 'modal' })).resolves.toMatchObject({ providerType: 'modal' });
  });
});
