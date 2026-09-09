import 'reflect-metadata';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../app.module';

/**
 * The container must actually build.
 *
 * The topology smoke test compares module names, and the image build only
 * requires the module file, so neither noticed when a global enterprise
 * module imported a module inside the providers/tools/agents forwardRef
 * cycle: every unit suite stayed green, the image built, and the pod then
 * hung forever half way through instantiating modules, with no error to
 * read. This boots the real graph, enterprise modules included, and fails
 * loudly instead of hanging.
 */
const run = process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;

run('the application graph instantiates (real Postgres + Redis)', () => {
  jest.setTimeout(120_000);

  it('creates every module without deadlocking', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });
});
