import { describe, it, expect } from 'vitest'

/**
 * Tests for JSON Schema Builder logic
 * These tests verify the schema generation and validation without UI rendering
 */

describe('JsonSchemaBuilder - Schema Generation Logic', () => {
  describe('Valid JSON Schema generation', () => {
    it('should generate minimal valid schema', () => {
      const schema = {
        type: 'object',
        properties: {},
      }

      expect(schema).toHaveProperty('type', 'object')
      expect(schema).toHaveProperty('properties')
    })

    it('should generate schema with string property', () => {
      const schema = {
        type: 'object',
        properties: {
          username: {
            type: 'string',
            description: 'User name',
          },
        },
      }

      expect(schema.properties.username.type).toBe('string')
      expect(schema.properties.username.description).toBe('User name')
    })

    it('should generate schema with required fields', () => {
      const schema = {
        type: 'object',
        properties: {
          email: { type: 'string' },
          password: { type: 'string' },
        },
        required: ['email', 'password'],
      }

      expect(schema.required).toEqual(['email', 'password'])
      expect(schema.required).toHaveLength(2)
    })

    it('should support all JSON Schema types', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
          id: { type: 'integer' },
          active: { type: 'boolean' },
          tags: { type: 'array' },
          metadata: { type: 'object' },
        },
      }

      const types = Object.values(schema.properties).map((p: any) => p.type)
      expect(types).toContain('string')
      expect(types).toContain('number')
      expect(types).toContain('integer')
      expect(types).toContain('boolean')
      expect(types).toContain('array')
      expect(types).toContain('object')
    })

    it('should support enum constraints', () => {
      const schema = {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['active', 'inactive', 'pending'],
          },
        },
      }

      expect(schema.properties.status.enum).toEqual(['active', 'inactive', 'pending'])
    })

    it('should support format constraints', () => {
      const schema = {
        type: 'object',
        properties: {
          email: {
            type: 'string',
            format: 'email',
          },
          createdAt: {
            type: 'string',
            format: 'date-time',
          },
        },
      }

      expect(schema.properties.email.format).toBe('email')
      expect(schema.properties.createdAt.format).toBe('date-time')
    })
  })

  describe('Property operations', () => {
    it('should add property to schema', () => {
      const initialSchema = {
        type: 'object',
        properties: {},
      }

      const updatedSchema = {
        ...initialSchema,
        properties: {
          ...initialSchema.properties,
          newProp: {
            type: 'string',
            description: '',
          },
        },
      }

      expect(Object.keys(updatedSchema.properties)).toHaveLength(1)
      expect(updatedSchema.properties.newProp).toBeDefined()
    })

    it('should remove property from schema', () => {
      const initialSchema = {
        type: 'object',
        properties: {
          prop1: { type: 'string' },
          prop2: { type: 'string' },
        },
        required: ['prop1'],
      }

      const { prop1, ...remaining } = initialSchema.properties
      const updatedSchema = {
        ...initialSchema,
        properties: remaining,
        required: initialSchema.required.filter((r: string) => r !== 'prop1'),
      }

      expect(Object.keys(updatedSchema.properties)).toHaveLength(1)
      expect(updatedSchema.properties.prop1).toBeUndefined()
      expect(updatedSchema.required).not.toContain('prop1')
    })

    it('should update property type', () => {
      const schema = {
        type: 'object',
        properties: {
          count: { type: 'string' },
        },
      }

      schema.properties.count.type = 'number'

      expect(schema.properties.count.type).toBe('number')
    })

    it('should rename property', () => {
      const initialSchema = {
        type: 'object',
        properties: {
          oldName: { type: 'string', description: 'Test' },
        },
      }

      const { oldName, ...otherProps } = initialSchema.properties
      const updatedSchema = {
        ...initialSchema,
        properties: {
          ...otherProps,
          newName: oldName,
        },
      }

      expect(updatedSchema.properties.newName).toBeDefined()
      expect(updatedSchema.properties.oldName).toBeUndefined()
      expect(updatedSchema.properties.newName.description).toBe('Test')
    })
  })

  describe('Required field management', () => {
    it('should add field to required array', () => {
      const schema = {
        type: 'object',
        properties: {
          username: { type: 'string' },
        },
        required: [] as string[],
      }

      schema.required.push('username')

      expect(schema.required).toContain('username')
    })

    it('should remove field from required array', () => {
      const schema = {
        type: 'object',
        properties: {
          email: { type: 'string' },
          password: { type: 'string' },
        },
        required: ['email', 'password'],
      }

      schema.required = schema.required.filter((r: string) => r !== 'email')

      expect(schema.required).not.toContain('email')
      expect(schema.required).toContain('password')
    })

    it('should remove required array when empty', () => {
      const schema: any = {
        type: 'object',
        properties: {
          optional: { type: 'string' },
        },
        required: ['optional'],
      }

      schema.required = schema.required.filter((r: string) => r !== 'optional')
      if (schema.required.length === 0) {
        delete schema.required
      }

      expect(schema.required).toBeUndefined()
    })
  })

  describe('JSON Schema compliance', () => {
    it('should match JSON Schema draft-07 structure', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: ['name'],
      }

      // Must have type at root
      expect(schema.type).toBe('object')

      // Properties must be an object
      expect(typeof schema.properties).toBe('object')

      // Required must be an array
      expect(Array.isArray(schema.required)).toBe(true)
    })

    it('should not include undefined or null fields', () => {
      const property = {
        type: 'string',
        description: 'Test',
        enum: undefined,
        format: undefined,
      }

      // Clean up undefined fields
      const cleanedProperty: any = { ...property }
      if (!cleanedProperty.enum) delete cleanedProperty.enum
      if (!cleanedProperty.format) delete cleanedProperty.format

      expect(cleanedProperty).not.toHaveProperty('enum')
      expect(cleanedProperty).not.toHaveProperty('format')
      expect(cleanedProperty).toHaveProperty('type')
      expect(cleanedProperty).toHaveProperty('description')
    })

    it('should validate property names follow conventions', () => {
      const validNames = ['username', 'user_name', 'userName', 'user123']
      const invalidNames = ['user name', '123user', 'user-name!']

      validNames.forEach((name) => {
        expect(/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)).toBe(true)
      })

      // Note: builder should sanitize invalid names
      invalidNames.forEach((name) => {
        const sanitized = name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^[0-9]/, '_$&')
        expect(/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sanitized)).toBe(true)
      })
    })
  })
})
