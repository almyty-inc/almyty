import 'reflect-metadata';
import { HttpException } from '@nestjs/common';

import { CanonicalMemoryController } from '../canonical-memory.controller';
import { fakeRepository } from '../../../../test/fake-repository';
import { orgMembersPolicy } from '../../../../test/execution-access.fixture';
import { OrganizationRole } from '../../../../entities/user-organization.entity';

/**
 * An agent's own memory (an agent whose memory is "this agent's own") is
 * seen by exactly the people who can see that agent: a private agent's by
 * its owner, a team agent's by its team (and admins), an org agent's by
 * the organization. Through every Memory API route: list, search, write,
 * and get, delete and supersede by id.
 */
describe("an agent's own memory is visible to whoever can see the agent", () => {
  const ORG = 'org-1';
  const agents = fakeRepository([
    { id: 'a-org', organizationId: ORG, visibility: 'org', teamId: null, createdBy: 'owner', isTemporary: false },
    { id: 'a-private', organizationId: ORG, visibility: 'private', teamId: null, createdBy: 'owner', isTemporary: false },
  ] as any);
  const policy = orgMembersPolicy(ORG, { owner: OrganizationRole.MEMBER, other: OrganizationRole.MEMBER });
  const req = (userId: string) => ({ user: { id: userId, sub: userId, currentOrganizationId: ORG } });

  function build() {
    const list = jest.fn(async (q: any) => ({ items: [], total: 0, cursor: null, scope: q.scope }));
    const search = jest.fn(async () => []);
    const get = jest.fn(async () => ({ id: 'm-1' }));
    const del = jest.fn(async () => true);
    const service: any = { list, search, get, delete: del, put: jest.fn(async () => ({ id: 'm-2' })) };
    const ctrl: any = new CanonicalMemoryController(service, {} as any, {} as any, {} as any, {} as any, undefined, policy as any, agents as any);
    return { ctrl, list, search, get, del };
  }

  const scope = (agentId: string) => ({ scope_type: 'agent', scope_id: `${ORG}:agent:${agentId}` });

  it("lists an org agent's memory for any member", async () => {
    const { ctrl, list } = build();
    await ctrl.list({ scope: scope('a-org'), mode: 'memory' }, req('other'));
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ scope: scope('a-org') }));
  });

  it("lists a private agent's memory for its owner only", async () => {
    const { ctrl, list } = build();
    await ctrl.list({ scope: scope('a-private'), mode: 'memory' }, req('owner'));
    expect(list).toHaveBeenCalledTimes(1);
    await expect(ctrl.list({ scope: scope('a-private'), mode: 'memory' }, req('other'))).rejects.toThrow(HttpException);
    await expect(ctrl.search({ scope: scope('a-private'), query: 'x' }, req('other'))).rejects.toThrow(HttpException);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('refuses an agent that does not exist in the organization', async () => {
    const { ctrl, list } = build();
    await expect(ctrl.list({ scope: scope('nope'), mode: 'memory' }, req('owner'))).rejects.toThrow(HttpException);
    expect(list).not.toHaveBeenCalled();
  });

  it('reaches memories by id in the agent scopes the caller can see, and no others', async () => {
    const { ctrl, get, del } = build();
    await ctrl.get('m-1', req('owner'));
    expect((get.mock.calls[0] as any[])[3]).toEqual([`${ORG}:agent:a-org`, `${ORG}:agent:a-private`]);
    await ctrl.get('m-1', req('other'));
    expect((get.mock.calls[1] as any[])[3]).toEqual([`${ORG}:agent:a-org`]);
    await ctrl.remove('m-1', 'soft', req('other'));
    expect((del.mock.calls[0] as any[])[4]).toEqual([`${ORG}:agent:a-org`]);
  });
});
