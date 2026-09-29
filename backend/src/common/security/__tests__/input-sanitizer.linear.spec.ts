import { sanitizeToolParameters } from '../input-sanitizer';

/**
 * Tool arguments come from an LLM or an MCP client. The shell, template
 * and DOCTYPE checks were `/X.*Y/` regexes that retried from every X, so
 * one 100 KB argument of `;`, `{{` or `${` held the event loop for three
 * to six seconds. Same verdicts, one pass.
 */

/** The patterns as they were, to hold the rewrite to the same answers. */
const PREVIOUS: Array<[string, RegExp]> = [
  ['shell-command', /[;&|`$].*(?:rm|curl|wget|nc|ncat|bash|sh|python|perl|ruby|php)\b/i],
  ['backtick-exec', /`[^`]+`/],
  ['xxe-entity', /<!ENTITY\s/i],
  ['xxe-system', /<!DOCTYPE[^>]*SYSTEM/i],
  ['path-traversal', /\.\.[/\\]/],
  ['ssrf-localhost', /(?:^|\s)(?:localhost|127\.0\.0\.1|0\.0\.0\.0|::1)(?::\d+)?(?:\s|$|\/)/i],
  ['ssrf-metadata', /169\.254\.169\.254/i],
  ['template-injection', /\{\{.*\}\}/],
  ['ssti', /\$\{.*\}/],
];

function* samples(alphabet: string[], count = 6000, maxLength = 12): Generator<string> {
  let seed = 11;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let i = 0; i < count; i++) {
    const length = Math.floor(next() * maxLength);
    let s = '';
    for (let j = 0; j < length; j++) s += alphabet[Math.floor(next() * alphabet.length)];
    yield s;
  }
}

function detected(value: string): string[] {
  return sanitizeToolParameters({ v: value }).warnings.map((w) => w.replace(/^\[\w+\] /, '').split(' ')[0]);
}

function elapsed(fn: () => unknown): number {
  const started = Date.now();
  fn();
  return Date.now() - started;
}

describe('input sanitizer: same verdicts as the regexes it replaced', () => {
  it('agrees on generated values', () => {
    const alphabet = [';', '|', '$', '`', ' ', '\n', '\r', '{{', '}}', '{', '}', '${', 'rm', 'sh', 'bash', 'x', 'shx',
      '<!DOCTYPE', '<!doctype', 'SYSTEM', 'system', '>', '<!ENTITY '];
    for (const s of samples(alphabet)) {
      const expected = PREVIOUS.filter(([, re]) => re.test(s)).map(([name]) => name);
      expect({ s, found: detected(s) }).toEqual({ s, found: expected });
    }
  });

  it('keeps the examples it was written for', () => {
    expect(detected('a; rm -rf /')).toContain('shell-command');
    expect(detected('x | curl http://evil')).toContain('shell-command');
    expect(detected('a;\nrm')).not.toContain('shell-command');
    expect(detected('{{7*7}}')).toContain('template-injection');
    expect(detected('{{a\n}}')).not.toContain('template-injection');
    expect(detected('${process.env}')).toContain('ssti');
    expect(detected('<!DOCTYPE x [<!ENTITY y SYSTEM "file:///etc/passwd">]>')).toEqual(
      expect.arrayContaining(['xxe-entity', 'xxe-system']),
    );
    expect(detected('<!DOCTYPE html><p>SYSTEM</p>')).not.toContain('xxe-system');
  });
});

describe('input sanitizer: linear on hostile arguments', () => {
  const size = 100_000;
  it.each([
    ['metacharacters', ';'.repeat(size)],
    ['template openers', '{{'.repeat(size / 2)],
    ['expression openers', '${'.repeat(size / 2)],
    ['DOCTYPE declarations', '<!DOCTYPE'.repeat(size / 9)],
  ])('100 KB of %s', (_label, value) => {
    expect(elapsed(() => sanitizeToolParameters({ value }))).toBeLessThan(250);
  });
});
