import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * Every secret read names who it is for.
 *
 * CredentialRefResolver applies the private and team rules at resolve time
 * (team only is team only), so the answer depends on the principal the
 * call acts as: a user, a run's ExecutionPrincipal (a gateway run keeps its
 * gateway's scope), or nobody. A call site that leaves the principal out
 * resolves as nobody -- or, before the rule, resolved a team row for
 * anyone. `ResolveOptions.principal` is required by type; this
 * source-reading guard also fails when:
 *   - a resolve/tryResolve/assertScope call site does not name a principal
 *     in its arguments (the one file that builds its options first is
 *     listed below, with the reason);
 *   - a new site resolves explicitly for nobody (`principal: null`) without
 *     being added to NO_PRINCIPAL_SITES with the reason it has no principal;
 *   - an agent run's model call passes the run row's user instead of the
 *     run's principal.
 */
const SRC = join(__dirname, '..', '..', '..');
const ROOTS = [SRC, join(SRC, '..', 'ee')];

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function productionFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === 'node_modules' || name === '__tests__' || name === 'test' || name === 'migrations') continue;
        walk(full);
      } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts') && !name.endsWith('.d.ts')) {
        out.push(full);
      }
    }
  };
  ROOTS.forEach(walk);
  return out;
}

/** The text between a call's parentheses, starting at the index of its `(`. */
function argsAt(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')' && --depth === 0) return source.slice(open + 1, i);
  }
  return source.slice(open + 1);
}

const rel = (file: string) => relative(SRC, file).split('\\').join('/');

/** Calls on a CredentialRefResolver, whatever the field is called. */
const RESOLVE_CALL = /\b(?:credentialRefs|refs|resolver)\s*\??\s*\.\s*(resolve|tryResolve|assertScope)\s*\(/g;

/** Files that pass an options object built a few lines up; the object names the principal. */
const OPTIONS_BUILT_FIRST: Record<string, string> = {
  'modules/llm-providers/llm-provider-secrets.helper.ts':
    'withResolvedSecrets builds `{ principal, systemFor, context }` once for both keys of a provider',
};

/**
 * Sites that resolve for nobody, on purpose. Each reaches only organization
 * rows plus the rows its own consumer manages (the resolver lets a managed
 * row's consumer through); a shared team or private row is refused.
 */
const NO_PRINCIPAL_SITES: Record<string, string> = {
  'modules/gateways/channels/channel-installation.service.ts':
    'an inbound platform event for a multi-workspace install acts for nobody; the row is the installation\'s own managed token',
};

interface Site {
  file: string;
  method: string;
  args: string;
}

function resolveSites(): Site[] {
  const sites: Site[] = [];
  for (const file of productionFiles()) {
    const raw = readFileSync(file, 'utf8');
    if (!raw.includes('credential-ref.resolver') && !raw.includes('CredentialRefResolver')) continue;
    if (rel(file) === 'modules/credentials/credential-ref.resolver.ts') continue;
    const source = stripComments(raw);
    for (const match of source.matchAll(RESOLVE_CALL)) {
      const open = (match.index ?? 0) + match[0].length - 1;
      sites.push({ file: rel(file), method: match[1], args: argsAt(source, open) });
    }
  }
  return sites;
}

describe('credential resolves name a principal', () => {
  const sites = resolveSites();

  it('finds the resolve call sites (the scan itself works)', () => {
    const files = new Set(sites.map((s) => s.file));
    for (const known of [
      'modules/tools/services/tool-auth.service.ts',
      'modules/mcp-sources/mcp-sources.service.ts',
      'modules/model-catalog/routing/model-router.service.ts',
      'modules/gateways/channels/channel-credential.service.ts',
      'modules/memory/canonical/backend-credentials.resolver.ts',
    ]) {
      expect(files).toContain(known);
    }
    expect(sites.length).toBeGreaterThanOrEqual(15);
  });

  it('every resolve, tryResolve and assertScope call names who it acts for', () => {
    const missing = sites
      .filter((s) => !/\bprincipal\b/.test(s.args) && !OPTIONS_BUILT_FIRST[s.file])
      .map((s) => `${s.file}: ${s.method}(${s.args.replace(/\s+/g, ' ').slice(0, 120)})`);
    expect(missing).toEqual([]);
  });

  it('a site that resolves for nobody is one of the known, reasoned ones', () => {
    const forNobody = [...new Set(sites.filter((s) => /\bprincipal:\s*null\b/.test(s.args)).map((s) => s.file))].sort();
    expect(forNobody).toEqual(Object.keys(NO_PRINCIPAL_SITES).sort());
  });
});

describe("an agent run's model calls act as the run's principal", () => {
  // chat/chatStream reach providers, keys and tools; runPanel and compact
  // make model calls of their own. Each takes who the call acts as; a run
  // passes principalOfRun(run), never the run row's user (null for a
  // gateway run, which then reached nothing its gateway's team owns).
  const CALL = /\.(chat|chatStream|runPanel|compact)\s*\(/g;

  it('no call in the agents module passes run.userId as who a model call acts for', () => {
    const offenders: string[] = [];
    for (const file of productionFiles().filter((f) => rel(f).startsWith('modules/agents/'))) {
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const match of source.matchAll(CALL)) {
        const args = argsAt(source, (match.index ?? 0) + match[0].length - 1);
        if (/\brun\.userId\b/.test(args)) offenders.push(`${rel(file)}: .${match[1]}(...run.userId...)`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
