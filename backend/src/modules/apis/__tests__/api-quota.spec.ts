import { BadRequestException } from '@nestjs/common';

import { Organization } from '../../../entities/organization.entity';
import { QuotaLockRequiresTransactionError } from '../../../common/quota/org-quota-lock';
import {
  ApiQuotaExceededException,
  assertApiQuota,
  remainingApiQuota,
  withApiQuota,
} from '../api-quota';

/**
 * Exploit-shaped: an organization sitting exactly at
 * `settings.maxApis` tries to add one more. Before the fix the only
 * check read the never-loaded `organization.apis` relation, so it
 * always passed. The organization below is loaded the way production
 * loads it: plain columns, no `apis` relation.
 */
const ORG = 'org-1';

function quotaManager(opts: { maxApis?: number; current: number }) {
  const org = Object.assign(new Organization(), {
    id: ORG,
    settings: opts.maxApis ? { maxApis: opts.maxApis } : {},
  });
  const orgRepo = { findOne: jest.fn().mockResolvedValue(org) };
  const count = jest.fn().mockResolvedValue(opts.current);
  const lock = jest.fn(async (_sql: string, _params?: unknown[]) => []);
  const getRepository = jest.fn((entity: unknown) => (entity === Organization ? orgRepo : { count }));
  const tx: any = { queryRunner: { isTransactionActive: true }, query: lock, getRepository };
  const manager: any = { getRepository, transaction: jest.fn(async (cb: any) => cb(tx)) };
  return { manager, tx, org, count, lock };
}

describe('API quota', () => {
  it('counts with a real query, not the organization.apis relation', async () => {
    const { tx, org, count } = quotaManager({ maxApis: 3, current: 3 });
    expect(org.apis).toBeUndefined();
    await expect(assertApiQuota(tx, ORG)).rejects.toBeInstanceOf(ApiQuotaExceededException);
    await expect(assertApiQuota(tx, ORG)).rejects.toBeInstanceOf(BadRequestException);
    // Every API row counts: deleting an API removes its row.
    expect(count).toHaveBeenCalledWith({ where: { organizationId: ORG } });
  });

  it('lets an API in while there is room', async () => {
    const { tx } = quotaManager({ maxApis: 3, current: 2 });
    await expect(assertApiQuota(tx, ORG)).resolves.toBeUndefined();
    await expect(assertApiQuota(tx, ORG, 2)).rejects.toThrow('this would add 2 APIs and only 1 remain');
  });

  it('lets an organization without a limit through, without locking', async () => {
    const { tx, lock } = quotaManager({ current: 10_000 });
    await expect(assertApiQuota(tx, ORG)).resolves.toBeUndefined();
    expect(lock).not.toHaveBeenCalled();
  });

  it('takes the per-organization API lock before it counts', async () => {
    const { tx, lock, count } = quotaManager({ maxApis: 3, current: 0 });
    await assertApiQuota(tx, ORG);
    expect(lock).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext($1))', [`quota:apis:${ORG}`]);
    expect(lock.mock.invocationCallOrder[0]).toBeLessThan(count.mock.invocationCallOrder[0]);
  });

  it('refuses to run outside a transaction', async () => {
    const { manager } = quotaManager({ maxApis: 3, current: 0 });
    await expect(assertApiQuota(manager, ORG)).rejects.toBeInstanceOf(QuotaLockRequiresTransactionError);
  });

  it('withApiQuota runs the insert in the checked transaction, and not at all when refused', async () => {
    const room = quotaManager({ maxApis: 3, current: 1 });
    await expect(withApiQuota(room.manager, ORG, 1, async (t) => t)).resolves.toBe(room.tx);

    const full = quotaManager({ maxApis: 3, current: 3 });
    const insert = jest.fn();
    await expect(withApiQuota(full.manager, ORG, 1, insert)).rejects.toBeInstanceOf(
      ApiQuotaExceededException,
    );
    expect(insert).not.toHaveBeenCalled();
  });

  it('reports remaining slots', async () => {
    await expect(remainingApiQuota(quotaManager({ maxApis: 5, current: 2 }).manager, ORG)).resolves.toBe(3);
    await expect(remainingApiQuota(quotaManager({ current: 2 }).manager, ORG)).resolves.toBe(Infinity);
  });
});
