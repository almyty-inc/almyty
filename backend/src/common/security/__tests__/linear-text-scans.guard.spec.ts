import * as fs from 'fs';
import * as path from 'path';

/**
 * Two regex shapes that are quadratic on input anyone can send, and that
 * this codebase kept reaching for on exactly that input:
 *
 *   /<[^>]*>/g, /<[^>]+>/g   every unclosed `<` scans to the end of the
 *                            input. Used to strip tags in DTO transforms
 *                            (registration included) and inbound mail.
 *   /^\s* ... /m             every line start rescans all the blank lines
 *                            after it. Used to sniff pasted/uploaded API
 *                            descriptions.
 *
 * 100 KB of either held the event loop for six to eight seconds. Use
 * `stripTags` from common/security/strip-tags, and `^[ \t]*` for a
 * line-anchored pattern.
 */

const SRC_ROOT = path.resolve(__dirname, '..', '..', '..');

const FORBIDDEN: Array<[string, RegExp]> = [
  ['a tag-stripping regex (use stripTags)', /\/<\[\^>\][*+]>\/[gimsuy]*/],
  ['`^\\s*` in a multiline regex (use ^[ \\t]*)', /\/\^\\s\*[^\n]*?\/[gisuy]*m[gisuy]*\b/],
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

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

describe('no quadratic text scans on request input', () => {
  const files = walk(SRC_ROOT);

  it('reads the source tree', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it.each(FORBIDDEN)('nothing in src uses %s', (_label, pattern) => {
    const offenders = files
      .filter((file) => pattern.test(stripComments(fs.readFileSync(file, 'utf8'))))
      .map((file) => path.relative(SRC_ROOT, file));
    expect(offenders).toEqual([]);
  });

  it('recognises the shapes it forbids', () => {
    expect(FORBIDDEN[0][1].test("value.replace(/<[^>]*>/g, '')")).toBe(true);
    expect(FORBIDDEN[0][1].test("s.replace(/<[^>]+>/g, '')")).toBe(true);
    expect(FORBIDDEN[1][1].test('/^\\s*(openapi|swagger)\\s*:/m.test(text)')).toBe(true);
    expect(FORBIDDEN[1][1].test('/^\\s*syntax\\b/gm')).toBe(true);
    expect(FORBIDDEN[1][1].test('/^[ \\t]*syntax\\b/m')).toBe(false);
    expect(FORBIDDEN[1][1].test('/^\\s*"""([\\s\\S]*?)"""/.exec(text)')).toBe(false);
  });
});
