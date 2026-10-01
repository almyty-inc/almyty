import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Source guard: every MCP HTTP entrance applies the core's HTTP rules and
 * hands the resolved version to a surface. A route that called a surface
 * without them would serve batches to 2025-06-18 clients, skip the Origin
 * check and answer every client in 2025-03-26 -- and still pass every unit
 * test of the core. (design doc, Test plan: "every McpSurface is reached by
 * a route".)
 */
const SRC = join(__dirname, '..', '..', '..', '..');
const read = (file: string) =>
  readFileSync(join(SRC, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('every MCP entrance goes through the core', () => {
  const ENTRANCES: Array<[string, RegExp[]]> = [
    [
      'modules/gateways/unified-gateway-delegation.helper.ts',
      [
        /mcpOriginRefusal\(req\)/,
        /resolveMcpRequestVersion\(req, body\)/,
        /almytyMcpService\.handleJsonRpc\([\s\S]*?ctx,?\s*\)/,
        /mcpService\.handleJsonRpcMessage\([\s\S]*?ctx,?\s*\)/,
      ],
    ],
    [
      'modules/mcp/mcp.controller.ts',
      [/mcpOriginRefusal\(req\)/, /resolveMcpRequestVersion\(req, body\)/, /handleJsonRpcMessage\([^)]*resolution\.ctx\)/],
    ],
  ];

  it.each(ENTRANCES)('%s applies Origin, version and batch rules and passes the version on', (file, patterns) => {
    const source = read(file);
    for (const pattern of patterns) expect(source).toMatch(pattern);
  });

  it('both surfaces dispatch through the shared core, not a switch of their own', () => {
    for (const file of ['modules/mcp/mcp.service.ts', 'modules/mcp/almyty-mcp.service.ts']) {
      const source = read(file);
      expect(source).toMatch(/handleMessage\(/);
      expect(source).not.toMatch(/case 'initialize'/);
      expect(source).not.toMatch(/case 'tools\/list'/);
    }
  });

  it('no MCP controller keeps the per-method REST routes', () => {
    expect(read('modules/mcp/mcp.controller.ts')).not.toMatch(/@Post\('\/(tools|resources|prompts|skills|initialize|ping|notifications)/);
  });
});
