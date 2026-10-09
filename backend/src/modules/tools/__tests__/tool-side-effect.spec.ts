import { derivedToolClass, graphqlKind, isSearchOperation, toolClass } from '../tool-side-effect';

/**
 * The side-effect class table of docs/design/code-mode.md, part A: every
 * row, the override, and where each class comes from.
 */
describe('tool side-effect class', () => {
  const generated = (method: string, apiType = 'openapi', type?: string) => ({
    metadata: { sourceOperation: { method, ...(type ? { type } : {}) }, sourceApi: { type: apiType } },
  });

  it.each([
    ['GET', 'read'],
    ['HEAD', 'read'],
    ['OPTIONS', 'read'],
    ['get', 'read'],
    ['DELETE', 'destructive'],
    ['POST', 'write'],
    ['PUT', 'write'],
    ['PATCH', 'write'],
  ])('classifies a generated %s operation as %s, from its HTTP method', (method, expected) => {
    expect(toolClass(generated(method))).toEqual({ sideEffect: expected, openWorld: true, sideEffectSource: 'http_method' });
  });

  it('classifies a hand-made HTTP tool by its method, and a templated method as having no signal', () => {
    expect(toolClass({ executionMethod: 'http', httpConfig: { method: 'DELETE' } })).toMatchObject({ sideEffect: 'destructive', sideEffectSource: 'http_method' });
    expect(toolClass({ executionMethod: 'http', httpConfig: { method: '{method}' } })).toMatchObject({ sideEffect: 'write', sideEffectSource: 'default' });
  });

  it.each([
    ['query', 'read'],
    ['subscription', 'read'],
    ['mutation', 'write'],
  ])('classifies a generated GraphQL %s as %s, though it travels as a POST', (type, expected) => {
    expect(toolClass(generated('POST', 'graphql', type))).toEqual({ sideEffect: expected, openWorld: true, sideEffectSource: 'graphql' });
  });

  it('reads the operation type of a hand-made GraphQL tool from its document', () => {
    expect(toolClass({ executionMethod: 'graphql', graphqlConfig: { query: 'query Pets { pets { id } }' } })).toMatchObject({ sideEffect: 'read', sideEffectSource: 'graphql' });
    expect(toolClass({ executionMethod: 'graphql', graphqlConfig: { query: '# archive\nmutation Archive($id: ID!) { archive(id: $id) }' } })).toMatchObject({ sideEffect: 'write' });
    expect(toolClass({ executionMethod: 'graphql', graphqlConfig: { query: '{ pets { id } }' } })).toMatchObject({ sideEffect: 'read' });
    expect(graphqlKind('fragment F on Pet { id }')).toBeNull();
  });

  it('uses the operation relation when it is loaded', () => {
    expect(toolClass({ operation: { method: 'DELETE' } })).toMatchObject({ sideEffect: 'destructive', sideEffectSource: 'http_method' });
  });

  it.each([
    [{ readOnlyHint: true }, 'read'],
    [{ readOnlyHint: false, destructiveHint: true }, 'destructive'],
    [{ readOnlyHint: false, destructiveHint: false }, 'write'],
  ])('takes a remote MCP tool\'s class from its annotations %j', (annotations, expected) => {
    expect(toolClass({ configuration: { mcp: { annotations: { ...annotations, openWorldHint: false } } } })).toEqual({
      sideEffect: expected,
      openWorld: false,
      sideEffectSource: 'annotation',
    });
  });

  it('treats a remote MCP tool without annotations as having no signal', () => {
    expect(toolClass({ configuration: { mcp: { annotations: { title: 'x' } } } })).toMatchObject({ sideEffect: 'write', sideEffectSource: 'default' });
  });

  it('has an LLM tool read, in a closed world', () => {
    expect(toolClass({ executionMethod: 'llm' })).toEqual({ sideEffect: 'read', openWorld: false, sideEffectSource: 'default' });
    expect(toolClass({ llmConfig: { model: 'x' } })).toMatchObject({ sideEffect: 'read', openWorld: false });
  });

  it.each([['custom'], ['soap'], ['grpc'], ['sdk'], [null]])('has no reliable signal for a %s tool, so it is write, never destructive by guess', (executionMethod) => {
    expect(toolClass({ executionMethod })).toEqual({ sideEffect: 'write', openWorld: true, sideEffectSource: 'default' });
  });

  describe('an override', () => {
    it('wins over every derived class, and keeps openWorld derived', () => {
      expect(toolClass({ ...generated('DELETE'), sideEffect: 'read', sideEffectSource: 'override' })).toEqual({
        sideEffect: 'read',
        openWorld: true,
        sideEffectSource: 'override',
      });
      expect(toolClass({ configuration: { mcp: { annotations: { readOnlyHint: true } } }, sideEffect: 'destructive', sideEffectSource: 'override' })).toMatchObject({
        sideEffect: 'destructive',
      });
    });

    it('also comes from the older metadata.sideEffect', () => {
      expect(toolClass({ ...generated('GET'), metadata: { ...generated('GET').metadata, sideEffect: 'destructive' } })).toMatchObject({
        sideEffect: 'destructive',
        sideEffectSource: 'override',
      });
    });

    it('is not taken from a stored class that was itself derived', () => {
      // A row that says read from an earlier GET, now a DELETE: derived again.
      expect(toolClass({ ...generated('DELETE'), sideEffect: 'read', sideEffectSource: 'http_method' })).toMatchObject({ sideEffect: 'destructive' });
    });

    it('is ignored when its value is not a class', () => {
      expect(toolClass({ ...generated('GET'), sideEffect: 'harmless', sideEffectSource: 'override' })).toMatchObject({ sideEffect: 'read', sideEffectSource: 'http_method' });
    });

    it('does not change what the definition says (derivedToolClass)', () => {
      expect(derivedToolClass({ ...generated('DELETE'), sideEffect: 'read', sideEffectSource: 'override' })).toMatchObject({ sideEffect: 'destructive' });
    });
  });

  it('reads a search sent as POST, by its path or operation id', () => {
    // HubSpot searches are POST /crm/v3/objects/companies/search; Always on's
    // "asks before it changes anything" held every CRM lookup for approval.
    const op = (endpoint: string, operationId: string | null = null) =>
      derivedToolClass({ metadata: { sourceOperation: { method: 'POST', endpoint, operationId } } }).sideEffect;
    expect(op('/crm/v3/objects/companies/search', 'post-/crm/v3/objects/companies/search_doSearch')).toBe('read');
    expect(op('/crm/v3/objects/0-3/batch/read')).toBe('read');
    expect(op('/freeBusy', 'calendar.freebusy.query')).toBe('read');
    expect(isSearchOperation({ endpoint: '/v1/query/' })).toBe(true);
    // Everything else sent as POST still changes something.
    expect(op('/crm/v3/objects/companies', 'post-/crm/v3/objects/companies_create')).toBe('write');
    expect(op('/gmail/v1/users/{userId}/messages/send', 'gmail.users.messages.send')).toBe('write');
    expect(op('/research-notes')).toBe('write');
  });
});
