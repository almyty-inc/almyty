import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Every controller in the codebase is registered in some module.
 *
 * A controller that exists, compiles and passes its own spec still serves
 * nothing if no module lists it — and a spec that builds its own
 * Test.createTestingModule cannot tell the difference, which is precisely
 * how /v1/messages came to be documented and unroutable while its tests
 * were green.
 *
 * Any module counts, not the neighbouring one: a controller file may sit
 * beside its feature and be registered by the module that owns the route,
 * which is how promoted-skill-replay is wired and is perfectly fine.
 *
 * Checked over source rather than by booting the app, so it is cheap
 * enough to run every time and fails on the file rather than on a 404
 * somewhere downstream.
 */
const SRC = join(__dirname, '../../..');

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

describe('controllers are registered somewhere', () => {
  const files = walk(SRC);
  // Only what is inside a `controllers: [...]` array. Scanning whole
  // module files passes on the import line alone, which is a guard that
  // cannot fail for the reason it exists -- caught by reverting to red.
  const registered = new Set(
    files
      .filter((f) => f.endsWith('.module.ts'))
      // Comments are stripped first: a module that explains its
      // controller ordering in the array otherwise glues the note to the
      // name and the entry never matches.
      .flatMap((f) => [...stripComments(readFileSync(f, 'utf8')).matchAll(/controllers:\s*\[([^\]]*)\]/g)])
      .flatMap((m) => m[1].split(',').map((name) => name.trim()))
      .filter(Boolean),
  );

  /** Classes carrying the @Controller decorator, which is what makes a route. */
  const controllers = files
    .filter((f) => f.endsWith('.controller.ts'))
    .flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      const names = [...source.matchAll(/@Controller\([^)]*\)[\s\S]{0,400}?export class (\w+)/g)].map((m) => m[1]);
      return names.map((name) => [file.slice(SRC.length + 1), name] as const);
    });

  it('finds controllers to check, so an empty sweep cannot pass', () => {
    expect(controllers.length).toBeGreaterThan(20);
  });

  it.each(controllers)('%s: %s', (_file, name) => {
    expect([...registered]).toContain(name);
  });
});
