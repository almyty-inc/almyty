import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';

import { McpController } from '../mcp.controller';
import { McpTransportController } from '../controllers/mcp-transport.controller';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator';
import { OrganizationRole } from '../../../entities/user-organization.entity';

// The MCP JSON-RPC surface carried @UseGuards(JwtAuthGuard) and nothing else:
// no RolesGuard, no @Roles. A `viewer` -- whose whole permission set is
// ['read', 'connections:read'] -- could therefore POST /mcp/tools/call, or
// POST /mcp with method 'tools/call', and execute any tool in the org,
// reaching the third-party APIs those tools front with the org's stored
// credentials on the org's bill. The dashboard equivalent,
// tools.controller.ts, gates list, read and execute alike at member+.
//
// Note RolesGuard returns true when neither @Roles nor @Permissions is
// present, so bolting the guard on without the decorator would have changed
// nothing -- these tests exercise the guard against the real metadata.
describe('MCP surface role gate', () => {
  const guard = new RolesGuard(new Reflector());

  const contextFor = (
    controller: any,
    handler: string,
    role: OrganizationRole,
  ): ExecutionContext => {
    const membership = {
      organizationId: 'org-1',
      role,
      hasPermission: () => role !== OrganizationRole.VIEWER,
    };
    const request = {
      method: 'POST',
      url: '/mcp',
      params: {},
      user: {
        id: 'u-1',
        currentOrganizationId: 'org-1',
        organizationMemberships: [membership],
      },
    };
    return {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => controller.prototype[handler],
      getClass: () => controller,
    } as unknown as ExecutionContext;
  };

  // Every authenticated handler on McpController.
  const mcpHandlers = [
    'handleMcp',
    'initialize',
    'ping',
    'handleNotifications',
    'listTools',
    'callTool',
    'discoverTools',
    'searchTools',
    'getToolDetails',
    'listSkills',
    'getSkill',
    'listResources',
    'readResource',
    'listPrompts',
    'getPrompt',
  ] as const;

  const transportHandlers = [
    'streamablePost',
    'streamableStream',
    'handleSse',
    'sendSseMessage',
    'handleServerSse',
    'getTransportStats',
  ] as const;

  describe('McpController', () => {
    it.each(mcpHandlers)('%s declares @Roles', (handler) => {
      const roles = Reflect.getMetadata(ROLES_KEY, McpController.prototype[handler]);
      expect(roles).toEqual(['member', 'admin', 'owner']);
    });

    it.each(mcpHandlers)('%s refuses a viewer', (handler) => {
      expect(() =>
        guard.canActivate(contextFor(McpController, handler, OrganizationRole.VIEWER)),
      ).toThrow(ForbiddenException);
    });

    it.each(mcpHandlers)('%s still admits a member', (handler) => {
      expect(guard.canActivate(contextFor(McpController, handler, OrganizationRole.MEMBER))).toBe(
        true,
      );
    });

    it('leaves the unauthenticated probes ungated', () => {
      expect(Reflect.getMetadata(ROLES_KEY, McpController.prototype.health)).toBeUndefined();
      expect(Reflect.getMetadata(ROLES_KEY, McpController.prototype.wellKnown)).toBeUndefined();
    });
  });

  describe('McpTransportController', () => {
    it.each(transportHandlers)('%s refuses a viewer', (handler) => {
      expect(
        () => guard.canActivate(contextFor(McpTransportController, handler, OrganizationRole.VIEWER)),
      ).toThrow(ForbiddenException);
    });

    it('broadcast sits at admin+, so a member is refused too', () => {
      expect(Reflect.getMetadata(ROLES_KEY, McpTransportController.prototype.broadcast)).toEqual([
        'admin',
        'owner',
      ]);
      expect(() =>
        guard.canActivate(contextFor(McpTransportController, 'broadcast', OrganizationRole.MEMBER)),
      ).toThrow(ForbiddenException);
      expect(
        guard.canActivate(contextFor(McpTransportController, 'broadcast', OrganizationRole.ADMIN)),
      ).toBe(true);
    });

    it('leaves the transport health probe ungated', () => {
      expect(
        Reflect.getMetadata(ROLES_KEY, McpTransportController.prototype.getTransportHealth),
      ).toBeUndefined();
    });
  });
});
