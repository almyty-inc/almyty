import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Two uniqueness rules the entities claim are enforced by the database.
 *
 * Both were app-code-only. The runner cap is a read-then-write in
 * runner.service.ts, which two concurrent registrations both pass, and
 * the table's own constraint included `name`, so a second runner was
 * accepted outright. After that findOne() returns an arbitrary row and
 * work routes to whichever runner Postgres picked -- possibly an offline
 * one. The distribution pair decides which credential signs a build, so a
 * duplicate means the wrong credential or an unsigned build, silently.
 *
 * Asserted over the migration SQL because that is where the guarantee
 * lives: a service-level test passes whether or not the database agrees,
 * which is exactly how both of these survived.
 */
const MIGRATIONS = join(__dirname, '../../migrations');

describe('uniqueness is enforced by the schema', () => {
  const sql = readFileSync(join(MIGRATIONS, '1750790000000-UniquenessParity.ts'), 'utf8');
  const up = sql.slice(sql.indexOf('async up('), sql.indexOf('async down('));
  const down = sql.slice(sql.indexOf('async down('));

  it('makes (ownerUserId, organizationId) unique on runners', () => {
    expect(up).toMatch(/CREATE UNIQUE INDEX[\s\S]*UQ_runners_owner_org[\s\S]*"ownerUserId", "organizationId"/);
  });

  it('drops the three-column constraint that allowed a second runner', () => {
    expect(up).toMatch(/DROP CONSTRAINT IF EXISTS runners_owner_org_name_unique/);
  });

  it('makes (appId, target) unique on distributions, replacing the plain index', () => {
    expect(up).toMatch(/DROP INDEX IF EXISTS "IDX_agent_app_distributions_app_target"/);
    expect(up).toMatch(/CREATE UNIQUE INDEX[\s\S]*UQ_agent_app_distributions_app_target/);
  });

  it('collapses existing duplicates first, or the whole migration fails', () => {
    // Adding a unique index to a table that already violates it aborts,
    // and a deploy that dies halfway is worse than the drift it fixes.
    expect((up.match(/DELETE FROM/g) ?? []).length).toBe(2);
    // A deterministic winner rather than whatever the planner returns.
    expect(up).toMatch(/keep\."updatedAt", keep\.id\) > /);
  });

  it('reverses in down(), restoring both original shapes', () => {
    expect(down).toMatch(/DROP INDEX IF EXISTS "UQ_runners_owner_org"/);
    expect(down).toMatch(/ADD CONSTRAINT runners_owner_org_name_unique/);
    expect(down).toMatch(/DROP INDEX IF EXISTS "UQ_agent_app_distributions_app_target"/);
    expect(down).toMatch(/CREATE INDEX IF NOT EXISTS "IDX_agent_app_distributions_app_target"/);
  });
});
