import { describe, expect, it } from 'vitest';
import { continuationOf, joinSubmission } from '../commands.js';

// Trailing-run trims as /\s+$/ and /\\+$/ reread a long run that does not
// end the text once per character; the lookbehind forms read it once.
describe('trailing trims stay linear', () => {
  it('joinSubmission on a 100 KB run of spaces inside the text', () => {
    const started = Date.now();
    expect(joinSubmission([' '.repeat(100_000) + 'x', 'y  '])).toBe(' '.repeat(100_000) + 'x\ny');
    expect(Date.now() - started).toBeLessThan(250);
  });

  it('continuationOf on a 100 KB run of backslashes inside the text', () => {
    const started = Date.now();
    expect(continuationOf('\\'.repeat(100_000) + 'x\\')).toBe('\\'.repeat(100_000) + 'x');
    expect(Date.now() - started).toBeLessThan(250);
  });
});
