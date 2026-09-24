import { ExecutionAccessService } from '../../../common/authorization/execution-access.service';
import { membershipFixture } from '../../../test/execution-access.fixture';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AgentExecutionEngine } from '../agent-execution.engine';
import { AgentNodeExecutor } from '../agent-node-executor';
import { AgentSubAgentExecutors } from '../agent-subagent-executors.helper';
import { AgentTemplateResolver, ExecutionContext } from '../agent-template-resolver';
import { AgentVerifierHelper } from '../agent-verifier.helper';
import { AgentValidationHelper } from '../agent-validation.helper';
import { AgentExecutionStateHelper } from '../agent-execution-state.helper';
import { AgentWebhookService } from '../agent-webhook.service';
import { LlmProvidersService } from '../../llm-providers/llm-providers.service';
import { ToolExecutorService } from '../../tools/tool-executor.service';
import { A2AClientService } from '../../a2a/a2a-client.service';
import { ExternalAgentsService } from '../../a2a/external-agents.service';
import { Agent, AgentPipeline, AgentPipelineNode, AgentStatus } from '../../../entities/agent.entity';
import { AgentExecution, AgentExecutionStatus } from '../../../entities/agent-execution.entity';
import { Organization } from '../../../entities/organization.entity';
import { compileStrategy } from '../strategies/strategy-compiler';
import { STRATEGY_SEEDS } from '../strategies/strategy-seeds';

/**
 * Cascade's whole reason for existing is the run that stops at the draft.
 *
 * Two things stopped that happening, and both were in the compiler.
 *
 * A compiled `verify` node carried no `checkers`, because the seed
 * declares the step with a role slot and no params and the compiler only
 * ever copied params through. The executor throws "requires at least one
 * checker", so the check failed every run of the two shapes that verify,
 * and the saved graph could not even be activated: the validator demanded
 * a pinned `providerId` per checker, which a compiler that names roles
 * can never supply.
 *
 * And `check -> escalate` compiled to a plain edge, because the compiler
 * had no way to express a branch at all. So the expensive `principal`
 * role ran on every request and, being the only leaf, its answer was the
 * result — the cascade always paid the bill it exists to avoid.
 */
describe('a cascade checks with its verifier role and only escalates when the check fails', () => {
  const cascade = STRATEGY_SEEDS.find((s) => s.key === 'cascade')!;
  const explore = STRATEGY_SEEDS.find((s) => s.key === 'explore_extract_patch')!;
  const bind = (slots: string[]) => Object.fromEntries(slots.map((s) => [s, `role-${s}`]));

  const compiledCascade = (): AgentPipeline => compileStrategy(cascade, bind(cascade.roleSlots));

  // ── The check has something to check with ────────────────────────────────

  describe('the compiled check names a checker', () => {
    it('derives a checker from the bound verifier role', () => {
      const check = compiledCascade().nodes.find((n) => n.id === 'check')!;
      expect(check.type).toBe('verify');
      expect(check.data?.checkers).toEqual([{ name: 'verifier', roleKey: 'role-verifier' }]);
      // Still a role and never a model — that is what keeps the graph portable.
      expect(check.data?.providerId).toBeUndefined();
      expect(check.data?.model).toBeUndefined();
    });

    it('does the same for explore_extract_patch, the other shape that verifies', () => {
      const pipeline = compileStrategy(explore, bind(explore.roleSlots));
      const check = pipeline.nodes.find((n) => n.id === 'check')!;
      expect(check.data?.checkers).toEqual([{ name: 'verifier', roleKey: 'role-verifier' }]);
    });

    it('leaves no compiled verify node checker-less, which is what the executor throws on', () => {
      for (const seed of STRATEGY_SEEDS) {
        for (const node of compileStrategy(seed, bind(seed.roleSlots)).nodes) {
          if (node.type !== 'verify') continue;
          expect(Array.isArray(node.data?.checkers)).toBe(true);
          expect((node.data!.checkers as unknown[]).length).toBeGreaterThan(0);
        }
      }
    });

    it('leaves an explicit checker list in the shape alone', () => {
      const pipeline = compileStrategy(
        {
          key: 'pinned',
          roleSlots: ['verifier'],
          shape: {
            entry: 'check',
            steps: [
              { id: 'check', kind: 'verify', roleSlot: 'verifier', params: { checkers: [{ name: 'hand-written' }] } },
            ],
          },
        },
        { verifier: 'role-verifier' },
      );
      expect(pipeline.nodes.find((n) => n.id === 'check')?.data?.checkers).toEqual([{ name: 'hand-written' }]);
    });
  });

  // ── The saved graph is saveable ──────────────────────────────────────────

  describe('an ejected strategy graph passes pipeline validation', () => {
    const validator = new AgentValidationHelper();

    it('accepts a checker that names a role instead of pinning a provider', () => {
      expect(() => validator.validatePipeline(compiledCascade())).not.toThrow();
    });

    it('accepts every built-in, compiled', () => {
      for (const seed of STRATEGY_SEEDS) {
        expect(() => validator.validatePipeline(compileStrategy(seed, bind(seed.roleSlots)))).not.toThrow();
      }
    });

    it('still refuses a checker that names neither a provider nor a role', () => {
      const pipeline = compiledCascade();
      pipeline.nodes.find((n) => n.id === 'check')!.data!.checkers = [{ name: 'nobody' }];
      expect(() => validator.validatePipeline(pipeline)).toThrow(/must have a 'providerId' or a 'roleKey'/);
    });

    it('still refuses a verify node with no checkers at all', () => {
      const pipeline = compiledCascade();
      pipeline.nodes.find((n) => n.id === 'check')!.data!.checkers = [];
      expect(() => validator.validatePipeline(pipeline)).toThrow(/non-empty 'checkers' array/);
    });
  });

  // ── The branch exists ────────────────────────────────────────────────────

  describe('the compiled graph expresses the branch', () => {
    it('puts a condition between the check and the escalation', () => {
      const { nodes, edges } = compiledCascade();
      const gate = nodes.find((n) => n.id === 'check__gate')!;
      expect(gate.type).toBe('condition');

      expect(edges).toContainEqual(expect.objectContaining({ source: 'check', target: 'check__gate' }));
      expect(edges).toContainEqual(
        expect.objectContaining({ source: 'check__gate', target: 'escalate', sourceHandle: 'false' }),
      );
      expect(edges).toContainEqual(
        expect.objectContaining({ source: 'check__gate', target: 'output', sourceHandle: 'true' }),
      );

      // The plain edge that made every run escalate is gone.
      expect(edges.find((e) => e.source === 'check' && e.target === 'escalate')).toBeUndefined();
    });

    it('is still deterministic, so eject stays safe', () => {
      expect(compiledCascade()).toEqual(compiledCascade());
    });

    it('refuses a check that fans out rather than emitting an unusable branch', () => {
      expect(() =>
        compileStrategy(
          {
            key: 'forked-check',
            roleSlots: ['verifier', 'principal'],
            shape: {
              entry: 'fan',
              steps: [
                { id: 'fan', kind: 'parallel', params: { n: 2 }, next: ['check'] },
                { id: 'check', kind: 'verify', roleSlot: 'verifier', next: ['escalate'] },
                { id: 'escalate', kind: 'call', roleSlot: 'principal' },
              ],
            },
          },
          { verifier: 'v', principal: 'p' },
        ),
      ).toThrow(/not across it/);
    });

    it('refuses a check with more than one escalation, which cannot be two branches', () => {
      expect(() =>
        compileStrategy(
          {
            key: 'two-ways-out',
            roleSlots: ['verifier', 'principal'],
            shape: {
              entry: 'check',
              steps: [
                { id: 'check', kind: 'verify', roleSlot: 'verifier', next: ['a', 'b'] },
                { id: 'a', kind: 'call', roleSlot: 'principal' },
                { id: 'b', kind: 'call', roleSlot: 'principal' },
              ],
            },
          },
          { verifier: 'v', principal: 'p' },
        ),
      ).toThrow(/exactly one step to escalate to/);
    });
  });

  // ── The branch means what it says ────────────────────────────────────────

  describe('the gate expression reads the verify verdict', () => {
    let executor: AgentNodeExecutor;

    const context = (checkOutput: any): ExecutionContext => ({
      input: {},
      nodes: checkOutput === undefined ? {} : { check: { output: checkOutput } },
      variables: {},
    });

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          { provide: ExecutionAccessService, useValue: membershipFixture().executionAccess },
          AgentNodeExecutor,
          AgentTemplateResolver,
          AgentSubAgentExecutors,
          AgentVerifierHelper,
          { provide: LlmProvidersService, useValue: { chat: jest.fn() } },
          { provide: ToolExecutorService, useValue: { executeTool: jest.fn() } },
          { provide: AgentExecutionEngine, useValue: { execute: jest.fn() } },
          { provide: A2AClientService, useValue: {} },
          { provide: ExternalAgentsService, useValue: {} },
          { provide: getRepositoryToken(Agent), useValue: { findOne: jest.fn() } },
          { provide: getRepositoryToken(Organization), useValue: { findOne: jest.fn() } },
        ],
      }).compile();
      executor = module.get(AgentNodeExecutor);
    });

    const gate = (): AgentPipelineNode => compiledCascade().nodes.find((n) => n.id === 'check__gate')!;

    /** The shape a verify node really emits. */
    const verdict = (passed: boolean) => ({
      verdict: passed ? 'pass' : 'fail',
      passed,
      policy: 'any_fail_blocks',
      failures: passed ? [] : [{ rule: 'wrong', evidence: 'x', checker: 'verifier' }],
      passed_rules: [],
      checkers: [{ checker: 'verifier', verdict: passed ? 'pass' : 'fail' }],
    });

    it('is true when the check passed', async () => {
      const result = await executor.execute(gate(), context(verdict(true)), 'org-1');
      expect(result.output).toEqual({ __condition: true, result: true });
    });

    it('is false when the check failed', async () => {
      const result = await executor.execute(gate(), context(verdict(false)), 'org-1');
      expect(result.output).toEqual({ __condition: true, result: false });
    });

    it('is false when the verdict cannot be read at all, so "we could not tell" escalates', async () => {
      const result = await executor.execute(gate(), context(undefined), 'org-1');
      expect(result.output).toEqual({ __condition: true, result: false });
    });
  });

  // ── The escalation is actually skipped ───────────────────────────────────

  describe('running the compiled graph', () => {
    let engine: AgentExecutionEngine;
    let nodeExecutor: { execute: jest.Mock };

    const makeAgent = (): Agent => {
      const agent = new Agent();
      agent.id = 'agent-1';
      agent.name = 'Cascade';
      agent.organizationId = 'org-1';
      agent.status = AgentStatus.ACTIVE;
      agent.pipeline = compiledCascade();
      agent.variables = {};
      agent.settings = {};
      agent.metadata = {};
      agent.totalExecutions = 0;
      agent.successfulExecutions = 0;
      agent.totalCost = 0;
      agent.averageExecutionTime = 0;
      agent.incrementExecution = jest.fn() as any;
      return agent;
    };

    /** Every node answers plausibly; the gate answers whatever the check said. */
    const wire = (checkPassed: boolean) => {
      nodeExecutor.execute.mockImplementation(async (node: AgentPipelineNode) => {
        switch (node.type) {
          case 'input':
            return { output: { task: 'do the thing' } };
          case 'llm_call':
            return { output: `${node.id} answered`, cost: node.id === 'escalate' ? 1 : 0.01 };
          case 'verify':
            return { output: { verdict: checkPassed ? 'pass' : 'fail', passed: checkPassed } };
          case 'condition':
            return { output: { __condition: true, result: checkPassed } };
          default:
            return { output: 'done' };
        }
      });
    };

    const ran = (): string[] =>
      nodeExecutor.execute.mock.calls.map(([node]: [AgentPipelineNode]) => node.id);

    beforeEach(async () => {
      nodeExecutor = { execute: jest.fn() };
      const qb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      const execution = new AgentExecution();
      Object.assign(execution, {
        id: 'exec-1',
        agentId: 'agent-1',
        organizationId: 'org-1',
        status: AgentExecutionStatus.RUNNING,
        input: {},
        nodeResults: {},
        metadata: {},
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          { provide: ExecutionAccessService, useValue: membershipFixture().executionAccess },
          AgentExecutionEngine,
          AgentExecutionStateHelper,
          {
            provide: getRepositoryToken(Agent),
            useValue: { save: jest.fn(), findOne: jest.fn(), createQueryBuilder: jest.fn().mockReturnValue(qb) },
          },
          {
            provide: getRepositoryToken(AgentExecution),
            useValue: {
              create: jest.fn().mockReturnValue(execution),
              save: jest.fn().mockImplementation((e: any) => Promise.resolve(e)),
              // Terminal writes are a guarded UPDATE now (see commitTerminal).
              update: jest.fn(async () => ({ affected: 1 })),
            },
          },
          { provide: AgentNodeExecutor, useValue: nodeExecutor },
          { provide: AgentWebhookService, useValue: { sendExecutionWebhook: jest.fn().mockResolvedValue(undefined) } },
        ],
      }).compile();
      engine = module.get(AgentExecutionEngine);
    });

    it('never runs the expensive escalation when the check passes', async () => {
      wire(true);
      const result = await engine.execute(makeAgent(), 'org-1', 'user-1', { input: { task: 'do the thing' } });

      expect(result.status).toBe(AgentExecutionStatus.COMPLETED);
      expect(ran()).toEqual(expect.arrayContaining(['input', 'draft', 'check', 'check__gate', 'output']));
      // This is the saving the strategy is sold on.
      expect(ran()).not.toContain('escalate');
      expect(result.nodeResults!['escalate']?.output).toBeUndefined();
      // The escalation costs 1 in this harness and the draft 0.01, so the
      // bill is the assertion: a passing check does not pay the principal.
      expect(result.totalCost).toBeLessThan(1);
    });

    it('runs the escalation when the check fails', async () => {
      wire(false);
      const result = await engine.execute(makeAgent(), 'org-1', 'user-1', { input: { task: 'do the thing' } });

      expect(result.status).toBe(AgentExecutionStatus.COMPLETED);
      expect(ran()).toContain('escalate');
      expect(result.nodeResults!['escalate']?.output).toBe('escalate answered');
      expect(result.totalCost).toBeGreaterThanOrEqual(1);
    });

    it('reaches the output either way, so a passing check is not a dead end', async () => {
      for (const passed of [true, false]) {
        nodeExecutor.execute.mockReset();
        wire(passed);
        const result = await engine.execute(makeAgent(), 'org-1', 'user-1', { input: { task: 'do the thing' } });
        expect(ran()).toContain('output');
        expect(result.status).toBe(AgentExecutionStatus.COMPLETED);
      }
    });
  });
});
