import { Api, ApiType, ApiStatus } from './api.entity';
import { ApiSchema } from './api-schema.entity';
import { Operation } from './operation.entity';

describe('Api Entity', () => {
  describe('getLatestSchema', () => {
    it('should return most recently created schema', () => {
      const api = new Api();

      const schema1 = new ApiSchema();
      schema1.createdAt = new Date('2024-01-01');

      const schema2 = new ApiSchema();
      schema2.createdAt = new Date('2024-01-03');

      const schema3 = new ApiSchema();
      schema3.createdAt = new Date('2024-01-02');

      api.schemas = [schema1, schema2, schema3];

      expect(api.getLatestSchema()).toBe(schema2);
    });

    it('should return undefined if no schemas', () => {
      const api = new Api();
      api.schemas = [];

      expect(api.getLatestSchema()).toBeUndefined();
    });

    it('should return undefined if schemas is null', () => {
      const api = new Api();
      api.schemas = null;

      expect(api.getLatestSchema()).toBeUndefined();
    });

    it('should handle single schema', () => {
      const api = new Api();

      const schema = new ApiSchema();
      schema.createdAt = new Date('2024-01-01');

      api.schemas = [schema];

      expect(api.getLatestSchema()).toBe(schema);
    });
  });

  describe('getActiveOperations', () => {
    it('should return only active operations', () => {
      const api = new Api();

      const op1 = new Operation();
      op1.id = 'op-1';
      op1.isActive = true;

      const op2 = new Operation();
      op2.id = 'op-2';
      op2.isActive = false;

      const op3 = new Operation();
      op3.id = 'op-3';
      op3.isActive = true;

      api.operations = [op1, op2, op3];

      const activeOps = api.getActiveOperations();

      expect(activeOps).toHaveLength(2);
      expect(activeOps).toContain(op1);
      expect(activeOps).toContain(op3);
      expect(activeOps).not.toContain(op2);
    });

    it('should return empty array if no operations', () => {
      const api = new Api();
      api.operations = [];

      expect(api.getActiveOperations()).toEqual([]);
    });

    it('should return empty array if operations is null', () => {
      const api = new Api();
      api.operations = null;

      expect(api.getActiveOperations()).toEqual([]);
    });

    it('should return empty array if all operations inactive', () => {
      const api = new Api();

      const op1 = new Operation();
      op1.isActive = false;

      const op2 = new Operation();
      op2.isActive = false;

      api.operations = [op1, op2];

      expect(api.getActiveOperations()).toEqual([]);
    });
  });

  describe('isConfigured', () => {
    it('should return true if status is ACTIVE and has schemas', () => {
      const api = new Api();
      api.status = ApiStatus.ACTIVE;
      api.schemas = [new ApiSchema()];

      expect(api.isConfigured()).toBe(true);
    });

    it('should return false if status is DRAFT', () => {
      const api = new Api();
      api.status = ApiStatus.DRAFT;
      api.schemas = [new ApiSchema()];

      expect(api.isConfigured()).toBe(false);
    });

    it('should return false if status is INACTIVE', () => {
      const api = new Api();
      api.status = ApiStatus.INACTIVE;
      api.schemas = [new ApiSchema()];

      expect(api.isConfigured()).toBe(false);
    });

    it('should return false if status is DEPRECATED', () => {
      const api = new Api();
      api.status = ApiStatus.DEPRECATED;
      api.schemas = [new ApiSchema()];

      expect(api.isConfigured()).toBe(false);
    });

    it('should return false if ACTIVE but no schemas', () => {
      const api = new Api();
      api.status = ApiStatus.ACTIVE;
      api.schemas = [];

      expect(api.isConfigured()).toBe(false);
    });

    it('should return false if ACTIVE but schemas is null', () => {
      const api = new Api();
      api.status = ApiStatus.ACTIVE;
      api.schemas = null;

      expect(api.isConfigured()).toBe(false);
    });
  });

  describe('supportsAuthentication', () => {
    it('should return true for api_key authentication', () => {
      const api = new Api();
      api.authentication = {
        type: 'api_key',
        config: {},
      };

      expect(api.supportsAuthentication()).toBe(true);
    });

    it('should return true for bearer authentication', () => {
      const api = new Api();
      api.authentication = {
        type: 'bearer',
        config: {},
      };

      expect(api.supportsAuthentication()).toBe(true);
    });

    it('should return true for basic authentication', () => {
      const api = new Api();
      api.authentication = {
        type: 'basic',
        config: {},
      };

      expect(api.supportsAuthentication()).toBe(true);
    });

    it('should return true for oauth2 authentication', () => {
      const api = new Api();
      api.authentication = {
        type: 'oauth2',
        config: {},
      };

      expect(api.supportsAuthentication()).toBe(true);
    });

    it('should return false for none authentication', () => {
      const api = new Api();
      api.authentication = {
        type: 'none',
        config: {},
      };

      expect(api.supportsAuthentication()).toBe(false);
    });

    it('should return true if authentication is null', () => {
      const api = new Api();
      api.authentication = null;

      expect(api.supportsAuthentication()).toBe(true);
    });

    it('should return true if authentication is undefined', () => {
      const api = new Api();
      api.authentication = undefined;

      expect(api.supportsAuthentication()).toBe(true);
    });
  });
});
