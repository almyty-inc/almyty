import * as fs from 'fs';
import * as path from 'path';
import { GUARDS_METADATA, METHOD_METADATA } from '@nestjs/common/constants';

import { allControllerRoutes, routesOfSource } from '../../../../test/controller-routes';
import { coverageMarkdown, coverageRows, GENERATED_END, GENERATED_START, withGeneratedSection } from '../../../../test/mcp-coverage-report';
import {
  CURATED_AUTHORIZATION,
  CURATED_PARAMS,
  CURATED_TOOL_ROUTES,
  EXCLUDED_ROUTES,
  HELD_ROUTES,
  OPERATIONS,
} from '../management-operations';
import { CURATED_CONTROLLER_NAMES, curatedControllerClass } from '../curated-controllers';

/**
 * Every controller route is accounted for by the management MCP: a
 * dedicated tool covers it, it is an operation, it is excluded with a
 * reason, or it is held for a product decision. A route added to a
 * controller without one of those fails here, so the MCP cannot fall
 * behind the dashboard without someone saying why.
 *
 * Read from the controllers' source (controller-routes.ts), so a new
 * controller is covered the day it lands, EE controllers included.
 */
const routes = allControllerRoutes();
const refs = new Set(routes.map((r) => r.ref));
const BACKEND = path.join(__dirname, '..', '..', '..', '..', '..');
const DOC = path.join(BACKEND, '..', 'docs', 'design', 'almyty-mcp-coverage.md');

const mapped = (): Map<string, string[]> => {
  const where = new Map<string, string[]>();
  const add = (ref: string, what: string) => where.set(ref, [...(where.get(ref) ?? []), what]);
  for (const [tool, list] of Object.entries(CURATED_TOOL_ROUTES)) for (const ref of list) add(ref, `tool ${tool}`);
  for (const op of OPERATIONS) add(op.route, `operation ${op.name}`);
  for (const ref of Object.keys(EXCLUDED_ROUTES)) add(ref, 'excluded');
  for (const ref of Object.keys(HELD_ROUTES)) add(ref, 'held');
  return where;
};

describe('management MCP coverage', () => {
  it('reads the routes it guards', () => {
    expect(routes.length).toBeGreaterThan(400);
    // The parser: a DTO class after the controller is not a controller,
    // and a handler with two verbs is one route.
    const source = [
      "@Controller('things')",
      'export class ThingsController {',
      "  @Post('a')",
      "  @Post('b')",
      '  async make(@Body() dto: X) {}',
      "  @Get(':id')",
      '  @Roles(\'member\')',
      '  get() {}',
      '}',
      'class X { @IsString() name: string; }',
    ].join('\n');
    expect(routesOfSource(source).map((r) => `${r.ref} ${r.method} ${r.path}`)).toEqual([
      'ThingsController.make POST /things/a',
      'ThingsController.get GET /things/:id',
    ]);
  });

  it('accounts for every controller route', () => {
    const where = mapped();
    const unmapped = routes.filter((r) => !where.has(r.ref)).map((r) => `${r.ref} (${r.method} ${r.path}, ${r.file})`);
    // A new route needs a curated tool, an OPERATIONS entry, an
    // EXCLUDED_ROUTES reason or a HELD_ROUTES question in
    // src/modules/mcp/management/management-operations.ts; then run
    // `npm run mcp:coverage`.
    expect(unmapped).toEqual([]);
  });

  it('maps no route that does not exist', () => {
    const unknown = [...mapped().keys()].filter((ref) => !refs.has(ref));
    expect(unknown).toEqual([]);
  });

  it('puts every route in exactly one place (a route may serve several curated tools)', () => {
    const conflicts = [...mapped().entries()]
      .filter(([, where]) => {
        const kinds = new Set(where.map((w) => w.split(' ')[0]));
        return kinds.size > 1 || where.filter((w) => !w.startsWith('tool')).length > 1;
      })
      .map(([ref, where]) => `${ref}: ${where.join(', ')}`);
    expect(conflicts).toEqual([]);
  });

  it('names operations resource.action, once each', () => {
    const names = OPERATIONS.map((op) => op.name);
    expect(names.filter((n) => !/^[a-z][a-z_]*\.[a-z][a-z_]*$/.test(n))).toEqual([]);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
  });

  it('gives every exclusion a reason and every held route its question', () => {
    expect(Object.entries(EXCLUDED_ROUTES).filter(([, reason]) => reason.trim().length < 30)).toEqual([]);
    expect(Object.entries(HELD_ROUTES).filter(([, q]) => !q.includes('?'))).toEqual([]);
  });

  it('only makes operations of routes a signed-in user reaches through JwtAuthGuard', () => {
    // Source-level, so EE controllers are checked without loading them:
    // the controller file must use JwtAuthGuard. The invoker refuses at
    // run time a route whose guards do not include it.
    const files = new Map(routes.map((r) => [r.ref, r.file]));
    const missing = OPERATIONS.filter((op) => {
      const file = files.get(op.route);
      return !file || !fs.readFileSync(path.join(BACKEND, file), 'utf8').includes('JwtAuthGuard');
    }).map((op) => op.route);
    expect(missing).toEqual([]);
  });

  it('can load every controller a curated tool mirrors, with the handler and a route', () => {
    const controllers = new Set(Object.values(CURATED_TOOL_ROUTES).flat().map((ref) => ref.split('.')[0]));
    expect([...controllers].filter((c) => !CURATED_CONTROLLER_NAMES.includes(c))).toEqual([]);
    for (const ref of Object.values(CURATED_TOOL_ROUTES).flat()) {
      const [name, handler] = ref.split('.');
      const cls = curatedControllerClass(name)!;
      expect(cls?.name).toBe(name);
      const fn = cls.prototype[handler];
      expect(typeof fn).toBe('function');
      expect(Reflect.getMetadata(METHOD_METADATA, fn)).toBeDefined();
      const guards = [...(Reflect.getMetadata(GUARDS_METADATA, cls) ?? []), ...(Reflect.getMetadata(GUARDS_METADATA, fn) ?? [])];
      expect(guards.map((g: any) => g.name)).toContain('JwtAuthGuard');
    }
  });

  it('authorizes every curated tool against a route it mirrors', () => {
    for (const [tool, pick] of Object.entries(CURATED_AUTHORIZATION)) {
      for (const args of [{}, { report: 'alerts' }, { decision: 'reject' }]) {
        expect(CURATED_TOOL_ROUTES[tool]).toContain(pick(args));
      }
    }
    expect(Object.keys(CURATED_PARAMS).filter((tool) => !CURATED_TOOL_ROUTES[tool]?.length)).toEqual([]);
  });

  it('keeps docs/design/almyty-mcp-coverage.md in step with the code', () => {
    const doc = fs.readFileSync(DOC, 'utf8');
    expect(doc).toContain(GENERATED_START);
    expect(doc).toContain(GENERATED_END);
    // Stale: run `npm run mcp:coverage` in backend/.
    expect(withGeneratedSection(doc, coverageMarkdown(routes))).toBe(doc);
  });

  it('has nothing unmapped in the matrix', () => {
    expect(coverageRows(routes).filter((r) => r.status === 'unmapped')).toEqual([]);
  });
});
