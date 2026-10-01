import { DropAcpAndOpenAiChatGateways1750813762000 } from '../1750813762000-DropAcpAndOpenAiChatGateways';

/**
 * The acp and openai_chat gateway types are gone; their rows are deleted,
 * not migrated. A truthful in-memory stand-in for the three tables runs the
 * migration's statements: a DELETE ... WHERE "gatewayId" IN (<gateways of
 * those types>) and a DELETE of the gateways themselves. Everything else
 * stays.
 */
describe('DropAcpAndOpenAiChatGateways migration', () => {
  type Row = Record<string, string>;
  const tables: Record<string, Row[]> = {};

  const typesIn = (sql: string): string[] => {
    const m = sql.match(/"type" IN \(([^)]*)\)/);
    if (!m) throw new Error(`no type filter in: ${sql}`);
    return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
  };

  const queryRunner: any = {
    query: async (sql: string) => {
      const target = sql.match(/^DELETE FROM "(\w+)"/)?.[1];
      if (!target) throw new Error(`unexpected statement: ${sql}`);
      const types = typesIn(sql);
      const goneIds = new Set(tables.gateways.filter((g) => types.includes(g.type)).map((g) => g.id));
      tables[target] = target === 'gateways'
        ? tables.gateways.filter((g) => !types.includes(g.type))
        : tables[target].filter((r) => !goneIds.has(r.gatewayId));
    },
  };

  beforeEach(() => {
    tables.gateways = ['mcp', 'utcp', 'skills', 'a2a', 'hosted_chat', 'acp', 'openai_chat'].map((type) => ({ id: `gw-${type}`, type }));
    tables.gateway_tools = tables.gateways.map((g) => ({ id: `gt-${g.id}`, gatewayId: g.id }));
    tables.api_keys = tables.gateways.map((g) => ({ id: `k-${g.id}`, gatewayId: g.id }));
  });

  it('deletes acp and openai_chat gateways with their tool attachments and keys, and nothing else', async () => {
    await new DropAcpAndOpenAiChatGateways1750813762000().up(queryRunner);

    const kept = ['gw-mcp', 'gw-utcp', 'gw-skills', 'gw-a2a', 'gw-hosted_chat'];
    expect(tables.gateways.map((g) => g.id)).toEqual(kept);
    expect(tables.gateway_tools.map((r) => r.gatewayId)).toEqual(kept);
    expect(tables.api_keys.map((r) => r.gatewayId)).toEqual(kept);
  });
});
