import { AgentRun, AgentRunStatus } from '../../../entities/agent-run.entity';
import { AgentExecution, AgentExecutionStatus } from '../../../entities/agent-execution.entity';
import { PiiFilterPlugin } from '../../plugins/built-in/pii-filter.plugin';
import { RunTracePrivacyService } from '../run-trace-privacy.service';
import { anthropicText, anthropicTool, runAgent } from './autonomous-harness';

jest.mock('../../llm-providers/providers/safe-request', () => ({
  ...jest.requireActual('../../llm-providers/providers/safe-request'),
  callLlmProviderHttpStream: jest.fn(),
}));

/**
 * "Hide personal data in logs, traces and outputs to outsiders" (Frane,
 * 2026-10-09). The steps Runs shows kept every address the agent searched
 * mail for and every address the tool returned, with the PII filter on.
 * The trace hides them now; the tool is still called with the real ones.
 */

// The organization's PII filter, as ToolExecutorService.hidePersonalData runs it.
const pii = new PiiFilterPlugin();
const hidePersonalData = jest.fn(async (data: any) => {
  const out = await pii.filterPiiFromData({ data } as any, { detectEmails: true, detectPhoneNumbers: true, maskCharacter: '*' });
  return out.data;
});
const privacy = () => new RunTracePrivacyService({ hidePersonalData } as any);

const MODEL = 'claude-sonnet-5';
const CRM = { id: 'tool-crm' };

describe("a run's stored trace under the PII filter", () => {
  beforeEach(() => hidePersonalData.mockClear());

  it('calls the tool with the real address, and stores the step with it hidden', async () => {
    const executeTool = jest.fn(async (_toolId: string, _params: any) => ({ success: true, data: { contact: 'jonas.weber@bluefin.example', phone: '415-555-0100' }, executionTime: 3 }));
    const seen = await runAgent({
      models: null,
      agent: { toolIds: [CRM.id] },
      executeTool,
      tracePrivacy: privacy(),
      streams: { [MODEL]: [anthropicTool(MODEL, 'crm_lookup', { account: 'jonas.weber@bluefin.example' }, 80, 9), anthropicText(MODEL, 120, ['Done.'], 2)] },
    });

    expect(seen.run.status).toBe(AgentRunStatus.COMPLETED);
    // The live call: the real value.
    expect(executeTool.mock.calls[0][1]).toEqual({ account: 'jonas.weber@bluefin.example' });

    // What Runs reads: the row as stored.
    const stored = JSON.stringify(seen.runRepository.row('run-1')!.steps);
    expect(stored).not.toContain('jonas.weber@bluefin.example');
    expect(stored).not.toContain('415-555-0100');
    const call = (seen.runRepository.row('run-1')!.steps as any[]).find((s) => s.type === 'tool_call');
    // Ids stay, so what reads the trace (reports, approvals) still finds the tool.
    expect(call.input.toolId).toBe('tool-crm');
    expect(call.input.parameters.account).not.toBe('jonas.weber@bluefin.example');
  });

  it("hides a run's steps on any save, keeping ids and states", async () => {
    const service = privacy();
    const run = Object.assign(new AgentRun(), {
      organizationId: 'org-1',
      userId: 'u-1',
      steps: [{ type: 'tool_call', input: { toolId: 't-1', parameters: { to: 'maya@lumen.example' } }, output: { status: 'waiting_approval', approvalId: 'ap-1', note: 'mail maya@lumen.example' } }],
    });
    await service.beforeUpdate({ entity: run } as any);
    expect(run.steps[0]).toMatchObject({ input: { toolId: 't-1' }, output: { status: 'waiting_approval', approvalId: 'ap-1' } });
    expect(JSON.stringify(run.steps)).not.toContain('maya@lumen.example');

    // An unchanged step is not filtered again on the next save.
    hidePersonalData.mockClear();
    await service.beforeUpdate({ entity: run } as any);
    expect(hidePersonalData).not.toHaveBeenCalled();
  });

  it("leaves a paused workflow's node results whole, for the run to carry on from, and hides them once it is over", async () => {
    const service = privacy();
    const results = () => ({ lookup: { output: { email: 'maya@lumen.example' } } });
    const paused = Object.assign(new AgentExecution(), { organizationId: 'org-1', status: AgentExecutionStatus.WAITING_APPROVAL, nodeResults: results() });
    await service.beforeUpdate({ entity: paused } as any);
    expect(paused.nodeResults.lookup.output.email).toBe('maya@lumen.example');

    const done = Object.assign(new AgentExecution(), { organizationId: 'org-1', status: AgentExecutionStatus.COMPLETED, nodeResults: results() });
    await service.beforeUpdate({ entity: done } as any);
    expect(JSON.stringify(done.nodeResults)).not.toContain('maya@lumen.example');
  });

  it('is what the step processor stores through update(), and is wired in the agents module', () => {
    const fs = jest.requireActual('fs');
    const path = jest.requireActual('path');
    const processor = fs.readFileSync(path.join(__dirname, '../agent-step-processor.ts'), 'utf8');
    expect(processor).toContain('steps: await this.stepsForPersist(run)');
    expect(processor).not.toMatch(/steps: run\.steps,|steps: this\.boundStepsForPersist\(run\.steps\)/);
    const module = fs.readFileSync(path.join(__dirname, '../agents.module.ts'), 'utf8');
    expect(module).toMatch(/providers: \[[\s\S]*RunTracePrivacyService/);
  });
});
