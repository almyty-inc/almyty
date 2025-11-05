import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new JwtAuthGuard(reflector);
  });

  const createMockContext = (): ExecutionContext => ({
    getHandler: jest.fn(),
    getClass: jest.fn(),
    switchToHttp: jest.fn(),
    getType: jest.fn(),
    getArgs: jest.fn(),
    getArgByIndex: jest.fn(),
    switchToRpc: jest.fn(),
    switchToWs: jest.fn(),
  } as any);

  describe('Real Business Logic - JWT Authentication', () => {
    describe('Public route handling', () => {
      it('should allow access to public routes without authentication', () => {
        jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);

        const mockContext = createMockContext();
        const result = guard.canActivate(mockContext);

        expect(result).toBe(true);
        expect(reflector.getAllAndOverride).toHaveBeenCalledWith('isPublic', [
          mockContext.getHandler(),
          mockContext.getClass(),
        ]);
      });

      it('should check isPublic decorator on handler and class', () => {
        jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);

        const mockContext = createMockContext();
        guard.canActivate(mockContext);

        expect(reflector.getAllAndOverride).toHaveBeenCalledWith('isPublic', [
          mockContext.getHandler(),
          mockContext.getClass(),
        ]);
      });
    });

    describe('Protected route handling', () => {
      it('should call super.canActivate for protected routes', () => {
        jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);

        // Mock the parent canActivate to return true
        const superCanActivateSpy = jest.spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate')
          .mockReturnValue(true);

        const mockContext = createMockContext();
        const result = guard.canActivate(mockContext);

        expect(result).toBe(true);
        expect(superCanActivateSpy).toHaveBeenCalledWith(mockContext);

        superCanActivateSpy.mockRestore();
      });

      it('should call super.canActivate when isPublic is undefined', () => {
        jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);

        const superCanActivateSpy = jest.spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate')
          .mockReturnValue(true);

        const mockContext = createMockContext();
        const result = guard.canActivate(mockContext);

        expect(result).toBe(true);
        expect(superCanActivateSpy).toHaveBeenCalledWith(mockContext);

        superCanActivateSpy.mockRestore();
      });

      it('should call super.canActivate when isPublic is null', () => {
        jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(null);

        const superCanActivateSpy = jest.spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate')
          .mockReturnValue(true);

        const mockContext = createMockContext();
        const result = guard.canActivate(mockContext);

        expect(result).toBe(true);
        expect(superCanActivateSpy).toHaveBeenCalledWith(mockContext);

        superCanActivateSpy.mockRestore();
      });
    });

    describe('handleRequest - Token validation', () => {
      it('should return user when authentication is successful', () => {
        const mockUser = {
          id: 'user-1',
          email: 'test@example.com',
        };

        const mockContext = createMockContext();
        const result = guard.handleRequest(null, mockUser, null, mockContext);

        expect(result).toEqual(mockUser);
      });

      it('should throw UnauthorizedException when user is null', () => {
        const mockContext = createMockContext();

        expect(() => guard.handleRequest(null, null, null, mockContext)).toThrow(
          new UnauthorizedException('Invalid token')
        );
      });

      it('should throw UnauthorizedException when user is undefined', () => {
        const mockContext = createMockContext();

        expect(() => guard.handleRequest(null, undefined, null, mockContext)).toThrow(
          new UnauthorizedException('Invalid token')
        );
      });

      it('should throw UnauthorizedException when user is false', () => {
        const mockContext = createMockContext();

        expect(() => guard.handleRequest(null, false, null, mockContext)).toThrow(
          new UnauthorizedException('Invalid token')
        );
      });

      it('should throw error when error is provided', () => {
        const mockError = new UnauthorizedException('Token expired');
        const mockContext = createMockContext();

        expect(() => guard.handleRequest(mockError, null, null, mockContext)).toThrow(
          mockError
        );
      });

      it('should prioritize error over missing user', () => {
        const mockError = new UnauthorizedException('Token malformed');
        const mockContext = createMockContext();

        expect(() => guard.handleRequest(mockError, null, null, mockContext)).toThrow(
          mockError
        );
      });

      it('should throw error even when user is present', () => {
        const mockError = new UnauthorizedException('Token blacklisted');
        const mockUser = { id: 'user-1' };
        const mockContext = createMockContext();

        expect(() => guard.handleRequest(mockError, mockUser, null, mockContext)).toThrow(
          mockError
        );
      });

      it('should return user with all properties intact', () => {
        const mockUser = {
          id: 'user-1',
          email: 'test@example.com',
          firstName: 'Test',
          lastName: 'User',
          organizationMemberships: [
            { organizationId: 'org-1', role: 'owner' },
          ],
        };

        const mockContext = createMockContext();
        const result = guard.handleRequest(null, mockUser, null, mockContext);

        expect(result).toEqual(mockUser);
        expect(result).toHaveProperty('organizationMemberships');
      });
    });

    describe('Real-world authentication scenarios', () => {
      it('should handle info parameter from passport strategy', () => {
        const mockUser = { id: 'user-1' };
        const mockInfo = { message: 'jwt expired' };
        const mockContext = createMockContext();

        const result = guard.handleRequest(null, mockUser, mockInfo, mockContext);

        expect(result).toEqual(mockUser);
      });

      it('should throw UnauthorizedException with info when user is missing', () => {
        const mockInfo = { message: 'jwt malformed' };
        const mockContext = createMockContext();

        expect(() => guard.handleRequest(null, null, mockInfo, mockContext)).toThrow(
          new UnauthorizedException('Invalid token')
        );
      });
    });
  });
});
