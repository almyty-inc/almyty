import { Resource, ResourceType } from './resource.entity';

describe('Resource Entity', () => {
  describe('getRequiredProperties', () => {
    it('should return names of required properties', () => {
      const resource = new Resource();
      resource.properties = {
        id: { name: 'id', type: { type: 'string' }, required: true, nullable: false },
        name: { name: 'name', type: { type: 'string' }, required: true, nullable: false },
        email: { name: 'email', type: { type: 'string' }, required: false, nullable: true },
      };

      const required = resource.getRequiredProperties();

      expect(required).toHaveLength(2);
      expect(required).toContain('id');
      expect(required).toContain('name');
      expect(required).not.toContain('email');
    });

    it('should return empty array if no properties', () => {
      const resource = new Resource();
      resource.properties = null;

      expect(resource.getRequiredProperties()).toEqual([]);
    });

    it('should return empty array if all properties optional', () => {
      const resource = new Resource();
      resource.properties = {
        age: { name: 'age', type: { type: 'number' }, required: false, nullable: true },
      };

      expect(resource.getRequiredProperties()).toEqual([]);
    });
  });

  describe('getOptionalProperties', () => {
    it('should return names of optional properties', () => {
      const resource = new Resource();
      resource.properties = {
        id: { name: 'id', type: { type: 'string' }, required: true, nullable: false },
        age: { name: 'age', type: { type: 'number' }, required: false, nullable: true },
        bio: { name: 'bio', type: { type: 'string' }, required: false, nullable: true },
      };

      const optional = resource.getOptionalProperties();

      expect(optional).toHaveLength(2);
      expect(optional).toContain('age');
      expect(optional).toContain('bio');
      expect(optional).not.toContain('id');
    });

    it('should return empty array if no properties', () => {
      const resource = new Resource();
      resource.properties = null;

      expect(resource.getOptionalProperties()).toEqual([]);
    });
  });

  describe('hasProperty', () => {
    it('should return true if property exists', () => {
      const resource = new Resource();
      resource.properties = {
        id: { name: 'id', type: { type: 'string' }, required: true, nullable: false },
      };

      expect(resource.hasProperty('id')).toBe(true);
    });

    it('should return false if property does not exist', () => {
      const resource = new Resource();
      resource.properties = {
        id: { name: 'id', type: { type: 'string' }, required: true, nullable: false },
      };

      expect(resource.hasProperty('name')).toBe(false);
    });

    it('should return falsy if properties is null', () => {
      const resource = new Resource();
      resource.properties = null;

      expect(resource.hasProperty('id')).toBeFalsy();
    });
  });

  describe('getProperty', () => {
    it('should return property definition', () => {
      const resource = new Resource();
      const idProp = { name: 'id', type: { type: 'string' }, required: true, nullable: false };
      resource.properties = { id: idProp };

      expect(resource.getProperty('id')).toBe(idProp);
    });

    it('should return undefined if property does not exist', () => {
      const resource = new Resource();
      resource.properties = {};

      expect(resource.getProperty('id')).toBeUndefined();
    });

    it('should return undefined if properties is null', () => {
      const resource = new Resource();
      resource.properties = null;

      expect(resource.getProperty('id')).toBeUndefined();
    });
  });

  describe('getPropertyType', () => {
    it('should return property type', () => {
      const resource = new Resource();
      resource.properties = {
        id: { name: 'id', type: { type: 'string' }, required: true, nullable: false },
        age: { name: 'age', type: { type: 'number' }, required: false, nullable: true },
      };

      expect(resource.getPropertyType('id')).toBe('string');
      expect(resource.getPropertyType('age')).toBe('number');
    });

    it('should return undefined if property does not exist', () => {
      const resource = new Resource();
      resource.properties = {};

      expect(resource.getPropertyType('id')).toBeUndefined();
    });
  });

  describe('validate', () => {
    it('should validate data successfully', () => {
      const resource = new Resource();
      resource.properties = {
        id: { name: 'id', type: { type: 'string' }, required: true, nullable: false },
        name: { name: 'name', type: { type: 'string' }, required: true, nullable: false },
      };

      const data = { id: '123', name: 'Test' };
      const result = resource.validate(data);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect missing required properties', () => {
      const resource = new Resource();
      resource.properties = {
        id: { name: 'id', type: { type: 'string' }, required: true, nullable: false },
        name: { name: 'name', type: { type: 'string' }, required: true, nullable: false },
      };

      const data = { id: '123' };
      const result = resource.validate(data);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Missing required property: name');
    });

    it('should detect type mismatches', () => {
      const resource = new Resource();
      resource.properties = {
        age: { name: 'age', type: { type: 'number' }, required: true, nullable: false },
      };

      const data = { age: 'not a number' };
      const result = resource.validate(data);

      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('should be number');
    });

    it('should reject non-object data', () => {
      const resource = new Resource();
      resource.properties = {};

      const result = resource.validate('not an object');

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Data must be an object');
    });

    it('should reject null data', () => {
      const resource = new Resource();
      resource.properties = {};

      const result = resource.validate(null);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Data must be an object');
    });

    it('should validate optional properties', () => {
      const resource = new Resource();
      resource.properties = {
        id: { name: 'id', type: { type: 'string' }, required: true, nullable: false },
        age: { name: 'age', type: { type: 'number' }, required: false, nullable: true },
      };

      const data = { id: '123' };
      const result = resource.validate(data);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('toJsonSchema', () => {
    it('should return existing schema if available', () => {
      const resource = new Resource();
      const existingSchema = { type: 'object', title: 'Existing' };
      resource.schema = existingSchema;

      expect(resource.toJsonSchema()).toBe(existingSchema);
    });

    it('should generate JSON schema from properties', () => {
      const resource = new Resource();
      resource.name = 'User';
      resource.description = 'A user object';
      resource.properties = {
        id: { name: 'id', type: { type: 'string' }, required: true, nullable: false, description: 'User ID' },
        age: { name: 'age', type: { type: 'number' }, required: false, nullable: true, description: 'User age' },
      };

      const schema = resource.toJsonSchema();

      expect(schema.type).toBe('object');
      expect(schema.title).toBe('User');
      expect(schema.description).toBe('A user object');
      expect(schema.required).toEqual(['id']);
      expect(schema.properties.id.type).toBe('string');
      expect(schema.properties.id.description).toBe('User ID');
      expect(schema.properties.age.type).toBe('number');
      expect(schema.properties.age.description).toBe('User age');
    });

    it('should handle resource with no properties', () => {
      const resource = new Resource();
      resource.name = 'Empty';
      resource.properties = null;

      const schema = resource.toJsonSchema();

      expect(schema.type).toBe('object');
      expect(schema.title).toBe('Empty');
      expect(schema.required).toEqual([]);
      expect(schema.properties).toEqual({});
    });
  });
});
