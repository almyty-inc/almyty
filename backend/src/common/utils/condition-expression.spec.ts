import {
  EQUALITY_OPERATORS,
  looksLikeMethodCall,
  matchComparison,
  matchMethodCondition,
  singleReference,
} from './condition-expression';

/** The regexes these readers replaced, as they were. */
const METHOD = /^(!?)\s*(.+)\.(includes|startsWith|endsWith)\(\s*(.*?)\s*\)$/s;
const COMPARISON = /^(.+?)\s*(===?|!==?|>=?|<=?)\s*(.+)$/;
const METHOD_CALL = /^!?\s*.+\.\s*[A-Za-z_$][\w$]*\s*\(.*\)$/s;
const DATA_COMPARISON = /^data\.(.+?)\s*(===?|!==?)\s*(.+)$/;
const SINGLE_REFERENCE = /^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/;

function* samples(alphabet: string[], count = 20000, maxLength = 10): Generator<string> {
  let seed = 5;
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

const groups = (m: RegExpMatchArray | null) => (m ? m.slice(1) : null);

function elapsed(fn: () => unknown): number {
  const started = Date.now();
  fn();
  return Date.now() - started;
}

describe('condition readers capture what the regexes captured', () => {
  it('method conditions', () => {
    const alphabet = ['!', ' ', '\n', 'a', "'", '.', '.includes(', '.startsWith(', '.endsWith(', '(', ')', 'x.y'];
    for (const s of samples(alphabet)) {
      expect({ s, m: matchMethodCondition(s) }).toEqual({ s, m: groups(s.match(METHOD)) });
    }
  });

  it('comparisons', () => {
    const alphabet = ['a', '1', ' ', '\n', '\t', '=', '==', '!', '<', '>', '===', '!=', "'"];
    for (const s of samples(alphabet)) {
      expect({ s, m: matchComparison(s) }).toEqual({ s, m: groups(s.match(COMPARISON)) });
      const data = `data.${s}`;
      expect({ data, m: matchComparison(data, EQUALITY_OPERATORS, 'data.') }).toEqual({
        data,
        m: groups(data.match(DATA_COMPARISON)),
      });
    }
  });

  it('method-call shape', () => {
    const alphabet = ['!', ' ', '\n', 'a', '.', '(', ')', '$', '_', '1', 'f('];
    for (const s of samples(alphabet)) {
      expect({ s, m: looksLikeMethodCall(s) }).toEqual({ s, m: METHOD_CALL.test(s) });
    }
  });

  it('single references', () => {
    const alphabet = ['{{', '}}', '{', '}', ' ', '\n', 'a', '.'];
    for (const s of samples(alphabet)) {
      const m = s.match(SINGLE_REFERENCE);
      expect({ s, m: singleReference(s) }).toEqual({ s, m: m ? m[1] : null });
    }
  });

  it('reads the builder expressions', () => {
    expect(matchMethodCondition("!'hello world'.includes('world')")).toEqual(['!', "'hello world'", 'includes', "'world'"]);
    expect(matchComparison('29.4 > 25')).toEqual(['29.4', '>', '25']);
    expect(matchComparison("positive === 'positive'")).toEqual(['positive', '===', "'positive'"]);
    expect(matchComparison('data.ok === true', EQUALITY_OPERATORS, 'data.')).toEqual(['ok', '===', 'true']);
    expect(looksLikeMethodCall("x.toUpperCase()")).toBe(true);
    expect(singleReference(' {{ input.items }} ')).toBe('input.items');
  });
});

describe('condition readers are linear on long upstream output', () => {
  const size = 100_000;
  const spaces = ' '.repeat(size);
  it.each([
    ['method call with a spaced argument', () => matchMethodCondition(`a.includes(${spaces}x`)],
    ['method call with a spaced receiver', () => matchMethodCondition(`!${spaces}x)`)],
    ['comparison over a line of spaces', () => matchComparison(`${spaces}\n`)],
    ['comparison with spaces before the operator', () => matchComparison(`a${spaces}=`)],
    ['data comparison', () => matchComparison(`data.${spaces}\n`, EQUALITY_OPERATORS, 'data.')],
    ['method-call shape', () => looksLikeMethodCall('.a('.repeat(size / 3))],
  ])('%s', (_label, run) => {
    expect(elapsed(run)).toBeLessThan(250);
  });
});
