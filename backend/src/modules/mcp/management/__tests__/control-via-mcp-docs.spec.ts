import * as fs from 'fs';
import * as path from 'path';

import { AlmytyMcpService } from '../../almyty-mcp.service';

/**
 * docs-site/content/control-via-mcp.mdx tells people how to reach the
 * management MCP and what it has. Both drifted: it pointed at `/mcp`,
 * which serves the organization's own API tools (mcp.controller.ts ->
 * McpService), and it counted tools the server did not have. The page is
 * checked against the code here.
 */
const REPO = path.join(__dirname, '..', '..', '..', '..', '..', '..');
const PAGE = fs.readFileSync(path.join(REPO, 'docs-site', 'content', 'control-via-mcp.mdx'), 'utf8');
const BACKEND = path.join(REPO, 'backend', 'src', 'modules');

async function managementToolNames(): Promise<string[]> {
  const service = new AlmytyMcpService({ get: () => undefined } as any);
  const res: any = await service.handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'org-1', 'user-1');
  return res.result.tools.map((t: any) => t.name);
}

describe('the "Control almyty via MCP" page matches the management MCP', () => {
  it('states the number of tools tools/list serves', async () => {
    const names = await managementToolNames();
    const stated = PAGE.match(/It has (\d+) tools/);
    expect(stated?.[1]).toBe(String(names.length));
  });

  it('lists exactly the tools tools/list serves in the developer table', async () => {
    const names = await managementToolNames();
    const table = PAGE.slice(PAGE.indexOf('The tools, by area:'), PAGE.indexOf('The first example'));
    const listed = [...table.matchAll(/`([a-z][a-z_]+)`/g)].map((m) => m[1]);
    expect([...new Set(listed)].sort()).toEqual([...names].sort());
  });

  it('gives the management address, /<org>/almyty, wherever it says how to connect', () => {
    // The system gateway is created at endpoint /almyty and served by the
    // unified endpoint at /:orgSlug/:resourceSlug.
    expect(fs.readFileSync(path.join(BACKEND, 'gateways', 'gateway-init.helper.ts'), 'utf8')).toContain("endpoint: '/almyty'");
    const connect = PAGE.slice(PAGE.indexOf('## Connect your assistant'), PAGE.indexOf('## What your assistant can do'));
    expect(connect).toContain('https://api.almyty.com/<org>/almyty');
    const configured = [
      ...PAGE.matchAll(/claude mcp add almyty[^\n]*?(https:\/\/\S+)/g),
      ...PAGE.matchAll(/"url":\s*"(https:\/\/[^"]+)"/g),
    ].map((m) => m[1]);
    expect(configured.length).toBeGreaterThan(0);
    expect(configured.filter((url) => url !== 'https://api.almyty.com/<org>/almyty')).toEqual([]);
  });
});
