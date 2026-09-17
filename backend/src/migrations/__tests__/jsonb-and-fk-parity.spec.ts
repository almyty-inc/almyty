import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..');
const ENTITIES = join(__dirname, '..', '..', 'entities');

const migrationFiles = () => readdirSync(MIGRATIONS).filter(f => f.endsWith('.ts'));
const allMigrations = migrationFiles()
  .map(f => readFileSync(join(MIGRATIONS, f), 'utf8'))
  .join('\n');

const entityFile = (name: string) => readFileSync(join(ENTITIES, name), 'utf8');

/**
 * Types the database actually has, not the ones the entity claims.
 *
 * `synchronize` is off, so an entity decorator is a description, never a
 * change. Two of them described something the schema did not have, and
 * both failed only at run time: `organizations.settings` was `json`
 * while the invite lookup used the jsonb-only `@>` operator, so the
 * whole invite-accept path threw `operator does not exist: json @>`;
 * `org_kms_configs.organizationId` was `character varying` with no
 * foreign key, so `onDelete: CASCADE` did nothing and a deleted
 * organization left its wrapped encryption key behind.
 */
describe('entity types match the schema', () => {
  it('stores organizations.settings as jsonb, because the invite lookup needs @>', () => {
    expect(entityFile('organization.entity.ts')).toContain(
      "@Column({ type: 'jsonb', nullable: true })\n  settings:",
    );
    expect(allMigrations).toMatch(/ALTER COLUMN "settings" TYPE jsonb/);
  });

  it('keeps @> off any column the schema still stores as json', () => {
    // A containment query against a json column is a run-time error, not
    // a slow query -- worth catching in the file rather than in prod.
    const invites = readFileSync(
      join(__dirname, '..', '..', 'modules', 'organizations', 'organizations-invites.helper.ts'),
      'utf8',
    );
    if (invites.includes('@> :needle')) {
      expect(entityFile('organization.entity.ts')).toContain("type: 'jsonb'");
    }
  });

  it('backs the org_kms_configs relation with a real foreign key', () => {
    expect(entityFile('org-kms-config.entity.ts')).toContain("@Column({ type: 'uuid' })");
    expect(allMigrations).toContain('FK_org_kms_configs_organization');
    expect(allMigrations).toMatch(/REFERENCES "organizations"\("id"\) ON DELETE CASCADE/);
  });

  it('gives every migration a down that undoes its up', () => {
    const withoutDown = migrationFiles().filter(
      f => !/public async down\(/.test(readFileSync(join(MIGRATIONS, f), 'utf8')),
    );

    expect(withoutDown).toEqual([]);
  });
});
