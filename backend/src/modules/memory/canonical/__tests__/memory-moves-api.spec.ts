import 'reflect-metadata';
import { HttpException } from '@nestjs/common';

import { CanonicalMemoryController } from '../canonical-memory.controller';
import { fakeRepository } from '../../../../test/fake-repository';
import { orgMembersPolicy } from '../../../../test/execution-access.fixture';
import { OrganizationRole } from '../../../../entities/user-organization.entity';

/**
 * The Memory API's account list and moves.
 *
 *  - A move names accounts by id (almyty-native or a memory connection)
 *    and a scope that must be the caller's own; an agent's memory only
 *    when the caller can see that agent.
 *  - A move of an agent's memory is visible only to those who can see
 *    the agent.
 *  - `moves` is declared before `:id`, or GET /memory/canonical/moves
 *    would be read as "the memory with id moves".
 */
describe('memory accounts and moves over the Memory API', () => {
  const ORG = 'org-1';
  const agents = fakeRepository([
    { id: 'a-org', organizationId: ORG, visibility: 'org', teamId: null, createdBy: 'owner', isTemporary: false },
    { id: 'a-private', organizationId: ORG, visibility: 'private', teamId: null, createdBy: 'owner', isTemporary: false },
  ] as any);
  const policy = orgMembersPolicy(ORG, { owner: OrganizationRole.ADMIN, other: OrganizationRole.ADMIN });
  const MEMBERSHIPS = [{ organizationId: ORG, role: 'admin', status: 'active' }];
  const req = (userId: string) => ({ user: { id: userId, sub: userId, currentOrganizationId: ORG, organizationMemberships: MEMBERSHIPS } });

  function build(moveRow: Record<string, any> = { id: 'mv-1', scopeType: 'workspace', scopeId: ORG }) {
    const accounts = {
      overview: jest.fn(async () => ({ accounts: [], services: [] })),
      describeAccount: jest.fn(async (_org: string, _u: any, id: string) =>
        id === 'almyty-native' ? { service: 'almyty-native', credentialId: null, name: 'almyty' } : { service: 'mem0', credentialId: id, name: 'Mem0' },
      ),
    };
    const moves = {
      start: jest.fn(async () => ({ id: 'mv-1', status: 'queued' })),
      preview: jest.fn(async () => ({ total: 3, more: false, warnings: [] })),
      resume: jest.fn(async () => ({ id: 'mv-1', status: 'queued' })),
      get: jest.fn(async () => moveRow),
      list: jest.fn(async () => []),
    };
    const ctrl: any = new CanonicalMemoryController({} as any, {} as any, {} as any, {} as any, {} as any, accounts as any, policy as any, agents as any, moves as any);
    return { ctrl, accounts, moves };
  }

  it('starts a move between the accounts named, in the caller’s own scope', async () => {
    const { ctrl, moves, accounts } = build();
    const res = await ctrl.startMove({ source: 'almyty-native', target: 'cred-9', scope_type: 'workspace', scope_id: ORG }, req('owner'));
    expect(res.data).toEqual({ id: 'mv-1', status: 'queued' });
    expect(accounts.describeAccount).toHaveBeenCalledWith(ORG, expect.objectContaining({ id: 'owner', organizationMemberships: MEMBERSHIPS }), 'cred-9');
    expect(moves.start).toHaveBeenCalledWith(ORG, 'owner', {
      source: { service: 'almyty-native', credentialId: null, name: 'almyty' },
      target: { service: 'mem0', credentialId: 'cred-9', name: 'Mem0' },
      scope: { scope_type: 'workspace', scope_id: ORG },
      mode: undefined,
    });
  });

  it('a dry run previews instead of starting', async () => {
    const { ctrl, moves } = build();
    const res = await ctrl.startMove({ source: 'almyty-native', target: 'cred-9', scope_type: 'workspace', scope_id: ORG, dry_run: true }, req('owner'));
    expect(res.data).toEqual({ total: 3, more: false, warnings: [] });
    expect(moves.start).not.toHaveBeenCalled();
  });

  it("refuses another organization's scope, and a private agent's memory for anyone but its owner", async () => {
    const { ctrl, moves } = build();
    await expect(ctrl.startMove({ source: 'almyty-native', target: 'c', scope_type: 'workspace', scope_id: 'org-2' }, req('owner'))).rejects.toBeInstanceOf(HttpException);
    await expect(
      ctrl.startMove({ source: 'almyty-native', target: 'c', scope_type: 'agent', scope_id: `${ORG}:agent:a-private` }, req('other')),
    ).rejects.toMatchObject({ status: 404 });
    expect(moves.start).not.toHaveBeenCalled();
    await ctrl.startMove({ source: 'almyty-native', target: 'c', scope_type: 'agent', scope_id: `${ORG}:agent:a-private` }, req('owner'));
    expect(moves.start).toHaveBeenCalledTimes(1);
  });

  it("hides a move of a private agent's memory from those who cannot see the agent", async () => {
    const { ctrl, moves } = build({ id: 'mv-1', scopeType: 'agent', scopeId: `${ORG}:agent:a-private` });
    await expect(ctrl.getMove('mv-1', req('other'))).rejects.toMatchObject({ status: 404 });
    await expect(ctrl.resumeMove('mv-1', req('other'))).rejects.toMatchObject({ status: 404 });
    expect(moves.resume).not.toHaveBeenCalled();
    expect((await ctrl.getMove('mv-1', req('owner'))).data.id).toBe('mv-1');
  });

  it('lists moves with the scopes the caller may see', async () => {
    const { ctrl, moves } = build();
    await ctrl.listMoves(req('other'));
    expect(moves.list).toHaveBeenCalledWith(ORG, [`${ORG}:user:other`, `${ORG}:agent:a-org`]);
  });

  it('lists accounts as the caller', async () => {
    const { ctrl, accounts } = build();
    await ctrl.accountsOverview(req('owner'));
    // The whole request user: the Connections service reads its memberships.
    expect(accounts.overview).toHaveBeenCalledWith(ORG, expect.objectContaining({ id: 'owner', organizationMemberships: MEMBERSHIPS }));
  });

  it('declares the moves routes before GET :id', () => {
    const names = Object.getOwnPropertyNames(CanonicalMemoryController.prototype);
    for (const route of ['accountsOverview', 'listMoves', 'getMove', 'startMove', 'resumeMove']) {
      expect(names.indexOf(route)).toBeGreaterThan(-1);
      expect(names.indexOf(route)).toBeLessThan(names.indexOf('get'));
    }
  });
});
