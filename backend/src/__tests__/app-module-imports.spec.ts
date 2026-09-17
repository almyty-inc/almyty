import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * A module imported into AppModule is actually registered in it.
 *
 * LifecycleModule sat at the top of app.module.ts as an unused import for
 * as long as it existed. Nest therefore never constructed its processor,
 * so every signup enqueued a welcome job that nothing consumed: the jobs
 * accumulated in Redis, no welcome or nudge email was ever sent, and the
 * unsubscribe link in those unsent emails pointed at a route that did not
 * exist. Nothing failed. TypeScript is happy with an unused import, the
 * module's own tests construct it directly, and the only symptom was
 * silence.
 *
 * This is the third variant of one bug found in a week -- the others were
 * a controller in no module and a provider in no providers array -- so it
 * gets the same treatment: check the wiring, not the unit.
 */
describe('AppModule registers what it imports', () => {
  const source = readFileSync(join(__dirname, '../app.module.ts'), 'utf8');

  const importedModules = [...source.matchAll(/^import\s*\{([^}]*)\}\s*from\s*['"]\.\/modules\//gm)]
    .flatMap((m) => m[1].split(','))
    .map((name) => name.trim())
    .filter((name) => name.endsWith('Module'));

  /** The imports array, matched by brackets: it nests forRoot({...}) calls. */
  const importsBlock = (() => {
    const at = source.search(/imports:\s*\[/);
    const start = source.indexOf('[', at) + 1;
    let depth = 1;
    let i = start;
    while (i < source.length && depth > 0) {
      if (source[i] === '[') depth++;
      else if (source[i] === ']') depth--;
      i++;
    }
    return source.slice(start, i - 1);
  })();

  it('finds modules to check, so an empty sweep cannot pass', () => {
    expect(importedModules.length).toBeGreaterThan(20);
  });

  it.each(importedModules.map((m) => [m]))('%s is in the imports array', (name: string) => {
    expect(importsBlock).toContain(name);
  });
});
