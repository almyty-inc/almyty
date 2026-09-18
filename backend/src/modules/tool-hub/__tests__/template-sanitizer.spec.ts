import {
  isSecretKey,
  isSecretValue,
  sanitizeConfiguration,
  sanitizeExamples,
  sanitizeHttpConfig,
  scrubStringMap,
} from '../template-sanitizer';

/**
 * The sanitizer is the only thing standing between a working tool's live
 * credentials and a template every other organization can read, so its
 * edges are pinned here rather than inferred from the publish path.
 */
describe('template sanitizer', () => {
  describe('isSecretKey', () => {
    it.each([
      'Authorization',
      'authorization',
      'X-Api-Key',
      'x_api_key',
      'apiKey',
      'api-key',
      'token',
      'access_token',
      'refreshToken',
      'client_secret',
      'Cookie',
      'password',
      'X-Subscription-Key',
    ])('treats %s as a credential', (key) => {
      expect(isSecretKey(key)).toBe(true);
    });

    it.each(['author', 'authors', 'keywords', 'sort', 'limit', 'q', 'monkeys'])(
      'leaves the structural parameter %s alone',
      (key) => {
        expect(isSecretKey(key)).toBe(false);
      },
    );
  });

  describe('isSecretValue', () => {
    it('catches a bearer header value whatever the key was called', () => {
      expect(isSecretValue('Bearer abc')).toBe(true);
    });

    it('catches a long opaque token', () => {
      expect(isSecretValue('sk-abc123def456ghi789jkl012')).toBe(true);
      expect(isSecretValue('AKIAIOSFODNN7EXAMPLEKEYXX')).toBe(true);
    });

    it('treats a value holding a placeholder as structural', () => {
      // The installing organization fills this in; it is a shape.
      expect(isSecretValue('{some_extremely_long_parameter_name}')).toBe(false);
    });

    it('leaves short structural constants alone', () => {
      expect(isSecretValue('application/json')).toBe(false);
      expect(isSecretValue('query')).toBe(false);
    });
  });

  describe('scrubStringMap', () => {
    it('drops credential-bearing entries and keeps the rest', () => {
      expect(
        scrubStringMap({
          Accept: 'application/json',
          Authorization: 'Bearer live-token',
          'X-Trace': '{traceId}',
        }),
      ).toEqual({ Accept: 'application/json', 'X-Trace': '{traceId}' });
    });

    it('returns undefined rather than an empty object when nothing survives', () => {
      expect(scrubStringMap({ Authorization: 'Bearer x' })).toBeUndefined();
      expect(scrubStringMap(undefined)).toBeUndefined();
    });
  });

  describe('sanitizeHttpConfig', () => {
    it('drops headers whole and filters query params', () => {
      const result = sanitizeHttpConfig({
        method: 'GET',
        path: '/v1/things',
        headers: { Accept: 'application/json', Authorization: 'Bearer live-token' },
        queryParams: { limit: '{limit}', api_key: 'live-key-value' },
        responseMapping: { dataPath: 'data' },
      } as any);

      expect(result).not.toHaveProperty('headers');
      expect(result!.queryParams).toEqual({ limit: '{limit}' });
      expect(result!.responseMapping).toEqual({ dataPath: 'data' });
      expect(result!.method).toBe('GET');
      expect(result!.path).toBe('/v1/things');
    });

    it('answers null for a tool with no http config', () => {
      expect(sanitizeHttpConfig(null)).toBeNull();
    });
  });

  describe('sanitizeConfiguration', () => {
    it('copies named fields only', () => {
      expect(
        sanitizeConfiguration({
          timeout: 5000,
          retries: 2,
          cache: { enabled: true },
          mcp: { sourceId: 'src-1', remoteName: 'x' },
          somethingElse: 'whatever',
        }),
      ).toEqual({ timeout: 5000, retries: 2, cache: { enabled: true } });
    });
  });

  describe('sanitizeExamples', () => {
    it('keeps the example and drops credential fields from its input', () => {
      expect(
        sanitizeExamples([
          { name: 'lookup', input: { owner: 'almyty', api_key: 'live-key' }, expectedOutput: { ok: true } },
        ]),
      ).toEqual([{ name: 'lookup', input: { owner: 'almyty' }, expectedOutput: { ok: true } }]);
    });

    it('answers an empty list for anything that is not an array', () => {
      expect(sanitizeExamples(undefined)).toEqual([]);
    });
  });
});
