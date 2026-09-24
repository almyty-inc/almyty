import { readFileSync } from 'fs';
import { join } from 'path';

import { AgentBuiltInToolsHelper } from '../agent-builtin-tools.helper';
import { agentOwnerUserId } from '../agent-owner';
import { fakeRepository } from '../../../test/fake-repository';
import { Agent } from '../../../entities/agent.entity';

/**
 * A temporary agent's owner is whoever the parent run works for.
 *
 * `create_agent` stored the string 'system' in `agents."createdBy"`, the
 * column every ownership rule reads a user id from (private visibility,
 * delete rights, handover, the user a heartbeat runs as). A sentinel there
 * is something each reader has to know to skip. The temporary agent now
 * records the parent run's user, the same user `invoke_agent` runs the
 * child as, and nobody (null) for a run without one, such as a visitor's.
 */
describe('create_agent records a real owner', () => {
  const MEMBER = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

  function build() {
    const agents = fakeRepository<Agent>({ make: () => new Agent(), idPrefix: 'agent' });
    const helper = new AgentBuiltInToolsHelper(agents as any, {} as any, {} as any, {} as any, {} as any);
    const create = (run: Record<string, any>) =>
      helper.executeBuiltInTool(
        'create_agent',
        { name: 'Researcher', instructions: 'Find sources' },
        { id: 'run-1', organizationId: 'org-1', agentId: 'agent-parent', ...run } as any,
        { id: 'agent-parent', name: 'Planner', modelConfig: { model: 'm' } } as any,
      );
    return { agents, create };
  }

  it("stores the parent run's user as the temporary agent's owner", async () => {
    const { agents, create } = build();
    const out = await create({ userId: MEMBER, endUserId: null });

    const saved = agents.row(out!.result.agentId)!;
    expect(saved.isTemporary).toBe(true);
    expect(saved.parentRunId).toBe('run-1');
    expect(saved.createdBy).toBe(MEMBER);
    expect(agentOwnerUserId(saved)).toBe(MEMBER);
  });

  it('stores no owner for a run without a user, never a sentinel string', async () => {
    const { agents, create } = build();
    const out = await create({ userId: null, endUserId: 'visitor-9' });

    const saved = agents.row(out!.result.agentId)!;
    expect(saved.createdBy).toBeNull();
  });

  it("no agent code writes or compares 'system' as an agent owner", () => {
    const dir = join(__dirname, '..');
    for (const file of ['agent-builtin-tools.helper.ts', 'agent-owner.ts', 'agents.service.ts']) {
      const source = readFileSync(join(dir, file), 'utf8');
      expect(source).not.toMatch(/createdBy\s*(:|===?|!==?)\s*['"`]system['"`]/);
    }
  });
});
