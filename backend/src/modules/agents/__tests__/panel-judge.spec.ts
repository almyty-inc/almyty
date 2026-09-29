import { AgentExecutionStatus } from '../../../entities/agent-execution.entity';
import type { ChatRequest } from '../../llm-providers/llm-providers.service';
import { compileStrategy, describeStrategy } from '../strategies/strategy-compiler';
import { STRATEGY_SEEDS } from '../strategies/strategy-seeds';
import { buildHarness, makeAgent, promptOf } from './workflow-harness';

/**
 * The panel's consensus judge is a role.
 *
 * It had no slot of its own, so the compiled `consensus` merge named no
 * role and took the organization's default routing policy -- and an
 * organization without one got a panel that failed at the very last step,
 * after paying for every panelist. The judge is now an optional `judge`
 * slot; with no judge role the principal role stands in, and only with
 * neither does the merge fall to the organization default (and choosing
 * Panel is refused when there is no default either; see
 * agent-execution-settings.spec.ts).
 */
const panel = STRATEGY_SEEDS.find((s) => s.key === 'panel')!;
const PANELISTS = ['panelist_one', 'panelist_two', 'panelist_three'];
const bind = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, k]));
const consensusNode = (keys: string[]) => compileStrategy(panel, bind(keys)).nodes.find((n) => n.id === 'consensus')!;

describe('the panel judge', () => {
  it('is an optional slot the picker can show', () => {
    const described = describeStrategy(panel);
    expect(described.roleSlots).toEqual(PANELISTS);
    expect(described.optionalRoleSlots).toEqual(['judge']);
  });

  it('compiles onto the judge role when the agent has one', () => {
    expect(consensusNode([...PANELISTS, 'judge', 'principal']).data?.roleKey).toBe('judge');
  });

  it('falls back to the principal role when there is no judge role', () => {
    expect(consensusNode([...PANELISTS, 'principal']).data?.roleKey).toBe('principal');
  });

  it('names no role with neither, leaving the organization default to fill it', () => {
    expect(consensusNode(PANELISTS).data?.roleKey).toBeUndefined();
  });

  it('a panel with a judge role runs to its answer with no organization default, the judge on its own model', async () => {
    const roles = [...PANELISTS, 'judge'];
    const h = buildHarness({
      llm: (req: ChatRequest, providerId) => {
        if (promptOf(req).startsWith('Several responses')) {
          return JSON.stringify({ agreeing: 3, answer: `agreed, judged by ${providerId}` });
        }
        return `answer from ${providerId}`;
      },
      strategy: { key: 'panel', pipeline: compileStrategy(panel, bind(roles)), roles },
      organization: { id: 'org-1', settings: {} } as any,
    });
    const agent = makeAgent({ nodes: [], edges: [] }, { settings: { execution: { strategyKey: 'panel' } } as any });

    const execution = await h.run(agent, { message: 'Is it going to rain?' });

    expect(execution.error ?? null).toBeNull();
    expect(execution.status).toBe(AgentExecutionStatus.COMPLETED);
    expect(execution.output).toBe('agreed, judged by p-judge');
    const providers = h.chat.mock.calls.map(([providerId]) => providerId);
    expect(providers.sort()).toEqual(['p-judge', 'p-panelist_one', 'p-panelist_three', 'p-panelist_two']);
  });
});
