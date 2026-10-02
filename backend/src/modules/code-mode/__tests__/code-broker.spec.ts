import * as fs from 'fs';
import * as path from 'path';

import { Tool } from '../../../entities/tool.entity';
import { CodeCallError } from '../../tools/node-sandbox/types';
import { CODE_GLOBAL_NAMES } from '../../tools/node-sandbox/types';
import { ToolDiscoveryService } from '../../tool-discovery/tool-discovery.service';
import { namespaceOf } from '../../tool-discovery/tool-signature';
import { CodeBroker } from '../code-broker';

const tool = (id: string, name: string, sideEffect: Tool['sideEffect'], extra: Partial<Tool> = {}) =>
  ({
    id,
    name,
    description: `${name} does a thing.`,
    sideEffect,
    parameters: { type: 'object', properties: {} },
    api: { name: 'Petstore' },
    operation: { operationId: name },
    ...extra,
  }) as unknown as Tool;

const FIND = tool('t-find', 'findPetsByStatus', 'read');
const UPDATE = tool('t-update', 'updatePet', 'write');
const DELETE = tool('t-delete', 'deletePet', 'destructive');

function broker(over: Partial<ConstructorParameters<typeof CodeBroker>[0]> = {}) {
  const execute = jest.fn(async (t: Tool, args: Record<string, any>) => ({
    success: true,
    data: { tool: t.name, args },
    executionTime: 1,
    cached: false,
    rateLimited: false,
    retryCount: 0,
  }));
  const b = new CodeBroker({
    scope: [FIND, UPDATE, DELETE],
    organizationId: 'org-1',
    policy: undefined,
    grantsLeft: new Map(),
    limits: { maxCalls: 100, maxInFlight: 4 },
    discovery: new ToolDiscoveryService(),
    execute,
    ...over,
  });
  return { b, execute: (over.execute as jest.Mock) ?? execute };
}

/**
 * The broker (docs/design/code-mode.md, part C): every call a script makes
 * is resolved in the script's scope, budgeted, held to the write policy,
 * and run through the executor, or refused.
 */
describe('code broker', () => {
  it('gives the script one namespace per API, functions named by operation id', () => {
    expect(broker().b.namespaces()).toEqual({ petstore: ['deletePet', 'findPetsByStatus', 'updatePet'] });
  });

  it('runs a read through the executor and hands back its data', async () => {
    const { b, execute } = broker();
    await expect(b.handle({ op: 'tool', namespace: 'petstore', fn: 'findPetsByStatus', args: { status: 'sold' } })).resolves.toEqual({
      tool: 'findPetsByStatus',
      args: { status: 'sold' },
    });
    expect(execute).toHaveBeenCalledWith(FIND, { status: 'sold' });
    expect(b.calls).toMatchObject([{ op: 'tool', target: 'petstore.findPetsByStatus', outcome: 'ran' }]);
  });

  it('answers "not found" for anything outside the scope, by code name or tool name', async () => {
    const { b, execute } = broker();
    await expect(b.handle({ op: 'tool', namespace: 'petstore', fn: 'dropDatabase', args: {} })).rejects.toThrow(/No tool named "petstore.dropDatabase"/);
    await expect(b.handle({ op: 'call', name: 'billing_invoice', args: {} })).rejects.toBeInstanceOf(CodeCallError);
    await expect(b.handle({ op: 'get', name: 'billing_invoice' })).rejects.toThrow(/No tool named/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('searches and describes only the scope, with code names', async () => {
    const { b } = broker();
    const hits = (await b.handle({ op: 'search', query: 'pets by status' })) as any[];
    expect(hits[0].name).toBe('petstore.findPetsByStatus');
    expect(hits.every((h) => h.name.startsWith('petstore.'))).toBe(true);
    const described = (await b.handle({ op: 'get', name: 'petstore.updatePet' })) as any;
    expect(described).toMatchObject({ name: 'petstore.updatePet', code: { namespace: 'petstore', function: 'updatePet' } });
  });

  it('stages a deletion by default: a receipt for the script, an entry in the change set, nothing run', async () => {
    const { b, execute } = broker();
    const receipt = await b.handle({ op: 'tool', namespace: 'petstore', fn: 'deletePet', args: { petId: 7 } });
    expect(receipt).toEqual({ staged: true, id: 1, tool: 'petstore.deletePet', note: expect.stringMatching(/has not run/) });
    expect(execute).not.toHaveBeenCalled();
    expect(b.changeSet).toEqual([
      expect.objectContaining({ id: 1, toolId: 't-delete', codeName: 'petstore.deletePet', arguments: { petId: 7 }, sideEffect: 'destructive', reason: 'policy', paramsHash: expect.any(String) }),
    ]);
  });

  it('stages writes when the agent turns staging on, and refuses what the policy denies', async () => {
    const { b, execute } = broker({ policy: { writes: { write: 'stage', destructive: 'deny' } } });
    await expect(b.handle({ op: 'call', name: 'petstore.updatePet', args: { id: 1 } })).resolves.toMatchObject({ staged: true });
    await expect(b.handle({ op: 'tool', namespace: 'petstore', fn: 'deletePet', args: {} })).rejects.toThrow(/deletes data and is not allowed/);
    expect(execute).not.toHaveBeenCalled();
    expect(b.calls.map((c) => c.outcome)).toEqual(['staged', 'refused']);
  });

  it('turns an amount rule hold into a staged entry with the rule, keeping the rule\'s fingerprint', async () => {
    const execute = jest.fn(async () => ({
      success: false,
      error: 'Needs approval',
      executionTime: 1,
      cached: false,
      rateLimited: false,
      retryCount: 0,
      approvalRequired: { summary: 'Ask before updatePet when price is over 500', paramsHash: 'rule-hash' } as any,
    }));
    const { b } = broker({ execute });
    await expect(b.handle({ op: 'tool', namespace: 'petstore', fn: 'updatePet', args: { price: 900 } })).resolves.toMatchObject({ staged: true });
    expect(b.changeSet[0]).toMatchObject({ reason: 'amount_rule', rule: 'Ask before updatePet when price is over 500', paramsHash: 'rule-hash' });
  });

  it('makes a failed call throw a ToolError naming the tool', async () => {
    const execute = jest.fn(async () => ({ success: false, error: 'Pet 9 not found', executionTime: 1, cached: false, rateLimited: false, retryCount: 0 }));
    const { b } = broker({ execute });
    await expect(b.handle({ op: 'tool', namespace: 'petstore', fn: 'findPetsByStatus', args: {} })).rejects.toMatchObject({ message: 'Pet 9 not found', tool: 'petstore.findPetsByStatus' });
  });

  it('refuses past the total budget and past the in-flight cap, never queues', async () => {
    const { b } = broker({ limits: { maxCalls: 2, maxInFlight: 100 } });
    await b.handle({ op: 'tool', namespace: 'petstore', fn: 'findPetsByStatus', args: {} });
    await b.handle({ op: 'tool', namespace: 'petstore', fn: 'findPetsByStatus', args: {} });
    await expect(b.handle({ op: 'tool', namespace: 'petstore', fn: 'findPetsByStatus', args: {} })).rejects.toThrow(/may make 2 calls/);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = jest.fn(async () => {
      await gate;
      return { success: true, data: 1, executionTime: 1, cached: false, rateLimited: false, retryCount: 0 };
    });
    const { b: b2 } = broker({ execute: slow, limits: { maxCalls: 100, maxInFlight: 2 } });
    const first = b2.handle({ op: 'tool', namespace: 'petstore', fn: 'findPetsByStatus', args: {} });
    const second = b2.handle({ op: 'tool', namespace: 'petstore', fn: 'findPetsByStatus', args: {} });
    await expect(b2.handle({ op: 'tool', namespace: 'petstore', fn: 'findPetsByStatus', args: {} })).rejects.toThrow(/At most 2 calls may run at once/);
    release();
    await Promise.all([first, second]);
    await expect(b2.handle({ op: 'tool', namespace: 'petstore', fn: 'findPetsByStatus', args: {} })).resolves.toBe(1);
  });

  it('uses a grant instead of staging, and counts it', async () => {
    const grantsLeft = new Map([['t-delete', 1]]);
    const { b, execute } = broker({ grantsLeft });
    await b.handle({ op: 'tool', namespace: 'petstore', fn: 'deletePet', args: { petId: 1 } });
    await b.handle({ op: 'tool', namespace: 'petstore', fn: 'deletePet', args: { petId: 2 } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(b.grantsUsed).toEqual({ 't-delete': 1 });
    expect(b.changeSet.map((e) => e.arguments)).toEqual([{ petId: 2 }]);
  });

  it('refuses extract where no extractor is available, and charges it where one is', async () => {
    await expect(broker().b.handle({ op: 'extract', value: 'x', schema: { type: 'object' } })).rejects.toThrow(/not available here/);
    const extract = jest.fn(async () => ({ value: { n: 1 }, cost: 0.002, tokens: 40 }));
    const { b } = broker({ extract });
    await expect(b.handle({ op: 'extract', value: 'one', schema: { type: 'object' } })).resolves.toEqual({ n: 1 });
    expect(b.extractCost).toBe(0.002);
    await expect(b.handle({ op: 'extract', value: 'one', schema: 'not a schema' as any })).rejects.toThrow(/JSON Schema object/);
  });

  it('never gives an API a namespace that shadows a script global', () => {
    for (const name of CODE_GLOBAL_NAMES) {
      expect(CODE_GLOBAL_NAMES).not.toContain(namespaceOf({ id: 'x', name: 'x', api: { name } }));
    }
    expect(namespaceOf({ id: 'x', name: 'x', api: { name: 'Tools' } })).toBe('toolsApi');
  });

  it('ends every tool call in the executor (guard)', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'code-broker.ts'), 'utf8');
    // The one place a brokered call runs, after the policy decided.
    expect(source.match(/this\.deps\.execute\(/g)).toHaveLength(1);
    const service = fs.readFileSync(path.join(__dirname, '..', 'code-mode.service.ts'), 'utf8');
    expect(service).toMatch(/execute: \(tool, args\) => this\.execute\(tool, args, context, row\.id, input\.signal\)/);
    expect(service).toMatch(/return this\.executor\.executeTool\(tool\.id, args, \{/);
    expect(service).toMatch(/holdForApproval: 'caller',\s+codeExecutionId,/);
  });
});
