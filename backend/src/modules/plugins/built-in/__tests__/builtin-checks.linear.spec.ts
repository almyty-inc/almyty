import { SecurityScannerPlugin } from '../security-scanner.plugin';
import { PiiFilterPlugin } from '../pii-filter.plugin';
import {
  commandSubstitutionMatcher,
  eventHandlerMatcher,
  tagBlockMatcher,
} from '../security-scanner.matchers';
import { matchEmailAddresses } from '../pii-filter.matchers';
import { PluginContext, PluginHookType } from '../../types/plugin.types';

/**
 * The scanner and the PII filter run their built-in checks over every
 * request and response body they see. Four of them were regexes that
 * rescanned the body from every candidate start; 100 KB of `on`, `$(`,
 * `<script` or `a.a.a.` took from half a second to several seconds.
 * The linear matchers return exactly what `text.match(regex)` did.
 */

function* samples(alphabet: string[], count = 5000, maxLength = 16): Generator<string> {
  let seed = 3;
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

const settings = {
  scanRequests: true,
  blockOnThreat: true,
  logThreats: false,
  alertOnCritical: false,
  whitelistPatterns: [],
  customPatterns: [],
  severityThreshold: 'medium',
};

function context(data: unknown): PluginContext {
  return {
    hookType: PluginHookType.PRE_REQUEST,
    userId: 'user-1',
    organizationId: 'org-1',
    requestId: 'req-1',
    data,
    metadata: { timestamp: new Date().toISOString() },
  } as unknown as PluginContext;
}

describe('security scanner matchers: same matches as the regexes', () => {
  it.each([
    ['script', /<script[^>]*>.*?<\/script>/gi, ['<script', '<SCRIPT', '<scrip', '>', '</script>', '</Script>', 'a', ' ', '\n', '<', '/']],
    ['iframe', /<iframe[^>]*>.*?<\/iframe>/gi, ['<iframe', '<IFRAME', '>', '</iframe>', '</iFrame>', 'x', '\r', '<', '/']],
  ])('<%s> blocks', (tag, regex, alphabet) => {
    const matcher = tagBlockMatcher(tag);
    expect(matcher.pattern).toBe(regex.toString());
    for (const s of samples(alphabet)) expect({ s, m: matcher.match(s) }).toEqual({ s, m: s.match(regex) });
  });

  it('event handlers', () => {
    const regex = /on\w+\s*=/gi;
    expect(eventHandlerMatcher.pattern).toBe(regex.toString());
    for (const s of samples(['on', 'ON', 'o', 'n', 'a', '_', '1', ' ', '\n', '=', '-', '\u00a0'])) {
      expect({ s, m: eventHandlerMatcher.match(s) }).toEqual({ s, m: s.match(regex) });
    }
  });

  it('command substitution', () => {
    const regex = /\$\(.*\)/g;
    expect(commandSubstitutionMatcher.pattern).toBe(regex.toString());
    for (const s of samples(['$(', '$', '(', ')', 'a', ' ', '\n', '\r', '\u2028'])) {
      expect({ s, m: commandSubstitutionMatcher.match(s) }).toEqual({ s, m: s.match(regex) });
    }
  });
});

describe('pii email matcher: same matches as the regex', () => {
  it('agrees on generated text', () => {
    const regex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
    for (const s of samples(['a', 'B', '1', '_', '.', '-', '%', '@', '|', ' ', 'co', 'x.io', '@b.', '#'], 8000, 18)) {
      expect({ s, m: matchEmailAddresses(s) }).toEqual({ s, m: s.match(regex) });
    }
  });

  it('finds ordinary addresses', () => {
    expect(matchEmailAddresses('write to ana.b+x@mail.example.com or bo@x.io.')).toEqual([
      'ana.b+x@mail.example.com',
      'bo@x.io',
    ]);
  });
});

describe('scanner and PII filter stay linear on hostile bodies', () => {
  const size = 100_000;
  const scanner = new SecurityScannerPlugin();
  const pii = new PiiFilterPlugin();

  it.each([
    ['on', 'on'.repeat(size / 2)],
    ['$(', '$('.repeat(size / 2)],
    ['<script', '<script'.repeat(size / 7)],
    ['<script>', '<script>'.repeat(size / 8)],
    ['<iframe>', '<iframe>'.repeat(size / 8)],
  ])('scanner: 100 KB of %s', async (_label, body) => {
    const started = Date.now();
    await scanner.scanRequest(context({ body }), settings);
    expect(Date.now() - started).toBeLessThan(250);
  });

  it('PII filter: 100 KB of a.a.a.', async () => {
    const started = Date.now();
    await pii.filterPiiFromRequest(context({ body: 'a.'.repeat(size / 2) }), { detectEmails: true });
    expect(Date.now() - started).toBeLessThan(250);
  });

  it('the matchers themselves on 100 KB', () => {
    expect(elapsed(() => matchEmailAddresses('a.'.repeat(size / 2) + '@' + 'b.'.repeat(size / 2)))).toBeLessThan(250);
    expect(elapsed(() => eventHandlerMatcher.match('on '.repeat(size / 3)))).toBeLessThan(250);
  });
});
