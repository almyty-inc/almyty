import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * The spec's isolation rule, enforced as a test: an adapter may not
 * import or invoke another adapter. Each one talks to its provider and
 * to the frozen interface, nothing else in this directory.
 */
describe('adapter isolation', () => {
  const dir = join(__dirname, '..', 'adapters');
  const files = readdirSync(dir).filter((f) => f.endsWith('.adapter.ts'));

  it('finds the adapters', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s imports no other adapter', (file) => {
    const source = readFileSync(join(dir, file), 'utf8');
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    const offenders = imports.filter((p) => /\.adapter(\.ts)?$/.test(p) || /adapters\/(?!adapter\.interface)/.test(p));
    expect(offenders).toEqual([]);
  });
});
