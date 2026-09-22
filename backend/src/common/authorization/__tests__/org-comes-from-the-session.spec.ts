import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * Which organization you are acting in comes from your session, never
 * from something you typed.
 *
 * RolesGuard deliberately refuses a query/body/header organizationId, so
 * any handler that reads one anyway gets its role check run against the
 * caller's own org while it queries a different one. `GET /apis` did
 * exactly that and returned another tenant's API rows -- `headers` and
 * `authentication` columns included, which routinely hold API keys.
 *
 * The same rule is what made the canonical-memory scope fix worth
 * anything: those checks compare against `currentOrganizationId`, so
 * every path that can set that value is part of this boundary.
 */
describe('the acting organization is never caller-supplied', () => {
  const controllers = walk(SRC);

  it('has no handler taking organizationId from the query string', () => {
    const offenders = controllers
      .filter(f => /@Query\(\s*['"]organizationId['"]\s*\)/.test(stripComments(readFileSync(f, 'utf8'))))
      .map(f => f.slice(SRC.length + 1));

    expect(offenders).toEqual([]);
  });

  it('checks membership before stamping an org on a new API key', () => {
    const auth = stripComments(
      readFileSync(join(SRC, 'modules', 'auth', 'auth.service.ts'), 'utf8'),
    );
    const createKey = auth.slice(auth.indexOf('async createApiKey('));

    // ApiKeyStrategy sets currentOrganizationId from the stored key, so
    // an unchecked org here authenticates as that org everywhere.
    expect(createKey).toMatch(/userOrganizationRepository\.findOne/);
    expect(createKey).toMatch(/ForbiddenException/);
  });

  it('re-checks membership when an API key authenticates', () => {
    const strategy = stripComments(
      readFileSync(join(SRC, 'modules', 'auth', 'strategies', 'api-key.strategy.ts'), 'utf8'),
    );

    // The check moved into the shared predicate; what matters is that
    // the key's org is still one the user is a member of.
    expect(strategy).toMatch(/hasEffectiveMembership\(user\.organizationMemberships, keyOrgId\)/);
  });

  it('checks membership before minting an MCP OAuth code for an org slug', () => {
    const controller = stripComments(
      readFileSync(join(SRC, 'modules', 'mcp', 'controllers', 'mcp-oauth.controller.ts'), 'utf8'),
    );

    // Client registration is unauthenticated by design, so the
    // authorize step is the only place the org boundary is enforced --
    // and both the GET (which resolves the user itself, because it must
    // redirect to login rather than 401) and the POST have to do it.
    const authorizeCalls = controller.match(/assertMember\([^)]*, organization\.id\)/g) ?? [];
    expect(authorizeCalls.length).toBe(2);
  });

  it('refuses a JSON-RPC post to another organization\'s SSE connection', () => {
    const transport = stripComments(
      readFileSync(join(SRC, 'modules', 'mcp', 'transports', 'sse.transport.ts'), 'utf8'),
    );

    expect(transport).toMatch(/callerOrganizationId/);
    // And the id itself must not be guessable from a sampled generator.
    expect(transport).not.toMatch(/Math\.random\(\)/);
  });

  it('denies a list query from somebody with no role in the organization', () => {
    const policy = stripComments(
      readFileSync(join(SRC, 'common', 'authorization', 'access-policy.service.ts'), 'utf8'),
    );
    const filter = policy.slice(policy.indexOf('async applyListFilter'));

    expect(filter.slice(0, 600)).toMatch(/if \(!orgRole\)/);
  });
});
