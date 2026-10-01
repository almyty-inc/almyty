import { keywordScore, reciprocalRankFusion, searchText, words } from '../tool-search';
import { codeNames, exampleCall, functionNameOf, namespaceOf, schemaToTs, toolSignature } from '../tool-signature';

/**
 * The keyword half of search_tools, the fusion of both halves, and how a
 * tool is named and typed in code (docs/design/code-mode.md, parts B and C).
 */
const petstore = (name: string, fields: Record<string, any> = {}) => ({
  id: `t-${name}`,
  name,
  metadata: { sourceApi: { name: 'Petstore' }, sourceOperation: { name: fields.operation ?? null }, tags: fields.tags ?? [] },
  description: fields.description ?? null,
  parameters: fields.parameters ?? { type: 'object', properties: {} },
});

describe('keyword search', () => {
  it('splits camelCase, snake_case and punctuation into words', () => {
    expect(words('findPetsByStatus')).toEqual(['find', 'pets', 'by', 'status']);
    expect(words('petstore_delete_pet')).toEqual(['petstore', 'delete', 'pet']);
  });

  it('weights a match in the name above one in the description', () => {
    const inName = petstore('petstore_archive_pet');
    const inDescription = petstore('petstore_update_pet', { description: 'Can also archive a pet.' });
    expect(keywordScore(inName, 'archive')).toBeGreaterThan(keywordScore(inDescription, 'archive'));
    expect(keywordScore(petstore('petstore_get_inventory'), 'archive')).toBe(0);
  });

  it('finds by a word\'s start, the operation id, the API name and tags', () => {
    expect(keywordScore(petstore('petstore_find_pets_by_status'), 'pet')).toBeGreaterThan(0);
    expect(keywordScore(petstore('x', { operation: 'findPetsByStatus' }), 'status')).toBeGreaterThan(0);
    expect(keywordScore(petstore('x'), 'petstore')).toBeGreaterThan(0);
    expect(keywordScore(petstore('x', { tags: ['inventory'] }), 'inventory')).toBeGreaterThan(0);
    expect(searchText(petstore('x', { operation: 'getPet' })).identifiers).toBe('getPet Petstore');
  });

  it('still finds a one-letter query by substring, at half weight', () => {
    // Half the name weight (2), plus the whole query inside the name (1).
    expect(keywordScore(petstore('weather'), 'e')).toBe(3);
    expect(keywordScore({ id: 'x', name: 'xyz' }, 'e')).toBe(0);
  });

  it('ignores the API prefix every tool of an API shares, stopwords, and finds parameter values', () => {
    const find = { ...petstore('petstore_find_pets_by_status'), parameters: { type: 'object', properties: { status: { type: 'string', enum: ['available', 'sold'] } } } };
    const add = petstore('petstore_add_pet', { description: 'Add a new pet to the store.' });
    // "pets" is a prefix of "petstore": only the tool that is about pets may score on it.
    expect(keywordScore(find, 'which pets are sold')).toBeGreaterThan(keywordScore(add, 'which pets are sold'));
    expect(keywordScore(add, 'which are the')).toBe(0);
    expect(searchText(find).name).toBe('find_pets_by_status');
    expect(searchText(find).params).toBe('status available sold');
  });

  it('merges rankings by reciprocal rank, so a tool high in both wins', () => {
    const fused = reciprocalRankFusion([['a', 'b', 'c'], ['b', 'c', 'a']], 60);
    const order = [...fused.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id);
    expect(order[0]).toBe('b');
    expect(fused.get('a')).toBeCloseTo(1 / 61 + 1 / 63);
  });
});

describe('code names and signatures', () => {
  it('puts a tool under its API\'s namespace, named by its operation id', () => {
    const t = petstore('petstore_find_pets_by_status', { operation: 'findPetsByStatus' });
    expect(namespaceOf(t)).toBe('petstore');
    expect(functionNameOf(t, 'petstore')).toBe('findPetsByStatus');
  });


  it('names a function by the operation id, never by the operation\'s summary', () => {
    const generated = { id: '1', name: 'petstore_find_pets_by_status', metadata: { sourceApi: { name: 'Petstore' }, sourceOperation: { name: 'Finds Pets by status', operationId: 'findPetsByStatus' } } };
    expect(functionNameOf(generated, 'petstore')).toBe('findPetsByStatus');
    expect(functionNameOf({ ...generated, metadata: { sourceApi: { name: 'Petstore' }, sourceOperation: { name: 'Finds Pets by status' } } }, 'petstore')).toBe('findPetsByStatus');
    expect(functionNameOf({ id: '2', name: 'x', operation: { operationId: 'getInventory', name: 'Returns pet inventories' } }, 'petstore')).toBe('getInventory');
  });
  it('drops the API prefix from a tool name when there is no operation id', () => {
    expect(functionNameOf(petstore('petstore_get_inventory'), 'petstore')).toBe('getInventory');
  });

  it('puts a hand-made tool under custom, and an MCP source\'s under the source', () => {
    expect(namespaceOf({ id: '1', name: 'send_invoice' })).toBe('custom');
    expect(namespaceOf({ id: '2', name: 'x', metadata: { mcpSource: { name: 'Linear Workspace' } } })).toBe('linearWorkspace');
    expect(functionNameOf({ id: '2', name: 'x', configuration: { mcp: { remoteName: 'create_issue' } } }, 'linearWorkspace')).toBe('createIssue');
  });

  it('suffixes a name taken twice, stably, and never shadows tools.search/get/call', () => {
    const names = codeNames([
      { id: 'b', name: 'getPet', metadata: { sourceApi: { name: 'Petstore' } } },
      { id: 'a', name: 'get_pet', metadata: { sourceApi: { name: 'Petstore' } } },
      { id: 'c', name: 'search', metadata: { sourceApi: { name: 'Petstore' } } },
    ]);
    expect(names.get('b')).toEqual({ namespace: 'petstore', fn: 'getPet' });
    expect(names.get('a')).toEqual({ namespace: 'petstore', fn: 'getPet2' });
    expect(names.get('c')!.fn).toBe('search2');
  });

  it('makes untrusted names into valid, non-reserved identifiers', () => {
    expect(namespaceOf({ id: '1', name: 'x', metadata: { sourceApi: { name: '2nd API; drop()' } } })).toMatch(/^[A-Za-z_$][A-Za-z0-9_$]*$/);
    expect(functionNameOf({ id: '1', name: 'delete' }, 'custom')).toBe('delete_');
  });

  it('types arguments and results from JSON Schema, unknown where it cannot', () => {
    expect(schemaToTs({ type: 'object', properties: { status: { type: 'string', enum: ['sold', 'available'] }, limit: { type: 'integer' } }, required: ['status'] })).toBe(
      '{ status: "sold" | "available"; limit?: number }',
    );
    expect(schemaToTs({ type: 'array', items: { type: ['string', 'null'] } })).toBe('Array<string | null>');
    expect(schemaToTs({ anyOf: [{ type: 'string' }, { type: 'number' }] })).toBe('string | number');
    expect(schemaToTs({ $ref: '#/x' })).toBe('unknown');
    expect(schemaToTs({ type: 'string', nullable: true })).toBe('string | null');
  });

  it('renders a signature with its doc comment and return type', () => {
    const t = petstore('petstore_get_pet_by_id', {
      operation: 'getPetById',
      description: 'Find a pet by id.',
      parameters: { type: 'object', properties: { petId: { type: 'integer' } }, required: ['petId'] },
    });
    expect(toolSignature(t, { namespace: 'petstore', fn: 'getPetById' }, { type: 'object', properties: { name: { type: 'string' } } })).toBe(
      '/** Find a pet by id. */\npetstore.getPetById(args: { petId: number }): Promise<{ name?: string }>',
    );
    expect(toolSignature(t, { namespace: 'petstore', fn: 'getPetById' }, null)).toContain('Promise<unknown>');
  });

  it('gives an example call: the tool\'s own, else one built from its schema', () => {
    const own = exampleCall({ id: '1', name: 'x', examples: [{ input: { petId: 7 } }] }, { namespace: 'custom', fn: 'x' });
    expect(own).toEqual({ arguments: { petId: 7 }, code: 'await custom.x({"petId":7})', synthesized: false });
    const built = exampleCall(
      { id: '1', name: 'x', parameters: { type: 'object', properties: { status: { type: 'string', enum: ['sold'] }, limit: { type: 'integer', minimum: 5 } }, required: ['status'] } },
      { namespace: 'custom', fn: 'x' },
    );
    expect(built.arguments).toEqual({ status: 'sold', limit: 5 });
    expect(built.synthesized).toBe(true);
  });
});
