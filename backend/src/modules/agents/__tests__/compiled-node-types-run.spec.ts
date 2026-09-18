import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AgentNodeExecutor } from '../agent-node-executor';
import { AgentSubAgentExecutors } from '../agent-subagent-executors.helper';
import { AgentTemplateResolver, ExecutionContext } from '../agent-template-resolver';
import { AgentVerifierHelper } from '../agent-verifier.helper';
import { AgentExecutionEngine } from '../agent-execution.engine';
import { LlmProvidersService } from '../../llm-providers/llm-providers.service';
import { ToolExecutorService } from '../../tools/tool-executor.service';
import { A2AClientService } from '../../a2a/a2a-client.service';
import { ExternalAgentsService } from '../../a2a/external-agents.service';
import { Agent, AgentPipelineNode } from '../../../entities/agent.entity';
import { Organization } from '../../../entities/organization.entity';
import { compileStrategy } from '../strategies/strategy-compiler';
import { STRATEGY_SEEDS } from '../strategies/strategy-seeds';

/**
 * A strategy that compiles must also run.
 *
 * `extract_context` was the counter-example: the compiler emitted it, the
 * seed for explore-extract-patch used it, a spec asserted the compiled
 * graph contained it, the docs described what it did at run time — and
 * the executor's switch had no case for it, so running the built-in threw
 * `Unsupported node type: extract_context`. Every layer was green and the
 * feature did not exist.
 *
 * The first test here is the guard for that whole class: whatever the
 * compiler can emit, the executor must dispatch. The rest cover the step
 * itself.
 */
describe('every node type a strategy compiles to is one the engine runs', () => {
  let executor: AgentNodeExecutor;
  let llm: { chat: jest.Mock };

  const buildContext = (over: Partial<ExecutionContext> = {}): ExecutionContext => ({
    input: { task: 'make the thing' },
    nodes: {},
    variables: {},
    ...over,
  });

  const node = (type: string, data: any = {}, id = 'n1'): AgentPipelineNode =>
    ({ id, type, data } as AgentPipelineNode);

  const answers = (content: string) => {
    llm.chat.mockResolvedValue({
      message: { role: 'assistant', content },
      cost: 0.004,
      usage: { totalTokens: 321 },
    } as any);
  };

  beforeEach(async () => {
    llm = { chat: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentNodeExecutor,
        AgentTemplateResolver,
        AgentSubAgentExecutors,
        AgentVerifierHelper,
        { provide: LlmProvidersService, useValue: llm },
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

  it('dispatches every node type the built-in strategies compile to', async () => {
    // Compile all five seeds, with every slot bound, and collect the node
    // types the engine would actually be handed.
    const types = new Set<string>();
    for (const seed of STRATEGY_SEEDS) {
      const bindings = Object.fromEntries((seed.roleSlots ?? []).map((slot) => [slot, `role-${slot}`]));
      for (const compiled of compileStrategy(seed, bindings).nodes) {
        types.add(compiled.type);
      }
    }
    // Sanity: the seeds really do exercise more than llm_call.
    expect(types.has('extract_context')).toBe(true);
    expect(types.size).toBeGreaterThan(4);

    const unsupported: string[] = [];
    for (const type of types) {
      // Each of these fails for its own reason (missing config, no
      // provider, nothing upstream). What none of them may do is fall
      // through to the default case.
      await executor.execute(node(type), buildContext(), 'org-1').catch((err: Error) => {
        if (/Unsupported node type/.test(err.message)) unsupported.push(type);
      });
    }
    expect(unsupported).toEqual([]);
  });

  describe('extract_context', () => {
    const brief = {
      relevantFiles: ['src/a.ts'],
      symbols: ['doThing'],
      callers: ['handler'],
      tests: ['a.spec.ts'],
      notes: 'the retry lives in the caller',
    };

    it('compresses the upstream outputs into a parsed brief', async () => {
      answers(JSON.stringify(brief));
      const ctx = buildContext({
        nodes: {
          try1: { output: 'attempt one read src/a.ts' },
          try2: { output: 'attempt two read src/b.ts' },
        },
      });

      const result = await executor.execute(
        node('extract_context', { providerId: 'p1' }),
        ctx,
        'org-1',
        undefined,
        { organizationId: 'org-1', edges: [
          { id: 'e1', source: 'try1', target: 'n1' },
          { id: 'e2', source: 'try2', target: 'n1' },
        ] },
      );

      expect(result.output).toEqual(brief);

      // Both transcripts reached the model, and the ask was the shared
      // instruction rather than a second copy of it.
      const [, request] = llm.chat.mock.calls[0];
      const user = request.messages.find((m: any) => m.role === 'user').content;
      expect(user).toContain('attempt one');
      expect(user).toContain('attempt two');
      expect(request.messages[0].role).toBe('system');
      expect(request.messages[0].content).toContain('compressing what several exploration attempts learned');
    });

    it('carries its own cost, so the compression is visible in the run', async () => {
      answers(JSON.stringify(brief));
      const result = await executor.execute(
        node('extract_context', { providerId: 'p1', sources: 'one transcript' }),
        buildContext(),
        'org-1',
      );
      expect(result.cost).toBe(0.004);
      expect(result.tokens).toBe(321);
    });

    it('fails the node when the brief is unusable rather than passing the transcripts through', async () => {
      answers('I had a look and it seems fine, honestly');
      await expect(
        executor.execute(
          node('extract_context', { providerId: 'p1', sources: 'one transcript' }),
          buildContext(),
          'org-1',
        ),
      ).rejects.toMatchObject({ code: 'EXTRACTED_CONTEXT_INVALID' });
    });

    it('refuses a partial brief, so an empty field cannot read as "nothing found"', async () => {
      answers(JSON.stringify({ relevantFiles: ['a.ts'], notes: 'hm' }));
      await expect(
        executor.execute(
          node('extract_context', { providerId: 'p1', sources: 'one transcript' }),
          buildContext(),
          'org-1',
        ),
      ).rejects.toThrow(/symbols is missing/);
    });

    it('says what to do when there is nothing upstream to compress', async () => {
      await expect(
        executor.execute(node('extract_context', { providerId: 'p1' }), buildContext(), 'org-1'),
      ).rejects.toThrow(/nothing to compress/);
      expect(llm.chat).not.toHaveBeenCalled();
    });

    it('honours a role binding the same way an llm_call node does', async () => {
      answers(JSON.stringify(brief));
      await expect(
        executor.execute(
          node('extract_context', { roleKey: 'summariser', sources: 'one transcript' }),
          buildContext(),
          'org-1',
          undefined,
          { organizationId: 'org-1', resolvedRoles: [] },
        ),
      ).rejects.toThrow(/names role 'summariser', which this agent does not define/);
    });
  });
});
