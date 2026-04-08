import {
  isLikelyCatastrophicRegex,
  compileSafeRegex,
  boundRegexInput,
  DEFAULT_PATTERN_MAX_LENGTH,
  DEFAULT_INPUT_MAX_LENGTH,
} from '../regex-safety';

describe('regex-safety', () => {
  describe('isLikelyCatastrophicRegex', () => {
    it('flags the textbook nested-quantifier shapes', () => {
      expect(isLikelyCatastrophicRegex('(a+)+')).toBe(true);
      expect(isLikelyCatastrophicRegex('(a*)*')).toBe(true);
      expect(isLikelyCatastrophicRegex('(a+)*')).toBe(true);
      expect(isLikelyCatastrophicRegex('(a*)+')).toBe(true);
      expect(isLikelyCatastrophicRegex('(a?)+')).toBe(true);
      expect(isLikelyCatastrophicRegex('^(a+)+$')).toBe(true);
    });

    it('flags bounded-quantifier variants', () => {
      expect(isLikelyCatastrophicRegex('(a{1,2})+')).toBe(true);
      expect(isLikelyCatastrophicRegex('(a+){3,5}')).toBe(true);
    });

    it('flags alternations inside a quantified group with overlap', () => {
      expect(isLikelyCatastrophicRegex('(a|a)+')).toBe(true);
      expect(isLikelyCatastrophicRegex('(a|ab)+')).toBe(true);
      expect(isLikelyCatastrophicRegex('(ab|a)+')).toBe(true);
    });

    it('leaves legitimate patterns alone', () => {
      expect(isLikelyCatastrophicRegex('^sk-[a-zA-Z0-9]{32}$')).toBe(false);
      expect(isLikelyCatastrophicRegex('\\d{3}-\\d{2}-\\d{4}')).toBe(false);
      expect(isLikelyCatastrophicRegex('[a-z]+@[a-z]+\\.[a-z]+')).toBe(false);
      expect(isLikelyCatastrophicRegex('^gw_[a-zA-Z0-9_-]+$')).toBe(false);
    });
  });

  describe('compileSafeRegex', () => {
    it('compiles legitimate patterns and returns a working RegExp', () => {
      const { regex, reason } = compileSafeRegex('^sk-[a-zA-Z0-9]{32}$');
      expect(reason).toBeUndefined();
      expect(regex).toBeInstanceOf(RegExp);
      expect(regex!.test('sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ012345')).toBe(true);
      expect(regex!.test('not-a-key')).toBe(false);
    });

    it('refuses empty patterns', () => {
      expect(compileSafeRegex('').regex).toBeNull();
    });

    it('refuses patterns over the source-length cap', () => {
      const longPattern = 'a'.repeat(DEFAULT_PATTERN_MAX_LENGTH + 1);
      const { regex, reason } = compileSafeRegex(longPattern);
      expect(regex).toBeNull();
      expect(reason).toContain('exceeds');
    });

    it('refuses known catastrophic shapes', () => {
      const { regex, reason } = compileSafeRegex('^(a+)+$');
      expect(regex).toBeNull();
      expect(reason).toContain('ReDoS');
    });

    it('returns null instead of throwing on invalid regex syntax', () => {
      const { regex, reason } = compileSafeRegex('[unclosed');
      expect(regex).toBeNull();
      expect(reason).toContain('invalid');
    });

    it('honours a custom maxPatternLength', () => {
      const pattern = 'a'.repeat(50);
      expect(compileSafeRegex(pattern, { maxPatternLength: 100 }).regex).toBeInstanceOf(RegExp);
      expect(compileSafeRegex(pattern, { maxPatternLength: 20 }).regex).toBeNull();
    });

    it('passes flags through to the RegExp constructor', () => {
      const { regex } = compileSafeRegex('cat', { flags: 'gi' });
      expect(regex).toBeInstanceOf(RegExp);
      expect(regex!.flags).toBe('gi');
    });
  });

  describe('boundRegexInput', () => {
    it('leaves short inputs alone', () => {
      expect(boundRegexInput('short input')).toBe('short input');
    });

    it('truncates inputs longer than the default cap', () => {
      const long = 'x'.repeat(DEFAULT_INPUT_MAX_LENGTH + 100);
      const result = boundRegexInput(long);
      expect(result.length).toBe(DEFAULT_INPUT_MAX_LENGTH);
    });

    it('honours a custom maxInputLength', () => {
      const long = 'y'.repeat(500);
      expect(boundRegexInput(long, 100)).toHaveLength(100);
      expect(boundRegexInput(long, 1000)).toHaveLength(500);
    });
  });
});
