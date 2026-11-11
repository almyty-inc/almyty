import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * public/llms.txt (https://llmstxt.org) tells a program or an AI agent how to
 * use almyty: the API, keys, the management MCP server and the CLIs. Every
 * claim in it points somewhere, so these tests hold each pointer to the code:
 * docs links name a real docs page, app links a real route, API addresses a
 * real backend controller, packages a real package. nginx must serve it as
 * the file it is, not as the SPA.
 */
const frontend = resolve(__dirname, '../..');
const repo = resolve(frontend, '..');
const llms = readFileSync(join(frontend, 'public', 'llms.txt'), 'utf8');
const links = [...llms.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => new URL(m[1]));

function files(dir: string, test: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...files(full, test));
    else if (test(name)) out.push(full);
  }
  return out;
}

describe('public/llms.txt', () => {
  it('follows the llms.txt shape: an H1, a blockquote summary, then H2 sections of links', () => {
    expect(llms).toMatch(/^# almyty\n\n> \S/);
    const sections = llms.match(/^## .+$/gm) ?? [];
    expect(sections.length).toBeGreaterThan(3);
    for (const section of llms.split(/^## .+$/m).slice(1)) {
      expect(section).toMatch(/^- \[[^\]]+\]\(https?:\/\/[^)]+\)/m);
    }
  });

  it('tells agents to use API keys, never the session cookie', () => {
    expect(llms).toMatch(/Authorization: Bearer almyty_/);
    expect(llms).toMatch(/Never use .* session cookie/);
  });

  it('links only to docs pages that exist', () => {
    const content = join(repo, 'docs-site', 'content');
    const docs = links.filter((u) => u.host === 'docs.almyty.com');
    expect(docs.length).toBeGreaterThan(10);
    for (const u of docs) {
      const path = u.pathname.replace(/^\/|\/$/g, '');
      if (path === 'llms.txt' || path === 'llms-full.txt') {
        // Generated at build time from the content tree (docs-site/scripts/llms.mjs).
        const pkg = JSON.parse(readFileSync(join(repo, 'docs-site', 'package.json'), 'utf8'));
        expect(pkg.scripts.prebuild, u.href).toContain('scripts/llms.mjs');
        continue;
      }
      const page = path === '' ? join(content, 'index.mdx') : join(content, `${path}.mdx`);
      const index = join(content, path, 'index.mdx');
      expect(existsSync(page) || existsSync(index), `${u.href} has no page under docs-site/content`).toBe(true);
    }
  });

  it('links only to app routes that exist', () => {
    const app = readFileSync(join(frontend, 'src', 'App.tsx'), 'utf8');
    const settings = readFileSync(join(frontend, 'src', 'pages', 'settings.tsx'), 'utf8');
    const routes = [...app.matchAll(/<Route path="([^"]+)"/g)].map((m) => m[1]);
    const absolute = routes.filter((r) => r.startsWith('/'));
    const appLinks = links.filter((u) => u.host === 'app.almyty.com' && u.pathname !== '/llms.txt');
    expect(appLinks.length).toBeGreaterThan(0);
    for (const u of appLinks) {
      const segs = u.pathname.split('/').filter(Boolean);
      const reached = absolute.some((r) => {
        const parts = r.split('/').filter(Boolean);
        const splat = parts[parts.length - 1] === '*';
        const fixed = splat ? parts.slice(0, -1) : parts;
        if (splat ? segs.length <= fixed.length : segs.length !== fixed.length) return false;
        if (!fixed.every((p, i) => p.startsWith(':') || p === segs[i])) return false;
        if (!splat) return true;
        // A splat route renders its own children: the rest must be one of them.
        const rest = segs.slice(fixed.length).join('/');
        return routes.includes(rest) || new RegExp(`key: '${rest}'`).test(settings);
      });
      expect(reached, `${u.href} matches no route in App.tsx`).toBe(true);
    }
  });

  it('names only API paths a backend controller serves', () => {
    const controllers = new Set(
      files(join(repo, 'backend', 'src'), (n) => n.endsWith('.controller.ts')).flatMap((f) =>
        [...readFileSync(f, 'utf8').matchAll(/@Controller\('([^']+)'\)/g)].map((m) => m[1].split('/')[0]),
      ),
    );
    // Full addresses, and the bare paths written in code spans (`/agents`,
    // `GET /auth/api-keys`). `/docs` is the self-hosted Swagger page, mounted
    // in main.ts rather than by a controller.
    const firstSegments = [
      ...llms.matchAll(/https:\/\/api\.almyty\.com\/([a-z0-9-]+)/g),
      ...llms.matchAll(/`(?:(?:GET|POST|PUT|PATCH|DELETE) )?\/([a-z0-9-]+)/g),
    ]
      .map((m) => m[1])
      .filter((seg) => seg !== 'docs' && seg !== 'docs-json');
    expect(firstSegments.length).toBeGreaterThan(10);
    const main = readFileSync(join(repo, 'backend', 'src', 'main.ts'), 'utf8');
    expect(main).toMatch(/SwaggerModule\.setup\('docs'/);
    for (const seg of firstSegments) expect(controllers, `api.almyty.com/${seg}`).toContain(seg);
    // The management MCP server is the system gateway at /<org>/almyty.
    const init = readFileSync(join(repo, 'backend', 'src', 'modules', 'gateways', 'gateway-init.helper.ts'), 'utf8');
    expect(init).toMatch(/isSystem: true, endpoint: '\/almyty'/);
    expect(llms).toContain('https://api.almyty.com/<organization slug>/almyty');
  });

  it('names only packages that exist', () => {
    const names = new Set(
      readdirSync(join(repo, 'packages'))
        .map((d) => join(repo, 'packages', d, 'package.json'))
        .filter((p) => existsSync(p))
        .map((p) => JSON.parse(readFileSync(p, 'utf8')).name),
    );
    const named = [...new Set([...llms.matchAll(/@almyty\/[a-z-]+/g)].map((m) => m[0]))];
    expect(named.length).toBeGreaterThan(5);
    for (const pkg of named) expect(names, pkg).toContain(pkg);
  });

  it('is served by nginx as plain text, never the SPA fallback', () => {
    const conf = readFileSync(join(frontend, 'nginx.conf'), 'utf8');
    const block = /location = \/llms\.txt \{([\s\S]*?)\n\s*\}/.exec(conf);
    expect(block, 'nginx.conf has no exact location for /llms.txt').not.toBeNull();
    expect(block![1]).not.toMatch(/try_files/);
    expect(block![1]).toMatch(/charset utf-8;/);
  });
});
