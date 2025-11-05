import { Tool, ToolType, ToolStatus } from './tool.entity';

describe('Tool Entity', () => {
  let tool: Tool;

  beforeEach(() => {
    tool = new Tool();
    tool.id = 'tool-1';
    tool.name = 'testTool';
    tool.description = 'A test tool';
    tool.type = ToolType.API;
    tool.status = ToolStatus.ACTIVE;
    tool.parameters = {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    };
    tool.usageCount = 10;
    tool.averageResponseTime = 200;
    tool.lastUsedAt = new Date();
  });

  describe('isActive', () => {
    it('should return true for active tool', () => {
      expect(tool.isActive()).toBe(true);
    });

    it('should return false for inactive tool', () => {
      tool.status = ToolStatus.INACTIVE;
      expect(tool.isActive()).toBe(false);
    });
  });

  describe('canExecute', () => {
    it('should return true for active tool with operation', () => {
      tool.operation = { id: 'op-1', deprecated: false } as any;
      expect(tool.canExecute()).toBe(true);
    });

    it('should return false for inactive tool', () => {
      tool.status = ToolStatus.INACTIVE;
      tool.operation = { id: 'op-1', deprecated: false } as any;
      expect(tool.canExecute()).toBe(false);
    });

    it('should return false for tool without operation', () => {
      tool.operation = null;
      expect(tool.canExecute()).toBeFalsy();
    });

    it('should return false for deprecated operation', () => {
      tool.operation = { id: 'op-1', deprecated: true } as any;
      expect(tool.canExecute()).toBe(false);
    });

    it('should return false for draft status', () => {
      tool.status = ToolStatus.DRAFT;
      tool.operation = { id: 'op-1', deprecated: false } as any;
      expect(tool.canExecute()).toBe(false);
    });

    it('should return false for deprecated status', () => {
      tool.status = ToolStatus.DEPRECATED;
      tool.operation = { id: 'op-1', deprecated: false } as any;
      expect(tool.canExecute()).toBe(false);
    });

    it('should return false for deleted status', () => {
      tool.status = ToolStatus.DELETED;
      tool.operation = { id: 'op-1', deprecated: false } as any;
      expect(tool.canExecute()).toBe(false);
    });
  });

  describe('validateInput', () => {
    it('should validate valid input', () => {
      const result = tool.validateInput({ id: 'test' });
      expect(result.isValid).toBe(true);
    });

    it('should return errors for invalid input', () => {
      const result = tool.validateInput({});
      expect(result.isValid).toBe(false);
    });

    it('should use inputSchema validation if available', () => {
      tool.inputSchema = {
        validate: jest.fn().mockReturnValue({ isValid: true, errors: [] })
      } as any;
      const result = tool.validateInput({ id: 'test' });
      expect(tool.inputSchema.validate).toHaveBeenCalledWith({ id: 'test' });
      expect(result.isValid).toBe(true);
    });

    it('should return schema errors if validation fails', () => {
      tool.inputSchema = {
        validate: jest.fn().mockReturnValue({ isValid: false, errors: ['Schema error'] })
      } as any;
      const result = tool.validateInput({ id: 'test' });
      expect(result.isValid).toBe(false);
      expect(result.errors).toEqual(['Schema error']);
    });

    it('should validate multiple missing required fields', () => {
      tool.parameters = {
        type: 'object',
        properties: { id: { type: 'string' }, name: { type: 'string' } },
        required: ['id', 'name']
      };
      const result = tool.validateInput({});
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Missing required parameter: id');
      expect(result.errors).toContain('Missing required parameter: name');
    });

    it('should return valid when all required fields present', () => {
      tool.parameters = {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id']
      };
      const result = tool.validateInput({ id: 'test', extra: 'value' });
      expect(result.isValid).toBe(true);
    });

    it('should handle non-array required fields', () => {
      tool.parameters = {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: 'id' as any
      };
      const result = tool.validateInput({ id: 'test' });
      expect(result.isValid).toBe(true);
    });

    it('should handle missing parameters object', () => {
      tool.parameters = null;
      const result = tool.validateInput({ id: 'test' });
      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
    });
  });

  describe('getRequiredParameters', () => {
    it('should return required parameters', () => {
      const result = tool.getRequiredParameters();
      expect(result).toEqual(['id']);
    });

    it('should use inputSchema if available', () => {
      tool.inputSchema = {
        getRequiredFields: jest.fn().mockReturnValue(['field1', 'field2'])
      } as any;
      const result = tool.getRequiredParameters();
      expect(tool.inputSchema.getRequiredFields).toHaveBeenCalled();
      expect(result).toEqual(['field1', 'field2']);
    });

    it('should return empty array if no required parameters', () => {
      tool.parameters = { type: 'object', properties: {} };
      const result = tool.getRequiredParameters();
      expect(result).toEqual([]);
    });

    it('should return empty array if parameters is null', () => {
      tool.parameters = null;
      const result = tool.getRequiredParameters();
      expect(result).toEqual([]);
    });
  });

  describe('getOptionalParameters', () => {
    it('should return optional parameters', () => {
      const result = tool.getOptionalParameters();
      expect(result).toEqual([]);
    });

    it('should use inputSchema if available', () => {
      tool.inputSchema = {
        getOptionalFields: jest.fn().mockReturnValue(['opt1', 'opt2'])
      } as any;
      const result = tool.getOptionalParameters();
      expect(tool.inputSchema.getOptionalFields).toHaveBeenCalled();
      expect(result).toEqual(['opt1', 'opt2']);
    });

    it('should return parameters not in required list', () => {
      tool.parameters = {
        type: 'object',
        properties: { id: { type: 'string' }, name: { type: 'string' }, age: { type: 'number' } },
        required: ['id']
      };
      const result = tool.getOptionalParameters();
      expect(result).toContain('name');
      expect(result).toContain('age');
      expect(result).not.toContain('id');
    });

    it('should return empty array if no properties', () => {
      tool.parameters = { type: 'object' };
      const result = tool.getOptionalParameters();
      expect(result).toEqual([]);
    });

    it('should return all properties if none required', () => {
      tool.parameters = {
        type: 'object',
        properties: { id: { type: 'string' }, name: { type: 'string' } }
      };
      const result = tool.getOptionalParameters();
      expect(result).toEqual(['id', 'name']);
    });
  });

  describe('incrementUsage', () => {
    it('should increment usage count', () => {
      const initial = tool.usageCount;
      tool.incrementUsage();
      expect(tool.usageCount).toBe(initial + 1);
    });
  });

  describe('updateMetrics', () => {
    it('should update average response time on success', () => {
      tool.usageCount = 10;
      tool.averageResponseTime = 200;
      tool.updateMetrics(300, true);
      expect(tool.averageResponseTime).toBeGreaterThan(200);
    });

    it('should increase success rate on success', () => {
      tool.successRate = 80;
      tool.usageCount = 10;
      tool.updateMetrics(300, true);
      expect(tool.successRate).toBeGreaterThan(80);
    });

    it('should decrease success rate on failure', () => {
      tool.successRate = 80;
      tool.usageCount = 10;
      tool.updateMetrics(300, false);
      expect(tool.successRate).toBeLessThan(80);
    });

    it('should set response time when usage count is zero', () => {
      tool.usageCount = 0;
      tool.averageResponseTime = 0;
      tool.updateMetrics(500, true);
      expect(tool.averageResponseTime).toBe(500);
    });

    it('should cap success rate at 100', () => {
      tool.successRate = 99.5;
      tool.usageCount = 10;
      for (let i = 0; i < 20; i++) {
        tool.updateMetrics(100, true);
      }
      expect(tool.successRate).toBeLessThanOrEqual(100);
    });

    it('should floor success rate at 0', () => {
      tool.successRate = 5;
      tool.usageCount = 10;
      for (let i = 0; i < 20; i++) {
        tool.updateMetrics(100, false);
      }
      expect(tool.successRate).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getPerformanceRating', () => {
    it('should return excellent for high score', () => {
      tool.successRate = 100;
      tool.averageResponseTime = 100;
      const result = tool.getPerformanceRating();
      expect(result).toBe('excellent');
    });

    it('should return good for medium-high score', () => {
      tool.successRate = 85;
      tool.averageResponseTime = 500;
      const result = tool.getPerformanceRating();
      expect(result).toBe('good');
    });

    it('should return fair for medium score', () => {
      tool.successRate = 70;
      tool.averageResponseTime = 1000;
      const result = tool.getPerformanceRating();
      expect(result).toBe('fair');
    });

    it('should return poor for low score', () => {
      tool.successRate = 50;
      tool.averageResponseTime = 3000;
      const result = tool.getPerformanceRating();
      expect(result).toBe('poor');
    });

    it('should handle very slow response times', () => {
      tool.successRate = 100;
      tool.averageResponseTime = 10000;
      const result = tool.getPerformanceRating();
      expect(['excellent', 'good', 'fair', 'poor']).toContain(result);
    });
  });

  describe('toOpenAPITool', () => {
    it('should convert to OpenAPI format', () => {
      const result = tool.toOpenAPITool();
      expect(result.type).toBe('function');
      expect(result.function.name).toBe('testTool');
      expect(result.function.description).toBe('A test tool');
    });

    it('should handle empty description', () => {
      tool.description = null;
      const result = tool.toOpenAPITool();
      expect(result.function.description).toBe('');
    });

    it('should use default parameters if null', () => {
      tool.parameters = null;
      const result = tool.toOpenAPITool();
      expect(result.function.parameters).toEqual({
        type: 'object',
        properties: {},
      });
    });

    it('should include parameters', () => {
      const result = tool.toOpenAPITool();
      expect(result.function.parameters).toEqual(tool.parameters);
    });
  });

  describe('toAnthropicTool', () => {
    it('should convert to Anthropic format', () => {
      const result = tool.toAnthropicTool();
      expect(result.name).toBe('testTool');
      expect(result.description).toBe('A test tool');
      expect(result.input_schema).toEqual(tool.parameters);
    });

    it('should handle empty description', () => {
      tool.description = null;
      const result = tool.toAnthropicTool();
      expect(result.description).toBe('');
    });

    it('should use default input_schema if null', () => {
      tool.parameters = null;
      const result = tool.toAnthropicTool();
      expect(result.input_schema).toEqual({
        type: 'object',
        properties: {},
      });
    });
  });
});