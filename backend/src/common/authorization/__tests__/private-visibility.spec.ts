import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

import {
  assertAttachable,
  canReference,
  isOthersPrivate,
  resolveVisibilityWrite,
  withoutOthersPrivate,
} from '../private-visibility';
import { PrivateAgentGuard } from '../private-resource.guard';
import { collectAgentReferences } from '../../../modules/agents/agent-references';

const ORG = 'org-1';
const OWNER = 'user-owner';
const OTHER = 'user-other';

const privateTool = { id: 't1', name: 'mine', organizationId: ORG, visibility: 'private' as const, createdBy: OWNER };
const orgTool = { id: 't2', name: 'ours', organizationId: ORG, visibility: 'org' as const, createdBy: OWNER };

describe('private visibility helpers', () => {
  describe('isOthersPrivate / withoutOthersPrivate', () => {
    it('is only ever the owner\'s', () => {
      expect(isOthersPrivate(privateTool, OWNER)).toBe(false);
      expect(isOthersPrivate(privateTool, OTHER)).toBe(true);
      expect(isOthersPrivate(privateTool, null)).toBe(true);
      expect(isOthersPrivate(orgTool, OTHER)).toBe(false);
      expect(withoutOthersPrivate([privateTool, orgTool], OTHER)).toEqual([orgTool]);
    });

    it('treats a private row with no recorded owner as nobody\'s', () => {
      expect(isOthersPrivate({ organizationId: ORG, visibility: 'private', createdBy: null }, OWNER)).toBe(true);
    });

    it('reads apis/gateways by ownerUserId', () => {
      expect(isOthersPrivate({ organizationId: ORG, visibility: 'private', ownerUserId: OWNER }, OWNER)).toBe(false);
      expect(isOthersPrivate({ organizationId: ORG, visibility: 'private', ownerUserId: OWNER }, OTHER)).toBe(true);
    });
  });

  describe('resolveVisibilityWrite', () => {
    it('makes a new private row the creator\'s, with no team', () => {
      expect(
        resolveVisibilityWrite({ requestedVisibility: 'private', requestedTeamId: 'team-1', current: { ownerId: OWNER }, callerId: OWNER }),
      ).toEqual({ visibility: 'private', teamId: null, ownerId: OWNER });
    });

    it('refuses anyone but the recorded owner making a row private', () => {
      expect(() =>
        resolveVisibilityWrite({
          requestedVisibility: 'private',
          requestedTeamId: undefined,
          current: { visibility: 'org', teamId: null, ownerId: OWNER },
          callerId: OTHER,
        }),
      ).toThrow(ForbiddenException);
    });

    it('gives an ownerless row to the caller who makes it private', () => {
      expect(
        resolveVisibilityWrite({
          requestedVisibility: 'private',
          requestedTeamId: undefined,
          current: { visibility: 'org', teamId: null, ownerId: null },
          callerId: OTHER,
        }).ownerId,
      ).toBe(OTHER);
    });

    it('refuses a private row without a caller to own it', () => {
      expect(() =>
        resolveVisibilityWrite({ requestedVisibility: 'private', requestedTeamId: undefined, current: { ownerId: null }, callerId: undefined }),
      ).toThrow(ForbiddenException);
    });

    it('keeps the team only for team scope and never re-owns an org row', () => {
      expect(
        resolveVisibilityWrite({ requestedVisibility: 'team', requestedTeamId: 'team-1', current: { ownerId: OWNER }, callerId: OTHER }),
      ).toEqual({ visibility: 'team', teamId: 'team-1', ownerId: OWNER });
      expect(
        resolveVisibilityWrite({ requestedVisibility: 'org', requestedTeamId: 'team-1', current: { ownerId: null }, callerId: OTHER }),
      ).toEqual({ visibility: 'org', teamId: null, ownerId: null });
    });
  });

  describe('canReference / assertAttachable', () => {
    it('lets only a same-owner private parent reference a private child', () => {
      expect(canReference({ visibility: 'private', ownerId: OWNER }, privateTool)).toBe(true);
      expect(canReference({ visibility: 'org', ownerId: OWNER }, privateTool)).toBe(false);
      expect(canReference({ visibility: 'team', ownerId: OWNER }, privateTool)).toBe(false);
      expect(canReference({ visibility: 'private', ownerId: OTHER }, privateTool)).toBe(false);
      expect(canReference({ visibility: 'org', ownerId: OTHER }, orgTool)).toBe(true);
    });

    it('refuses with a message that does not name another member\'s resource', () => {
      expect(() => assertAttachable({ visibility: 'private', ownerId: OTHER, noun: 'agent' }, [privateTool], 'tool')).toThrow(
        BadRequestException,
      );
      try {
        assertAttachable({ visibility: 'private', ownerId: OTHER, noun: 'agent' }, [privateTool], 'tool');
      } catch (e: any) {
        expect(e.message).toContain('t1');
        expect(e.message).not.toContain('mine');
      }
    });
  });

  describe('collectAgentReferences', () => {
    it('finds tools and agents in toolIds, pipeline nodes and the collaboration roster', () => {
      const refs = collectAgentReferences({
        toolIds: ['a'],
        pipeline: {
          nodes: [
            { id: 'n1', type: 'tool_call', data: { toolId: 'b' } },
            { id: 'n2', type: 'tool_call', config: { toolId: 'c' } },
            { id: 'n3', type: 'sub_agent', data: { agentId: 'x' } },
          ],
          edges: [],
        } as any,
        collaboration: { strategy: 'sequential', agents: [{ agentId: 'y' }], judgeAgentId: 'z' } as any,
      });
      expect([...refs.toolIds].sort()).toEqual(['a', 'b', 'c']);
      expect([...refs.agentIds].sort()).toEqual(['x', 'y', 'z']);
    });
  });

  describe('PrivateResourceGuard', () => {
    const ctx = (userId: string, params: Record<string, string>) =>
      ({ switchToHttp: () => ({ getRequest: () => ({ user: { id: userId }, params }) }) }) as any;
    const repoWith = (row: any) => ({ getRepository: () => ({ findOne: jest.fn().mockResolvedValue(row) }) }) as any;
    const ID = '11111111-1111-4111-8111-111111111111';

    it('404s another user\'s private row and passes the owner', async () => {
      const guard = new PrivateAgentGuard(repoWith({ id: ID, organizationId: ORG, visibility: 'private', createdBy: OWNER }));
      await expect(guard.canActivate(ctx(OTHER, { id: ID }))).rejects.toBeInstanceOf(NotFoundException);
      await expect(guard.canActivate(ctx(OWNER, { id: ID }))).resolves.toBe(true);
    });

    it('leaves literal sub-routes and missing rows to the handler', async () => {
      const ds = repoWith(null);
      const guard = new PrivateAgentGuard(ds);
      await expect(guard.canActivate(ctx(OTHER, { id: 'templates' }))).resolves.toBe(true);
      await expect(guard.canActivate(ctx(OTHER, { id: ID }))).resolves.toBe(true);
    });
  });
});
