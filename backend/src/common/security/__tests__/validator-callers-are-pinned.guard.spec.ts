import { readFileSync, readdirSync, statSync } from 'fs';
import { join, sep } from 'path';

/**
 * A file that runs the SSRF string check also has to send the request
 * through a transport that honours it.
 *
 * `validateUrl` / `assertOutboundUrlAllowed` look at the URL's host as a
 * string. Two things walk around a string check, and neither is visible
 * in the string:
 *
 *   - DNS. A public name whose A record answers 169.254.169.254 or
 *     127.0.0.1 passes; the address is only known at connect time. The
 *     pinned transports (`ssrfSafeHttp(s)Agent`, `agentsExempting`,
 *     `ssrfSafeDispatcher`, `dispatcherExempting`) re-check the resolved
 *     address before a socket opens.
 *   - Redirects. axios follows 5 by default and `fetch` follows 20; a
 *     public host that answers 302 with an internal Location takes the
 *     request back inside. `maxRedirects: 0` / `redirect: 'error'|'manual'`
 *     refuse, `pinnedRedirects()` re-validates every hop.
 *
 * The audit that added this found a dozen call sites that ran the check
 * and then used a bare axios or fetch: the agent webhook, the API and
 * credential test-connection buttons, the OAuth token refresh, the MCP
 * peer and MCP source clients, agent-card import, the embedding call, the
 * connector probes, the S3 registry client, and gRPC tools. Every one of
 * them had a comment saying it was SSRF-guarded.
 *
 * So this reads the source, like every-tenant-url-is-gated.spec.ts: a
 * behavioural test passes for an unpinned call site the moment somebody
 * writes a new one. For each file under src/ that calls the string gate,
 * every request it makes must show BOTH a DNS pin and a redirect policy,
 * in the call's own arguments or in the object literal it passes by name.
 * Exceptions are listed below with the reason, and match one call each.
 */
const SRC = join(__dirname, '..', '..', '..');

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function productionFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (['node_modules', '__tests__', 'test'].includes(name)) continue;
      productionFiles(p, out);
    } else if (name.endsWith('.ts') && !name.includes('.spec.')) {
      out.push(p);
    }
  }
  return out;
}

/** What proves the connection is pinned to a checked address. */
const PINS_DNS = /ssrfSafeHttpsAgent|ssrfSafeDispatcher|agentsExempting\(|dispatcherExempting\(|pinnedRedirects\(|pinDns: true/;
/**
 * What proves a 3xx cannot take the request somewhere unchecked. The AWS
 * SDK's NodeHttpHandler (`requestHandler: { httpAgent, httpsAgent }`) and
 * gRPC never follow an HTTP redirect, so their pin is the whole story.
 */
const LIMITS_REDIRECTS = /maxRedirects: 0|pinnedRedirects\(|redirect: '(error|manual)'|pinDns: true|requestHandler: \{ httpAgent: ssrfSafeHttpAgent/;

/** A string gate call, not the import of one. */
const CALLS_THE_GATE = /\b(validateUrl|validateUrlAllowingPrivate|assertOutboundUrlAllowed)\(/;

/**
 * Transports this guard recognises. `fetch(` is word-bounded, so
 * `safeFetch(` (pinned and redirect-refusing by construction) is not one.
 */
const TRANSPORT = new RegExp(
  [
    String.raw`\baxios(?:\.(?:get|post|put|patch|delete|head|request))?\(`,
    String.raw`\bfetch\(`,
    String.raw`\bnew (?:sdk\.)?S3Client\(`,
    String.raw`\.grpcCaller\.call\(`,
  ].join('|'),
  'g',
);

/**
 * Calls on an injected / created client (`this.http.get(...)`). Their
 * transport is defined once in the same file -- `axios.create({...})` or a
 * default fetch factory -- and those definitions are checked as transports
 * themselves; an instance call is accepted only when such a definition
 * exists and passes.
 */
const INSTANCE_CALL = /\bthis\.http(?:\.(?:get|post|put|patch|delete))?\(/g;
const INSTANCE_DEFINITION = /\baxios\.create\(|\bfetch\(/;

/** A vendor endpoint whose origin is a literal: nothing tenant-written picks the host. */
const CONSTANT_ORIGIN = /^\s*['`]https:\/\/[a-z0-9.-]+\//i;

/**
 * Justified exceptions: [file, a pattern matching the call's text, why].
 * Each must still match a call -- a stale entry fails the last test.
 */
const ALLOWED: Array<[string, RegExp, string]> = [
  [
    'modules/llm-providers/providers/safe-request.ts',
    /gatedConfig\(config, opts\)/,
    'gatedConfig() builds the transport from LLM_HTTP_DEFAULTS (maxRedirects: 0 + pinned agents, or agentsExempting for the one approved host) and re-applies it over the caller config; ollama-ssrf.spec and egress-approved-host.spec prove it behaviourally',
  ],
];

/** The text between the call's parentheses, skipping string contents. */
function callArgs(src: string, openParen: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openParen; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return src.slice(openParen + 1, i);
  }
  return src.slice(openParen + 1);
}

/** The object literal assigned to `name` in this file, if any. */
function literalFor(src: string, name: string): string {
  const decl = new RegExp(String.raw`\b(?:const|let|var)\s+${name}\b[^=;]*=\s*\{`).exec(src);
  if (!decl) return '';
  const open = decl.index + decl[0].length - 1;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return '';
}

/** The call's arguments plus any literal it passes by bare name. */
function evidenceFor(src: string, args: string): string {
  const names = args
    .split(',')
    .map((a) => a.trim())
    .filter((a) => /^[A-Za-z_$][\w$]*$/.test(a));
  return [args, ...names.map((n) => literalFor(src, n))].join('\n');
}

interface Site {
  file: string;
  line: number;
  call: string;
  args: string;
  ok: boolean;
}

function scan(): { sites: Site[]; offenders: string[]; allowUsed: Set<number> } {
  const sites: Site[] = [];
  const offenders: string[] = [];
  const allowUsed = new Set<number>();

  for (const path of productionFiles(SRC)) {
    const rel = path.slice(SRC.length + 1).split(sep).join('/');
    if (rel.startsWith('common/security/')) continue; // the gate itself
    const src = stripComments(readFileSync(path, 'utf8'));
    if (!CALLS_THE_GATE.test(src)) continue;

    const lineOf = (i: number) => src.slice(0, i).split('\n').length;
    let definitionsPass = true;
    let definitions = 0;

    for (const m of src.matchAll(TRANSPORT)) {
      const open = m.index! + m[0].length - 1;
      const args = callArgs(src, open);
      const evidence = evidenceFor(src, args);
      const constant = /fetch\($|axios/.test(m[0]) && CONSTANT_ORIGIN.test(args);
      let ok = constant || (PINS_DNS.test(evidence) && LIMITS_REDIRECTS.test(evidence));
      if (!ok) {
        const idx = ALLOWED.findIndex(([f, pattern]) => f === rel && pattern.test(`(${args})`));
        if (idx >= 0) {
          allowUsed.add(idx);
          ok = true;
        }
      }
      sites.push({ file: rel, line: lineOf(m.index!), call: m[0], args, ok });
      if (!ok) offenders.push(`${rel}:${lineOf(m.index!)} ${m[0]}...`);
    }

    // The client definitions behind `this.http...(` calls.
    const defs = new RegExp(INSTANCE_DEFINITION.source, 'g');
    for (const m of src.matchAll(defs)) {
      definitions++;
      const evidence = evidenceFor(src, callArgs(src, m.index! + m[0].length - 1));
      if (!(PINS_DNS.test(evidence) && LIMITS_REDIRECTS.test(evidence))) definitionsPass = false;
    }
    for (const m of src.matchAll(INSTANCE_CALL)) {
      const ok = definitions > 0 && definitionsPass;
      sites.push({ file: rel, line: lineOf(m.index!), call: m[0], args: '', ok });
      if (!ok) offenders.push(`${rel}:${lineOf(m.index!)} ${m[0]}... (client not defined pinned in this file)`);
    }
  }
  return { sites, offenders, allowUsed };
}

describe('every caller of the SSRF string gate sends through a pinned, redirect-safe transport', () => {
  const { sites, offenders, allowUsed } = scan();

  it('no request after a validateUrl / assertOutboundUrlAllowed check goes out unpinned or redirect-following', () => {
    expect(offenders).toEqual([]);
  });

  it('actually finds the call sites, so it cannot pass by reading nothing', () => {
    const files = new Set(sites.map((s) => s.file));
    // A sample across every transport kind the guard recognises.
    for (const f of [
      'modules/agents/agent-webhook.service.ts',
      'modules/a2a/external-agents.service.ts',
      'modules/apis/credential.service.ts',
      'modules/credentials/oauth2.service.ts',
      'modules/mcp-sources/mcp-client.service.ts',
      'modules/connections/connection-validation.service.ts',
      'modules/model-registry/model-registry.service.ts',
      'modules/tools/executors/tool-grpc.executor.ts',
      'modules/model-deployments/adapters/ollama.adapter.ts',
    ]) {
      expect(files).toContain(f);
    }
    expect(sites.length).toBeGreaterThanOrEqual(30);
  });

  it('every allowlist entry still matches a call site', () => {
    const stale = ALLOWED.filter((_, i) => !allowUsed.has(i)).map(([f, p]) => `${f} ${p}`);
    expect(stale).toEqual([]);
  });

  /**
   * The guard's own red-check: the shapes the audit found must be flagged.
   * Run against snippets so a later rewrite of the matcher cannot quietly
   * stop recognising them.
   */
  it.each([
    ['bare axios.get', `axios.get(url, { timeout: 10_000 })`],
    ['redirects refused but DNS unpinned', `axios.post(url, body, { maxRedirects: 0 })`],
    ['pinned but following redirects', `axios.get(url, { httpAgent: ssrfSafeHttpAgent, httpsAgent: ssrfSafeHttpsAgent })`],
    ['fetch with redirect manual and no dispatcher', `fetch(tokenUrl, { method: 'POST', redirect: 'manual' })`],
  ])('flags %s', (_label, snippet) => {
    const open = snippet.indexOf('(');
    const evidence = evidenceFor(snippet, callArgs(snippet, open));
    expect(PINS_DNS.test(evidence) && LIMITS_REDIRECTS.test(evidence)).toBe(false);
  });

  it('accepts a config passed by name when the literal carries both', () => {
    const src = `const config = { maxRedirects: 0, httpAgent: ssrfSafeHttpAgent, httpsAgent: ssrfSafeHttpsAgent };\naxios(config);`;
    const open = src.indexOf('axios(') + 'axios'.length;
    const evidence = evidenceFor(src, callArgs(src, open));
    expect(PINS_DNS.test(evidence) && LIMITS_REDIRECTS.test(evidence)).toBe(true);
  });
});
