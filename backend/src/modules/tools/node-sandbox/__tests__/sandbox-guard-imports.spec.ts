import { builtinModules } from 'module';
import * as fs from 'fs';
import * as path from 'path';

import { SANDBOX_GUARD_SHARED_MODULES, sandboxGuardDependencyPaths } from '../node-sandbox.service';

/**
 * The compiled sandbox worker runs under Node's permission model with
 * read access to its own directory and, file by file, to the shared
 * modules its net guard imports from `common/security`. Anything one of
 * those modules imports in turn would be unreadable in production and
 * break every sandboxed tool at load time -- while passing every test
 * that runs the worker from TypeScript with the whole backend readable.
 * So those modules may import Node built-ins and nothing else.
 */
describe('modules the sandbox net guard shares with the host', () => {
  const securityDir = path.resolve(__dirname, '..', '..', '..', '..', 'common', 'security');

  it.each([...SANDBOX_GUARD_SHARED_MODULES])('%s imports only Node built-ins', (name) => {
    const source = fs.readFileSync(path.join(securityDir, `${name}.ts`), 'utf8');
    const specifiers = [...source.matchAll(/(?:^|\n)\s*import\s+(?:type\s+)?[^'"]*?from\s+['"]([^'"]+)['"]/g)].map(
      (m) => m[1],
    );
    const requires = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    for (const spec of [...specifiers, ...requires]) {
      const bare = spec.startsWith('node:') ? spec.slice(5) : spec;
      expect(builtinModules).toContain(bare);
    }
  });

  it('are exactly the common/security modules the net guard imports', () => {
    const guard = fs.readFileSync(path.resolve(__dirname, '..', 'sandbox-net-guard.ts'), 'utf8');
    const imported = [...guard.matchAll(/from\s+['"]\.\.\/\.\.\/\.\.\/common\/security\/([^'"]+)['"]/g)].map(
      (m) => m[1],
    );
    expect(new Set(imported)).toEqual(new Set(SANDBOX_GUARD_SHARED_MODULES));
  });

  it('are granted by exact file path relative to the compiled worker', () => {
    const worker = path.join('/app', 'dist', 'modules', 'tools', 'node-sandbox', 'sandbox-worker.js');
    expect(sandboxGuardDependencyPaths(worker)).toEqual(
      SANDBOX_GUARD_SHARED_MODULES.map((n) => path.join('/app', 'dist', 'common', 'security', `${n}.js`)),
    );
  });
});
