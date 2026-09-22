import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * A service with a lifecycle hook is registered by some module.
 *
 * AgentRunReaperService implemented OnModuleInit, was imported by
 * AgentsModule, and was in no `providers:` array — so its five-minute
 * sweep never started and runs stuck in RUNNING were never timed out.
 * Nothing errored and nothing logged; agent runs simply span forever in
 * the UI. Its own spec passed because it constructs the class directly.
 *
 * That is worse than an unregistered controller, which at least 404s.
 * A lifecycle service that is never constructed is pure silence, so it
 * gets its own guard rather than riding on the controller one.
 */
const ROOT = join(__dirname, '../../..');

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

describe('lifecycle services are registered somewhere', () => {
  const files = walk(ROOT).filter((f) => f.endsWith('.ts') && !/\.(spec|d)\.ts$/.test(f));

  /**
   * The contents of every `providers: [...]` array, read by matching
   * brackets rather than by a regex: these arrays nest objects for
   * factory providers, and a lazy regex stops at the first inner `]`,
   * which reported two dozen registered services as missing.
   */
  function providerArrays(source: string): string[] {
    const out: string[] = [];
    const key = /providers:\s*\[/g;
    let m: RegExpExecArray | null;
    while ((m = key.exec(source))) {
      let depth = 1;
      let i = m.index + m[0].length;
      const start = i;
      while (i < source.length && depth > 0) {
        if (source[i] === '[') depth++;
        else if (source[i] === ']') depth--;
        i++;
      }
      out.push(source.slice(start, i - 1));
    }
    return out;
  }

  const registered = new Set(
    files
      .filter((f) => f.endsWith('.module.ts'))
      .flatMap((f) => providerArrays(stripComments(readFileSync(f, 'utf8'))))
      .flatMap((block) => block.match(/[A-Z]\w+/g) ?? []),
  );

  /** Classes that ask Nest to call them at a lifecycle point. */
  const lifecycle = files.flatMap((file) => {
    const source = stripComments(readFileSync(file, 'utf8'));
    return [...source.matchAll(/export class (\w+)[^{]*implements\s+([^{]+)\{/g)]
      // A @Module class may implement these too; Nest constructs those
      // itself, so they are never in a providers array and are not the
      // bug this guards.
      .filter((m) => /OnModuleInit|OnApplicationBootstrap|OnModuleDestroy/.test(m[2]) && !m[1].endsWith('Module'))
      .map((m) => [file.slice(ROOT.length + 1), m[1]] as const);
  });

  it('finds lifecycle services to check, so an empty sweep cannot pass', () => {
    expect(lifecycle.length).toBeGreaterThan(0);
  });

  it.each(lifecycle)('%s: %s', (_file, name) => {
    // A provider registered via a factory token rather than by class is
    // still named in the array, so this holds for those too.
    expect(registered.has(name)).toBe(true);
  });
});
