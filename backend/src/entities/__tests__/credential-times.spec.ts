import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getMetadataArgsStorage } from 'typeorm';

import { Credential } from '../credential.entity';

/**
 * A credential's times carry their time zone. As `timestamp without time
 * zone` the database's default (UTC) and the driver's reading (local
 * time) disagreed, and a credential added a minute ago showed "2h ago"
 * on any backend not running in UTC.
 */
describe('credential times', () => {
  const TIMES = ['createdAt', 'updatedAt', 'expiresAt', 'lastUsedAt', 'healthCheckedAt'];
  const columns = getMetadataArgsStorage().columns.filter((c) => c.target === Credential);

  it.each(TIMES)('%s is timestamptz', (name) => {
    const column = columns.find((c) => c.propertyName === name);
    expect(column).toBeDefined();
    expect(column!.options.type).toBe('timestamptz');
  });

  it('a migration converts the existing columns, reading their values as UTC', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'migrations', '1750813759000-CredentialTimesWithZone.ts'), 'utf8');
    for (const name of TIMES) expect(source).toContain(`'${name}'`);
    expect(source).toMatch(/TYPE timestamptz USING "\$\{column\}" AT TIME ZONE 'UTC'/);
  });
});
