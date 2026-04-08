import { BadRequestException } from '@nestjs/common';
import {
  getByDotPath,
  escapeXml,
  applyJsonBodyTemplate,
  substituteHeaderValue,
  assertSafeNextPageUrl,
  evaluateHttpSuccessCondition,
  compareConditionValues,
  encodeFormUrlencoded,
  hashCacheObject,
  generateRequestId,
} from '../tool-execution-utils';

describe('tool-execution-utils', () => {
  // ─── getByDotPath ────────────────────────────────────────────────

  describe('getByDotPath', () => {
    it('returns the value at a nested path', () => {
      expect(getByDotPath({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42);
    });

    it('returns undefined on any missing link', () => {
      expect(getByDotPath({ a: { b: 1 } }, 'a.b.c')).toBeUndefined();
      expect(getByDotPath({ a: null }, 'a.b')).toBeUndefined();
      expect(getByDotPath(null, 'a')).toBeUndefined();
    });

    it('returns undefined for empty paths', () => {
      expect(getByDotPath({ a: 1 }, '')).toBeUndefined();
    });
  });

  // ─── escapeXml ───────────────────────────────────────────────────

  describe('escapeXml', () => {
    it('escapes the five predefined XML entities', () => {
      expect(escapeXml('&')).toBe('&amp;');
      expect(escapeXml('<')).toBe('&lt;');
      expect(escapeXml('>')).toBe('&gt;');
      expect(escapeXml('"')).toBe('&quot;');
      expect(escapeXml("'")).toBe('&apos;');
    });

    it('neutralizes a SOAP element break-out payload (regression)', () => {
      // Regression: SOAP body templates used to raw-interpolate
      // parameter values, so a payload containing `</soap:Body>`
      // could terminate the element early and inject arbitrary XML
      // into the outbound request.
      const payload = 'alice</soap:Body><injected>gotcha</injected><soap:Body>';
      const escaped = escapeXml(payload);
      expect(escaped).not.toContain('</soap:Body>');
      expect(escaped).not.toContain('<injected>');
      expect(escaped).toContain('&lt;/soap:Body&gt;');
    });

    it('escapes ampersands before other characters (no double-escape)', () => {
      expect(escapeXml('a & <b>')).toBe('a &amp; &lt;b&gt;');
    });
  });

  // ─── applyJsonBodyTemplate ───────────────────────────────────────

  describe('applyJsonBodyTemplate (JSON injection regression)', () => {
    it('substitutes a whole-placeholder string field with the parameter value type', () => {
      const template = '{"user": "{name}"}';
      expect(applyJsonBodyTemplate(template, { name: 'alice' })).toEqual({ user: 'alice' });
    });

    it('splices in objects/arrays/numbers when the whole field is a placeholder', () => {
      // If the placeholder occupies the entire string, we can safely
      // replace it with the actual typed value rather than coerce to
      // string — this is the "better templating" part of the fix.
      const template = '{"user": "{payload}"}';
      expect(
        applyJsonBodyTemplate(template, { payload: { id: 1, tags: ['a', 'b'] } }),
      ).toEqual({ user: { id: 1, tags: ['a', 'b'] } });
    });

    it('refuses to let a substituted value inject new JSON fields (regression)', () => {
      // Pre-fix contract:
      //   template = '{"user": "{name}"}'
      //   parameters = { name: 'bar", "admin": true, "x": "' }
      //   → naive string-replace builds '{"user": "bar", "admin": true, "x": ""}'
      //   → JSON.parse yields { user: 'bar', admin: true, x: '' }
      //
      // Post-fix contract: the template is parsed FIRST, so the
      // injected punctuation is just characters inside a string
      // field. The `admin` key never appears.
      const template = '{"user": "{name}", "role": "guest"}';
      const parameters = { name: 'bar", "admin": true, "x": "' };
      const out = applyJsonBodyTemplate(template, parameters);
      expect(out).toEqual({
        user: 'bar", "admin": true, "x": "',
        role: 'guest',
      });
      expect(out).not.toHaveProperty('admin');
    });

    it('supports mixed-string interpolation', () => {
      const template = '{"greeting": "Hello, {name}!"}';
      expect(applyJsonBodyTemplate(template, { name: 'Alice' })).toEqual({
        greeting: 'Hello, Alice!',
      });
    });

    it('leaves unknown placeholders untouched', () => {
      const template = '{"x": "{missing}"}';
      expect(applyJsonBodyTemplate(template, {})).toEqual({ x: '{missing}' });
    });

    it('walks nested structures', () => {
      const template = '{"outer": {"inner": "{val}", "list": ["{val}", "static"]}}';
      expect(applyJsonBodyTemplate(template, { val: 'X' })).toEqual({
        outer: { inner: 'X', list: ['X', 'static'] },
      });
    });

    it('throws BadRequest on invalid JSON templates', () => {
      expect(() => applyJsonBodyTemplate('{not valid json', {})).toThrow(BadRequestException);
    });
  });

  // ─── substituteHeaderValue ───────────────────────────────────────

  describe('substituteHeaderValue (CRLF header injection regression)', () => {
    it('substitutes a simple placeholder', () => {
      expect(substituteHeaderValue('Bearer {token}', { token: 'abc' }, 'Authorization')).toBe(
        'Bearer abc',
      );
    });

    it('throws on CRLF in a substituted value (regression)', () => {
      // Pre-fix: CRLF in a parameter value landed in the outgoing
      // header string and the post-hoc sanitizer ran on the merged
      // map, so injected CRLF was indistinguishable from a CRLF
      // the caller set directly. HTTP request splitting reachable
      // by anyone who could invoke the tool with a crafted value.
      expect(() =>
        substituteHeaderValue(
          'Bearer {token}',
          { token: 'abc\r\nX-Injected: evil' },
          'Authorization',
        ),
      ).toThrow(BadRequestException);
    });

    it('throws on lone \\r or \\n too', () => {
      expect(() =>
        substituteHeaderValue('v-{x}', { x: 'a\rb' }, 'X-Test'),
      ).toThrow(BadRequestException);
      expect(() =>
        substituteHeaderValue('v-{x}', { x: 'a\nb' }, 'X-Test'),
      ).toThrow(BadRequestException);
    });

    it('leaves unknown placeholders intact', () => {
      expect(substituteHeaderValue('v-{missing}', { other: '1' }, 'X-Test')).toBe('v-{missing}');
    });
  });

  // ─── assertSafeNextPageUrl ───────────────────────────────────────

  describe('assertSafeNextPageUrl (pagination SSRF regression)', () => {
    it('accepts a public https absolute URL', () => {
      const resolved = assertSafeNextPageUrl(
        'https://api.example.com/v1/things?cursor=abc',
        'https://api.example.com/v1/things',
      );
      expect(resolved).toBe('https://api.example.com/v1/things?cursor=abc');
    });

    it('resolves relative URLs against the base', () => {
      const resolved = assertSafeNextPageUrl(
        '/v1/things?cursor=next',
        'https://api.example.com/v1/things',
      );
      expect(resolved).toBe('https://api.example.com/v1/things?cursor=next');
    });

    it('refuses a next URL pointing at the EC2 metadata service', () => {
      expect(() =>
        assertSafeNextPageUrl(
          'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
          'https://api.example.com/v1/things',
        ),
      ).toThrow(BadRequestException);
    });

    it('refuses a next URL pointing at localhost', () => {
      expect(() =>
        assertSafeNextPageUrl('http://localhost:6379/', 'https://api.example.com/v1/things'),
      ).toThrow(BadRequestException);
    });

    it('refuses a next URL pointing at a private RFC1918 address', () => {
      expect(() =>
        assertSafeNextPageUrl('http://10.0.0.1/internal', 'https://api.example.com/v1/things'),
      ).toThrow(BadRequestException);
    });

    it('refuses an obviously-broken URL', () => {
      expect(() => assertSafeNextPageUrl('not a url', undefined)).toThrow(BadRequestException);
    });
  });

  // ─── evaluateHttpSuccessCondition + compareConditionValues ──────

  describe('evaluateHttpSuccessCondition', () => {
    it('supports status numeric comparisons', () => {
      expect(evaluateHttpSuccessCondition('status < 400', 200, null)).toBe(true);
      expect(evaluateHttpSuccessCondition('status < 400', 500, null)).toBe(false);
      expect(evaluateHttpSuccessCondition('status == 200', 200, null)).toBe(true);
      expect(evaluateHttpSuccessCondition('status >= 300', 201, null)).toBe(false);
    });

    it('supports data path comparisons', () => {
      expect(evaluateHttpSuccessCondition('data.ok === true', 200, { ok: true })).toBe(true);
      expect(evaluateHttpSuccessCondition('data.ok === false', 200, { ok: true })).toBe(false);
      expect(
        evaluateHttpSuccessCondition("data.status === 'ok'", 200, { status: 'ok' }),
      ).toBe(true);
    });

    it('falls back to HTTP 2xx+3xx default on unparseable condition', () => {
      expect(evaluateHttpSuccessCondition('garbage', 200, null)).toBe(true);
      expect(evaluateHttpSuccessCondition('garbage', 500, null)).toBe(false);
    });
  });

  describe('compareConditionValues', () => {
    it('implements the supported operators', () => {
      expect(compareConditionValues(1, '==', 1)).toBe(true);
      expect(compareConditionValues(1, '!=', 2)).toBe(true);
      expect(compareConditionValues(1, '<', 2)).toBe(true);
      expect(compareConditionValues(2, '>', 1)).toBe(true);
      expect(compareConditionValues(1, '<=', 1)).toBe(true);
      expect(compareConditionValues(1, '>=', 1)).toBe(true);
    });

    it('returns false for unknown operators', () => {
      expect(compareConditionValues(1, '~~' as any, 1)).toBe(false);
    });
  });

  // ─── encodeFormUrlencoded ────────────────────────────────────────

  describe('encodeFormUrlencoded', () => {
    it('encodes scalar keys', () => {
      expect(encodeFormUrlencoded({ name: 'alice', age: 30 })).toBe('name=alice&age=30');
    });

    it('flattens arrays with the []= convention', () => {
      expect(encodeFormUrlencoded({ tags: ['a', 'b'] })).toBe('tags%5B%5D=a&tags%5B%5D=b');
    });

    it('flattens nested objects with [child] convention', () => {
      expect(encodeFormUrlencoded({ user: { name: 'alice' } })).toBe('user%5Bname%5D=alice');
    });

    it('skips null and undefined', () => {
      expect(encodeFormUrlencoded({ a: 1, b: null, c: undefined, d: 2 })).toBe('a=1&d=2');
    });
  });

  // ─── hashCacheObject ─────────────────────────────────────────────

  describe('hashCacheObject (cache-collision regression)', () => {
    it('generates a stable 32-char md5 hex for equal inputs', () => {
      const a = hashCacheObject({ a: 1, b: 2 });
      const b = hashCacheObject({ a: 1, b: 2 });
      expect(a).toBe(b);
      expect(a).toHaveLength(32);
    });

    it('is order-independent at every nesting level', () => {
      const a = hashCacheObject({ a: 1, nested: { x: 1, y: 2 } });
      const b = hashCacheObject({ nested: { y: 2, x: 1 }, a: 1 });
      expect(a).toBe(b);
    });

    it('DIFFERS when nested values differ (regression)', () => {
      // Pre-fix: `JSON.stringify(obj, Object.keys(obj).sort())` used
      // the key array as a FILTER at every level, so nested keys
      // that didn't appear at top level got dropped. These two
      // objects used to collide in the cache.
      const a = hashCacheObject({ filter: { name: 'alice' }, tenant: 'acme' });
      const b = hashCacheObject({ filter: { name: 'bob' }, tenant: 'acme' });
      expect(a).not.toBe(b);
    });

    it('DIFFERS when deeply nested scalars differ', () => {
      const a = hashCacheObject({ outer: { inner: { value: 1 } } });
      const b = hashCacheObject({ outer: { inner: { value: 2 } } });
      expect(a).not.toBe(b);
    });
  });

  // ─── generateRequestId ───────────────────────────────────────────

  describe('generateRequestId', () => {
    it('produces the `req_<hex>` shape and is unguessable', () => {
      // crypto.randomBytes(12).toString('hex') is 24 hex chars — 96
      // bits of entropy. The previous Date.now + Math.random shape
      // was enumerable; keep the new contract pinned.
      const id = generateRequestId();
      expect(id).toMatch(/^req_[a-f0-9]{24}$/);
    });

    it('does not repeat across calls', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) ids.add(generateRequestId());
      expect(ids.size).toBe(100);
    });
  });
});
