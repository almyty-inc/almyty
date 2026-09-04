import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * nginx add_header is not inherited by a block that declares its own
 * add_header, so the security headers must be re-included wherever a
 * location (or nested `if`) sets Cache-Control / CORS / Content-Type.
 * This test walks the config and fails the moment a block sets an
 * add_header without also pulling in the shared include.
 */
const root = resolve(__dirname, '../..');
const conf = readFileSync(resolve(root, 'nginx.conf'), 'utf8');
const inc = readFileSync(resolve(root, 'nginx-security-headers.inc'), 'utf8');
const dockerfile = readFileSync(resolve(root, 'Dockerfile'), 'utf8');

const INCLUDE = 'include /etc/nginx/conf.d/security-headers.inc;';

/** Split nginx config into { header, body } blocks by brace matching. */
function blocks(src: string): Array<{ header: string; body: string }> {
  const out: Array<{ header: string; body: string }> = [];
  const lines = src.split('\n');
  const stack: Array<{ header: string; lines: string[] }> = [];
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '');
    if (/\{\s*$/.test(line)) {
      stack.push({ header: line.trim().replace(/\{\s*$/, '').trim(), lines: [] });
      continue;
    }
    if (/^\s*\}\s*$/.test(line)) {
      const done = stack.pop();
      if (done) out.push({ header: done.header, body: done.lines.join('\n') });
      continue;
    }
    if (stack.length) stack[stack.length - 1].lines.push(line);
  }
  return out;
}

describe('frontend nginx.conf security headers', () => {
  const all = blocks(conf);

  it('ships the include file into the image', () => {
    expect(dockerfile).toContain('COPY nginx-security-headers.inc /etc/nginx/conf.d/security-headers.inc');
  });

  it('applies the include at server level', () => {
    const server = all.find((b) => b.header.startsWith('server'));
    expect(server?.body).toContain(INCLUDE);
  });

  it('re-applies the include in every block that sets its own add_header', () => {
    const offenders = all
      .filter((b) => /^\s*add_header\b/m.test(b.body))
      .filter((b) => !b.body.includes(INCLUDE))
      .map((b) => b.header);
    expect(offenders).toEqual([]);
  });

  it('keeps the essential headers in the include', () => {
    for (const h of ['X-Frame-Options', 'X-Content-Type-Options', 'Referrer-Policy', 'Content-Security-Policy']) {
      expect(inc).toMatch(new RegExp(`add_header ${h} .* always;`));
    }
    expect(inc).toMatch(/frame-ancestors 'self'/);
  });
});
