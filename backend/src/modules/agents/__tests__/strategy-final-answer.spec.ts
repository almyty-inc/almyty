import { AgentExecutionStatus } from '../../../entities/agent-execution.entity';
import type { ApiKey } from '../../../entities/api-key.entity';
import type { ChatRequest } from '../../llm-providers/llm-providers.service';
import { AgentExecutionController } from '../agent-execution.controller';
import { AgentOpenAIStreamHelper } from '../agent-openai-stream.helper';
import { CompatAgentInvoker } from '../compat-agent-invoker.service';
import { AgentValidationHelper } from '../agent-validation.helper';
import { EXTRACT_CONTEXT_INSTRUCTION } from '../strategies/extract-context';
import { compileStrategy } from '../strategies/strategy-compiler';
import { STRATEGY_SEEDS } from '../strategies/strategy-seeds';
import { buildHarness, LlmHandler, makeAgent, ORG, promptOf, USER } from './workflow-harness';

/**
 * A compiled strategy answers with the text a person expects, on every
 * surface a workflow agent is reached through.
 *
 * The output node of a compiled strategy used to have no mapping, so the
 * run's answer was every node's output keyed by node id -- the draft, the
 * verdict, each candidate and the judge's pick, as one JSON object -- and
 * explore-extract-patch, whose last step is its check, had nothing better
 * to offer than that. Each case below runs the real engine on the compiled
 * graph, with a fake model per role, and reads the answer back where a
 * person reads it: the run record, the Try it invoke response and the
 * OpenAI-compatible completion.
 *
 * (Hosted chat serves autonomous agents only -- it starts runs on the
 * autonomous runtime -- so its answers are proven in
 * autonomous-strategies-end-to-end.spec.ts.)
 */

const QUESTION = 'Why do owls hunt at night?';
const PASS = JSON.stringify({ verdict: 'pass', failures: [], passed_rules: ['answers the question'] });
const FAIL = JSON.stringify({ verdict: 'fail', failures: [{ rule: 'too vague', evidence: 'they like it' }], passed_rules: [] });
const BRIEF = { relevantFiles: [], symbols: [], callers: [], tests: [], notes: 'Owls see well in low light.' };

interface Scenario {
  name: string;
  key: string;
  verdict?: 'pass' | 'fail';
  expected: string;
  /** What each role's model answers an ordinary call with; `n` counts that role's calls from 1. */
  answers: Record<string, (n: number) => string>;
}

const scenarios: Scenario[] = [
  {
    name: 'single',
    key: 'single',
    expected: 'Owls hunt at night because their prey is out.',
    answers: { principal: () => 'Owls hunt at night because their prey is out.' },
  },
  {
    name: 'cascade, check passes: the draft',
    key: 'cascade',
    verdict: 'pass',
    expected: 'Draft: night is when mice move.',
    answers: { drafter: () => 'Draft: night is when mice move.', principal: () => 'Escalated: owls evolved for darkness.' },
  },
  {
    name: 'cascade, check fails: the escalated answer',
    key: 'cascade',
    verdict: 'fail',
    expected: 'Escalated: owls evolved for darkness.',
    answers: { drafter: () => 'Draft: they like it.', principal: () => 'Escalated: owls evolved for darkness.' },
  },
  {
    name: 'best_of_n: the candidate the judge picked',
    key: 'best_of_n',
    expected: 'Candidate BEST: silent flight and sharp hearing.',
    answers: { principal: (n) => (n === 2 ? 'Candidate BEST: silent flight and sharp hearing.' : `Candidate ${n}: because.`) },
  },
  {
    name: 'panel: the judged consensus',
    key: 'panel',
    expected: 'Consensus: less competition and plenty of prey.',
    answers: {
      panelist_one: () => 'Less competition at night.',
      panelist_two: () => 'Prey is plentiful at night.',
      panelist_three: () => 'They are shy.',
    },
  },
  {
    name: 'explore_extract_patch: the patched answer, not the verdict',
    key: 'explore_extract_patch',
    verdict: 'pass',
    expected: 'Patched: owls see well in low light, so they hunt at night.',
    answers: {
      explorer: (n) => `Rollout ${n}: low-light vision.`,
      principal: () => 'Patched: owls see well in low light, so they hunt at night.',
    },
  },
];

/** A model per role: the harness fills role `r` with provider `p-r`. */
function modelFor(s: Scenario): LlmHandler {
  const calls: Record<string, number> = {};
  return (req: ChatRequest, providerId: string | null) => {
    const system = String(req.messages[0]?.content ?? '');
    const prompt = promptOf(req);
    if (system.startsWith('You are a verifier')) return s.verdict === 'fail' ? FAIL : PASS;
    if (system === EXTRACT_CONTEXT_INSTRUCTION) return JSON.stringify(BRIEF);
    if (prompt.startsWith('You are a judge. Pick the best')) {
      const options = prompt.split('\n\n').filter((l) => l.startsWith('Option '));
      return String(options.findIndex((o) => o.includes('BEST')) + 1);
    }
    if (prompt.startsWith('Several responses to the same question')) {
      return JSON.stringify({ agreeing: 2, answer: 'Consensus: less competition and plenty of prey.' });
    }
    const role = (providerId ?? '').replace(/^p-/, '');
    const answer = s.answers[role];
    if (!answer) throw new Error(`no fake answer for role ${role || '(routed)'} in ${s.name}`);
    calls[role] = (calls[role] ?? 0) + 1;
    return answer(calls[role]);
  };
}

function setUp(s: Scenario) {
  const seed = STRATEGY_SEEDS.find((x) => x.key === s.key)!;
  const roles = seed.roleSlots ?? [];
  const pipeline = compileStrategy(seed, Object.fromEntries(roles.map((r) => [r, r])));
  // Every compiled graph is one the product would store.
  new AgentValidationHelper().validatePipeline(pipeline);
  const h = buildHarness({
    llm: modelFor(s),
    strategy: { key: s.key, pipeline, roles },
    organization: { id: ORG, settings: { defaultRouting: { objective: 'balanced' } } } as any,
  });
  const agent = makeAgent({ nodes: [], edges: [] }, { settings: { execution: { strategyKey: s.key } } as any });
  h.agents.set(agent.id, agent);
  return { h, agent };
}

describe('a compiled strategy answers with the text a person expects', () => {
  for (const s of scenarios) {
    describe(s.name, () => {
      it("is the run's answer", async () => {
        const { h, agent } = setUp(s);
        const execution = await h.run(agent, { message: QUESTION });
        expect(execution.error ?? null).toBeNull();
        expect(execution.status).toBe(AgentExecutionStatus.COMPLETED);
        expect(execution.output).toBe(s.expected);
      });

      it('is what Try it shows', async () => {
        const { h, agent } = setUp(s);
        const controller = new AgentExecutionController(
          { getAgent: async () => agent } as any,
          h.engine,
          { executionAccess: h.executionAccess } as any,
        );
        const res: any = await controller.invokeAgent(agent.id, { input: { message: QUESTION } } as any, {
          user: { sub: USER, currentOrganizationId: ORG },
        });
        expect(res.success).toBe(true);
        expect(res.data.output).toBe(s.expected);
      });

      it("is the OpenAI-compatible completion's message", async () => {
        const { h, agent } = setUp(s);
        let body: any;
        const res: any = {
          setHeader: () => undefined,
          status: () => res,
          json: (b: any) => {
            body = b;
            return res;
          },
        };
        const key = { id: 'key-1', organizationId: ORG, userId: USER } as ApiKey;
        await new AgentOpenAIStreamHelper(new CompatAgentInvoker(h.engine)).handleSync(agent, { message: QUESTION }, key, res);
        expect(body.choices?.[0]?.message?.content).toBe(s.expected);
      });
    });
  }
});
