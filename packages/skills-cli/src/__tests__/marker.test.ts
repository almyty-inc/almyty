import { describe, expect, it } from 'vitest';
import { ALMYTY_MARKER } from '../installer.js';

// The SKILL.md we read back is the gateway's content. As /^\s*author:.../m
// the marker check rescanned every run of blank lines from each line start.
describe('the almyty marker', () => {
  const previous = /^\s*author:\s*almyty\s*$/m;

  it('finds what the previous pattern found', () => {
    const parts = ['\n', '\r\n', ' ', '\t', 'author:', ' almyty', 'almyty', 'x', '---'];
    let seed = 1;
    for (let i = 0; i < 5000; i++) {
      let s = '';
      const length = i % 9;
      for (let j = 0; j < length; j++) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        s += parts[seed % parts.length];
      }
      expect({ s, found: ALMYTY_MARKER.test(s) }).toEqual({ s, found: previous.test(s) });
    }
  });

  it('reads 100 KB of blank lines in linear time', () => {
    const started = Date.now();
    ALMYTY_MARKER.test('\n'.repeat(100_000) + 'x');
    expect(Date.now() - started).toBeLessThan(250);
  });
});
