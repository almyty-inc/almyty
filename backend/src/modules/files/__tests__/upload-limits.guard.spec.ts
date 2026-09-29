import * as fs from 'fs';
import * as path from 'path';

/**
 * Every multipart route is bounded by uploadLimits(): one file of a set
 * size and a handful of fields. multer bounds nothing it is not told to,
 * and the fields beside a file were unlimited on both upload routes.
 *
 * An interceptor passes `limits: uploadLimits(...)` itself, or sits in a
 * module directory whose MulterModule.register does.
 */

const SRC_ROOT = path.resolve(__dirname, '..', '..', '..');
const INTERCEPTOR = /\b(?:FileInterceptor|FilesInterceptor|AnyFilesInterceptor|FileFieldsInterceptor|NoFilesInterceptor)\s*\(/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'test' || entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** The argument text of each call to `name` in `source`, matched by parentheses. */
function callArguments(source: string, pattern: RegExp): string[] {
  const out: string[] = [];
  const global = new RegExp(pattern.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = global.exec(source))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') depth--;
    }
    out.push(source.slice(start, i - 1));
  }
  return out;
}

describe('multipart routes are bounded', () => {
  const files = walk(SRC_ROOT);
  const read = (file: string) => fs.readFileSync(file, 'utf8');

  it('finds the upload routes', () => {
    const withInterceptors = files.filter((file) => INTERCEPTOR.test(read(file)));
    expect(withInterceptors.map((f) => path.relative(SRC_ROOT, f)).sort()).toEqual(
      expect.arrayContaining([
        path.join('modules', 'apis', 'apis.controller.ts'),
        path.join('modules', 'files', 'files.controller.ts'),
      ]),
    );
  });

  it('every MulterModule.register passes uploadLimits', () => {
    const offenders = files.flatMap((file) =>
      callArguments(read(file), /\bMulterModule\.register(?:Async)?\s*\(/)
        .filter((args) => !/\blimits\s*:\s*uploadLimits\(/.test(args))
        .map(() => path.relative(SRC_ROOT, file)),
    );
    expect(offenders).toEqual([]);
  });

  it('every file interceptor passes uploadLimits or sits under a module that registers them', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = read(file);
      const calls = callArguments(source, INTERCEPTOR);
      if (calls.length === 0) continue;
      const dir = path.dirname(file);
      const moduleBounds = fs
        .readdirSync(dir)
        .filter((name) => name.endsWith('.module.ts'))
        .some((name) =>
          callArguments(read(path.join(dir, name)), /\bMulterModule\.register(?:Async)?\s*\(/).some((args) =>
            /\blimits\s*:\s*uploadLimits\(/.test(args),
          ),
        );
      for (const args of calls) {
        if (!/\blimits\s*:\s*uploadLimits\(/.test(args) && !moduleBounds) {
          offenders.push(`${path.relative(SRC_ROOT, file)}: ${args.trim().slice(0, 80)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
