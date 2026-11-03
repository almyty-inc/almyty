import { AgentAuditService } from '../../agents/agent-audit.service';
import { ApprovalsService } from '../../approvals/approvals.service';
import { OrganizationsController } from '../../organizations/organizations.controller';
import { InvitesController } from '../../organizations/invites.controller';
import { fakeApprovalsRepo } from '../../approvals/__tests__/approvals-repo.fixture';
import { FakePolicyApprovalsRepo } from '../../approvals/__tests__/fake-policy-approvals';
import { AuditAction, AuditResource } from '../../../entities/audit-log.entity';

/**
 * The audit trail (Settings > Audit, and every SIEM streaming target fed
 * from it) missed approval decisions, agent edits, team changes and
 * invitations: agent events went only into the agent's own metadata, and
 * the rest wrote nothing.
 */
describe('governance events reach the audit trail', () => {
  const trail = () => ({ log: jest.fn(async (_entry: any): Promise<null> => null) });

  describe('agent edits', () => {
    function service(agent: any | null) {
      const audit = trail();
      const tx = {
        findOne: jest.fn(async () => agent),
        update: jest.fn(async () => ({ affected: 1 })),
      };
      const repo = { manager: { transaction: async (fn: any) => fn(tx) } };
      return { svc: new AgentAuditService(repo as any, audit as any), audit };
    }

    it('an update is on the organization trail, not only in the agent metadata', async () => {
      const { svc, audit } = service({ id: 'ag-1', name: 'Refund assistant', metadata: {} });
      await svc.log({ agentId: 'ag-1', organizationId: 'org-1', userId: 'u-1', action: 'updated', details: { updatedFields: ['systemPrompt'] } });
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
        organizationId: 'org-1', userId: 'u-1', action: AuditAction.UPDATE, resourceType: AuditResource.AGENT,
        resourceId: 'ag-1', resourceName: 'Refund assistant',
        details: { updatedFields: ['systemPrompt'], agentEvent: 'updated' },
      }));
    });

    it('a deleted agent (no row left) is still recorded', async () => {
      const { svc, audit } = service(null);
      await svc.log({ agentId: 'ag-1', organizationId: 'org-1', userId: 'u-1', action: 'deleted', details: { name: 'Refund assistant' } });
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.DELETE, resourceName: 'Refund assistant' }));
    });
  });

  describe('approval decisions', () => {
    function service() {
      const audit = trail();
      const approvals = fakeApprovalsRepo();
      const access = {
        canAccess: async () => ({ allowed: true, reason: 'ok' }),
        applyListFilter: async () => ({ bypass: true, teamIds: [] }),
        getOrgRole: async () => 'admin',
        getTeamMemberships: async () => new Map(),
      };
      const svc = new ApprovalsService(
        approvals as any,
        { update: async () => ({ affected: 1 }) } as any,
        new FakePolicyApprovalsRepo() as any,
        access as any,
        undefined,
        undefined,
        undefined,
        audit as any,
      );
      return { svc, audit };
    }

    it('records who approved what, with their note', async () => {
      const { svc, audit } = service();
      const row = await svc.create({ organizationId: 'org-1', teamId: null, runId: null, agentId: null, reason: 'Refund 2,500' });
      await svc.approve(row.id, { decidedBy: 'u-ana', decisionReason: 'Gold customer' }, { id: 'u-ana' }, 'org-1');
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
        organizationId: 'org-1', userId: 'u-ana', action: AuditAction.APPROVAL_DECIDED, resourceType: AuditResource.APPROVAL,
        resourceId: row.id, status: 'approved', details: expect.objectContaining({ decision: 'approved', note: 'Gold customer' }),
      }));
    });

    it('records a rejection', async () => {
      const { svc, audit } = service();
      const row = await svc.create({ organizationId: 'org-1', teamId: null, runId: null, agentId: null, reason: 'Refund 2,500' });
      await svc.reject(row.id, { decidedBy: 'u-ana' }, { id: 'u-ana' }, 'org-1');
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.APPROVAL_DECIDED, status: 'rejected' }));
    });
  });

  describe('teams and invitations', () => {
    const req = { user: { id: 'u-admin' }, ip: '203.0.113.9', headers: { 'user-agent': 'test' } };
    function controller() {
      const audit = trail();
      const orgs = {
        inviteUser: jest.fn(async () => ({ inviteSent: true })),
        revokePendingInvite: jest.fn(async () => ({ revoked: true })),
        updateMemberRole: jest.fn(async () => ({})),
        removeMember: jest.fn(async () => undefined),
        createTeam: jest.fn(async () => ({ id: 't-1', name: 'Finance' })),
        updateTeam: jest.fn(async () => ({ id: 't-1', name: 'Finance ops' })),
        deleteTeam: jest.fn(async () => undefined),
        addTeamMember: jest.fn(async () => ({})),
        updateTeamMemberRole: jest.fn(async () => ({})),
        removeTeamMember: jest.fn(async () => undefined),
        acceptInvite: jest.fn(async () => ({ organizationId: 'org-1', organizationName: 'Acme' })),
      };
      return { ctl: new OrganizationsController(orgs as any, audit as any), invites: new InvitesController(orgs as any, audit as any), audit };
    }
    const actions = (audit: ReturnType<typeof trail>) => audit.log.mock.calls.map((c: any[]) => c[0].action);

    it('records each team change with who made it', async () => {
      const { ctl, audit } = controller();
      await ctl.createTeam('org-1', { name: 'Finance' } as any, req);
      await ctl.updateTeam('org-1', 't-1', { name: 'Finance ops' }, req);
      await ctl.addMemberToTeam('org-1', 't-1', { userId: 'u-2' }, req);
      await ctl.updateTeamMemberRole('org-1', 't-1', 'u-2', { role: 'lead' }, req);
      await ctl.removeMemberFromTeam('org-1', 't-1', 'u-2', req);
      await ctl.deleteTeam('org-1', 't-1', req);
      expect(actions(audit)).toEqual([
        AuditAction.TEAM_CREATE, AuditAction.TEAM_UPDATE, AuditAction.TEAM_MEMBER_ADD,
        AuditAction.TEAM_MEMBER_ROLE_CHANGE, AuditAction.TEAM_MEMBER_REMOVE, AuditAction.TEAM_DELETE,
      ]);
      expect(audit.log.mock.calls[0][0]).toMatchObject({ organizationId: 'org-1', userId: 'u-admin', resourceType: AuditResource.TEAM, resourceId: 't-1', resourceName: 'Finance', ipAddress: '203.0.113.9' });
      expect(audit.log.mock.calls[3][0]).toMatchObject({ details: { userId: 'u-2', role: 'lead' } });
    });

    it('records invitations sent, revoked and accepted, and member changes', async () => {
      const { ctl, invites, audit } = controller();
      await ctl.inviteUserToOrganization('org-1', { email: 'Dana@acme.example', role: 'member' } as any, req);
      await ctl.revokePendingInvite('org-1', 'inv-1', req);
      await ctl.updateMemberRole('org-1', 'u-2', { role: 'admin' as any }, req);
      await ctl.removeMember('org-1', 'u-2', req);
      await invites.acceptInvite('tok', { user: { id: 'u-dana' }, headers: {} });
      expect(actions(audit)).toEqual([
        AuditAction.INVITE_SEND, AuditAction.INVITE_REVOKE, AuditAction.MEMBER_ROLE_CHANGE, AuditAction.MEMBER_REMOVE, AuditAction.INVITE_ACCEPT,
      ]);
      expect(audit.log.mock.calls[0][0]).toMatchObject({ resourceType: AuditResource.INVITATION, resourceId: 'dana@acme.example', details: { role: 'member', emailSent: true } });
      expect(audit.log.mock.calls[4][0]).toMatchObject({ organizationId: 'org-1', userId: 'u-dana' });
    });
  });
});
