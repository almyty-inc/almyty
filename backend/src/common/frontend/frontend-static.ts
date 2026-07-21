import { existsSync } from 'fs';
import { join } from 'path';
import type { DynamicModule } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';

/**
 * Optional single-image frontend serving.
 *
 * The default deployment ships two images — `almyty/api` (this backend, a
 * pure JSON API) and `almyty/frontend` (nginx serving the built React SPA) —
 * on separate origins. In that split model the backend NEVER serves static
 * files and this whole module stays dormant.
 *
 * The `almyty/almyty` single self-host image bakes the built SPA into the API
 * image and flips `SERVE_FRONTEND=true`. Only then does the backend also
 * serve the React bundle + an SPA fallback, so a self-hoster can run one
 * container (plus external postgres/redis) and get both the API and the UI on
 * one origin.
 *
 * Gating is deliberately conservative: serving turns on ONLY when the env
 * flag is set AND a build actually exists on disk. A misconfigured `api`
 * deployment can therefore never accidentally start shadowing API routes with
 * a missing `index.html`.
 */

/** Directory the built SPA (Vite `dist/`) is expected at. */
export function resolveFrontendDist(): string {
  // The all-in-one image sets FRONTEND_DIST explicitly; the default is a
  // fallback resolved against the working directory (the image WORKDIR, /app)
  // rather than __dirname, so it is stable across the differing dist/ (OSS) and
  // dist-ee/ (EE) build layouts.
  return process.env.FRONTEND_DIST || join(process.cwd(), 'public');
}

/**
 * True when the backend should also serve the frontend. Requires BOTH the
 * `SERVE_FRONTEND` flag to be truthy AND an `index.html` present in the dist
 * dir — so the plain `api` image (flag unset) is completely unaffected, and a
 * set-but-empty dir fails closed to pure-API behavior instead of 500ing every
 * navigation.
 */
export function shouldServeFrontend(dist: string = resolveFrontendDist()): boolean {
  const flag = String(process.env.SERVE_FRONTEND || '').toLowerCase();
  const enabled = flag === 'true' || flag === '1' || flag === 'yes';
  if (!enabled) return false;
  return existsSync(join(dist, 'index.html'));
}

/**
 * API route roots the SPA fallback must never shadow. This backend has NO
 * global prefix — every controller is mounted at the domain root — so the
 * fallback would otherwise be free to answer these with `index.html`. In
 * practice explicit controller routes already win over ServeStaticModule's
 * catch-all, but listing them in `exclude` is the belt-and-suspenders that
 * guarantees a request which does not match a concrete controller method
 * (e.g. a wrong verb) 404s as JSON instead of returning the HTML shell.
 *
 * Patterns use Express 5 / path-to-regexp v8 named-wildcard syntax.
 */
export const API_ROUTE_ROOTS: string[] = [
  'agents',
  'apis',
  'approvals',
  'audit-logs',
  'auth',
  'budgets',
  'channels',
  'credentials',
  'external-agents',
  'files',
  'gateways',
  'health',
  'invites',
  'licensing',
  'llm-providers',
  'mcp',
  'memory',
  'monitoring',
  'notifications',
  'oauth',
  'organizations',
  'promoted-skills',
  'provider-usage',
  'referrals',
  'runners',
  'test-resources',
  'tool-hub',
  'users',
  'v1',
  'versions',
  'workspaces',
  '.well-known',
];

/** `exclude` patterns for ServeStaticModule — the root itself and everything under it. */
export function buildExcludePatterns(): string[] {
  const patterns: string[] = [];
  for (const root of API_ROUTE_ROOTS) {
    patterns.push(`/${root}`);
    patterns.push(`/${root}/{*rest}`);
  }
  return patterns;
}

/**
 * Build the ServeStaticModule import list. Returns `[]` (no static serving)
 * unless serving is enabled — callers spread this into the AppModule imports
 * so the module tree is identical to today when serving is off.
 *
 * Loaded lazily via `require` so `@nestjs/serve-static` is only touched when
 * actually serving; the dependency is present in the image regardless.
 */
export function frontendStaticImports(): DynamicModule[] {
  const dist = resolveFrontendDist();
  if (!shouldServeFrontend(dist)) return [];

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ServeStaticModule } = require('@nestjs/serve-static');
  return [
    ServeStaticModule.forRoot({
      rootPath: dist,
      exclude: buildExcludePatterns(),
    }),
  ];
}

/**
 * Express middleware that serves `index.html` for a bare `GET /` browser
 * navigation. The unified gateway controller registers `@All('/')` (root-level
 * JSON-RPC), which — because controller routes are registered before
 * ServeStaticModule's static middleware — would otherwise shadow `/` and 404
 * the SPA entry point. This middleware runs before Nest routing and only
 * intercepts HTML navigations to `/`, so API clients POSTing JSON-RPC to the
 * root (or requesting JSON) still reach the controller untouched.
 *
 * No-op unless serving is enabled, so wiring it in `main.ts` unconditionally
 * is safe for the `api` image.
 */
export function createSpaRootMiddleware(dist: string = resolveFrontendDist()) {
  if (!shouldServeFrontend(dist)) return null;
  const indexFile = join(dist, 'index.html');
  return (req: Request, res: Response, next: NextFunction): void => {
    if (
      req.method === 'GET' &&
      req.path === '/' &&
      String(req.headers.accept || '').includes('text/html')
    ) {
      res.sendFile(indexFile);
      return;
    }
    next();
  };
}
