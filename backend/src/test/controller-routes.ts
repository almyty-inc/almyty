import * as fs from 'fs';
import * as path from 'path';

/**
 * Every HTTP route the backend declares, read from the controllers'
 * source: `ControllerClass.handler`, its method and its full path.
 *
 * Read from the source rather than from Nest's route metadata so a spec
 * can list the routes of a controller without booting its module, and so
 * the EE controllers (ee/modules) are listed by the same code. Used by the
 * management MCP coverage guard (mcp/management/__tests__) and by
 * `scripts/mcp-coverage.ts`, which writes docs/design/almyty-mcp-coverage.md.
 */
export interface ControllerRoute {
  /** `ControllerClass.handler`, the key the coverage tables use. */
  ref: string;
  controller: string;
  handler: string;
  method: string;
  /** Controller prefix + route path, with a leading slash. */
  path: string;
  /** Path relative to the backend root. */
  file: string;
}

const BACKEND_ROOT = path.join(__dirname, '..', '..');
const ROOTS = [path.join(BACKEND_ROOT, 'src', 'modules'), path.join(BACKEND_ROOT, 'ee', 'modules')];
const VERB = /^\s*@(Get|Post|Put|Patch|Delete|All)\(\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)?\s*\)/;
const CONTROLLER = /@Controller\(\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)?\s*\)/;
const CLASS = /^(?:export\s+)?class\s+(\w+)/;
const HANDLER = /^\s*(?:public\s+|private\s+|protected\s+)?(?:async\s+)?(\w+)\s*(?:<[^>]*>)?\s*\(/;
const NOT_A_HANDLER = new Set(['if', 'for', 'while', 'switch', 'return', 'catch']);

export function controllerFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '__tests__') controllerFiles(p, out);
    } else if (entry.name.endsWith('.controller.ts')) {
      out.push(p);
    }
  }
  return out;
}

function join(prefix: string, sub: string): string {
  const parts = [prefix, sub].map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean);
  return '/' + parts.join('/');
}

/** The routes one controller source declares, in declaration order. */
export function routesOfSource(source: string, file = ''): ControllerRoute[] {
  const routes: ControllerRoute[] = [];
  let prefix: string | null = null;
  let controller: string | null = null;
  let pendingController = false;
  let pendingVerb: { method: string; path: string } | null = null;
  for (const line of source.split('\n')) {
    const c = line.match(CONTROLLER);
    if (c) {
      prefix = c[1] ?? c[2] ?? c[3] ?? '';
      pendingController = true;
      continue;
    }
    const k = line.match(CLASS);
    if (k) {
      // A DTO class declared in the same file is not the controller.
      controller = pendingController ? k[1] : null;
      pendingController = false;
      continue;
    }
    if (!controller || prefix === null) continue;
    const v = line.match(VERB);
    if (v) {
      // A handler with two verbs is one route; it is listed by the first.
      pendingVerb ??= { method: v[1].toUpperCase(), path: v[2] ?? v[3] ?? v[4] ?? '' };
      continue;
    }
    if (!pendingVerb || /^\s*@/.test(line) || /^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    const h = line.match(HANDLER);
    if (h && !NOT_A_HANDLER.has(h[1])) {
      routes.push({
        ref: `${controller}.${h[1]}`,
        controller,
        handler: h[1],
        method: pendingVerb.method,
        path: join(prefix, pendingVerb.path),
        file,
      });
      pendingVerb = null;
    }
  }
  return routes;
}

/** Every route of every controller under src/modules and ee/modules. */
export function allControllerRoutes(): ControllerRoute[] {
  return ROOTS.flatMap((root) => controllerFiles(root))
    .sort()
    .flatMap((file) => routesOfSource(fs.readFileSync(file, 'utf8'), path.relative(BACKEND_ROOT, file)));
}
