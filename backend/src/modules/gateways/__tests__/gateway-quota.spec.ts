import { BadRequestException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { In } from 'typeorm';

import { GatewayType } from '../../../entities/gateway.entity';
import { Organization } from '../../../entities/organization.entity';
import { QuotaLockRequiresTransactionError } from '../../../common/quota/org-quota-lock';
import {
  GatewayQuotaExceededException,
  QUOTA_GATEWAY_TYPES,
  assertGatewayQuota,
  countsTowardGatewayQuota,
  withGatewayQuota,
} from '../gateway-quota';

/**
 * Exploit-shaped: an organization sitting exactly at
 * `settings.maxGateways` tries to add one more. Before the fix the only
 * check read the never-loaded `organization.gateways` relation, so it
 * always passed. The organization below is loaded the way production
 * loads it: plain columns, no `gateways` relation.
 */
const ORG = 'org-1';

function quotaManager(opts: { maxGateways?: number; current: number }) {
  const org = Object.assign(new Organization(), {
    id: ORG,
    settings: opts.maxGateways ? { maxGateways: opts.maxGateways } : {},
  });
  const orgRepo = { findOne: jest.fn().mockResolvedValue(org) };
  const count = jest.fn().mockResolvedValue(opts.current);
  const lock = jest.fn(async (_sql: string, _params?: unknown[]) => []);
  const getRepository = jest.fn((entity: unknown) => (entity === Organization ? orgRepo : { count }));
  const tx: any = { queryRunner: { isTransactionActive: true }, query: lock, getRepository };
  const manager: any = { getRepository, transaction: jest.fn(async (cb: any) => cb(tx)) };
  return { manager, tx, org, count, lock };
}

describe('gateway quota', () => {
  it('counts with a real query, not the organization.gateways relation', async () => {
    const { tx, org, count } = quotaManager({ maxGateways: 3, current: 3 });
    expect(org.gateways).toBeUndefined();
    await expect(assertGatewayQuota(tx, ORG)).rejects.toBeInstanceOf(GatewayQuotaExceededException);
    await expect(assertGatewayQuota(tx, ORG)).rejects.toBeInstanceOf(BadRequestException);
    // The platform's own system gateway is not the organization's, and
    // channels (web chat, widget, messaging, A2A) are the agents'.
    expect(count).toHaveBeenCalledWith({ where: { organizationId: ORG, isSystem: false, type: In(['mcp', 'utcp', 'skills']) } });
  });

  it('counts MCP, UTCP and Skills gateways toward the plan, and no channel', () => {
    expect(QUOTA_GATEWAY_TYPES).toEqual([GatewayType.MCP, GatewayType.UTCP, GatewayType.SKILLS]);
    for (const type of [GatewayType.MCP, GatewayType.UTCP, GatewayType.SKILLS]) expect(countsTowardGatewayQuota(type)).toBe(true);
    for (const type of [GatewayType.A2A, GatewayType.SLACK, GatewayType.CHAT_WIDGET, GatewayType.HOSTED_CHAT, GatewayType.EMAIL]) {
      expect(countsTowardGatewayQuota(type)).toBe(false);
    }
  });

  it('lets a channel gateway in at the limit: creating one adds nothing to the count', async () => {
    const full = quotaManager({ maxGateways: 3, current: 3 });
    const insert = jest.fn(async () => 'saved');
    await expect(withGatewayQuota(full.manager, ORG, 0, insert)).resolves.toBe('saved');
    expect(full.count).not.toHaveBeenCalled();
  });

  it('is asked with nothing to add when the gateway being made is a channel', () => {
    const src = readFileSync(join(__dirname, '..', 'gateways.service.ts'), 'utf8');
    expect(src).toMatch(/withGatewayQuota\([\s\S]{0,300}countsTowardGatewayQuota\(createGatewayDto\.type\) \? 1 : 0/);
  });

  it('lets a gateway in while there is room', async () => {
    const { tx } = quotaManager({ maxGateways: 3, current: 2 });
    await expect(assertGatewayQuota(tx, ORG)).resolves.toBeUndefined();
    await expect(assertGatewayQuota(tx, ORG, 2)).rejects.toThrow('this would add 2 gateways and only 1 remain');
  });

  it('lets an organization without a limit through, without locking', async () => {
    const { tx, lock } = quotaManager({ current: 10_000 });
    await expect(assertGatewayQuota(tx, ORG)).resolves.toBeUndefined();
    expect(lock).not.toHaveBeenCalled();
  });

  it('takes the per-organization gateway lock before it counts', async () => {
    const { tx, lock, count } = quotaManager({ maxGateways: 3, current: 0 });
    await assertGatewayQuota(tx, ORG);
    expect(lock).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext($1))', [`quota:gateways:${ORG}`]);
    expect(lock.mock.invocationCallOrder[0]).toBeLessThan(count.mock.invocationCallOrder[0]);
  });

  it('refuses to run outside a transaction', async () => {
    const { manager } = quotaManager({ maxGateways: 3, current: 0 });
    await expect(assertGatewayQuota(manager, ORG)).rejects.toBeInstanceOf(QuotaLockRequiresTransactionError);
  });

  it('withGatewayQuota runs the insert in the checked transaction, and not at all when refused', async () => {
    const room = quotaManager({ maxGateways: 3, current: 1 });
    await expect(withGatewayQuota(room.manager, ORG, 1, async (t) => t)).resolves.toBe(room.tx);

    const full = quotaManager({ maxGateways: 3, current: 3 });
    const insert = jest.fn();
    await expect(withGatewayQuota(full.manager, ORG, 1, insert)).rejects.toBeInstanceOf(
      GatewayQuotaExceededException,
    );
    expect(insert).not.toHaveBeenCalled();
  });
});
