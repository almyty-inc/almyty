import { readFileSync } from 'fs';
import { join } from 'path';

const CONTROLLER = join(__dirname, '..', 'canonical-memory.controller.ts');
const MCP = join(__dirname, '..', '..', '..', 'mcp', 'almyty-mcp.service.ts');

/**
 * Every memory scope is the caller's own, by construction.
 *
 * `scope_id` IS the organization id, and it is not a secret -- it
 * travels in headers, invite links and gateway URLs. Handlers that
 * passed the client's value through to a service that scoped on it and
 * nothing else let anyone read another tenant's memory, write rows into
 * it, or repoint its backend, with the audit row filed under the
 * victim's org.
 *
 * Three handlers were fixed once and the other ten kept the hole, so
 * this asserts the shape rather than the instances: no handler may
 * reach for a caller-supplied scope id at all.
 */
describe('canonical memory never trusts a caller-supplied scope', () => {
  const controller = readFileSync(CONTROLLER, 'utf8');
  const mcp = readFileSync(MCP, 'utf8');

  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('routes every scope through ownScope in the controller', () => {
    const body = stripComments(controller);
    // `this.orgId(req)` is the other legitimate source; `ownScope` calls
    // it. What must not appear is the request's own scope id reaching a
    // service.
    const leaks = [
      'scope_id: body.scope_id',
      'body.scope_type, body.scope_id',
      'scope: body.scope',
      'scope_type: body.scope_type, scope_id: body.scope_id',
    ].filter(pattern => body.includes(pattern));

    expect(leaks).toEqual([]);
  });

  it('gives every scope-taking handler the request it needs to check', () => {
    const body = stripComments(controller);
    // A handler that takes a scope but no @Request() cannot have checked
    // it, whatever else it does.
    const handlers = [...body.matchAll(/async (\w+)\(([\s\S]*?)\n  \) \{/g)];
    const scoped = handlers.filter(([, , params]) => /scope/i.test(params));
    const unchecked = scoped.filter(([, name, params]) => !params.includes('@Request()')).map(([, name]) => name);

    expect(unchecked).toEqual([]);
  });

  it('does not let an MCP client name the scope it operates on', () => {
    const body = stripComments(mcp);

    expect(body).not.toContain('args.scope_id');
    // Nor advertise it, so a client is not invited to try.
    expect(body).not.toMatch(/scope_id: \{ type: 'string'/);
  });
});
