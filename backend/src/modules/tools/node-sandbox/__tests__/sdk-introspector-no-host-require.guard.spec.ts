import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SdkIntrospectorService } from '../sdk-introspector.service';

/**
 * `SdkIntrospectorService.introspect()` used to fall back to
 * `require(<basePath>/node_modules/<packageName>)` when a package shipped
 * no type declarations. That require runs in the BACKEND process, not in
 * the sandbox worker: whatever the package's entry file does -- read
 * process.env, open sockets, spawn processes -- it does with the full
 * privileges of the API server. The package name and the install dir are
 * both user-controlled (a tool's `dependencies`), so the day anything
 * called `introspect()` on a user's package it would have been remote
 * code execution on the host.
 *
 * Nothing outside its own spec calls it today, which is the only reason
 * it was not exploitable. These tests pin both halves: the method never
 * loads package code, and no production file starts calling it.
 */
const SRC = path.join(__dirname, '..', '..', '..', '..');
const BACKEND = path.join(SRC, '..');

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const isSpec = (f: string) =>
  f.endsWith('.spec.ts') ||
  f.includes(`${path.sep}__tests__${path.sep}`) ||
  f.includes(`${path.sep}test${path.sep}`);

describe('SDK introspection never loads package code in the host process', () => {
  const introspectorFiles = fs
    .readdirSync(path.join(__dirname, '..'))
    .filter((f) => f.startsWith('sdk-introspector') && f.endsWith('.ts'))
    .map((f) => path.join(__dirname, '..', f));

  it('finds the introspector sources it is guarding', () => {
    expect(introspectorFiles.length).toBeGreaterThan(0);
  });

  it.each(introspectorFiles.map((f) => [path.basename(f), f]))(
    '%s has no require()/import() of a computed specifier',
    (_name, file) => {
      // Comments are stripped first: the files explain, in prose, why
      // the require is gone, and prose is not a call.
      const src = fs
        .readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      // A require or dynamic import whose argument is anything but a
      // single plain string literal.
      const dynamicRequire = /\brequire\s*\(\s*(?!['"][^'"`$]*['"]\s*\))/;
      const dynamicImport = /\bimport\s*\(\s*(?!['"][^'"`$]*['"]\s*\))/;
      expect(src).not.toMatch(dynamicRequire);
      expect(src).not.toMatch(dynamicImport);
      expect(src).not.toMatch(/createRequire\s*\(/);
    },
  );

  it('no production file calls .introspect(', () => {
    const offenders = [...walk(SRC), ...walk(path.join(BACKEND, 'ee'))]
      .filter((f) => !isSpec(f))
      .filter((f) => /\.introspect\s*\(/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  describe('a package with no type declarations', () => {
    let base: string;
    const marker = '__almyty_sdk_introspect_marker__';

    beforeAll(() => {
      base = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-introspect-exec-'));
      const pkgDir = path.join(base, 'node_modules', 'no-types-pkg');
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({ name: 'no-types-pkg', version: '1.0.0', main: 'index.js' }),
      );
      // The entry file records that it ran. Reading process.env or
      // opening a socket would work just as well from here.
      fs.writeFileSync(
        path.join(pkgDir, 'index.js'),
        `globalThis[${JSON.stringify(marker)}] = true;\n` +
          'module.exports = { Client: class Client { list() {} } };\n',
      );
    });

    afterAll(() => {
      delete (globalThis as any)[marker];
      fs.rmSync(base, { recursive: true, force: true });
    });

    it('is not executed in the host process', () => {
      const map = new SdkIntrospectorService().introspect('no-types-pkg', base);
      expect((globalThis as any)[marker]).toBeUndefined();
      expect(map).toEqual({});
    });
  });

  it('refuses a package name that is not an npm package name', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-introspect-name-'));
    try {
      expect(() => new SdkIntrospectorService().introspect('../../../etc', base)).toThrow(
        /package name/i,
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
