import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateWorkspaceDto } from './create-workspace.dto';
import { RunnerIsolationTier } from '../../../entities/runner.entity';

/**
 * POST /workspaces used to take a TypeScript interface. Nest's global
 * ValidationPipe reads the runtime metatype of the @Body() parameter to
 * decide whether to validate, and an interface erases to `Object` --
 * which the pipe classifies as a native type and skips. So the endpoint
 * ran with no validation and, more surprisingly, without the app-wide
 * `forbidNonWhitelisted` rule either.
 *
 * These tests are on the DTO rather than through the pipe because that
 * is where the rules are; the controller's part is naming the class,
 * which is what makes the pipe look at all.
 */
async function violations(payload: any): Promise<string[]> {
  const dto = plainToInstance(CreateWorkspaceDto, payload);
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return errors.flatMap((e) =>
    Object.keys(e.constraints ?? {}).map((constraint) => `${e.property}:${constraint}`),
  );
}

describe('CreateWorkspaceDto', () => {
  it('accepts a minimal body', async () => {
    await expect(violations({ cwd: '/Users/frane/workspace/almyty' })).resolves.toEqual([]);
  });

  it('accepts every optional field at a legal value', async () => {
    await expect(
      violations({
        cwd: '/srv/app',
        isolation: RunnerIsolationTier.HOST,
        ttlMs: 60_000,
        runnerId: '3f7c2b1e-9d4a-4c8e-9f1b-2a6d5e4c3b2a',
      }),
    ).resolves.toEqual([]);
  });

  it('refuses a missing cwd', async () => {
    const errs = await violations({});
    expect(errs).toContain('cwd:isString');
  });

  /**
   * The one that reached the database. `isolation` is an enum column,
   * so an unknown value was a Postgres error surfacing as a 500 on a
   * request that should have been answered 400.
   */
  it('refuses an isolation tier that is not one of the two', async () => {
    const errs = await violations({ cwd: '/srv/app', isolation: 'firejail' });
    expect(errs).toContain('isolation:isEnum');
  });

  it('refuses a ttl above the 24 hour ceiling, and a non-integer one', async () => {
    await expect(violations({ cwd: '/srv/app', ttlMs: 48 * 60 * 60 * 1000 })).resolves.toContain(
      'ttlMs:max',
    );
    await expect(violations({ cwd: '/srv/app', ttlMs: 'forever' })).resolves.toContain('ttlMs:isInt');
  });

  it('refuses a runnerId that is not a uuid', async () => {
    const errs = await violations({ cwd: '/srv/app', runnerId: "'; drop table workspaces--" });
    expect(errs).toContain('runnerId:isUuid');
  });

  it('refuses unknown fields, which the interface silently accepted', async () => {
    const errs = await violations({ cwd: '/srv/app', organizationId: 'someone-elses-org' });
    expect(errs).toContain('organizationId:whitelistValidation');
  });
});
