import { readFileSync } from 'fs';
import { join } from 'path';
import express from 'express';
import helmet from 'helmet';
import request from 'supertest';
import { CSP_DIRECTIVES } from '../content-security-policy';
import { serveOnLoopback } from '../../../test/http';

/**
 * The all-in-one image serves the SPA from the backend, under the helmet
 * policy. That policy refused the sign-up captcha (and the Google Fonts
 * stylesheet and Sentry), exactly like the nginx one did on production.
 * These parse the header helmet actually sends.
 */
const repo = join(__dirname, '../../../../..');
const widget = readFileSync(join(repo, 'frontend/src/components/auth/captcha-widget.tsx'), 'utf8');
const widgetScripts = [...widget.matchAll(/'(https:\/\/[^']+)'/g)].map((m) => new URL(m[1]));
const indexHtml = readFileSync(join(repo, 'frontend/index.html'), 'utf8');

async function servedCsp(): Promise<Map<string, string[]>> {
  const app = express();
  app.use(helmet({ contentSecurityPolicy: { directives: CSP_DIRECTIVES } }));
  app.get('/', (_req, res) => res.send('<!doctype html>'));
  const server = await serveOnLoopback(app);
  const res = await request(server).get('/');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const header = String(res.headers['content-security-policy'] ?? '');
  const map = new Map<string, string[]>();
  for (const part of header.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) map.set(name, sources);
  }
  return map;
}

const allows = (sources: string[], url: URL) =>
  sources.some((src) => {
    if (!src.startsWith('https://')) return false;
    const host = src.slice('https://'.length);
    return host.startsWith('*.') ? url.hostname.endsWith(host.slice(1)) : url.hostname === host;
  });

describe('backend Content-Security-Policy', () => {
  let csp: Map<string, string[]>;
  beforeAll(async () => {
    csp = await servedCsp();
  });

  it('reads both captcha script URLs from the widget', () => {
    expect(widgetScripts.map((u) => u.hostname).sort()).toEqual(['challenges.cloudflare.com', 'js.hcaptcha.com']);
  });

  it('allows every captcha script and iframe the widget loads', () => {
    for (const url of widgetScripts) {
      expect(allows(csp.get('script-src') ?? [], url)).toBe(true);
      expect(allows(csp.get('frame-src') ?? [], url)).toBe(true);
    }
  });

  it('lists hCaptcha in style-src and connect-src, as hCaptcha documents', () => {
    for (const d of ['style-src', 'connect-src']) {
      expect(csp.get(d)).toEqual(expect.arrayContaining(['https://hcaptcha.com', 'https://*.hcaptcha.com']));
    }
  });

  it('allows the Google Fonts stylesheet and files index.html links', () => {
    expect(indexHtml).toContain('https://fonts.googleapis.com');
    expect(csp.get('style-src')).toContain('https://fonts.googleapis.com');
    expect(allows(csp.get('font-src') ?? [], new URL('https://fonts.gstatic.com/x.woff2')) || (csp.get('font-src') ?? []).includes('https:')).toBe(true);
  });

  it('lets Sentry deliver error reports', () => {
    expect(allows(csp.get('connect-src') ?? [], new URL('https://o1.ingest.de.sentry.io'))).toBe(true);
  });

  it('still refuses inline and eval scripts', () => {
    const script = csp.get('script-src') ?? [];
    expect(script[0]).toBe("'self'");
    for (const unsafe of ["'unsafe-inline'", "'unsafe-eval'", '*', 'https:']) expect(script).not.toContain(unsafe);
  });

  it('is the policy main.ts installs', () => {
    const main = readFileSync(join(__dirname, '../../../main.ts'), 'utf8');
    expect(main).toMatch(/contentSecurityPolicy:\s*\{\s*directives:\s*CSP_DIRECTIVES\s*\}/);
  });
});
