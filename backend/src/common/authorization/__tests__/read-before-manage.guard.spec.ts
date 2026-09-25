import * as fs from 'fs';
import * as path from 'path';

/**
 * Read before manage, held in the source.
 *
 * The rule (read-rule.ts): a caller who cannot READ a resource gets the
 * same 404 a missing id gets; only a caller who can read it but not manage
 * it gets a 403. The manage decision used to be made first in each
 * service, so a member outside a team was told "403 not a member of the
 * resource's team" -- confirming the id exists. read-before-manage
 * .integration.spec.ts proves the behaviour against Postgres; this spec
 * keeps the next manage path from being written the old way.
 *
 * 1. Nothing outside read-rule.ts asks AccessPolicyService for a 'manage'
 *    decision. assertManageable is the one place that does, after the
 *    read check.
 * 2. Every manage path below goes through the gate (assertManageable, or
 *    the service's own wrapper around it).
 */
const SRC = path.resolve(__dirname, '../../..');
const ROOTS = [SRC, path.resolve(SRC, '../ee')];

function sourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === 'test' || entry.name === 'migrations') continue;
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

const rel = (file: string) => path.relative(SRC, file);
const read = (file: string) => fs.readFileSync(path.join(SRC, file), 'utf8');

/** The body of `method` in `source`: from its signature to the next member. */
function methodBody(source: string, method: string): string | null {
  const start = source.search(new RegExp(`\\n  (?:private |public |protected )?async ${method}\\(`));
  if (start < 0) return null;
  const rest = source.slice(start + 1);
  const next = rest.slice(1).search(/\n  (?:private |public |protected |async |get |static |\/\*\*|[a-zA-Z]+\()/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

// The gate calls a manage path may use: the helper itself, or a service's
// own one-line wrapper around it (each wrapper is checked below too).
const GATE = /assertManageable\(|this\.checkAgentPermission\(|this\.assertCanManage\(|this\.loadManageable\(/;

const MANAGE_PATHS: Record<string, string[]> = {
  'modules/tools/tools.service.ts': ['updateTool', 'activateTool', 'deactivateTool', 'deleteTool'],
  'modules/agents/agents.service.ts': ['updateAgent', 'deleteAgent', 'activateAgent', 'deactivateAgent', 'saveVersion', 'rollbackToVersion'],
  'modules/apis/apis.service.ts': ['update', 'remove'],
  'modules/credentials/credentials.service.ts': ['update', 'delete'],
  'modules/llm-providers/llm-providers.service.ts': ['updateProvider', 'deleteProvider'],
  'modules/gateways/gateways.service.ts': ['updateGateway', 'activateGateway', 'deactivateGateway', 'deleteGateway', 'findManageable'],
  'modules/runner/runner.service.ts': ['unregister'],
  'modules/approvals/approvals.service.ts': ['decide'],
  'modules/tool-hub/tool-hub.service.ts': ['publishTool'],
};

// The wrappers GATE accepts, each of which must itself be assertManageable.
const WRAPPERS: Array<[string, string]> = [
  ['modules/agents/agents.service.ts', 'checkAgentPermission'],
  ['modules/gateways/gateways.service.ts', 'assertCanManage'],
  ['modules/runner/runner.service.ts', 'loadManageable'],
];

describe('read before manage (source guard)', () => {
  it('asks for a manage decision only in read-rule.ts, after the read check', () => {
    const allowed = new Set(['common/authorization/read-rule.ts', 'common/authorization/access-policy.service.ts']);
    const offenders = ROOTS.flatMap(sourceFiles)
      .filter((file) => !allowed.has(rel(file)))
      .filter((file) => /canAccess\([^)]*'manage'\s*\)/.test(fs.readFileSync(file, 'utf8')))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it.each(Object.entries(MANAGE_PATHS).flatMap(([file, methods]) => methods.map((m) => [file, m] as const)))(
    '%s %s goes through the read-before-manage gate',
    (file, method) => {
      const body = methodBody(read(file), method);
      expect(body).not.toBeNull();
      expect(body).toMatch(GATE);
    },
  );

  it.each(WRAPPERS)('%s %s is assertManageable', (file, method) => {
    const body = methodBody(read(file), method);
    expect(body).not.toBeNull();
    expect(body).toMatch(/assertManageable\(/);
  });

  it('the gate reads before it decides manage', () => {
    const helper = read('common/authorization/read-rule.ts');
    const body = helper.slice(helper.indexOf('export async function assertManageable'));
    expect(body.indexOf('assertReadable(')).toBeGreaterThan(-1);
    expect(body.indexOf('assertReadable(')).toBeLessThan(body.indexOf("'manage'"));
  });
});
