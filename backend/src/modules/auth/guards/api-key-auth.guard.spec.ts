import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiKeyAuthGuard } from './api-key-auth.guard';

describe('ApiKeyAuthGuard', () => {
  let guard: ApiKeyAuthGuard;
  let reflector: jest.Mocked<Reflector>;

  beforeEach(async () => {
    const mockReflector = {
      getAllAndOverride: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiKeyAuthGuard,
        {
          provide: Reflector,
          useValue: mockReflector,
        },
      ],
    }).compile();

    guard = module.get<ApiKeyAuthGuard>(ApiKeyAuthGuard);
    reflector = module.get(Reflector);
  });

  describe('canActivate', () => {
    it('should allow access to public routes', async () => {
      const mockContext = {
        getHandler: jest.fn(),
        getClass: jest.fn(),
      } as any;

      reflector.getAllAndOverride.mockReturnValue(true);

      const result = guard.canActivate(mockContext);

      expect(result).toBe(true);
      expect(reflector.getAllAndOverride).toHaveBeenCalledWith('isPublic', [
        mockContext.getHandler(),
        mockContext.getClass(),
      ]);
    });

    it('should call super.canActivate for non-public routes', async () => {
      const mockContext = {
        getHandler: jest.fn(),
        getClass: jest.fn(),
      } as any;

      reflector.getAllAndOverride.mockReturnValue(false);

      // Mock the super.canActivate method
      const superCanActivateSpy = jest.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'canActivate');
      superCanActivateSpy.mockReturnValue(true);

      const result = guard.canActivate(mockContext);

      expect(result).toBe(true);
      expect(superCanActivateSpy).toHaveBeenCalledWith(mockContext);
    });

    it('should handle undefined public metadata', async () => {
      const mockContext = {
        getHandler: jest.fn(),
        getClass: jest.fn(),
      } as any;

      reflector.getAllAndOverride.mockReturnValue(undefined);

      const superCanActivateSpy = jest.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'canActivate');
      superCanActivateSpy.mockReturnValue(true);

      const result = guard.canActivate(mockContext);

      expect(result).toBe(true);
      expect(superCanActivateSpy).toHaveBeenCalledWith(mockContext);
    });

    it('should handle null public metadata', async () => {
      const mockContext = {
        getHandler: jest.fn(),
        getClass: jest.fn(),
      } as any;

      reflector.getAllAndOverride.mockReturnValue(null);

      const superCanActivateSpy = jest.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'canActivate');
      superCanActivateSpy.mockReturnValue(true);

      const result = guard.canActivate(mockContext);

      expect(result).toBe(true);
      expect(superCanActivateSpy).toHaveBeenCalledWith(mockContext);
    });
  });

  describe('handleRequest', () => {
    it('should return user when authentication succeeds', () => {
      const mockUser = { id: 'user-1', apiKey: 'valid-key' };

      const result = guard.handleRequest(null, mockUser, null);

      expect(result).toBe(mockUser);
    });

    it('should throw error when user is null', () => {
      expect(() => {
        guard.handleRequest(null, null, null);
      }).toThrow('Invalid API key');
    });

    it('should throw error when user is undefined', () => {
      expect(() => {
        guard.handleRequest(null, undefined, null);
      }).toThrow('Invalid API key');
    });

    it('should throw original error when err is provided', () => {
      const originalError = new Error('Original auth error');

      expect(() => {
        guard.handleRequest(originalError, null, null);
      }).toThrow(originalError);
    });

    it('should throw original error even when user exists', () => {
      const originalError = new Error('Priority error');
      const mockUser = { id: 'user-1' };

      expect(() => {
        guard.handleRequest(originalError, mockUser, null);
      }).toThrow(originalError);
    });

    it('should handle falsy user values', () => {
      expect(() => {
        guard.handleRequest(null, false, null);
      }).toThrow('Invalid API key');

      expect(() => {
        guard.handleRequest(null, 0, null);
      }).toThrow('Invalid API key');

      expect(() => {
        guard.handleRequest(null, '', null);
      }).toThrow('Invalid API key');
    });

    it('should handle user with additional properties', () => {
      const mockUser = {
        id: 'user-1',
        apiKey: 'valid-key',
        email: 'test@example.com',
        isActive: true,
        extraProperty: 'extra-value',
      };

      const result = guard.handleRequest(null, mockUser, null);

      expect(result).toBe(mockUser);
      expect(result.extraProperty).toBe('extra-value');
    });

    it('should handle info parameter', () => {
      const mockUser = { id: 'user-1' };
      const mockInfo = { message: 'Authentication successful' };

      const result = guard.handleRequest(null, mockUser, mockInfo);

      expect(result).toBe(mockUser);
    });
  });

  describe('edge cases', () => {
    it('should handle complex execution context', () => {
      const mockContext = {
        getHandler: jest.fn().mockReturnValue('handler-function'),
        getClass: jest.fn().mockReturnValue('controller-class'),
        switchToHttp: jest.fn(),
        switchToRpc: jest.fn(),
        switchToWs: jest.fn(),
        getType: jest.fn().mockReturnValue('http'),
      } as any;

      reflector.getAllAndOverride.mockReturnValue(true);

      const result = guard.canActivate(mockContext);

      expect(result).toBe(true);
      expect(reflector.getAllAndOverride).toHaveBeenCalledWith('isPublic', [
        'handler-function',
        'controller-class',
      ]);
    });

    it('should handle reflector throwing error', () => {
      const mockContext = {
        getHandler: jest.fn(),
        getClass: jest.fn(),
      } as any;

      reflector.getAllAndOverride.mockImplementation(() => {
        throw new Error('Reflector error');
      });

      expect(() => {
        guard.canActivate(mockContext);
      }).toThrow('Reflector error');
    });
  });
});