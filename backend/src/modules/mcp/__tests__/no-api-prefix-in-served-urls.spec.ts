import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * No URL the server hands out may carry an `/api` prefix.
 *
 * `BASE_URL` is the api host (`https://api.almyty.com`), and that host's
 * ingress routes `/` straight through to this service with no rewrite
 * (`k8s/base/ingress.yaml`). The hosts that DO use an `/api` prefix --
 * `*.almyty.app` and the vite dev proxy -- strip it before the request
 * reaches Express. So `/api` is never part of a path this service serves,
 * in either direction: an absolute URL built with it 404s on the api host,
 * and a relative one 404s everywhere.
 *
 * This had been got wrong independently in six places -- the MCP discovery
 * document, the WebSocket info payload, the persisted virtual-server
 * endpoint, and four generated CLI snippets handed to users to paste into
 * a terminal. Each one compiled, and none of them is exercised by a test
 * that actually resolves the URL, which is why they all survived.
 */
const SRC = join(__dirname, '..', '..');
// A third party's own URL is not ours to reshape -- openrouter.ai/api/v1
// really is spelled that way. Only a path we serve counts, so an absolute
// URL to some other host is skipped.
const OFFENDER = /["'`][^"'`]*\/api\/(mcp|utcp|a2a|agents|gateways)\b/;
const THIRD_PARTY = /https?:\/\/(?!\$\{)/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'migrations') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') && !full.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

describe('the server never hands out a URL with an /api prefix', () => {
  it('no source file builds one', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const trimmed = line.trimStart();
        // Comments explaining the rule necessarily quote the wrong form.
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
        if (OFFENDER.test(line) && !THIRD_PARTY.test(line)) {
          offenders.push(`${relative(SRC, file)}:${i + 1}: ${trimmed}`);
        }
      });
    }
    // Jest's expect takes no message argument, so the offending lines go in
    // the compared value itself -- a failure then names the file and line
    // rather than only saying an array was not empty.
    expect(offenders.join('\n')).toBe('');
  });
});