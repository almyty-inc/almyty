import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * The global jest setup used to export mockRepository, mockDataSource,
 * createMockProviders and TestHelper: repository and DataSource doubles
 * whose query builders answered every chained call with `this`
 * (mockReturnThis) and every read with `undefined`. A spec built on them
 * passed whatever SQL the code under test composed. Nothing imported them
 * any more; these keep them from coming back and from being imported.
 */
const SETUP = join(__dirname, '..', 'setup.ts');
const SRC_ROOT = join(__dirname, '..', '..');
const EE_ROOT = join(SRC_ROOT, '..', 'ee');

function sources(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path);
    return path.endsWith('.ts') && path !== SETUP ? [path] : [];
  });
}

describe('global jest setup and shared doubles', () => {
  const source = readFileSync(SETUP, 'utf8');

  it('exports no repository, DataSource or TestingModule doubles', () => {
    expect(source).not.toMatch(/\bexport\s+(const|class|function|let|var)\s+\w+/);
    for (const name of ['mockRepository', 'mockDataSource', 'createMockProviders', 'TestHelper']) {
      expect(source).not.toContain(name);
    }
  });

  it('builds no match-anything chains', () => {
    expect(source).not.toMatch(/mockReturnThis|createQueryBuilder/);
  });

  it('is imported by no source or spec', () => {
    const importsSetup = /(?:from\s+|require\(\s*|import\(\s*)['"`][^'"`]*\/(?:test\/)?setup['"`]/;
    const offenders = [...sources(SRC_ROOT), ...sources(EE_ROOT)]
      .filter((file) => importsSetup.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC_ROOT, file));
    expect(offenders).toEqual([]);
  });
});
