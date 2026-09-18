import { AgentSubAgentExecutors } from '../agent-subagent-executors.helper';

/**
 * The builder writes a sub_agent node's input mapping as an array of
 * {key, value} rows. Read with Object.entries alone, that array became
 * {"0": {key, value}} — the wrong key, and the template arrived at the
 * child agent as literal text instead of a resolved value.
 */
describe('sub_agent input mapping accepts both shapes', () => {
  const build = () => {
    const executors = Object.create(
      AgentSubAgentExecutors.prototype,
    ) as AgentSubAgentExecutors;

    (executors as any).templateResolver = {
      resolve: (template: string, context: any) =>
        template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m: string, path: string) => {
          const value = path
            .split('.')
            .reduce((acc: any, part: string) => (acc == null ? acc : acc[part]), context);
          return value === undefined || value === null ? '' : String(value);
        }),
    };

    const seen: Array<Record<string, any>> = [];
    (executors as any).agentRepository = {
      findOne: async () => ({ id: 'child', name: 'child' }),
    };
    (executors as any).executionEngine = {
      execute: async (_agent: any, _org: string, _user: string, options: any) => {
        seen.push(options.input);
        return { status: 'completed', output: 'ok', totalCost: 0, totalTokens: 0 };
      },
    };

    return { executors, seen };
  };

  const context = { input: { message: 'hello world' }, nodes: {} };
  const options = { organizationId: 'org-1', userId: 'user-1' } as any;

  it('resolves an array of {key, value} rows into named, resolved inputs', async () => {
    const { executors, seen } = build();

    await executors.executeSubAgentNode(
      {
        id: 'sub_1',
        type: 'sub_agent',
        data: {
          agentId: 'child',
          inputMapping: [{ key: 'query', value: '{{input.message}}' }],
        },
      } as any,
      context as any,
      options,
    );

    expect(seen[0]).toEqual({ query: 'hello world' });
    expect(seen[0]).not.toHaveProperty('0');
  });

  it('still resolves the object shape a hand-written pipeline may use', async () => {
    const { executors, seen } = build();

    await executors.executeSubAgentNode(
      {
        id: 'sub_1',
        type: 'sub_agent',
        data: {
          agentId: 'child',
          inputMapping: { query: '{{input.message}}' },
        },
      } as any,
      context as any,
      options,
    );

    expect(seen[0]).toEqual({ query: 'hello world' });
  });

  it('passes non-string mapping values through untouched', async () => {
    const { executors, seen } = build();

    await executors.executeSubAgentNode(
      {
        id: 'sub_1',
        type: 'sub_agent',
        data: {
          agentId: 'child',
          inputMapping: [{ key: 'limit', value: 10 }],
        },
      } as any,
      context as any,
      options,
    );

    expect(seen[0]).toEqual({ limit: 10 });
  });

  it('falls back to the whole input when every mapping row is blank', async () => {
    const { executors, seen } = build();

    await executors.executeSubAgentNode(
      {
        id: 'sub_1',
        type: 'sub_agent',
        data: {
          agentId: 'child',
          inputMapping: [{ key: '', value: '' }],
        },
      } as any,
      context as any,
      options,
    );

    expect(seen[0]).toEqual({ message: 'hello world' });
  });
});
