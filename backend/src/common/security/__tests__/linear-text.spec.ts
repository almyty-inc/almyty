import { hasDelimited, matchDelimited, replaceDelimited } from '../linear-text';

/** Deterministic strings over a small alphabet, so every shape turns up. */
function* samples(alphabet: string[], count = 4000, maxLength = 14): Generator<string> {
  let seed = 7;
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

function elapsed(fn: () => unknown): number {
  const started = Date.now();
  fn();
  return Date.now() - started;
}

/**
 * The trailing-run trims across the backend were rewritten from the left
 * column to the right. Same result on every string; the right one can only
 * start at the first character of a run, so a long run that does not end
 * the string is read once instead of once per character.
 */
const TRIMS: Array<[RegExp, RegExp]> = [
  [/\/+$/, /(?<!\/)\/+$/],
  [/-+$/, /(?<!-)-+$/],
  [/\.+$/, /(?<!\.)\.+$/],
  [/=+$/, /(?<!=)=+$/],
  [/[.,)\]]+$/, /(?<![.,)\]])[.,)\]]+$/],
  [/^-+|-+$/g, /^-+|(?<!-)-+$/g],
  [/^_+|_+$/g, /^_+|(?<!_)_+$/g],
  [/^[-_]+|[-_]+$/g, /^[-_]+|(?<![-_])[-_]+$/g],
  [/^[-._]+|[-._]+$/g, /^[-._]+|(?<![-._])[-._]+$/g],
  [/^\/+|\/+$/g, /^\/+|(?<!\/)\/+$/g],
];

describe('trailing-run trims: the lookbehind form is the same trim', () => {
  it.each(TRIMS.map(([before, after]) => [String(before), before, after] as const))('%s', (_label, before, after) => {
    for (const s of samples(['/', '-', '.', '=', '_', ',', ')', ']', 'a', ' '])) {
      expect({ s, out: s.replace(after, '') }).toEqual({ s, out: s.replace(before, '') });
    }
  });

  it.each(TRIMS.map(([, after]) => [String(after), after] as const))('%s is linear on a 100 KB run', (_label, after) => {
    const run = after.source.includes('/') ? '/' : after.source.includes('=') ? '=' : after.source.includes('.') ? '.' : after.source.includes('-') ? '-' : '_';
    expect(elapsed(() => `a${run.repeat(100_000)}a`.replace(after, ''))).toBeLessThan(250);
  });
});

describe('delimited spans match the regexes they replace', () => {
  it('replaceDelimited, matchDelimited and hasDelimited', () => {
    const tag = (whole: string, body: string) => `[${body}|${whole.length}]`;
    for (const s of samples(['{', '}', 'a', ' ', '\n', '{{', '}}'])) {
      expect(replaceDelimited(s, '{{', '}}', tag)).toBe(s.replace(/\{\{([^}]+)\}\}/g, tag));
      expect(replaceDelimited(s, '{', '}', tag)).toBe(s.replace(/\{([^}]+)\}/g, tag));
      expect(matchDelimited(s, '{', '}')).toEqual(s.match(/\{([^}]+)\}/g) ?? []);
      expect(hasDelimited(s, '{', '}')).toBe(/\{[^}]+\}/.test(s));
    }
  });

  it('scans 100 KB of unclosed delimiters once', () => {
    const run = 100_000;
    expect(elapsed(() => replaceDelimited('{{'.repeat(run / 2), '{{', '}}', () => ''))).toBeLessThan(250);
    expect(elapsed(() => replaceDelimited('{{a}'.repeat(run / 4), '{{', '}}', () => ''))).toBeLessThan(250);
    expect(elapsed(() => hasDelimited('{'.repeat(run), '{', '}'))).toBeLessThan(250);
    expect(elapsed(() => matchDelimited('{'.repeat(run), '{', '}'))).toBeLessThan(250);
  });
});
