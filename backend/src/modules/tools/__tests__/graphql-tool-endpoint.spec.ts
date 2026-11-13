jest.mock('axios', () => {
  const fn: any = jest.fn();
  fn.isAxiosError = () => false;
  return { __esModule: true, default: fn };
});

import axios from 'axios';
import { GraphQLParserService } from '../../schema-parser/parsers/graphql-parser.service';
import { ToolProtocolExecutor } from '../executors/tool-protocol.executor';
import { graphqlTargetUrl } from '../executors/graphql-operation-request';

/**
 * A tool generated from a GraphQL import calls the endpoint the API was
 * imported from -- the URL that answered introspection, or the address
 * the person gave -- not that address with `/graphql` appended.
 * `https://graphqlzero.almansi.me/api` serves GraphQL at /api; the call
 * used to go to /api/graphql and fail.
 */

const SDL = 'type User { id: ID name: String } type Query { user(id: ID!): User }';

async function callUser(baseUrl: string, endpoint?: string): Promise<string> {
  const mocked = axios as unknown as jest.Mock;
  mocked.mockReset();
  mocked.mockResolvedValue({ data: { data: { user: { id: '1', name: 'x' } } }, status: 200, headers: {} });
  const parser = new GraphQLParserService();
  const [op] = await parser.extractOperations(await parser.parseSchema(SDL));
  if (endpoint !== undefined) op.endpoint = endpoint;
  const exec = new ToolProtocolExecutor({ applyApiAuth: async () => {} } as any, {} as any);
  const res = await exec.executeGraphQLOperation({ name: 'query_user' } as any, op, { baseUrl, organizationId: null } as any, { id: '1' }, {} as any);
  expect(res.success).toBe(true);
  return mocked.mock.calls[0][0].url;
}

describe('GraphQL tools call the endpoint the API was imported from', () => {
  it('an endpoint with a path of its own is called as it is', async () => {
    expect(await callUser('https://graphqlzero.almansi.me/api')).toBe('https://graphqlzero.almansi.me/api');
  });

  it('an endpoint at /graphql is called as it is', async () => {
    expect(await callUser('https://rickandmortyapi.com/graphql')).toBe('https://rickandmortyapi.com/graphql');
  });

  it('a bare host is called as given', async () => {
    expect(await callUser('https://countries.trevorblades.com/')).toBe('https://countries.trevorblades.com/');
  });

  it('the import stores no path of its own', async () => {
    const parser = new GraphQLParserService();
    const ops = await parser.extractOperations(await parser.parseSchema(SDL));
    expect(ops.map((o) => o.endpoint)).toEqual(['']);
  });

  describe('operations stored with the path /graphql', () => {
    it('an address with its own path is the endpoint', async () => {
      expect(await callUser('https://graphqlzero.almansi.me/api', '/graphql')).toBe('https://graphqlzero.almansi.me/api');
    });

    it('a bare host still gets /graphql, as when it was imported', async () => {
      expect(await callUser('https://countries.trevorblades.com/', '/graphql')).toBe('https://countries.trevorblades.com/graphql');
    });

    it('an address already ending in /graphql is not doubled', () => {
      expect(graphqlTargetUrl('https://rickandmortyapi.com/graphql', '/graphql')).toBe('https://rickandmortyapi.com/graphql');
    });
  });
});
