import { collectModelReferences } from '../agent-references';

/**
 * Every (connection, model) pair an agent names, for telling its owner when
 * one of them goes away. A connection with no model, or a routed step,
 * names no particular model and is not listed.
 */
describe('collectModelReferences', () => {
  it('reads every place a workflow or an autonomous agent names a model, and where', () => {
    const refs = collectModelReferences({
      modelConfig: { providerId: 'p1', model: 'gpt-4o', compaction: { providerId: 'p2', model: 'small' } } as any,
      pipeline: {
        nodes: [
          { id: 'n1', type: 'llm_call', data: { label: 'Summarise', providerId: 'p1', model: 'gpt-4o-mini' } },
          { id: 'n2', type: 'llm_call', data: { providerId: 'p1' } },
          { id: 'n3', type: 'llm_call', data: { routing: { objective: 'cheapest' } } },
          { id: 'n4', type: 'verify', config: { label: 'Check', checkers: [{ providerId: 'p3', model: 'judge' }] } },
          { id: 'n5', type: 'extract_context', data: { providerId: 'p1', model: 'x' } },
        ],
        edges: [],
      } as any,
      agentConfig: { verify: { checkers: [{ providerId: 'p3', model: 'critic' }] }, constraints: { distill: { providerId: 'p1', model: 'd' } } } as any,
      collaboration: { participants: [{ kind: 'model', providerId: 'p4', model: 'teammate' }, { kind: 'agent', agentId: 'a2' }] } as any,
    });
    expect(refs).toEqual([
      { providerId: 'p1', model: 'gpt-4o', where: 'model' },
      { providerId: 'p2', model: 'small', where: 'context compaction' },
      { providerId: 'p1', model: 'gpt-4o-mini', where: 'step Summarise' },
      { providerId: 'p3', model: 'judge', where: 'step Check' },
      { providerId: 'p1', model: 'x', where: 'step n5' },
      { providerId: 'p3', model: 'critic', where: 'checker' },
      { providerId: 'p1', model: 'd', where: 'constraints' },
      { providerId: 'p4', model: 'teammate', where: 'team' },
    ]);
  });

  it('names an autonomous agent\'s main model once, by its role, not again as the mirrored model config', () => {
    const refs = collectModelReferences({
      modelConfig: { providerId: 'p1', model: 'qwen' } as any,
      models: { roles: [{ key: 'main', name: 'Main', purpose: 'main', kind: 'model', providerId: 'p1', model: 'qwen' }, { key: 'checker', name: 'Checker', purpose: 'checker', kind: 'model', providerId: 'p2', model: 'llama' }] } as any,
    });
    expect(refs).toEqual([
      { providerId: 'p1', model: 'qwen', where: 'role Main' },
      { providerId: 'p2', model: 'llama', where: 'role Checker' },
    ]);
  });
});
