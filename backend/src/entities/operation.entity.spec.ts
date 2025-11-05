import { Operation, HttpMethod, OperationType } from './operation.entity';
import { Api } from './api.entity';

describe('Operation Entity', () => {
  describe('getFullEndpoint', () => {
    it('should concatenate baseUrl with endpoint', () => {
      const operation = new Operation();
      operation.endpoint = '/users/{id}';
      operation.api = { baseUrl: 'https://api.example.com' } as Api;

      expect(operation.getFullEndpoint()).toBe('https://api.example.com/users/{id}');
    });

    it('should handle baseUrl with trailing slash', () => {
      const operation = new Operation();
      operation.endpoint = '/users';
      operation.api = { baseUrl: 'https://api.example.com/' } as Api;

      expect(operation.getFullEndpoint()).toBe('https://api.example.com/users');
    });

    it('should handle endpoint without leading slash', () => {
      const operation = new Operation();
      operation.endpoint = 'users';
      operation.api = { baseUrl: 'https://api.example.com' } as Api;

      expect(operation.getFullEndpoint()).toBe('https://api.example.com/users');
    });

    it('should return endpoint alone if no api baseUrl', () => {
      const operation = new Operation();
      operation.endpoint = '/users/{id}';
      operation.api = { baseUrl: null } as Api;

      expect(operation.getFullEndpoint()).toBe('/users/{id}');
    });

    it('should return endpoint if no api object', () => {
      const operation = new Operation();
      operation.endpoint = '/users/{id}';
      operation.api = null;

      expect(operation.getFullEndpoint()).toBe('/users/{id}');
    });
  });

  describe('requiresAuthentication', () => {
    it('should return true if security array has items', () => {
      const operation = new Operation();
      operation.security = [{ 'api_key': [] }];

      expect(operation.requiresAuthentication()).toBe(true);
    });

    it('should return false if security array is empty', () => {
      const operation = new Operation();
      operation.security = [];

      expect(operation.requiresAuthentication()).toBeFalsy();
    });

    it('should return falsy if security is null', () => {
      const operation = new Operation();
      operation.security = null;

      expect(operation.requiresAuthentication()).toBeFalsy();
    });

    it('should return falsy if security is undefined', () => {
      const operation = new Operation();
      operation.security = undefined;

      expect(operation.requiresAuthentication()).toBeFalsy();
    });
  });

  describe('hasParameters', () => {
    it('should return true if has path parameters', () => {
      const operation = new Operation();
      operation.parameters = {
        path: { id: { type: 'string' } },
      };

      expect(operation.hasParameters()).toBe(true);
    });

    it('should return true if has query parameters', () => {
      const operation = new Operation();
      operation.parameters = {
        query: { limit: { type: 'number' } },
      };

      expect(operation.hasParameters()).toBe(true);
    });

    it('should return true if has header parameters', () => {
      const operation = new Operation();
      operation.parameters = {
        header: { 'X-API-Key': { type: 'string' } },
      };

      expect(operation.hasParameters()).toBe(true);
    });

    it('should return true if has body parameters', () => {
      const operation = new Operation();
      operation.parameters = {
        body: { name: { type: 'string' } },
      };

      expect(operation.hasParameters()).toBe(true);
    });

    it('should return false if no parameters', () => {
      const operation = new Operation();
      operation.parameters = {};

      expect(operation.hasParameters()).toBe(false);
    });

    it('should return false if parameters is null', () => {
      const operation = new Operation();
      operation.parameters = null;

      expect(operation.hasParameters()).toBe(false);
    });
  });

  describe('getSuccessResponse', () => {
    it('should return 200 response', () => {
      const operation = new Operation();
      operation.responses = {
        '200': {
          description: 'Success',
          schema: { type: 'object' },
        },
        '404': {
          description: 'Not Found',
        },
      };

      const response = operation.getSuccessResponse();

      expect(response.description).toBe('Success');
      expect(response.schema).toEqual({ type: 'object' });
    });

    it('should return 201 response if 200 not found', () => {
      const operation = new Operation();
      operation.responses = {
        '201': {
          description: 'Created',
        },
        '400': {
          description: 'Bad Request',
        },
      };

      const response = operation.getSuccessResponse();

      expect(response.description).toBe('Created');
    });

    it('should return first 2xx response found', () => {
      const operation = new Operation();
      operation.responses = {
        '204': {
          description: 'No Content',
        },
        '400': {
          description: 'Bad Request',
        },
      };

      const response = operation.getSuccessResponse();

      expect(response.description).toBe('No Content');
    });

    it('should return null if no 2xx responses', () => {
      const operation = new Operation();
      operation.responses = {
        '400': {
          description: 'Bad Request',
        },
        '404': {
          description: 'Not Found',
        },
      };

      const response = operation.getSuccessResponse();

      expect(response).toBeNull();
    });

    it('should return null if no responses', () => {
      const operation = new Operation();
      operation.responses = null;

      const response = operation.getSuccessResponse();

      expect(response).toBeNull();
    });
  });

  describe('isReadOperation', () => {
    it('should return true for GET method', () => {
      const operation = new Operation();
      operation.method = HttpMethod.GET;
      operation.type = OperationType.MUTATION;

      expect(operation.isReadOperation()).toBe(true);
    });

    it('should return true for QUERY type', () => {
      const operation = new Operation();
      operation.method = HttpMethod.POST;
      operation.type = OperationType.QUERY;

      expect(operation.isReadOperation()).toBe(true);
    });

    it('should return false for POST method with MUTATION type', () => {
      const operation = new Operation();
      operation.method = HttpMethod.POST;
      operation.type = OperationType.MUTATION;

      expect(operation.isReadOperation()).toBe(false);
    });

    it('should return false for DELETE method', () => {
      const operation = new Operation();
      operation.method = HttpMethod.DELETE;
      operation.type = OperationType.MUTATION;

      expect(operation.isReadOperation()).toBe(false);
    });
  });

  describe('isWriteOperation', () => {
    it('should return true for POST method', () => {
      const operation = new Operation();
      operation.method = HttpMethod.POST;
      operation.type = OperationType.QUERY;

      expect(operation.isWriteOperation()).toBe(true);
    });

    it('should return true for PUT method', () => {
      const operation = new Operation();
      operation.method = HttpMethod.PUT;
      operation.type = OperationType.QUERY;

      expect(operation.isWriteOperation()).toBe(true);
    });

    it('should return true for PATCH method', () => {
      const operation = new Operation();
      operation.method = HttpMethod.PATCH;
      operation.type = OperationType.QUERY;

      expect(operation.isWriteOperation()).toBe(true);
    });

    it('should return true for DELETE method', () => {
      const operation = new Operation();
      operation.method = HttpMethod.DELETE;
      operation.type = OperationType.QUERY;

      expect(operation.isWriteOperation()).toBe(true);
    });

    it('should return true for MUTATION type', () => {
      const operation = new Operation();
      operation.method = HttpMethod.GET;
      operation.type = OperationType.MUTATION;

      expect(operation.isWriteOperation()).toBe(true);
    });

    it('should return false for GET method with QUERY type', () => {
      const operation = new Operation();
      operation.method = HttpMethod.GET;
      operation.type = OperationType.QUERY;

      expect(operation.isWriteOperation()).toBe(false);
    });

    it('should return false for OPTIONS method', () => {
      const operation = new Operation();
      operation.method = HttpMethod.OPTIONS;
      operation.type = OperationType.QUERY;

      expect(operation.isWriteOperation()).toBe(false);
    });
  });
});
