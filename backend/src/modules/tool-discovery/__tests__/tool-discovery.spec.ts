import { readFileSync } from 'fs';
import { join } from 'path';

import { ToolDiscoveryService, summaryOf, toolOutputSchema } from '../tool-discovery.service';
import { ToolEmbeddingService, embeddingText, textHash } from '../tool-embedding.service';
import { snapshotEnv } from '../../../test/env';

/**
 * search_tools and get_tool over a scope (docs/design/code-mode.md, part B),
 * the embeddings that feed the ranking, and the guard that every caller
 * resolves its scope the way tools/list does.
 */
const tool = (id: string, name: string, fields: Record<string, any> = {}): any => ({
  id,
  name,
  description: fields.description ?? null,
  sideEffect: fields.sideEffect ?? 'read',
  openWorld: true,
  parameters: fields.parameters ?? { type: 'object', properties: {} },
  metadata: { sourceApi: { name: 'Petstore' }, ...(fields.metadata ?? {}) },
  configuration: fields.configuration ?? null,
  outputSchema: fields.outputSchema ?? null,
  llmConfig: null,
});

const scope = [
  tool('1', 'petstore_find_pets_by_status', { description: 'Find pets by status. Multiple values can be given.', metadata: { sourceOperation: { name: 'findPetsByStatus' } } }),
  tool('2', 'petstore_delete_pet', { description: 'Deletes a pet.', sideEffect: 'destructive', metadata: { sourceOperation: { name: 'deletePet' } } }),
  tool('3', 'petstore_get_inventory', { description: 'Returns pet inventories by status.', metadata: { sourceOperation: { name: 'getInventory' } } }),
];
const nameOf = (t: any) => t.name;

describe('ToolDiscoveryService', () => {
  const restore = snapshotEnv('TOOL_SEARCH_DEFAULT_LIMIT', 'TOOL_SEARCH_MAX_LIMIT', 'TOOL_SEARCH_RRF_K', 'TOOL_EMBEDDINGS_ENABLED', 'TOOL_SEARCH_FALLBACK_VECTOR_WEIGHT');
  afterEach(restore);

  it('ranks by keywords within the scope, with the class and a one-sentence summary', async () => {
    const { results, total } = await new ToolDiscoveryService().search(scope, 'delete pet', { organizationId: 'org-1', nameOf });
    expect(results[0]).toMatchObject({ name: 'petstore_delete_pet', sideEffect: 'destructive', summary: 'Deletes a pet.' });
    expect(total).toBe(3); // "pet" matches every Petstore tool's name, more weakly
  });

  it('never ranks a tool outside the scope, even one the vector half returns', async () => {
    const embeddings = { nearest: jest.fn(async () => ({ ids: ['outside', '3'], model: 'text-embedding-3-small' })) } as unknown as ToolEmbeddingService;
    const { results } = await new ToolDiscoveryService(embeddings).search(scope, 'stock levels', { organizationId: 'org-1', nameOf });
    expect(results.map((r) => r.name)).toEqual(['petstore_get_inventory']);
    expect((embeddings.nearest as jest.Mock).mock.calls[0][1]).toEqual(['1', '2', '3']);
  });

  it('fuses keyword and vector rankings: a tool high in both comes first', async () => {
    const embeddings = { nearest: jest.fn(async () => ({ ids: ['3', '1'], model: 'text-embedding-3-small' })) } as unknown as ToolEmbeddingService;
    const { results } = await new ToolDiscoveryService(embeddings).search(scope, 'status', { organizationId: 'org-1', nameOf });
    expect(results.map((r) => r.name)).toEqual(['petstore_find_pets_by_status', 'petstore_get_inventory']);
  });

  it('keeps vector-only hits to the top of the vector ranking when keywords matched', async () => {
    const many = Array.from({ length: 30 }, (_, i) => tool(`v${i}`, `other_${i}`, { metadata: { sourceApi: { name: 'Other' } } }));
    // The vector half ranks every tool; the inventory tool, unrelated to it, comes last.
    const embeddings = { nearest: jest.fn(async () => ({ ids: [...many.map((t) => t.id), '3'], model: 'text-embedding-3-small' })) } as unknown as ToolEmbeddingService;
    const { results } = await new ToolDiscoveryService(embeddings).search([...scope, ...many], 'inventory', { organizationId: 'org-1', nameOf, limit: 3 });
    expect(results.map((r) => r.name)[0]).toBe('petstore_get_inventory');
    expect(results).toHaveLength(3);
  });

  it('caps results at TOOL_SEARCH_MAX_LIMIT and defaults to TOOL_SEARCH_DEFAULT_LIMIT', async () => {
    process.env.TOOL_SEARCH_DEFAULT_LIMIT = '1';
    process.env.TOOL_SEARCH_MAX_LIMIT = '2';
    const svc = new ToolDiscoveryService();
    expect((await svc.search(scope, 'pet', { organizationId: 'o', nameOf })).results).toHaveLength(1);
    expect((await svc.search(scope, 'pet', { organizationId: 'o', nameOf, limit: 50 })).results).toHaveLength(2);
    expect((await svc.search(scope, 'pet', { organizationId: 'o', nameOf, limit: 50, uncapped: true })).results).toHaveLength(3);
  });


  it('lets keywords carry the ranking when only the hash fallback embedded (TOOL_SEARCH_FALLBACK_VECTOR_WEIGHT)', async () => {
    // Keywords put "delete pet" first; the hash vectors would put inventory first.
    const embeddings = (model: string) => ({ nearest: jest.fn(async () => ({ ids: ['3', '1', '2'], model })) }) as unknown as ToolEmbeddingService;
    const query = 'delete';
    const withHash = await new ToolDiscoveryService(embeddings('hash-ngram-v1')).search(scope, query, { organizationId: 'o', nameOf });
    expect(withHash.results[0].name).toBe('petstore_delete_pet');
    process.env.TOOL_SEARCH_FALLBACK_VECTOR_WEIGHT = '1';
    const fullWeight = await new ToolDiscoveryService(embeddings('hash-ngram-v1')).search(scope, query, { organizationId: 'o', nameOf });
    const real = await new ToolDiscoveryService(embeddings('text-embedding-3-small')).search(scope, query, { organizationId: 'o', nameOf });
    expect(fullWeight.results.map((r) => r.score)).toEqual(real.results.map((r) => r.score));
  });
  it('answers an empty query or an empty scope with nothing', async () => {
    const svc = new ToolDiscoveryService();
    expect(await svc.search(scope, '  ', { organizationId: 'o', nameOf })).toEqual({ results: [], total: 0 });
    expect(await svc.search([], 'pet', { organizationId: 'o', nameOf })).toEqual({ results: [], total: 0 });
  });

  it('describes a tool at three levels of detail', () => {
    const svc = new ToolDiscoveryService();
    const t = tool('9', 'petstore_get_pet_by_id', {
      description: 'Find a pet.',
      metadata: { sourceOperation: { name: 'getPetById' } },
      parameters: { type: 'object', properties: { petId: { type: 'integer' } }, required: ['petId'] },
      outputSchema: { schema: { type: 'object', properties: { name: { type: 'string' } } } },
    });
    expect(svc.describe([...scope, t], t, 'name', nameOf)).toEqual({ name: 'petstore_get_pet_by_id' });
    expect(svc.describe([...scope, t], t, 'description', nameOf)).toEqual({ name: 'petstore_get_pet_by_id', description: 'Find a pet.', sideEffect: 'read' });
    const full: any = svc.describe([...scope, t], t, 'full', nameOf);
    expect(full.code).toEqual({ namespace: 'petstore', function: 'getPetById' });
    expect(full.signature).toBe('/** Find a pet. */\npetstore.getPetById(args: { petId: number }): Promise<{ name?: string }>');
    expect(full.outputSchema).toMatchObject({ type: 'object' });
    expect(full.example).toMatchObject({ arguments: { petId: 1 }, synthesized: true });
  });

  it('resolves a name only within the scope', () => {
    const svc = new ToolDiscoveryService();
    expect(svc.resolve(scope, 'petstore_delete_pet', nameOf)?.id).toBe('2');
    expect(svc.resolve(scope, 'petstore_admin_reset', nameOf)).toBeNull();
  });

  it('reads an output schema from the tool, an LLM tool\'s JSON mode or a remote MCP tool', () => {
    expect(toolOutputSchema(tool('a', 'x', { configuration: { mcp: { outputSchema: { type: 'object', properties: {} } } } }))).toMatchObject({ type: 'object' });
    expect(toolOutputSchema(tool('b', 'y'))).toBeNull();
    expect(summaryOf('One. Two.')).toBe('One.');
    expect(summaryOf('x'.repeat(300))).toHaveLength(200);
  });
});

describe('ToolEmbeddingService', () => {
  const restore = snapshotEnv('TOOL_EMBEDDINGS_ENABLED');
  afterEach(restore);

  function setup(rows: Record<string, any[]> = {}) {
    const queries: Array<{ sql: string; params: any[] }> = [];
    const repo = { findOne: jest.fn(async () => rows.tool?.[0] ?? null) };
    const dataSource: any = {
      subscribers: [] as any[],
      getRepository: () => repo,
      query: jest.fn(async (sql: string, params: any[]) => {
        queries.push({ sql, params });
        if (sql.includes('SELECT "textHash"')) return rows.existing ?? [];
        if (sql.includes('ORDER BY "embedding" <=>')) return rows.nearest ?? [];
        if (sql.includes('NOT EXISTS')) return rows.missing ?? [];
        return [];
      }),
    };
    const embeddings: any = { generateEmbedding: jest.fn(async () => ({ vector: [0.1, 0.2], model: 'text-embedding-3-small', dim: 2, provider: 'openai' })) };
    const queue: any = { add: jest.fn(async () => ({})) };
    const svc = new ToolEmbeddingService(dataSource, embeddings, queue);
    return { svc, dataSource, embeddings, queue, queries, repo };
  }

  it('subscribes to every tool write, whichever service makes it', () => {
    const { svc, dataSource } = setup();
    expect(dataSource.subscribers).toContain(svc);
  });

  it('queues a tool on insert and on an update of its text, not on one that leaves the text alone', () => {
    const { svc, queue } = setup();
    svc.afterInsert({ entity: { id: 't-1' } } as any);
    svc.afterUpdate({ entity: { id: 't-1' }, updatedColumns: [{ propertyName: 'description' }] } as any);
    svc.afterUpdate({ entity: { id: 't-1' }, updatedColumns: [{ propertyName: 'usageCount' }] } as any);
    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add.mock.calls[0][0]).toBe('embed');
  });

  it('queues nothing when TOOL_EMBEDDINGS_ENABLED is off', () => {
    process.env.TOOL_EMBEDDINGS_ENABLED = 'false';
    const { svc, queue } = setup();
    svc.afterInsert({ entity: { id: 't-1' } } as any);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('stores the vector with its model, padded to the column width, and skips unchanged text', async () => {
    const t = tool('t-1', 'petstore_get_pet', { description: 'Get a pet.' });
    const fresh = setup({ tool: [{ ...t, organizationId: 'org-1', status: 'active' }] });
    expect(await fresh.svc.embedTool('t-1')).toBe('embedded');
    const insert = fresh.queries.find((q) => q.sql.includes('INSERT INTO "tool_embeddings"'))!;
    expect(insert.params.slice(0, 4)).toEqual(['t-1', 'org-1', 'text-embedding-3-small', 2]);
    expect(insert.params[4].split(',')).toHaveLength(1536);

    const same = setup({ tool: [{ ...t, organizationId: 'org-1', status: 'active' }], existing: [{ textHash: textHash(embeddingText(t)) }] });
    expect(await same.svc.embedTool('t-1')).toBe('unchanged');
    expect(same.queries.some((q) => q.sql.includes('INSERT'))).toBe(false);
  });

  it('drops the embeddings of a deleted tool', async () => {
    const { svc, queries } = setup({ tool: [{ id: 't-1', status: 'deleted' }] });
    expect(await svc.embedTool('t-1')).toBe('removed');
    expect(queries[0].sql).toContain('DELETE FROM "tool_embeddings"');
  });

  it('compares only vectors of the query\'s model, among the candidate tools', async () => {
    const { svc, queries } = setup({ nearest: [{ toolId: 'b' }, { toolId: 'a' }] });
    expect(await svc.nearest('org-1', ['a', 'b'], 'pets', 10)).toEqual({ ids: ['b', 'a'], model: 'text-embedding-3-small' });
    const q = queries.find((x) => x.sql.includes('<=>'))!;
    expect(q.sql).toMatch(/"model" = \$2 AND "toolId" = ANY\(\$3::uuid\[\]\)/);
    expect(q.params.slice(0, 3)).toEqual(['org-1', 'text-embedding-3-small', ['a', 'b']]);
    expect(await svc.nearest('org-1', [], 'pets', 10)).toEqual({ ids: [], model: null });
  });

  it('queues candidates that have no vector of the query\'s model, once each', async () => {
    const { svc, queue, dataSource } = setup({ nearest: [{ toolId: 'a' }] });
    dataSource.query.mockImplementation(async (sql: string) => {
      if (sql.includes('ORDER BY "embedding" <=>')) return [{ toolId: 'a' }];
      if (sql.includes('SELECT "toolId" FROM "tool_embeddings" WHERE "model" = $1')) return [{ toolId: 'a' }];
      return [];
    });
    await svc.nearest('org-1', ['a', 'b', 'c'], 'pets', 10);
    const queued = queue.add.mock.calls.map((c: any[]) => [c[1].toolId, c[2].jobId]);
    expect(queued).toEqual([
      ['b', 'tool-embed:b:text-embedding-3-small'],
      ['c', 'tool-embed:c:text-embedding-3-small'],
    ]);
  });

  it('backfills every tool without an embedding, a page at a time', async () => {
    const { svc, queue } = setup({ missing: [{ id: 'x1' }, { id: 'x2' }] });
    expect(await svc.backfill(500)).toBe(2);
    expect(queue.add).toHaveBeenCalledTimes(2);
  });
});

describe('tool discovery scope guards', () => {
  const handler = readFileSync(join(__dirname, '../../mcp/services/mcp-tool.handler.ts'), 'utf8');
  const body = (name: string) => {
    const start = handler.indexOf(`  async ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const next = handler.indexOf('\n  async ', start + 10);
    return handler.slice(start, next === -1 ? undefined : next);
  };

  it('tools/list, search and get resolve the same set: servableToolsOnGateway on a gateway, the caller\'s listScope off it', () => {
    expect(body('handleToolsList')).toMatch(/servableToolsOnGateway\(this\.gatewayToolRepository, gatewayId/);
    expect(body('handleToolsList')).toMatch(/this\.listScope\(gatewayId, caller\)/);
    expect(body('discoveryScope')).toMatch(/servableToolsOnGateway\(this\.gatewayToolRepository, gatewayId/);
    expect(body('discoveryScope')).toMatch(/this\.listScope\(gatewayId, caller\)/);
    expect(body('handleToolsSearch')).toMatch(/this\.discoveryScope\(/);
    expect(body('handleToolGet')).toMatch(/this\.discoveryScope\(/);
  });
});
