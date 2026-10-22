import { readFileSync } from 'fs';
import { join } from 'path';
import { getMetadataArgsStorage } from 'typeorm';

import { AgentRunEvent } from '../../../entities/agent-run-event.entity';
import { AgentRun } from '../../../entities/agent-run.entity';

/**
 * A run's event log (agent_run_events, durable runs step 1) has no sweep of
 * its own: it is deleted with its run. The retention sweep deletes terminal
 * runs by id (RetentionSweepService.batchDelete), and so does visitor
 * erasure; both reach the events only through the foreign key's cascade.
 * Without it every swept run would leave its whole log behind.
 */
describe('a run takes its event log with it when it is deleted', () => {
  it('the entity declares the cascade', () => {
    const relation = getMetadataArgsStorage().relations.find((r) => r.target === AgentRunEvent && r.propertyName === 'run');
    expect(relation).toBeDefined();
    expect((relation!.type as () => unknown)()).toBe(AgentRun);
    expect(relation!.options.onDelete).toBe('CASCADE');
  });

  it('the migration creates the foreign key with ON DELETE CASCADE', () => {
    const sql = readFileSync(join(__dirname, '../../../migrations/1791000500000-AgentRunEvents.ts'), 'utf8');
    expect(sql).toMatch(/"runId" uuid NOT NULL REFERENCES "agent_runs"\("id"\) ON DELETE CASCADE/);
  });

  it('the retention doc names the table under the agent runs class', () => {
    const doc = readFileSync(join(__dirname, '../../../../../docs/retention.md'), 'utf8');
    expect(doc).toMatch(/`agentRunsDays` \| `agent_runs` \+ `agent_run_events`/);
  });
});
