import { ApiSchema, SchemaFormat } from './api-schema.entity';

describe('ApiSchema Entity', () => {
  let schema: ApiSchema;

  beforeEach(() => {
    schema = new ApiSchema();
    schema.id = 'schema-1';
    schema.apiId = 'api-1';
    schema.version = '1.0.0';
    schema.format = SchemaFormat.JSON;
    schema.rawSchema = '{"openapi": "3.0.0"}';
    schema.schemaHash = 'abc123';
    schema.validationResults = {
      isValid: true,
      warnings: [],
      errors: [],
    };
    schema.statistics = {
      operationCount: 10,
    };
    schema.createdAt = new Date();
  });

  describe('generateHash', () => {
    it('should generate hash when rawSchema is present', () => {
      schema.rawSchema = '{"test": "data"}';
      schema.generateHash();

      expect(schema.schemaHash).toBeDefined();
      expect(schema.schemaHash.length).toBe(64); // SHA-256 produces 64-char hex string
    });

    it('should not generate hash when rawSchema is null', () => {
      schema.rawSchema = null;
      schema.schemaHash = null;
      schema.generateHash();

      expect(schema.schemaHash).toBeNull();
    });

    it('should not generate hash when rawSchema is undefined', () => {
      schema.rawSchema = undefined;
      schema.schemaHash = null;
      schema.generateHash();

      expect(schema.schemaHash).toBeNull();
    });
  });

  describe('isValid', () => {
    it('should return true when validationResults.isValid is true', () => {
      expect(schema.isValid()).toBe(true);
    });

    it('should return false when validationResults.isValid is false', () => {
      schema.validationResults = { isValid: false, warnings: [], errors: [] };
      expect(schema.isValid()).toBe(false);
    });

    it('should return false when validationResults is null', () => {
      schema.validationResults = null;
      expect(schema.isValid()).toBe(false);
    });

    it('should return false when validationResults is undefined', () => {
      schema.validationResults = undefined;
      expect(schema.isValid()).toBe(false);
    });
  });

  describe('hasWarnings', () => {
    it('should return false when no warnings', () => {
      expect(schema.hasWarnings()).toBe(false);
    });

    it('should return true when warnings exist', () => {
      schema.validationResults = {
        isValid: true,
        warnings: [{ path: '/test', message: 'Warning 1' }],
        errors: [],
      };
      expect(schema.hasWarnings()).toBe(true);
    });

    it('should return false when warnings array is null', () => {
      schema.validationResults = { isValid: true, warnings: null, errors: [] };
      expect(schema.hasWarnings()).toBe(false);
    });

    it('should return false when validationResults is null', () => {
      schema.validationResults = null;
      expect(schema.hasWarnings()).toBe(false);
    });
  });

  describe('hasErrors', () => {
    it('should return false when no errors', () => {
      expect(schema.hasErrors()).toBe(false);
    });

    it('should return true when errors exist', () => {
      schema.validationResults = {
        isValid: false,
        warnings: [],
        errors: [{ path: '/test', message: 'Error 1', severity: 'error' }],
      };
      expect(schema.hasErrors()).toBe(true);
    });

    it('should return false when errors array is null', () => {
      schema.validationResults = { isValid: true, warnings: [], errors: null };
      expect(schema.hasErrors()).toBe(false);
    });

    it('should return false when validationResults is null', () => {
      schema.validationResults = null;
      expect(schema.hasErrors()).toBe(false);
    });
  });

  describe('getCriticalErrors', () => {
    it('should return empty array when no errors', () => {
      expect(schema.getCriticalErrors()).toEqual([]);
    });

    it('should filter critical errors', () => {
      schema.validationResults = {
        isValid: false,
        warnings: [],
        errors: [
          { path: '/test1', message: 'Error 1', severity: 'error' },
          { path: '/test2', message: 'Warning 1', severity: 'warning' },
          { path: '/test3', message: 'Error 2', severity: 'error' },
        ],
      };

      const criticalErrors = schema.getCriticalErrors();
      expect(criticalErrors).toHaveLength(2);
      expect(criticalErrors.every(e => e.severity === 'error')).toBe(true);
    });

    it('should return empty array when validationResults is null', () => {
      schema.validationResults = null;
      expect(schema.getCriticalErrors()).toEqual([]);
    });

    it('should return empty array when errors is null', () => {
      schema.validationResults = { isValid: true, warnings: [], errors: null };
      expect(schema.getCriticalErrors()).toEqual([]);
    });
  });

  describe('getOperationCount', () => {
    it('should return operation count when available', () => {
      expect(schema.getOperationCount()).toBe(10);
    });

    it('should return 0 when statistics is null', () => {
      schema.statistics = null;
      expect(schema.getOperationCount()).toBe(0);
    });

    it('should return 0 when statistics is undefined', () => {
      schema.statistics = undefined;
      expect(schema.getOperationCount()).toBe(0);
    });

    it('should return 0 when operationCount is missing', () => {
      schema.statistics = {};
      expect(schema.getOperationCount()).toBe(0);
    });
  });

  describe('hasChanged', () => {
    it('should return false when schemas are identical', () => {
      const newRawSchema = '{"openapi": "3.0.0"}';
      schema.rawSchema = newRawSchema;
      schema.generateHash();

      expect(schema.hasChanged(newRawSchema)).toBe(false);
    });

    it('should return true when schemas are different', () => {
      schema.rawSchema = '{"openapi": "3.0.0"}';
      schema.generateHash();
      const newRawSchema = '{"openapi": "3.1.0"}';

      expect(schema.hasChanged(newRawSchema)).toBe(true);
    });

    it('should handle empty schema change', () => {
      schema.rawSchema = '';
      schema.generateHash();

      expect(schema.hasChanged('{"new": "data"}')).toBe(true);
    });
  });
});
