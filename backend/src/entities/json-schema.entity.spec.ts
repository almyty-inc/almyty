import { JsonSchema, JsonSchemaType } from './json-schema.entity';

describe('JsonSchema Entity', () => {
  describe('validate', () => {
    it('should validate object data against object schema', () => {
      const jsonSchema = new JsonSchema();
      jsonSchema.schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
        required: ['name'],
      };

      const validData = { name: 'John', age: 30 };
      const result = jsonSchema.validate(validData);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect missing required fields', () => {
      const jsonSchema = new JsonSchema();
      jsonSchema.schema = {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          email: { type: 'string' },
        },
        required: ['id', 'email'],
      };

      const invalidData = { name: 'John' };
      const result = jsonSchema.validate(invalidData);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Missing required field: id');
      expect(result.errors).toContain('Missing required field: email');
    });

    it('should detect type mismatch for object schema', () => {
      const jsonSchema = new JsonSchema();
      jsonSchema.schema = {
        type: 'object',
        properties: {},
      };

      const invalidData = 'not an object';
      const result = jsonSchema.validate(invalidData);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Expected object, got string');
    });

    it('should validate when no required fields specified', () => {
      const jsonSchema = new JsonSchema();
      jsonSchema.schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
      };

      const data = {};
      const result = jsonSchema.validate(data);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should validate when required is empty array', () => {
      const jsonSchema = new JsonSchema();
      jsonSchema.schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: [],
      };

      const data = {};
      const result = jsonSchema.validate(data);

      expect(result.isValid).toBe(true);
    });

    it('should handle validation errors gracefully', () => {
      const jsonSchema = new JsonSchema();
      jsonSchema.schema = {
        type: 'object',
      };

      // Pass null - typeof null is 'object' in JavaScript
      const result = jsonSchema.validate(null);

      // null is an object in JavaScript, so this passes basic type check
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should validate with multiple required fields present', () => {
      const jsonSchema = new JsonSchema();
      jsonSchema.schema = {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          email: { type: 'string' },
        },
        required: ['id', 'name', 'email'],
      };

      const validData = { id: '123', name: 'John', email: 'john@test.com' };
      const result = jsonSchema.validate(validData);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should handle array data type correctly', () => {
      const jsonSchema = new JsonSchema();
      jsonSchema.schema = {
        type: 'object',
        properties: {},
      };

      // Arrays are objects in JavaScript
      const arrayData = [1, 2, 3];
      const result = jsonSchema.validate(arrayData);

      expect(result.isValid).toBe(true);
    });
  });

  describe('getRequiredFields', () => {
    it('should return required fields from schema', () => {
      const jsonSchema = new JsonSchema();
      jsonSchema.schema = {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          age: { type: 'number' },
        },
        required: ['id', 'name'],
      };

      const required = jsonSchema.getRequiredFields();

      expect(required).toEqual(['id', 'name']);
    });

    it('should return empty array if no required fields', () => {
      const jsonSchema = new JsonSchema();
      jsonSchema.schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
      };

      const required = jsonSchema.getRequiredFields();

      expect(required).toEqual([]);
    });

    it('should return empty array if required is explicitly empty', () => {
      const jsonSchema = new JsonSchema();
      jsonSchema.schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: [],
      };

      const required = jsonSchema.getRequiredFields();

      expect(required).toEqual([]);
    });
  });

  describe('getOptionalFields', () => {
    it('should return optional fields excluding required ones', () => {
      const jsonSchema = new JsonSchema();
      jsonSchema.schema = {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          age: { type: 'number' },
          email: { type: 'string' },
        },
        required: ['id', 'name'],
      };

      const optional = jsonSchema.getOptionalFields();

      expect(optional).toHaveLength(2);
      expect(optional).toContain('age');
      expect(optional).toContain('email');
      expect(optional).not.toContain('id');
      expect(optional).not.toContain('name');
    });

    it('should return all fields if none are required', () => {
      const jsonSchema = new JsonSchema();
      jsonSchema.schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
          city: { type: 'string' },
        },
      };

      const optional = jsonSchema.getOptionalFields();

      expect(optional).toEqual(['name', 'age', 'city']);
    });

    it('should return empty array if no properties defined', () => {
      const jsonSchema = new JsonSchema();
      jsonSchema.schema = {
        type: 'object',
      };

      const optional = jsonSchema.getOptionalFields();

      expect(optional).toEqual([]);
    });

    it('should return empty array if properties is null', () => {
      const jsonSchema = new JsonSchema();
      jsonSchema.schema = {
        type: 'object',
        properties: null,
      };

      const optional = jsonSchema.getOptionalFields();

      expect(optional).toEqual([]);
    });

    it('should return empty array if all fields are required', () => {
      const jsonSchema = new JsonSchema();
      jsonSchema.schema = {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
        },
        required: ['id', 'name'],
      };

      const optional = jsonSchema.getOptionalFields();

      expect(optional).toEqual([]);
    });
  });

  describe('hasField', () => {
    it('should return true if field exists in properties', () => {
      const jsonSchema = new JsonSchema();
      jsonSchema.schema = {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
        },
      };

      expect(jsonSchema.hasField('id')).toBe(true);
      expect(jsonSchema.hasField('name')).toBe(true);
    });

    it('should return false if field does not exist', () => {
      const jsonSchema = new JsonSchema();
      jsonSchema.schema = {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
      };

      expect(jsonSchema.hasField('name')).toBe(false);
      expect(jsonSchema.hasField('email')).toBe(false);
    });

    it('should return falsy if properties is not defined', () => {
      const jsonSchema = new JsonSchema();
      jsonSchema.schema = {
        type: 'object',
      };

      expect(jsonSchema.hasField('name')).toBeFalsy();
    });

    it('should return falsy if properties is null', () => {
      const jsonSchema = new JsonSchema();
      jsonSchema.schema = {
        type: 'object',
        properties: null,
      };

      expect(jsonSchema.hasField('name')).toBeFalsy();
    });

    it('should handle special characters in field names', () => {
      const jsonSchema = new JsonSchema();
      jsonSchema.schema = {
        type: 'object',
        properties: {
          '@id': { type: 'string' },
          '$schema': { type: 'string' },
          'field-name': { type: 'string' },
        },
      };

      expect(jsonSchema.hasField('@id')).toBe(true);
      expect(jsonSchema.hasField('$schema')).toBe(true);
      expect(jsonSchema.hasField('field-name')).toBe(true);
    });
  });

  describe('generateHash', () => {
    it('should generate SHA256 hash of schema', () => {
      const jsonSchema = new JsonSchema();
      jsonSchema.schema = {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
      };

      jsonSchema.generateHash();

      expect(jsonSchema.schemaHash).toBeDefined();
      expect(jsonSchema.schemaHash).toHaveLength(64); // SHA256 produces 64 hex characters
      expect(jsonSchema.schemaHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should generate same hash for identical schemas', () => {
      const jsonSchema1 = new JsonSchema();
      jsonSchema1.schema = {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
        },
      };

      const jsonSchema2 = new JsonSchema();
      jsonSchema2.schema = {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
        },
      };

      jsonSchema1.generateHash();
      jsonSchema2.generateHash();

      expect(jsonSchema1.schemaHash).toBe(jsonSchema2.schemaHash);
    });

    it('should generate different hashes for different schemas', () => {
      const jsonSchema1 = new JsonSchema();
      jsonSchema1.schema = {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
      };

      const jsonSchema2 = new JsonSchema();
      jsonSchema2.schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
      };

      jsonSchema1.generateHash();
      jsonSchema2.generateHash();

      expect(jsonSchema1.schemaHash).not.toBe(jsonSchema2.schemaHash);
    });

    it('should update hash when schema changes', () => {
      const jsonSchema = new JsonSchema();
      jsonSchema.schema = {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
      };

      jsonSchema.generateHash();
      const firstHash = jsonSchema.schemaHash;

      jsonSchema.schema = {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
        },
      };

      jsonSchema.generateHash();
      const secondHash = jsonSchema.schemaHash;

      expect(firstHash).not.toBe(secondHash);
    });

    it('should handle complex nested schemas', () => {
      const jsonSchema = new JsonSchema();
      jsonSchema.schema = {
        type: 'object',
        properties: {
          user: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              profile: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  age: { type: 'number' },
                },
              },
            },
          },
        },
      };

      jsonSchema.generateHash();

      expect(jsonSchema.schemaHash).toBeDefined();
      expect(jsonSchema.schemaHash).toHaveLength(64);
    });

    it('should handle array schemas', () => {
      const jsonSchema = new JsonSchema();
      jsonSchema.schema = {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
        },
      };

      jsonSchema.generateHash();

      expect(jsonSchema.schemaHash).toBeDefined();
      expect(jsonSchema.schemaHash).toHaveLength(64);
    });

    it('should not generate hash if schema is not defined', () => {
      const jsonSchema = new JsonSchema();
      jsonSchema.schema = null;
      jsonSchema.schemaHash = undefined;

      jsonSchema.generateHash();

      expect(jsonSchema.schemaHash).toBeUndefined();
    });
  });
});
