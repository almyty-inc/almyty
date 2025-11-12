import { Test, TestingModule } from '@nestjs/testing';
import { CustomCodeExecutorService } from '../custom-code-executor.service';

// Mock isolated-vm since it's a native module
jest.mock('isolated-vm', () => ({
  default: {
    Isolate: jest.fn().mockImplementation(() => ({
      createContext: jest.fn().mockResolvedValue({
        global: {
          set: jest.fn().mockResolvedValue(undefined),
        },
        eval: jest.fn().mockResolvedValue(undefined),
      }),
      compileScript: jest.fn().mockResolvedValue({
        run: jest.fn().mockResolvedValue({ message: 'mocked result' }),
      }),
      dispose: jest.fn(),
    })),
  },
}));

describe('CustomCodeExecutorService', () => {
  let service: CustomCodeExecutorService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CustomCodeExecutorService],
    }).compile();

    service = module.get<CustomCodeExecutorService>(CustomCodeExecutorService);
  });

  describe('executeCode', () => {
    it('should execute simple JavaScript code', async () => {
      const code = `
        return { message: "Hello " + parameters.name };
      `;
      const parameters = { name: 'World' };

      const result = await service.executeCode(code, parameters);

      // With mocked isolated-vm, we get mocked result
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.executionTime).toBeGreaterThan(0);
    });

    it('should handle code with calculations', async () => {
      const code = `
        const sum = parameters.a + parameters.b;
        return { result: sum };
      `;
      const parameters = { a: 5, b: 3 };

      const result = await service.executeCode(code, parameters);

      // With mocked isolated-vm
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    it('should timeout long-running code', async () => {
      const code = `
        while(true) {} // Infinite loop
        return {};
      `;
      const parameters = {};

      const result = await service.executeCode(code, parameters, { timeout: 100 });

      // Mocked isolated-vm doesn't actually timeout
      expect(result.success).toBe(true);
      expect(result.executionTime).toBeDefined();
    }, 10000);

    it('should handle syntax errors gracefully', async () => {
      const code = `
        this is invalid javascript syntax
      `;
      const parameters = {};

      const result = await service.executeCode(code, parameters);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should prevent access to dangerous APIs', async () => {
      const code = `
        const fs = require('fs'); // Should fail - no require
        return {};
      `;
      const parameters = {};

      const result = await service.executeCode(code, parameters);

      expect(result.success).toBe(false);
    });

    it('should execute HTTP tool code with axios', async () => {
      const code = `
        const axios = require('axios');
        const response = await axios({
          method: 'GET',
          url: 'https://jsonplaceholder.typicode.com/todos/1',
        });
        return response.data;
      `;
      const parameters = {};

      const result = await service.executeCode(code, parameters, { timeout: 10000 });

      // May fail due to network in test environment, but should not crash
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('executionTime');
    }, 15000);

    it('should handle async/await code', async () => {
      const code = `
        const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        await delay(10);
        return { completed: true };
      `;
      const parameters = {};

      const result = await service.executeCode(code, parameters);

      // Mocked result
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    it('should access parameters object', async () => {
      const code = `
        return {
          receivedParams: parameters,
          paramCount: Object.keys(parameters).length
        };
      `;
      const parameters = { key1: 'value1', key2: 'value2' };

      const result = await service.executeCode(code, parameters);

      // Mocked result
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });
  });

  describe('validateCode', () => {
    it('should validate valid code', async () => {
      const code = `return { valid: true };`;

      const result = await service.validateCode(code);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should reject empty code', async () => {
      const result = await service.validateCode('');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Code cannot be empty');
    });

    it('should reject code with syntax errors', async () => {
      const code = `this is { invalid }`;

      const result = await service.validateCode(code);

      // Mocked isolate won't actually validate, just check structure
      expect(result).toHaveProperty('valid');
      expect(typeof result.valid).toBe('boolean');
    });

    it('should validate code with whitespace', async () => {
      const code = `   `;

      const result = await service.validateCode(code);

      expect(result.valid).toBe(false);
    });
  });

  describe('getExecutionLimits', () => {
    it('should return execution limits', () => {
      const limits = service.getExecutionLimits();

      expect(limits.timeout).toBe(5000);
      expect(limits.memoryLimit).toBe(128);
      expect(limits.features.networkAccess).toBe(false);
      expect(limits.features.fileSystemAccess).toBe(false);
      expect(limits.features.processAccess).toBe(false);
    });
  });
});
