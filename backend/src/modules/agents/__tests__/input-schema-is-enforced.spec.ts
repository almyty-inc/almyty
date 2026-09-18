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
import { schemaConstrainsAnything, schemaProblems } from '../input-schema';

/**
 * The input node's declared schema is a contract, not decoration.
 *
 * The builder has had a JSON Schema editor on the input node since the
 * beginning; it saved to `node.data.schema`; `executeInputNode` passed
 * `context.input` straight through without looking at it. A caller could
 * send anything, the run proceeded, and the failure surfaced several
 * nodes later as a template resolving to undefined or a model asked to
 * reason about a field that was never sent.
 */
describe('a declared input schema is enforced', () => {
  let executor: AgentNodeExecutor;

  const ctx = (input: any): ExecutionContext => ({ input, nodes: {}, variables: {} });
  const inputNode = (schema: any): AgentPipelineNode =>
    ({ id: 'input', type: 'input', data: { schema } } as AgentPipelineNode);

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
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

  const ticketSchema = {
    type: 'object',
    properties: {
      subject: { type: 'string' },
      priority: { type: 'string', enum: ['low', 'high'] },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['subject'],
  };

  it('passes input that matches, unchanged', async () => {
    const input = { subject: 'printer on fire', priority: 'high', tags: ['hardware'] };
    const result = await executor.execute(inputNode(ticketSchema), ctx(input), 'org-1');
    expect(result.output).toEqual(input);
  });

  it('refuses a missing required field, naming it', async () => {
    await expect(
      executor.execute(inputNode(ticketSchema), ctx({ priority: 'high' }), 'org-1'),
    ).rejects.toThrow(/input\.subject is required and was not given/);
  });

  it('refuses a wrong type, saying what arrived', async () => {
    await expect(
      executor.execute(inputNode(ticketSchema), ctx({ subject: 42 }), 'org-1'),
    ).rejects.toThrow(/input\.subject must be string, and it is number/);
  });

  it('refuses a value outside an enum', async () => {
    await expect(
      executor.execute(inputNode(ticketSchema), ctx({ subject: 'x', priority: 'urgent' }), 'org-1'),
    ).rejects.toThrow(/input\.priority must be one of "low", "high"/);
  });

  it('checks inside an array, and says which element', async () => {
    await expect(
      executor.execute(inputNode(ticketSchema), ctx({ subject: 'x', tags: ['ok', 7] }), 'org-1'),
    ).rejects.toThrow(/input\.tags\[1\] must be string/);
  });

  it('carries a code the UI can branch on, and every problem at once', async () => {
    const err = await executor
      .execute(inputNode(ticketSchema), ctx({ priority: 'urgent' }), 'org-1')
      .catch((e) => e);
    expect(err.code).toBe('INPUT_SCHEMA_VIOLATION');
    expect(err.problems).toHaveLength(2);
    expect(err.message).toMatch(/Send input that matches, or change the schema on the input node/);
  });

  it('treats the builder default as unspecified rather than "must be an object"', async () => {
    // Opening the schema editor and closing it again leaves exactly this.
    // Enforcing it would make every agent behind a chat surface start
    // refusing its own input.
    const untouched = { type: 'object', properties: {} };
    expect(schemaConstrainsAnything(untouched)).toBe(false);
    const result = await executor.execute(inputNode(untouched), ctx('just a string'), 'org-1');
    expect(result.output).toBe('just a string');
  });

  it('passes through when there is no schema at all', async () => {
    const bare = { id: 'input', type: 'input' } as AgentPipelineNode;
    const result = await executor.execute(bare, ctx({ anything: true }), 'org-1');
    expect(result.output).toEqual({ anything: true });
  });

  describe('the validator itself', () => {
    it('skips a keyword it does not implement rather than rejecting the schema', () => {
      // The editor also accepts pasted schemas. Refusing a `pattern`
      // nobody asked us to enforce would be worse than not enforcing it.
      expect(schemaProblems({ type: 'string', pattern: '^[a-z]+$' }, 'HELLO')).toEqual([]);
    });

    it('accepts an integer where a number is asked for, but not the reverse', () => {
      expect(schemaProblems({ type: 'number' }, 3)).toEqual([]);
      expect(schemaProblems({ type: 'integer' }, 3.5)).toHaveLength(1);
    });

    it('does not pile a second complaint on a value of the wrong shape', () => {
      // One useful sentence beats one useful sentence and a guess.
      expect(
        schemaProblems({ type: 'object', required: ['a', 'b'], properties: { a: { type: 'string' } } }, 'not an object'),
      ).toEqual(['input must be object, and it is string']);
    });

    it('distinguishes null from an absent field', () => {
      expect(schemaProblems({ type: 'object', required: ['a'] }, { a: null })).toEqual([]);
      expect(schemaProblems({ type: 'object', required: ['a'] }, {})).toHaveLength(1);
    });

    it('accepts a union of types', () => {
      expect(schemaProblems({ type: ['string', 'null'] }, null)).toEqual([]);
      expect(schemaProblems({ type: ['string', 'null'] }, 7)).toHaveLength(1);
    });

    it('recurses into nested objects with a readable path', () => {
      const schema = {
        type: 'object',
        properties: { user: { type: 'object', properties: { age: { type: 'integer' } } } },
      };
      expect(schemaProblems(schema, { user: { age: 'old' } })).toEqual([
        'input.user.age must be integer, and it is string',
      ]);
    });
  });
});
