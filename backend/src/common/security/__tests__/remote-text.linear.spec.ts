import { stripClosingFence } from '../../../modules/agents/agent-verifier.helper';
import { outermostJsonSpan } from '../../../modules/tools/executors/tool-script.executor';
import { nextLinkTarget } from '../../../modules/tools/executors/tool-http-pagination';
import { AnthropicMemoryToolBackend } from '../../../modules/memory/canonical/backends/anthropic-memory-tool.backend';
import { VisitorEmailOtpService } from '../../../modules/gateways/channels/visitor-email-otp.service';
import { detectApiSchema } from '../../../modules/schema-parser/schema-detect';
import { validateUrl } from '../url-validator';
import { isBlockedHostname } from '../ip-classification';
import { isLikelyCatastrophicRegex } from '../regex-safety';

/**
 * Text that arrives from somewhere else -- an LLM reply, a remote API's
 * headers, a Files API listing, a URL someone pasted, an uploaded spec --
 * was read by regexes that retried from every candidate start. Each
 * reader below is checked against the regex it replaced on generated
 * input, and timed on 100 KB of the character that made the regex slow.
 */

function* samples(alphabet: string[], count = 5000, maxLength = 14): Generator<string> {
  let seed = 13;
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

const size = 100_000;

describe('closing code fence (verifier checker replies)', () => {
  it('strips what /\\s*```$/i stripped', () => {
    for (const s of samples([' ', '\n', '`', '```', 'a', '{', '}'])) {
      expect({ s, out: stripClosingFence(s) }).toEqual({ s, out: s.replace(/\s*```$/i, '') });
    }
  });
  it('is linear on 100 KB of spaces', () => {
    expect(elapsed(() => stripClosingFence(' '.repeat(size) + 'x'))).toBeLessThan(250);
  });
});

describe('outermost JSON span (LLM tool replies)', () => {
  it('finds what /\\{[\\s\\S]*\\}|\\[[\\s\\S]*\\]/ found', () => {
    for (const s of samples(['{', '}', '[', ']', 'a', ' ', '\n', '"'])) {
      expect({ s, out: outermostJsonSpan(s) }).toEqual({ s, out: s.match(/\{[\s\S]*\}|\[[\s\S]*\]/)?.[0] ?? null });
    }
  });
  it.each(['{', '['])('is linear on 100 KB of %s', (ch) => {
    expect(elapsed(() => outermostJsonSpan(ch.repeat(size)))).toBeLessThan(250);
  });
});

describe('Link header next target (remote API headers)', () => {
  it('reads what /<([^>]+)>;\\s*rel="next"/ read', () => {
    for (const s of samples(['<', '>', ';', ' ', 'a', 'rel="next"', 'rel="prev"', ',', '\t'])) {
      expect({ s, out: nextLinkTarget(s) }).toEqual({ s, out: s.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null });
    }
    expect(nextLinkTarget('<https://a/p1>; rel="prev", <https://a/p3>; rel="next"')).toBe('https://a/p3');
  });
  it('is linear on 100 KB of <', () => {
    expect(elapsed(() => nextLinkTarget('<'.repeat(size)))).toBeLessThan(250);
  });
});

describe('Anthropic memory filenames (Files API listing)', () => {
  const backend = new AnthropicMemoryToolBackend();
  const id = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
  it('parses the names it writes', () => {
    const item = backend.toCanonical({ filename: `workspace_ws-1__${id}.md`, _content: 'x' });
    expect(item).toMatchObject({ id, scope_type: 'workspace', scope_id: 'ws-1' });
  });
  it('reads a long name that does not end in a uuid in linear time', () => {
    // The old pattern took 96 s on 500 characters of this.
    expect(elapsed(() => backend.toCanonical({ filename: `a_${'b'.repeat(size)}__x`, _content: '' }))).toBeLessThan(250);
  });
});

describe('hostnames with a run of dots (URLs people and models paste)', () => {
  const host = `a${'.'.repeat(size)}b`;
  it('validateUrl', () => {
    expect(elapsed(() => validateUrl(`https://${host}/`))).toBeLessThan(250);
  });
  it('isBlockedHostname', () => {
    expect(elapsed(() => isBlockedHostname(host))).toBeLessThan(250);
  });
  it('still drops the trailing dots of a hostname', () => {
    expect(isBlockedHostname('localhost...')).toBe(true);
  });
});

describe('visitor sign-in addresses', () => {
  it('accepts what /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/ accepted', () => {
    for (const s of samples(['a', '@', '.', ' ', 'b', '-'], 6000, 10)) {
      const expected = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim().toLowerCase()) ? s.trim().toLowerCase() : null;
      expect({ s, out: VisitorEmailOtpService.normalizeEmail(s) }).toEqual({ s, out: expected || null });
    }
  });
});

describe('uploaded API descriptions', () => {
  it('reads a proto leading comment the way /^[ \\t]*\\/\\/[ \\t]*(.+)$/m did', () => {
    const old = /^[ \t]*\/\/[ \t]*(.+)$/m;
    const current = /^[ \t]*\/\/[ \t]*((?![ \t]).+|[ \t])$/m;
    for (const s of samples(['/', '//', ' ', '\t', '\n', 'a', 'x y'])) {
      expect({ s, out: current.exec(s)?.[1] }).toEqual({ s, out: old.exec(s)?.[1] });
    }
  });
  it('fills a server URL of 100 KB of { in linear time', () => {
    const spec = JSON.stringify({ openapi: '3.0.0', info: { title: 't', version: '1' }, servers: [{ url: '{'.repeat(size) }], paths: {} });
    expect(elapsed(() => detectApiSchema(spec))).toBeLessThan(250);
  });
});

describe('regex-safety vets a pattern the way its old regex did', () => {
  it('agrees on generated patterns', () => {
    const old = /\(([^()]*[+*?][^()]*|[^()]*\{\d+,?\d*\}[^()]*)\)[+*?{]/;
    const alternation = /\(([^()|]+)\|([^()|]+)\)[+*?]/;
    const oldCheck = (p: string) => {
      if (old.test(p)) return true;
      const m = p.match(alternation);
      return !!m && (m[1] === m[2] || m[1].startsWith(m[2]) || m[2].startsWith(m[1]));
    };
    for (const s of samples(['(', ')', 'a', '+', '*', '?', '{', '}', '1', ',', '|', '\\'], 8000, 12)) {
      expect({ s, out: isLikelyCatastrophicRegex(s) }).toEqual({ s, out: oldCheck(s) });
    }
  });
});
