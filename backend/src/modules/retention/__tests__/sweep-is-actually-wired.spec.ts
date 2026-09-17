import { readFileSync } from 'fs';
import { join } from 'path';

import { UpdateRetentionPolicyDto } from '../dto/update-retention-policy.dto';

/**
 * A sweep clause nobody can reach is not a sweep.
 *
 * Two data classes were added to RetentionSweepService with `@Optional()
 * @InjectRepository(...)` and left out of the module's forFeature, so
 * both repositories resolved to undefined in the running app and the
 * guards in front of their clauses short-circuited forever. The DTO also
 * did not list either field, and the controller validates with
 * forbidNonWhitelisted -- so the column could never be set to non-null
 * either. Two tables went on growing behind a fix that read as done.
 *
 * The unit spec could not see any of it, because it constructs the
 * service directly with mock repositories. This asserts the wiring
 * instead of the logic.
 */
describe('every retention data class is actually wired', () => {
  const sweepSource = readFileSync(join(__dirname, '..', 'retention-sweep.service.ts'), 'utf8');
  const moduleSource = readFileSync(join(__dirname, '..', 'retention.module.ts'), 'utf8');

  /** Entities the sweep asks the container for. */
  const injected = [...sweepSource.matchAll(/@InjectRepository\((\w+)\)/g)].map(m => m[1]);

  it('finds the injected repositories, so this cannot pass by matching nothing', () => {
    expect(injected.length).toBeGreaterThanOrEqual(8);
  });

  it('registers every repository the sweep injects', () => {
    const registered = moduleSource.slice(
      moduleSource.indexOf('forFeature(['),
      moduleSource.indexOf('])', moduleSource.indexOf('forFeature([')),
    );

    const missing = injected.filter(entity => !new RegExp(`\\b${entity}\\b`).test(registered));

    expect(missing).toEqual([]);
  });

  it('lets an admin set every day-count the sweep reads', () => {
    // Each `policy.<x>Days` the sweep branches on must be settable, or
    // its clause is dead.
    const readFields = [...sweepSource.matchAll(/policy\.(\w+Days)\s*!=\s*null/g)].map(m => m[1]);
    expect(readFields.length).toBeGreaterThanOrEqual(5);

    const dto = new UpdateRetentionPolicyDto() as any;
    const dtoSource = readFileSync(
      join(__dirname, '..', 'dto', 'update-retention-policy.dto.ts'),
      'utf8',
    );
    const missing = readFields.filter(field => !new RegExp(`\\b${field}\\??:`).test(dtoSource));

    expect(missing).toEqual([]);
    expect(dto).toBeDefined();
  });
});
