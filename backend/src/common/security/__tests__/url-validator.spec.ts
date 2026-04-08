import { validateUrl, sanitizeHeaders, validateResponseSize } from '../url-validator';

describe('URL Validator (SSRF Protection)', () => {
  describe('validateUrl', () => {
    // Valid URLs
    it('should allow normal HTTP URLs', () => {
      expect(validateUrl('https://api.example.com/v1/pets')).toEqual({
        valid: true,
        sanitizedUrl: 'https://api.example.com/v1/pets',
      });
    });

    it('should allow HTTPS URLs', () => {
      expect(validateUrl('https://petstore.swagger.io/v2/pet')).toEqual({
        valid: true,
        sanitizedUrl: 'https://petstore.swagger.io/v2/pet',
      });
    });

    it('should allow HTTP URLs', () => {
      const result = validateUrl('http://api.example.com/data');
      expect(result.valid).toBe(true);
    });

    // Blocked protocols
    it('should block file:// protocol', () => {
      const result = validateUrl('file:///etc/passwd');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Blocked protocol');
    });

    it('should block ftp:// protocol', () => {
      const result = validateUrl('ftp://files.example.com/data');
      expect(result.valid).toBe(false);
    });

    // SSRF - private IPs
    it('should block localhost', () => {
      const result = validateUrl('http://localhost:4000/api');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Blocked hostname');
    });

    it('should block 127.0.0.1', () => {
      const result = validateUrl('http://127.0.0.1:6379/');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Blocked private');
    });

    it('should block 10.x private range', () => {
      const result = validateUrl('http://10.0.0.1/internal');
      expect(result.valid).toBe(false);
    });

    it('should block 172.16.x private range', () => {
      const result = validateUrl('http://172.16.0.1/internal');
      expect(result.valid).toBe(false);
    });

    it('should block 192.168.x private range', () => {
      const result = validateUrl('http://192.168.1.1/admin');
      expect(result.valid).toBe(false);
    });

    // Cloud metadata
    it('should block AWS metadata endpoint', () => {
      const result = validateUrl('http://169.254.169.254/latest/meta-data/');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('metadata');
    });

    it('should block link-local range', () => {
      const result = validateUrl('http://169.254.0.1/');
      expect(result.valid).toBe(false);
    });

    // Credentials in URL
    it('should block URLs with embedded credentials', () => {
      const result = validateUrl('http://admin:password@example.com/');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('credentials');
    });

    // Invalid URLs
    it('should reject invalid URLs', () => {
      const result = validateUrl('not-a-url');
      expect(result.valid).toBe(false);
    });

    // Internal hostname patterns
    it('should block metadata.google.internal', () => {
      const result = validateUrl('http://metadata.google.internal/computeMetadata/v1/');
      expect(result.valid).toBe(false);
    });

    // IPv6 brackets — Node's URL parser preserves the [ ] in `hostname`,
    // so any check that doesn't strip them silently lets [::1], [fc00::1],
    // etc. through.
    describe('IPv6 brackets', () => {
      it('should block bracketed IPv6 loopback', () => {
        const result = validateUrl('http://[::1]/admin');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('::1');
      });

      it('should block bracketed unique-local IPv6', () => {
        const result = validateUrl('http://[fc00::1]/internal');
        expect(result.valid).toBe(false);
      });

      it('should block bracketed link-local IPv6', () => {
        const result = validateUrl('http://[fe80::1]/');
        expect(result.valid).toBe(false);
      });
    });
  });

  describe('sanitizeHeaders', () => {
    it('should pass through safe headers', () => {
      const result = sanitizeHeaders({
        'Content-Type': 'application/json',
        'Authorization': 'Bearer token123',
        'X-Custom': 'value',
      });
      expect(result).toEqual({
        'Content-Type': 'application/json',
        'Authorization': 'Bearer token123',
        'X-Custom': 'value',
      });
    });

    it('should block dangerous headers', () => {
      const result = sanitizeHeaders({
        'Content-Type': 'application/json',
        'Host': 'evil.com',
        'Cookie': 'session=abc',
        'X-Forwarded-For': '1.2.3.4',
        'Proxy-Authorization': 'Basic xxx',
      });
      expect(result).toEqual({
        'Content-Type': 'application/json',
      });
    });

    it('should block header injection via newlines', () => {
      const result = sanitizeHeaders({
        'X-Custom': 'value\r\nInjected: header',
      });
      expect(result).toEqual({});
    });

    it('should block oversized header values', () => {
      const result = sanitizeHeaders({
        'X-Normal': 'ok',
        'X-Huge': 'a'.repeat(9000),
      });
      expect(result).toEqual({ 'X-Normal': 'ok' });
    });
  });

  describe('validateResponseSize', () => {
    it('should allow normal responses', () => {
      expect(validateResponseSize(1024)).toBe(true);
    });

    it('should block oversized responses', () => {
      expect(validateResponseSize(20 * 1024 * 1024)).toBe(false);
    });

    it('should allow when content length is undefined', () => {
      expect(validateResponseSize(undefined)).toBe(true);
    });

    it('should respect custom max size', () => {
      expect(validateResponseSize(500, 1000)).toBe(true);
      expect(validateResponseSize(1500, 1000)).toBe(false);
    });
  });
});
