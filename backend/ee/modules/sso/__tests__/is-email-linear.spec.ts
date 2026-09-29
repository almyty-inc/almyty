import { isEmail } from '../sso.service';

/**
 * A SAML NameID or an OIDC claim is the identity provider's text. The
 * check was /.+@.+\..+/, three overlapping `.+` that tried every way of
 * sharing a line between them: 100 KB of `@` did not finish in thirty
 * seconds.
 */

function* samples(alphabet: string[], count = 8000, maxLength = 10): Generator<string> {
  let seed = 17;
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

describe('SSO isEmail', () => {
  it('agrees with /.+@.+\\..+/', () => {
    for (const s of samples(['a', '@', '.', ' ', '\n', '\r'])) {
      expect({ s, out: isEmail(s) }).toEqual({ s, out: /.+@.+\..+/.test(s) });
    }
    expect(isEmail('ana@example.com')).toBe(true);
    expect(isEmail(42)).toBe(false);
  });

  it.each([
    ['@', '@'.repeat(100_000)],
    ['spaces', ' '.repeat(100_000)],
  ])('is linear on 100 KB of %s', (_label, value) => {
    const started = Date.now();
    isEmail(value);
    expect(Date.now() - started).toBeLessThan(250);
  });
});
