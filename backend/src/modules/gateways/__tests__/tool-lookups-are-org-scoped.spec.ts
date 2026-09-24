import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * A tool is loaded with its organization, everywhere.
 *
 * `agent.toolIds` is a plain `string[]` column and `gateway_tools` has no
 * organization column, so neither the type system nor the database
 * rejects a tool id from another tenant. Four read paths resolved tool
 * ids with no `organizationId` filter, and each of them puts the tool's
 * name, description and parameter schema somewhere a different tenant
 * can see it: the gateway's tool listing, the agent card a gateway
 * client GETs, and the prompt the model is handed. Execution itself
 * fails closed in ToolExecutorService — its comment describes this
 * attack — so the harm was metadata disclosure plus an association that
 * could never run.
 *
 * This guard is textual on purpose. The defect is an *absent* clause, and
 * a behavioural test can only cover the call sites somebody thought to
 * write one for; reading the source catches the next unscoped `find` as
 * well as these four.
 */
describe('every tool lookup is scoped to an organization', () => {
  const read = (rel: string) => readFileSync(join(__dirname, '..', '..', '..', rel), 'utf8');

  /**
   * The call sites that resolve tool ids coming from somewhere other
   * than a tool query of their own, with the identifier each one must
   * scope by.
   */
  const sites: Array<{ file: string; needle: string; scope: string }> = [
    {
      file: 'modules/gateways/gateway-tool.service.ts',
      needle: 'createGatewayToolDto.toolId',
      scope: 'organizationId',
    },
    {
      file: 'modules/gateways/gateway-tool-queries.helper.ts',
      needle: 'In(bulkAssociateDto.toolIds)',
      scope: 'organizationId',
    },
    {
      file: 'modules/gateways/unified-agent.helper.ts',
      needle: 'In(agent.toolIds)',
      scope: 'organizationId: agent.organizationId',
    },
    {
      file: 'modules/agents/agent-step-processor.ts',
      needle: 'In(agent.toolIds)',
      scope: 'organizationId: agent.organizationId',
    },
  ];

  for (const { file, needle, scope } of sites) {
    it(`${file} scopes its tool lookup`, () => {
      const source = read(file);
      const at = source.indexOf(needle);
      expect(at).toBeGreaterThan(-1); // the call site still exists; update this guard if it moved
      // The filter object is short — the scope belongs within a few
      // lines of the id, not somewhere else in the function.
      const clause = source.slice(at, at + 200);
      expect(clause).toContain(scope);
    });
  }
});
