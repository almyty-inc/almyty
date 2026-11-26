import * as fs from 'fs';
import * as path from 'path';

import {
  SIGNUP_ATTRIBUTION_KEYS,
  SIGNUP_ATTRIBUTION_MAX_LENGTH,
  sanitizeSignupAttribution,
} from '../signup-attribution';

describe('sanitizeSignupAttribution', () => {
  it('keeps the whitelisted keys only', () => {
    expect(
      sanitizeSignupAttribution({
        utm_source: 'almyty.com',
        utm_medium: 'website',
        utm_campaign: 'launch-2026',
        utm_content: 'pricing_table',
        cta: 'hero',
        utm_term: 'agents',
        gclid: 'abc',
        email: 'x',
      }),
    ).toEqual({
      utm_source: 'almyty.com',
      utm_medium: 'website',
      utm_campaign: 'launch-2026',
      utm_content: 'pricing_table',
      cta: 'hero',
    });
  });

  it('caps every value at the maximum length', () => {
    const out = sanitizeSignupAttribution({ utm_campaign: 'a'.repeat(5000) });
    expect(out?.utm_campaign).toHaveLength(SIGNUP_ATTRIBUTION_MAX_LENGTH);
  });

  it('drops values that are not plain identifiers, so no email address or markup rides along', () => {
    expect(
      sanitizeSignupAttribution({
        utm_source: 'dana@example.com',
        utm_medium: '<script>alert(1)</script>',
        utm_campaign: 'line\nbreak',
        utm_content: '   ',
        cta: 'docs nav',
      }),
    ).toEqual({ cta: 'docs nav' });
  });

  it.each([null, undefined, 'utm_source=x', 42, ['utm_source'], { utm_source: 7 }, {}])(
    'returns null for %p',
    (raw) => {
      expect(sanitizeSignupAttribution(raw)).toBeNull();
    },
  );

  it('accepts exactly the keys the register page reads (frontend/src/lib/signup-attribution.ts)', () => {
    const frontend = fs.readFileSync(
      path.join(__dirname, '../../../../../frontend/src/lib/signup-attribution.ts'),
      'utf8',
    );
    const list = frontend.match(/SIGNUP_ATTRIBUTION_KEYS\s*=\s*\[([^\]]*)\]/);
    expect(list).not.toBeNull();
    const keys = [...list![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(keys).toEqual([...SIGNUP_ATTRIBUTION_KEYS]);
    expect(frontend).toContain(`SIGNUP_ATTRIBUTION_MAX_LENGTH = ${SIGNUP_ATTRIBUTION_MAX_LENGTH}`);
  });
});
