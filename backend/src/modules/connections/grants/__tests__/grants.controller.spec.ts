import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';

import { CreateGrantDto } from '../dto/grants.dto';
import { GrantsController } from '../grants.controller';

async function violations(payload: any): Promise<string[]> {
  const errors = await validate(plainToInstance(CreateGrantDto, payload), { whitelist: true, forbidNonWhitelisted: true });
  return errors.flatMap((e) => Object.keys(e.constraints ?? {}).map((k) => `${e.property}:${k}`));
}

describe('CreateGrantDto', () => {
  const good = { principalType: 'agent', principalId: randomUUID() };

  it('accepts the documented shape', async () => {
    expect(await violations(good)).toEqual([]);
    expect(await violations({ ...good, permission: 'manage', budgetId: randomUUID(), expiresAt: '2030-01-01T00:00:00Z' })).toEqual([]);
    expect(await violations({ principalType: 'role', principalId: 'member' })).toEqual([]);
  });

  it('rejects unknown principal types, empty ids, bad permissions, non-uuid budgets, non-ISO dates and extra keys', async () => {
    expect(await violations({ ...good, principalType: 'robot' })).toContain('principalType:isIn');
    expect(await violations({ principalType: 'user' })).toContain('principalId:isString');
    expect(await violations({ principalType: 'user', principalId: '' })).toContain('principalId:minLength');
    expect(await violations({ principalType: 'user', principalId: 'x'.repeat(65) })).toContain('principalId:maxLength');
    expect(await violations({ ...good, permission: 'own' })).toContain('permission:isIn');
    expect(await violations({ ...good, budgetId: 'budget-1' })).toContain('budgetId:isUuid');
    expect(await violations({ ...good, expiresAt: 'next week' })).toContain('expiresAt:isIso8601');
    expect(await violations({ ...good, expiresAt: 1234 })).toContain('expiresAt:isIso8601');
    expect(await violations({ ...good, organizationId: 'org-2' })).toContain('organizationId:whitelistValidation');
  });
});

describe('GrantsController', () => {
  const CONNECTION = randomUUID();
  const GRANT = randomUUID();
  const service = () => ({
    list: jest.fn(async () => [{ id: GRANT }]),
    grant: jest.fn(async (_id: string, input: any) => ({ id: GRANT, connectionId: CONNECTION, ...input })),
    // Mirrors the real service: the grant/connection binding is checked
    // inside revoke(), before the row is removed.
    revoke: jest.fn(async (grantId: string, _actor: any, _org: any, expectedConnectionId?: string) => {
      if (expectedConnectionId && expectedConnectionId !== CONNECTION) {
        throw new NotFoundException({ code: 'GRANT_NOT_FOUND', message: 'grant does not belong to this connection' });
      }
      return { id: grantId, connectionId: CONNECTION };
    }),
  });
  const req = (currentOrganizationId?: string) => ({ user: { id: 'u-1', currentOrganizationId, organizationMemberships: [] } });

  it('passes the request user and organization through and wraps the result', async () => {
    const svc = service();
    const controller = new GrantsController(svc as any);
    expect(await controller.list(req('org-1'), CONNECTION)).toEqual({ success: true, data: [{ id: GRANT }], message: 'Grants retrieved successfully' });
    expect(svc.list).toHaveBeenCalledWith(CONNECTION, req('org-1').user, 'org-1');

    const body = { principalType: 'user', principalId: 'u-2', permission: 'use' } as any;
    expect(await controller.create(req('org-1'), CONNECTION, body)).toMatchObject({ success: true, data: { id: GRANT, principalId: 'u-2' } });
    expect(svc.grant).toHaveBeenCalledWith(CONNECTION, body, req('org-1').user, 'org-1');

    expect(await controller.revoke(req('org-1'), CONNECTION, GRANT)).toMatchObject({ success: true, data: { id: GRANT } });
    expect(svc.revoke).toHaveBeenCalledWith(GRANT, req('org-1').user, 'org-1', CONNECTION);
  });

  it('requires an organization context', async () => {
    const controller = new GrantsController(service() as any);
    await expect(controller.list(req(), CONNECTION)).rejects.toMatchObject({ response: { error: 'NO_ORGANIZATION' } });
    await expect(controller.create(req(), CONNECTION, {} as any)).rejects.toMatchObject({ response: { error: 'NO_ORGANIZATION' } });
    await expect(controller.revoke(req(), CONNECTION, GRANT)).rejects.toMatchObject({ response: { error: 'NO_ORGANIZATION' } });
  });

  it('hands the addressed connection id to revoke, so the binding is checked before the delete', async () => {
    const svc = service();
    const controller = new GrantsController(svc as any);
    const other = randomUUID();
    await expect(controller.revoke(req('org-1'), other, GRANT)).rejects.toMatchObject({ response: { code: 'GRANT_NOT_FOUND' } });
    expect(svc.revoke).toHaveBeenCalledWith(GRANT, req('org-1').user, 'org-1', other);
  });
});
