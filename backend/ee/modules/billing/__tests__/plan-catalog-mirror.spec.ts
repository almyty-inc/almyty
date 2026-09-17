import { readFileSync } from 'fs';
import { join } from 'path';

import { PLAN_ENTITLEMENTS } from '../billing.constants';
import { EE_ENTITLEMENTS } from '../../../../src/modules/licensing/license.constants';

const FRONTEND_CATALOG = join(
  __dirname, '..', '..', '..', '..', '..', 'frontend', 'src', 'lib', 'plan-catalog.ts',
);

/**
 * The plan catalog the customer reads must match the one that mints tokens.
 *
 * `plan-catalog.ts` declares itself a mirror of PLAN_ENTITLEMENTS and
 * asks to be kept in sync, and `white_label` drifted: the backend granted
 * it on Enterprise while the frontend listed neither the entitlement nor
 * a comparison row, so a customer weighing plans never saw that removing
 * the almyty mark was something Enterprise includes.
 *
 * Read as text rather than imported, because the frontend is a separate
 * TypeScript project.
 */
describe('the frontend plan catalog mirrors the backend', () => {
  const catalog = readFileSync(FRONTEND_CATALOG, 'utf8');

  const frontendBlock = (plan: string): string => {
    const start = catalog.indexOf(`${plan}:`, catalog.indexOf('PLAN_ENTITLEMENTS'));
    return catalog.slice(start, catalog.indexOf('\n  ]', start) + 4);
  };

  it.each(['business', 'enterprise'])('lists every %s entitlement the backend grants', plan => {
    const granted = PLAN_ENTITLEMENTS[plan] ?? [];
    expect(granted.length).toBeGreaterThan(0);

    const block = frontendBlock(plan);
    const missing = granted.filter(key => !block.includes(`'${key}'`));

    expect(missing).toEqual([]);
  });

  it('gives every entitlement a row in the comparison matrix', () => {
    const matrix = catalog.slice(catalog.indexOf('FEATURE_MATRIX'));
    const granted = [...new Set(Object.values(PLAN_ENTITLEMENTS).flat())];

    const unlisted = granted.filter(key => !matrix.includes(`entitlement: '${key}'`));

    expect(unlisted).toEqual([]);
  });

  it('does not grant an entitlement that is not defined', () => {
    const defined = new Set(Object.values(EE_ENTITLEMENTS));
    const granted = [...new Set(Object.values(PLAN_ENTITLEMENTS).flat())];

    expect(granted.filter(key => !defined.has(key as any))).toEqual([]);
  });
});
