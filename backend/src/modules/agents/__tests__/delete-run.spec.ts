import * as fs from 'fs';
import * as path from 'path';
import { ConflictException, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { In } from 'typeorm';

import { AgentRunDeletionService, RUN_STILL_GOING } from '../agent-run-deletion.service';
import { AgentRunsController } from '../agent-runs.controller';
import { AgentRun, AgentRunStatus } from '../../../entities/agent-run.entity';
import { ToolExecution } from '../../../entities/tool-execution.entity';
import { AuditAction, AuditResource } from '../../../entities/audit-log.entity';
import { AccessPolicyService } from '../../../common/authorization/access-policy.service';
import { OrganizationRole } from '../../../entities/user-organization.entity';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator';
import { RBAC_ACTION_KEY, RBAC_PERMISSIONS } from '../../../common/authorization/rbac-actions';

/**
 * "Delete run": DELETE /agents/:id/runs/:runId removes one finished run,
 * for someone who may manage the agent. Before it there was no way to
 * remove a single run at all; retention only deletes by age.
 */

const ORG = 'org-1';
const AGENT = 'agent-1';
const RUN = 'run-1';
const OWNER = 'user-owner';
const ADMIN = 'user-admin';
const MEMBER = 'user-member';

type Row = { id: string; organizationId: string; agentId: string; status: AgentRunStatus };

function setup(opts: { runs?: Row[]; agentOrg?: string; visibility?: 'org' | 'team' | 'private' } = {}) {
  const runs: Row[] = opts.runs ?? [{ id: RUN, organizationId: ORG, agentId: AGENT, status: AgentRunStatus.COMPLETED }];
  const toolCalls = [
    { id: 'te-1', runId: RUN, organizationId: ORG },
    { id: 'te-2', runId: RUN, organizationId: ORG },
    { id: 'te-3', runId: 'run-other', organizationId: ORG },
  ];
  const agent = { id: AGENT, organizationId: opts.agentOrg ?? ORG, createdBy: OWNER, visibility: opts.visibility ?? 'org', teamId: null };
  const roles: Record<string, OrganizationRole> = {
    [OWNER]: OrganizationRole.MEMBER,
    [ADMIN]: OrganizationRole.ADMIN,
    [MEMBER]: OrganizationRole.MEMBER,
  };
  const accessPolicy = new AccessPolicyService(
    { findOne: async ({ where }: any) => (roles[where.userId] && where.organizationId === ORG ? { role: roles[where.userId], isActive: true } : null) } as any,
    { find: async () => [] } as any,
  );

  const matches = (row: Record<string, any>, where: Record<string, any>) =>
    Object.entries(where).every(([k, v]) => {
      const inner = (v as any)?._type === 'in' ? (v as any)._value : null;
      return inner ? inner.includes(row[k]) : row[k] === v;
    });
  const deleted: Array<{ entity: string; where: unknown }> = [];
  const tx = {
    getRepository: (entity: unknown) => {
      if (entity === AgentRun) {
        return {
          findOne: async ({ where }: any) => runs.find((r) => matches(r, where)) ?? null,
          delete: async (where: any) => {
            deleted.push({ entity: 'agent_runs', where });
            const gone = runs.filter((r) => matches(r, where));
            for (const r of gone) runs.splice(runs.indexOf(r), 1);
            return { affected: gone.length };
          },
        };
      }
      if (entity === ToolExecution) {
        return {
          delete: async (where: any) => {
            deleted.push({ entity: 'tool_executions', where });
            const gone = toolCalls.filter((r) => matches(r, where));
            for (const r of gone) toolCalls.splice(toolCalls.indexOf(r), 1);
            return { affected: gone.length };
          },
        };
      }
      throw new Error('unexpected repository');
    },
  };
  const runRepo = { manager: { transaction: async (fn: (t: any) => unknown) => fn(tx) } };
  const agentRepo = { findOne: async ({ where }: any) => (where.id === agent.id && where.organizationId === agent.organizationId ? agent : null) };
  const audit = { log: jest.fn().mockResolvedValue(null) };
  const service = new AgentRunDeletionService(agentRepo as any, runRepo as any, accessPolicy, audit as any);
  return { service, runs, toolCalls, deleted, audit };
}

describe('AgentRunDeletionService.deleteRun', () => {
  it('deletes a finished run and the tool calls it made, and nothing else', async () => {
    const { service, runs, toolCalls, audit } = setup();

    await expect(service.deleteRun(AGENT, RUN, ORG, ADMIN)).resolves.toEqual({ id: RUN, toolCalls: 2 });

    expect(runs).toEqual([]);
    expect(toolCalls.map((t) => t.id)).toEqual(['te-3']);
    // Ids only: no input, output, thread or steps of the run.
    expect(audit.log).toHaveBeenCalledWith({
      organizationId: ORG,
      userId: ADMIN,
      action: AuditAction.DELETE,
      resourceType: AuditResource.AGENT_RUN,
      resourceId: RUN,
      details: { agentId: AGENT, toolCalls: 2 },
    });
  });

  it.each([AgentRunStatus.FAILED, AgentRunStatus.CANCELLED, AgentRunStatus.TIMEOUT])('deletes a %s run', async (status) => {
    const { service, runs } = setup({ runs: [{ id: RUN, organizationId: ORG, agentId: AGENT, status }] });
    await service.deleteRun(AGENT, RUN, ORG, ADMIN);
    expect(runs).toEqual([]);
  });

  it.each([
    AgentRunStatus.PENDING,
    AgentRunStatus.RUNNING,
    AgentRunStatus.WAITING_INPUT,
    AgentRunStatus.SLEEPING,
    AgentRunStatus.WAITING_APPROVAL,
  ])('refuses a %s run with 409 and deletes nothing', async (status) => {
    const { service, runs, deleted, audit } = setup({ runs: [{ id: RUN, organizationId: ORG, agentId: AGENT, status }] });
    const err = await service.deleteRun(AGENT, RUN, ORG, ADMIN).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getStatus()).toBe(409);
    expect(err.message).toBe(RUN_STILL_GOING);
    expect(runs).toHaveLength(1);
    expect(deleted).toEqual([]);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("is 404 for another agent's run", async () => {
    const { service, runs } = setup({ runs: [{ id: RUN, organizationId: ORG, agentId: 'agent-2', status: AgentRunStatus.COMPLETED }] });
    await expect(service.deleteRun(AGENT, RUN, ORG, ADMIN)).rejects.toBeInstanceOf(NotFoundException);
    expect(runs).toHaveLength(1);
  });

  it("is 404 for another organization's run", async () => {
    const { service, runs } = setup({ runs: [{ id: RUN, organizationId: 'org-2', agentId: AGENT, status: AgentRunStatus.COMPLETED }] });
    await expect(service.deleteRun(AGENT, RUN, ORG, ADMIN)).rejects.toBeInstanceOf(NotFoundException);
    expect(runs).toHaveLength(1);
  });

  it("is 404 for an agent of another organization", async () => {
    const { service, runs } = setup({ agentOrg: 'org-2' });
    await expect(service.deleteRun(AGENT, RUN, ORG, ADMIN)).rejects.toBeInstanceOf(NotFoundException);
    expect(runs).toHaveLength(1);
  });

  it('lets the member who owns the agent delete its run', async () => {
    const { service, runs } = setup();
    await service.deleteRun(AGENT, RUN, ORG, OWNER);
    expect(runs).toEqual([]);
  });

  it('is 403 for a member who may see and run the agent but not manage it', async () => {
    const { service, runs, audit } = setup();
    await expect(service.deleteRun(AGENT, RUN, ORG, MEMBER)).rejects.toBeInstanceOf(ForbiddenException);
    expect(runs).toHaveLength(1);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("is 404, not 403, for an admin reaching into another member's private agent", async () => {
    const { service, runs } = setup({ visibility: 'private' });
    await expect(service.deleteRun(AGENT, RUN, ORG, ADMIN)).rejects.toBeInstanceOf(NotFoundException);
    expect(runs).toHaveLength(1);
  });

  it('scopes both deletes to the organization', async () => {
    const { service, deleted } = setup();
    await service.deleteRun(AGENT, RUN, ORG, ADMIN);
    expect(deleted).toEqual([
      { entity: 'tool_executions', where: { runId: In([RUN]), organizationId: ORG } },
      { entity: 'agent_runs', where: { id: In([RUN]), organizationId: ORG } },
    ]);
  });
});

describe('DELETE /agents/:id/runs/:runId', () => {
  const handler = AgentRunsController.prototype.deleteRun;

  it('is a route for the roles that may edit an agent, not viewers', () => {
    expect(Reflect.getMetadata('path', handler)).toBe(':id/runs/:runId');
    expect(Reflect.getMetadata('method', handler)).toBe(3); // RequestMethod.DELETE
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(['member', 'admin', 'owner']);
    expect(Reflect.getMetadata(RBAC_ACTION_KEY, handler)).toBe(RBAC_PERMISSIONS.AGENTS_UPDATE);
  });

  const call = async (error: unknown) => {
    const runDeletion = { deleteRun: jest.fn().mockRejectedValue(error) };
    const controller = new AgentRunsController({} as any, undefined, undefined, runDeletion as any);
    return controller
      .deleteRun(AGENT, RUN, { user: { sub: ADMIN, currentOrganizationId: ORG } })
      .catch((e: HttpException) => e.getStatus());
  };

  it('keeps the status the service decided', async () => {
    expect(await call(new ConflictException(RUN_STILL_GOING))).toBe(409);
    expect(await call(new ForbiddenException())).toBe(403);
    expect(await call(new NotFoundException('Run not found'))).toBe(404);
  });

  it('passes the caller and the agent in the path to the service', async () => {
    const runDeletion = { deleteRun: jest.fn().mockResolvedValue({ id: RUN, toolCalls: 0 }) };
    const controller = new AgentRunsController({} as any, undefined, undefined, runDeletion as any);
    await expect(controller.deleteRun(AGENT, RUN, { user: { sub: ADMIN, currentOrganizationId: ORG } })).resolves.toMatchObject({ success: true });
    expect(runDeletion.deleteRun).toHaveBeenCalledWith(AGENT, RUN, ORG, ADMIN);
  });
});

describe('wiring (source guard)', () => {
  const src = (p: string) => fs.readFileSync(path.join(__dirname, '..', '..', '..', p), 'utf8');

  it('AgentsModule provides the deletion service', () => {
    expect(src('modules/agents/agents.module.ts')).toMatch(/providers: \[[\s\S]*AgentRunDeletionService,/);
  });

  it("a visitor's erasure removes runs the same way", () => {
    const erase = src('modules/gateways/visitor-data.service.ts');
    expect(erase).toMatch(/removeRuns\(tx, organizationId, runIds\)/);
    expect(erase).not.toMatch(/getRepository\(AgentRun\)\.delete/);
  });
});
