import { normalizeEmail, isDisposableEmail } from './email-normalization';

describe('normalizeEmail', () => {
  it('strips dots from gmail local part', () => {
    expect(normalizeEmail('f.o.o@gmail.com')).toBe('foo@gmail.com');
    expect(normalizeEmail('foo@gmail.com')).toBe('foo@gmail.com');
    // The abuse example from the wild.
    expect(normalizeEmail('f.a.yek.e.v.u.3.0.5@gmail.com')).toBe('fayekevu305@gmail.com');
  });

  it('collapses gmail alias variants to the same canonical form', () => {
    const canonical = normalizeEmail('foo@gmail.com');
    expect(normalizeEmail('f.o.o@gmail.com')).toBe(canonical);
    expect(normalizeEmail('foo+newsletter@gmail.com')).toBe(canonical);
    expect(normalizeEmail('f.o.o+spam@gmail.com')).toBe(canonical);
    expect(normalizeEmail('F.O.O@Gmail.com')).toBe(canonical);
  });

  it('folds googlemail.com into gmail.com', () => {
    expect(normalizeEmail('f.o.o@googlemail.com')).toBe('foo@gmail.com');
  });

  it('strips +tag sub-addressing on all domains but keeps dots on non-gmail', () => {
    expect(normalizeEmail('john.doe+shopping@outlook.com')).toBe('john.doe@outlook.com');
    expect(normalizeEmail('jane+x@fastmail.com')).toBe('jane@fastmail.com');
  });

  it('does not strip dots on non-gmail domains', () => {
    expect(normalizeEmail('a.b.c@company.com')).toBe('a.b.c@company.com');
  });

  it('lowercases the whole address', () => {
    expect(normalizeEmail('User@Company.COM')).toBe('user@company.com');
  });

  it('falls back to lowercased input for degenerate/unparseable values', () => {
    expect(normalizeEmail('not-an-email')).toBe('not-an-email');
    expect(normalizeEmail('+tag@gmail.com')).toBe('+tag@gmail.com');
  });
});

describe('isDisposableEmail', () => {
  it('flags known disposable domains', () => {
    expect(isDisposableEmail('bob@mailinator.com')).toBe(true);
    expect(isDisposableEmail('bob@guerrillamail.com')).toBe(true);
    expect(isDisposableEmail('x@10minutemail.com')).toBe(true);
    expect(isDisposableEmail('X@YOPMAIL.COM')).toBe(true);
  });

  it('allows normal domains', () => {
    expect(isDisposableEmail('bob@gmail.com')).toBe(false);
    expect(isDisposableEmail('alice@company.com')).toBe(false);
    expect(isDisposableEmail('dev@almyty.com')).toBe(false);
  });

  it('is safe on malformed input', () => {
    expect(isDisposableEmail('garbage')).toBe(false);
    expect(isDisposableEmail('')).toBe(false);
  });
});
