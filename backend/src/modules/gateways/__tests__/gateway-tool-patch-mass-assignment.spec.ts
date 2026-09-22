import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { GatewayToolService } from '../gateway-tool.service';
import { GatewayToolTransferHelper } from '../gateway-tool-transfer.helper';
import { GatewayToolStatsHelper } from '../gateway-tool-stats.helper';
import { GatewayToolQueriesHelper } from '../gateway-tool-queries.helper';
import {
  UpdateGatewayToolBodyDto,
  updateGatewayToolValidationPipe,
} from '../gateway-tools.controller';
import { GatewayTool } from '../../../entities/gateway-tool.entity';
import { Gateway } from '../../../entities/gateway.entity';
import { Tool } from '../../../entities/tool.entity';
import { User } from '../../../entities/user.entity';
import { AuditLogService } from '../../audit-log/audit-log.service';

// The gateway-tool PATCH took `@Body() updateDto: any` and handed the whole
// object to `Object.assign(gatewayTool, dto)`. `gateway_tools` carries
// `gatewayId` and `toolId` columns, and the org check only validated the row
// as it was found -- nothing re-checked after assignment. So an admin of their
// own org could repoint an association at a foreign org's tool (the listing
// joins `tool` with no org filter), or push their own row onto another org's
// gateway, injecting an attacker-named, attacker-described tool into that
// tenant's gateway listing and from there into the victim's agents and MCP
// clients. These tests assert the unauthorized shapes are *refused*.
describe('gateway-tool PATCH mass assignment', () => {
  const metaFor = (dto: any) => ({
    type: 'body' as const,
    metatype: UpdateGatewayToolBodyDto,
    data: '',
  });

  describe('the HTTP body pipe', () => {
    it('refuses a body that names toolId', async () => {
      await expect(
        updateGatewayToolValidationPipe.transform(
          { isActive: true, toolId: 'foreign-org-tool' },
          metaFor(null),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a body that names gatewayId', async () => {
      await expect(
        updateGatewayToolValidationPipe.transform(
          { isActive: true, gatewayId: 'other-org-gateway' },
          metaFor(null),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a body that names a bookkeeping column', async () => {
      await expect(
        updateGatewayToolValidationPipe.transform({ usageCount: 0 }, metaFor(null)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts the fields that are genuinely configuration', async () => {
      const result = await updateGatewayToolValidationPipe.transform(
        {
          isActive: false,
          overrides: { name: 'renamed' },
          permissions: { allowedRoles: ['admin'] },
          transformations: { inputMapping: { a: 'b' } },
          metadata: { note: 'x' },
          securityPolicy: { requireHttps: true },
        },
        metaFor(null),
      );

      expect(result.isActive).toBe(false);
      expect(result.securityPolicy).toEqual({ requireHttps: true });
    });
  });

  describe('the service, called directly', () => {
    let service: GatewayToolService;
    let gatewayToolRepository: any;
    let userRepository: any;

    const existingRow = () => ({
      id: 'gt-1',
      gatewayId: 'gw-own',
      toolId: 'tool-own',
      isActive: true,
      overrides: null,
      permissions: null,
      transformations: null,
      metadata: null,
      securityPolicy: null,
      usageCount: 17,
      gateway: { id: 'gw-own', organizationId: 'org-attacker' },
      tool: { id: 'tool-own', name: 'own tool' },
    });

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          GatewayToolService,
          {
            provide: getRepositoryToken(GatewayTool),
            useValue: {
              findOne: jest.fn(),
              find: jest.fn(),
              create: jest.fn(),
              save: jest.fn(),
              remove: jest.fn(),
              delete: jest.fn(),
              increment: jest.fn(),
              update: jest.fn(),
              createQueryBuilder: jest.fn(),
            },
          },
          { provide: getRepositoryToken(Gateway), useValue: { findOne: jest.fn() } },
          { provide: getRepositoryToken(Tool), useValue: { findOne: jest.fn(), find: jest.fn() } },
          { provide: getRepositoryToken(User), useValue: { findOne: jest.fn() } },
          {
            provide: AuditLogService,
            useValue: {
              log: jest.fn().mockResolvedValue(null),
              logUpdate: jest.fn().mockResolvedValue(null),
              computeChanges: jest.fn().mockReturnValue([]),
            },
          },
          {
            provide: 'default_IORedisModuleConnectionToken',
            useValue: { del: jest.fn().mockResolvedValue(1) },
          },
          GatewayToolTransferHelper,
          GatewayToolStatsHelper,
          GatewayToolQueriesHelper,
        ],
      }).compile();

      service = module.get(GatewayToolService);
      gatewayToolRepository = module.get(getRepositoryToken(GatewayTool));
      userRepository = module.get(getRepositoryToken(User));

      userRepository.findOne.mockResolvedValue({
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      });
      gatewayToolRepository.save.mockImplementation(async (row: any) => row);
    });

    it('refuses to repoint the association at a foreign org tool', async () => {
      gatewayToolRepository.findOne.mockResolvedValue(existingRow());

      await expect(
        service.updateGatewayTool(
          'gt-1',
          { toolId: 'victim-org-tool' } as any,
          'org-attacker',
          'u-1',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(gatewayToolRepository.save).not.toHaveBeenCalled();
    });

    it("refuses to push the association onto another org's gateway", async () => {
      gatewayToolRepository.findOne.mockResolvedValue(existingRow());

      await expect(
        service.updateGatewayTool(
          'gt-1',
          { gatewayId: 'victim-org-gateway' } as any,
          'org-attacker',
          'u-1',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(gatewayToolRepository.save).not.toHaveBeenCalled();
    });

    it('refuses to re-id the row', async () => {
      gatewayToolRepository.findOne.mockResolvedValue(existingRow());

      await expect(
        service.updateGatewayTool('gt-1', { id: 'gt-victim' } as any, 'org-attacker', 'u-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(gatewayToolRepository.save).not.toHaveBeenCalled();
    });

    it('drops a non-identity column that is not configuration', async () => {
      gatewayToolRepository.findOne.mockResolvedValue(existingRow());

      const saved = await service.updateGatewayTool(
        'gt-1',
        { isActive: false, usageCount: 999999 } as any,
        'org-attacker',
        'u-1',
      );

      expect(saved.isActive).toBe(false);
      expect(saved.usageCount).toBe(17);
    });

    it('still writes the configuration fields it is meant to write', async () => {
      gatewayToolRepository.findOne.mockResolvedValue(existingRow());

      const saved = await service.updateGatewayTool(
        'gt-1',
        { isActive: false, securityPolicy: { requireHttps: true } } as any,
        'org-attacker',
        'u-1',
      );

      expect(saved.isActive).toBe(false);
      expect(saved.securityPolicy).toEqual({ requireHttps: true });
      expect(saved.gatewayId).toBe('gw-own');
      expect(saved.toolId).toBe('tool-own');
    });
  });
});
