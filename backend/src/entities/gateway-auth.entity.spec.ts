import { GatewayAuth, GatewayAuthType } from './gateway-auth.entity';

describe('GatewayAuth Entity', () => {
  let auth: GatewayAuth;

  beforeEach(() => {
    auth = new GatewayAuth();
    auth.id = 'auth-1';
    auth.gatewayId = 'gateway-1';
    auth.type = GatewayAuthType.API_KEY;
    auth.isRequired = true;
    auth.isActive = true;
    auth.configuration = {
      keyHeader: 'x-api-key',
      keyQuery: 'api_key',
      defaultScopes: ['read', 'write'],
    };
  });

  describe('validateRequest', () => {
    it('should return valid when auth is not required', () => {
      auth.isRequired = false;

      const result = auth.validateRequest({}, {});

      expect(result.isValid).toBe(true);
    });

    it('should return valid when auth is not active', () => {
      auth.isActive = false;

      const result = auth.validateRequest({}, {});

      expect(result.isValid).toBe(true);
    });

    it('should return valid when type is NONE', () => {
      auth.type = GatewayAuthType.NONE;

      const result = auth.validateRequest({}, {});

      expect(result.isValid).toBe(true);
    });

    it('should validate API_KEY type', () => {
      auth.type = GatewayAuthType.API_KEY;

      const result = auth.validateRequest({ 'x-api-key': 'test-key' }, {});

      expect(result.isValid).toBe(true);
      expect(result.userId).toBe('extracted-from-key');
      expect(result.scopes).toEqual(['read', 'write']);
    });

    it('should validate BEARER_TOKEN type', () => {
      auth.type = GatewayAuthType.BEARER_TOKEN;

      const result = auth.validateRequest({ authorization: 'Bearer test-token' }, {});

      expect(result.isValid).toBe(true);
      expect(result.userId).toBe('extracted-from-token');
    });

    it('should validate BASIC_AUTH type', () => {
      auth.type = GatewayAuthType.BASIC_AUTH;
      const credentials = Buffer.from('user:pass').toString('base64');

      const result = auth.validateRequest({ authorization: `Basic ${credentials}` }, {});

      expect(result.isValid).toBe(true);
      expect(result.userId).toBe('user');
    });

    it('should validate JWT type', () => {
      auth.type = GatewayAuthType.JWT;
      const payload = Buffer.from(JSON.stringify({ sub: 'user-123', scopes: ['read'] })).toString('base64');
      const token = `header.${payload}.signature`;

      const result = auth.validateRequest({ authorization: `Bearer ${token}` }, {});

      expect(result.isValid).toBe(true);
      expect(result.userId).toBe('user-123');
      expect(result.scopes).toEqual(['read']);
    });

    it('should validate OAUTH2 type', () => {
      auth.type = GatewayAuthType.OAUTH2;

      const result = auth.validateRequest({ authorization: 'Bearer oauth-token' }, {});

      expect(result.isValid).toBe(true);
    });

    it('should return error for unsupported auth type', () => {
      auth.type = GatewayAuthType.CUSTOM;

      const result = auth.validateRequest({}, {});

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Unsupported authentication type');
    });

    it('should catch and handle validation errors', () => {
      auth.type = GatewayAuthType.JWT;

      const result = auth.validateRequest({ authorization: 'Bearer invalid-token' }, {});

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Invalid JWT token');
    });
  });

  describe('validateApiKey', () => {
    beforeEach(() => {
      auth.type = GatewayAuthType.API_KEY;
    });

    it('should validate API key from header', () => {
      const result = auth.validateRequest({ 'x-api-key': 'test-key-123' }, {});

      expect(result.isValid).toBe(true);
    });

    it('should validate API key from query parameter', () => {
      const result = auth.validateRequest({}, { api_key: 'test-key-456' });

      expect(result.isValid).toBe(true);
    });

    it('should prefer header over query parameter', () => {
      const result = auth.validateRequest(
        { 'x-api-key': 'header-key' },
        { api_key: 'query-key' }
      );

      expect(result.isValid).toBe(true);
    });

    it('should return error when API key is missing', () => {
      const result = auth.validateRequest({}, {});

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('API key is required');
    });

    it('should validate key format with regex', () => {
      auth.validationRules = {
        keyFormat: '^sk-[a-z0-9]{32}$',
      };

      const result = auth.validateRequest({ 'x-api-key': 'invalid-format' }, {});

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Invalid API key format');
    });

    it('should accept valid key format', () => {
      auth.validationRules = {
        keyFormat: '^sk-[a-z0-9]{10}$',
      };

      const result = auth.validateRequest({ 'x-api-key': 'sk-abcdef1234' }, {});

      expect(result.isValid).toBe(true);
    });

    it('should use custom header name', () => {
      auth.configuration.keyHeader = 'X-Custom-API-Key';

      const result = auth.validateRequest({ 'x-custom-api-key': 'test-key' }, {});

      expect(result.isValid).toBe(true);
    });

    it('should use custom query parameter name', () => {
      auth.configuration.keyQuery = 'key';

      const result = auth.validateRequest({}, { key: 'test-key' });

      expect(result.isValid).toBe(true);
    });

    it('should return default scopes', () => {
      const result = auth.validateRequest({ 'x-api-key': 'test-key' }, {});

      expect(result.scopes).toEqual(['read', 'write']);
    });

    it('should return empty scopes when not configured', () => {
      auth.configuration.defaultScopes = undefined;

      const result = auth.validateRequest({ 'x-api-key': 'test-key' }, {});

      expect(result.scopes).toEqual([]);
    });
  });

  describe('validateBearerToken', () => {
    beforeEach(() => {
      auth.type = GatewayAuthType.BEARER_TOKEN;
    });

    it('should validate bearer token from lowercase authorization header', () => {
      const result = auth.validateRequest({ authorization: 'Bearer token123' }, {});

      expect(result.isValid).toBe(true);
    });

    it('should validate bearer token from uppercase Authorization header', () => {
      const result = auth.validateRequest({ Authorization: 'Bearer token456' }, {});

      expect(result.isValid).toBe(true);
    });

    it('should return error when authorization header is missing', () => {
      const result = auth.validateRequest({}, {});

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Bearer token is required');
    });

    it('should return error when authorization header does not start with Bearer', () => {
      const result = auth.validateRequest({ authorization: 'Basic token123' }, {});

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Bearer token is required');
    });

    it('should return error when token is empty', () => {
      const result = auth.validateRequest({ authorization: 'Bearer ' }, {});

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Invalid bearer token');
    });

    it('should extract token correctly', () => {
      const result = auth.validateRequest({ authorization: 'Bearer my-token' }, {});

      expect(result.isValid).toBe(true);
      expect(result.userId).toBe('extracted-from-token');
    });
  });

  describe('validateBasicAuth', () => {
    beforeEach(() => {
      auth.type = GatewayAuthType.BASIC_AUTH;
    });

    it('should validate basic auth with valid credentials', () => {
      const credentials = Buffer.from('username:password').toString('base64');

      const result = auth.validateRequest({ authorization: `Basic ${credentials}` }, {});

      expect(result.isValid).toBe(true);
      expect(result.userId).toBe('username');
    });

    it('should return error when authorization header is missing', () => {
      const result = auth.validateRequest({}, {});

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Basic authentication is required');
    });

    it('should return error when authorization header does not start with Basic', () => {
      const result = auth.validateRequest({ authorization: 'Bearer token' }, {});

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Basic authentication is required');
    });

    it('should return error when credentials are missing username', () => {
      const credentials = Buffer.from(':password').toString('base64');

      const result = auth.validateRequest({ authorization: `Basic ${credentials}` }, {});

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Invalid basic auth credentials');
    });

    it('should return error when credentials are missing password', () => {
      const credentials = Buffer.from('username:').toString('base64');

      const result = auth.validateRequest({ authorization: `Basic ${credentials}` }, {});

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Invalid basic auth credentials');
    });

    it('should return error when base64 is invalid', () => {
      const result = auth.validateRequest({ authorization: 'Basic invalid-base64!!!' }, {});

      expect(result.isValid).toBe(false);
      // Invalid base64 still decodes but may result in invalid credentials format
      expect(result.error).toMatch(/Invalid basic auth/);
    });

    it('should handle credentials with special characters', () => {
      const credentials = Buffer.from('user@email.com:p@$$w0rd!').toString('base64');

      const result = auth.validateRequest({ authorization: `Basic ${credentials}` }, {});

      expect(result.isValid).toBe(true);
      expect(result.userId).toBe('user@email.com');
    });
  });

  describe('validateJWT', () => {
    beforeEach(() => {
      auth.type = GatewayAuthType.JWT;
    });

    it('should validate JWT with sub claim', () => {
      const payload = Buffer.from(JSON.stringify({ sub: 'user-123' })).toString('base64');
      const token = `header.${payload}.signature`;

      const result = auth.validateRequest({ authorization: `Bearer ${token}` }, {});

      expect(result.isValid).toBe(true);
      expect(result.userId).toBe('user-123');
    });

    it('should validate JWT with userId claim', () => {
      const payload = Buffer.from(JSON.stringify({ userId: 'user-456' })).toString('base64');
      const token = `header.${payload}.signature`;

      const result = auth.validateRequest({ authorization: `Bearer ${token}` }, {});

      expect(result.isValid).toBe(true);
      expect(result.userId).toBe('user-456');
    });

    it('should extract scopes array from JWT', () => {
      const payload = Buffer.from(JSON.stringify({ sub: 'user', scopes: ['read', 'write'] })).toString('base64');
      const token = `header.${payload}.signature`;

      const result = auth.validateRequest({ authorization: `Bearer ${token}` }, {});

      expect(result.scopes).toEqual(['read', 'write']);
    });

    it('should parse scope string into array', () => {
      const payload = Buffer.from(JSON.stringify({ sub: 'user', scope: 'read write admin' })).toString('base64');
      const token = `header.${payload}.signature`;

      const result = auth.validateRequest({ authorization: `Bearer ${token}` }, {});

      expect(result.scopes).toEqual(['read', 'write', 'admin']);
    });

    it('should return empty scopes when not present', () => {
      const payload = Buffer.from(JSON.stringify({ sub: 'user' })).toString('base64');
      const token = `header.${payload}.signature`;

      const result = auth.validateRequest({ authorization: `Bearer ${token}` }, {});

      expect(result.scopes).toEqual([]);
    });

    it('should return error when JWT header is missing', () => {
      const result = auth.validateRequest({}, {});

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('JWT token is required');
    });

    it('should return error when JWT format is invalid', () => {
      const result = auth.validateRequest({ authorization: 'Bearer invalid-jwt' }, {});

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Invalid JWT token');
    });

    it('should return error when JWT payload is not valid JSON', () => {
      const token = 'header.invalid-base64.signature';

      const result = auth.validateRequest({ authorization: `Bearer ${token}` }, {});

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Invalid JWT token');
    });
  });

  describe('validateOAuth2', () => {
    beforeEach(() => {
      auth.type = GatewayAuthType.OAUTH2;
    });

    it('should delegate to bearer token validation', () => {
      const result = auth.validateRequest({ authorization: 'Bearer oauth-token' }, {});

      expect(result.isValid).toBe(true);
      expect(result.userId).toBe('extracted-from-token');
    });

    it('should return error for missing token', () => {
      const result = auth.validateRequest({}, {});

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Bearer token is required');
    });
  });

  describe('getErrorResponse', () => {
    it('should return unauthorized error response', () => {
      const response = auth.getErrorResponse('unauthorized');

      expect(response.code).toBe(401);
      expect(response.message).toBe('Unauthorized');
    });

    it('should return forbidden error response', () => {
      const response = auth.getErrorResponse('forbidden');

      expect(response.code).toBe(403);
      expect(response.message).toBe('Forbidden');
    });

    it('should return invalid error response', () => {
      const response = auth.getErrorResponse('invalid');

      expect(response.code).toBe(400);
      expect(response.message).toBe('Invalid authentication');
    });

    it('should return custom unauthorized error response', () => {
      auth.errorResponses = {
        unauthorized: {
          code: 401,
          message: 'Custom unauthorized message',
          details: { reason: 'token expired' },
        },
      };

      const response = auth.getErrorResponse('unauthorized');

      expect(response.code).toBe(401);
      expect(response.message).toBe('Custom unauthorized message');
      expect(response.details).toEqual({ reason: 'token expired' });
    });

    it('should return custom forbidden error response', () => {
      auth.errorResponses = {
        forbidden: {
          code: 403,
          message: 'Access denied',
          details: { requiredRole: 'admin' },
        },
      };

      const response = auth.getErrorResponse('forbidden');

      expect(response.message).toBe('Access denied');
      expect(response.details.requiredRole).toBe('admin');
    });

    it('should fall back to default when custom not configured', () => {
      auth.errorResponses = {
        unauthorized: { code: 401, message: 'Custom' },
      };

      const response = auth.getErrorResponse('forbidden');

      expect(response.code).toBe(403);
      expect(response.message).toBe('Forbidden');
    });

    it('should handle null errorResponses', () => {
      auth.errorResponses = null;

      const response = auth.getErrorResponse('unauthorized');

      expect(response.code).toBe(401);
      expect(response.message).toBe('Unauthorized');
    });
  });
});
