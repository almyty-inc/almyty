import { CredentialType } from '../../../../entities/credential.entity';
import { MEMORY_CONNECTORS, BUILTIN_CONNECTORS } from '../../../connections/connector-catalog';
import { validateConnectorDefinition } from '../../../connections/connector-schema';
import { AlmytyNativeBackend } from '../backends/almyty-native.backend';
import { AnthropicMemoryToolBackend } from '../backends/anthropic-memory-tool.backend';
import { Mem0Backend } from '../backends/mem0.backend';
import { SupermemoryBackend } from '../backends/supermemory.backend';
import { VertexMemoryBankBackend } from '../backends/vertex-memory-bank.backend';
import { ZepBackend } from '../backends/zep.backend';

/**
 * A memory account is a credential made from a memory connector whose key
 * is the memory backend's id. Every outside backend the router can reach
 * therefore needs a connector of that key, or nobody can add an account
 * for it (the Memory page's "Add account" and the agent's inline picker
 * both open the connect flow on connectorKey = backend id).
 */
describe('memory connectors', () => {
  const outside = [new Mem0Backend(), new ZepBackend(), new SupermemoryBackend(), new AnthropicMemoryToolBackend(), new VertexMemoryBankBackend()];

  it.each(outside.map((b) => [b.id]))('%s has a memory connector of the same key', (id) => {
    const connector = BUILTIN_CONNECTORS.find((c) => c.key === id);
    expect(connector).toBeDefined();
    expect(connector!.kind).toBe('memory');
    expect(validateConnectorDefinition(connector!)).toEqual([]);
    for (const method of connector!.connect) expect(method.credentialType).toBe(CredentialType.MEMORY_BACKEND);
  });

  it('has no connector for almyty\'s own memory, which needs no account', () => {
    const native = new AlmytyNativeBackend({} as any);
    expect(MEMORY_CONNECTORS.some((c) => c.key === native.id)).toBe(false);
  });

  it('stores the fields the backends read', () => {
    for (const c of MEMORY_CONNECTORS) {
      const fields = Object.keys(c.connect[0].schema!.properties);
      if (c.key === 'vertex-memory-bank') expect(fields).toEqual(expect.arrayContaining(['serviceAccountJson', 'engine', 'location']));
      else expect(fields).toContain('apiKey');
    }
  });
});
