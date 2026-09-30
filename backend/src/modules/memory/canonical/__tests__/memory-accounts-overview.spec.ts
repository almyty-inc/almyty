import { NotFoundException } from '@nestjs/common';
import { MemoryAccountsService } from '../memory-accounts.service';
import { fakeRepository } from '../../../../test/fake-repository';

/**
 * The Memory page's list of memory accounts.
 *
 * An account is almyty's own memory or a memory connection: several per
 * service, each with its own name and health. A service with no account
 * says so, rather than reading as "unreachable" because its probe ran
 * without a key.
 */
describe('MemoryAccountsService.overview', () => {
  const ORG = 'org-1';
  const USER = { id: 'user-1' };

  const nativeBackend = { id: 'almyty-native', healthCheck: jest.fn(async () => ({ ok: true, latency_ms: 3 })) };
  const backends: Record<string, any> = {
    'almyty-native': nativeBackend,
    mem0: { id: 'mem0', nativeId: () => null },
    zep: { id: 'zep', nativeId: () => null },
    'vertex-memory-bank': { id: 'vertex-memory-bank' },
  };
  const router = {
    backend: (id: string) => backends[id],
    list_backends: () => [
      { id: 'almyty-native', modes: ['memory', 'document'] },
      { id: 'mem0', modes: ['memory'] },
      { id: 'zep', modes: ['memory'] },
      { id: 'vertex-memory-bank', modes: ['memory'] },
    ],
  };

  const connection = (over: Record<string, any>) => ({
    kind: 'memory', accountLabel: null, owner: 'org', health: { status: 'unknown', checkedAt: null, error: null }, ...over,
  });

  function build(connections: any[], routing: Record<string, any> = {}) {
    const list = jest.fn(async () => connections);
    const moduleRef = { get: jest.fn(() => ({ list })) };
    const config = fakeRepository([{ scopeType: 'workspace', scopeId: ORG, overrides: { routing } }] as any);
    const svc = new MemoryAccountsService({} as any, router as any, config as any, fakeRepository([]) as any, fakeRepository([]) as any, undefined, moduleRef as any);
    return { svc, list };
  }

  it('lists almyty first, then every memory connection, several per service, each with its own health', async () => {
    const { svc, list } = build(
      [
        connection({ id: 'c1', name: 'Mem0 production', connectorKey: 'mem0', health: { status: 'valid', checkedAt: new Date(1), error: null } }),
        connection({ id: 'c2', name: 'Mem0 staging', connectorKey: 'mem0', health: { status: 'failed', checkedAt: new Date(2), error: 'Invalid API key' } }),
        // Not memory connections, or a memory service almyty has no adapter for: left out.
        connection({ id: 'c3', name: 'OpenAI', connectorKey: 'openai', kind: 'inference' }),
        connection({ id: 'c4', name: 'Home server', connectorKey: 'memory-custom' }),
      ],
      { memory_backend: 'mem0', credentials: { mem0: 'c1' } },
    );
    const out = await svc.overview(ORG, USER);

    expect(list).toHaveBeenCalledWith(USER, ORG);
    expect(out.accounts.map((a) => [a.id, a.service, a.name, a.health.status, a.isDefault])).toEqual([
      ['almyty-native', 'almyty-native', "almyty's own memory", 'valid', false],
      ['c1', 'mem0', 'Mem0 production', 'valid', true],
      ['c2', 'mem0', 'Mem0 staging', 'failed', false],
    ]);
    expect(out.accounts[2].health.error).toBe('Invalid API key');
  });

  it('says a service has no account instead of calling it unreachable', async () => {
    const { svc } = build([connection({ id: 'c1', name: 'Mem0', connectorKey: 'mem0' })]);
    const out = await svc.overview(ORG, USER);
    expect(out.services).toEqual([
      { id: 'mem0', name: 'Mem0', accounts: 1 },
      { id: 'zep', name: 'Zep', accounts: 0 },
      { id: 'vertex-memory-bank', name: 'Vertex AI Memory Bank', accounts: 0 },
    ]);
    // A connection never checked reads as not checked, not as down.
    expect(out.accounts[1].health.status).toBe('unknown');
    // almyty is the default when nothing else was picked.
    expect(out.accounts[0].isDefault).toBe(true);
  });

  it('marks accounts memories cannot be moved out of (the service cannot delete one memory)', async () => {
    const { svc } = build([
      connection({ id: 'c1', name: 'Mem0', connectorKey: 'mem0' }),
      connection({ id: 'c2', name: 'Vertex', connectorKey: 'vertex-memory-bank' }),
    ]);
    const out = await svc.overview(ORG, USER);
    expect(out.accounts.map((a) => [a.id, a.canMoveFrom])).toEqual([['almyty-native', true], ['c1', true], ['c2', false]]);
  });

  it('describes an account for a move: almyty, or a memory connection the caller can see', async () => {
    const { svc } = build([connection({ id: 'c1', name: 'Mem0 production', connectorKey: 'mem0' })]);
    expect(await svc.describeAccount(ORG, USER, 'almyty-native')).toEqual({ service: 'almyty-native', credentialId: null, name: "almyty's own memory" });
    expect(await svc.describeAccount(ORG, USER, 'c1')).toEqual({ service: 'mem0', credentialId: 'c1', name: 'Mem0 production' });
    await expect(svc.describeAccount(ORG, USER, 'someone-elses')).rejects.toBeInstanceOf(NotFoundException);
  });
});
