import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { GatewayToolService } from './gateway-tool.service';
import { GatewayToolTransferHelper } from './gateway-tool-transfer.helper';
import { GatewayToolStatsHelper } from './gateway-tool-stats.helper';
import { GatewayToolQueriesHelper } from './gateway-tool-queries.helper';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { Gateway } from '../../entities/gateway.entity';
import { Tool, ToolStatus } from '../../entities/tool.entity';
import { User } from '../../entities/user.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { fakeRepository } from '../../test/fake-repository';
import {
  ClauseModel,
  ExecutedQuery,
  RecordingQueryBuilder,
  clause,
  matchingRows,
  organizationScope,
} from './__tests__/recording-query-builder';

describe('GatewayToolService', () => {
  let service: GatewayToolService;
  let gatewayToolRepository: any;
  let gatewayRepository: any;
  let toolRepository: any;
  let userRepository: any;

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
        {
          provide: getRepositoryToken(Gateway),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Tool),
          useValue: {
            findOne: jest.fn(),
            find: jest.fn(),
            createQueryBuilder: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(User),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: AuditLogService,
          useValue: {
            log: jest.fn().mockResolvedValue(null),
            logCreate: jest.fn().mockResolvedValue(null),
            logUpdate: jest.fn().mockResolvedValue(null),
            logDelete: jest.fn().mockResolvedValue(null),
            logToolExecution: jest.fn().mockResolvedValue(null),
            logGatewayRequest: jest.fn().mockResolvedValue(null),
            logRunEvent: jest.fn().mockResolvedValue(null),
            computeChanges: jest.fn().mockReturnValue([]),
            findAll: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 50, totalPages: 0 }),
            getResourceHistory: jest.fn().mockResolvedValue([]),
          },
        },
        {
          // GatewayToolService now busts the UTCP manual Redis cache
          // on every assignment / dissociation so the served manual
          // is consistent with the gateway's tools. Tests provide a
          // stub Redis that records the del calls.
          provide: 'default_IORedisModuleConnectionToken',
          useValue: { del: jest.fn().mockResolvedValue(1) },
        },
        GatewayToolTransferHelper,
        GatewayToolStatsHelper,
        GatewayToolQueriesHelper,
      ],
    }).compile();

    service = module.get<GatewayToolService>(GatewayToolService);
    gatewayToolRepository = module.get(getRepositoryToken(GatewayTool));
    gatewayRepository = module.get(getRepositoryToken(Gateway));
    toolRepository = module.get(getRepositoryToken(Tool));
    userRepository = module.get(getRepositoryToken(User));
    redis = module.get('default_IORedisModuleConnectionToken');
  });

  let redis: any;

  describe('UTCP manual cache invalidation', () => {
    // Bug 9: the UTCP manual is Redis-cached for 5 min keyed by
    // gatewayId. Every gateway-tool mutation must bust that key
    // or clients see stale tools (or stale absences) for up to
    // 5 minutes after a change.
    const baseUser = { hasPermissionInOrganization: jest.fn().mockReturnValue(true) };

    beforeEach(() => {
      gatewayRepository.findOne.mockResolvedValue({ id: 'gw-1', organizationId: 'org-1', name: 'GW' });
      userRepository.findOne.mockResolvedValue(baseUser);
    });

    it('busts the manual cache after associateTool', async () => {
      toolRepository.findOne.mockResolvedValue({ id: 'tool-1', name: 't', status: ToolStatus.ACTIVE });
      gatewayToolRepository.findOne.mockResolvedValue(null);
      gatewayToolRepository.create.mockReturnValue({ id: 'gt-1', gatewayId: 'gw-1', toolId: 'tool-1' });
      gatewayToolRepository.save.mockResolvedValue({ id: 'gt-1', gatewayId: 'gw-1', toolId: 'tool-1' });

      await service.associateTool('gw-1', { toolId: 'tool-1' } as any, 'org-1', 'u-1');

      expect(redis.del).toHaveBeenCalledWith('utcp:manual:gw:gw-1');
    });

    it('busts the manual cache after dissociateTool', async () => {
      gatewayToolRepository.findOne.mockResolvedValue({
        id: 'gt-1',
        gatewayId: 'gw-1',
        gateway: { id: 'gw-1', organizationId: 'org-1', name: 'GW' },
        tool: { id: 'tool-1', name: 't' },
      });

      await service.dissociateTool('gt-1', 'org-1', 'u-1');

      expect(redis.del).toHaveBeenCalledWith('utcp:manual:gw:gw-1');
    });

    it('busts the manual cache after activateGatewayTool / deactivateGatewayTool', async () => {
      const gt = { id: 'gt-1', gatewayId: 'gw-1', isActive: false, gateway: { id: 'gw-1', organizationId: 'org-1' } };
      gatewayToolRepository.findOne.mockResolvedValue(gt);
      gatewayToolRepository.save.mockImplementation(async (x: any) => x);

      await service.activateGatewayTool('gt-1', 'org-1', 'u-1');
      expect(redis.del).toHaveBeenCalledWith('utcp:manual:gw:gw-1');

      redis.del.mockClear();
      gt.isActive = true;
      await service.deactivateGatewayTool('gt-1', 'org-1', 'u-1');
      expect(redis.del).toHaveBeenCalledWith('utcp:manual:gw:gw-1');
    });

    it('busts the manual cache after removeAllTools', async () => {
      gatewayToolRepository.delete.mockResolvedValue({ affected: 5 });
      await service.removeAllTools('gw-1', 'org-1');
      expect(redis.del).toHaveBeenCalledWith('utcp:manual:gw:gw-1');
    });
  });

  describe('associateTool', () => {
    const createGatewayToolDto = {
      toolId: 'tool-1',
      isActive: true,
      overrides: {
        name: 'Custom Tool Name',
        description: 'Custom description',
      },
      permissions: {
        allowedUsers: ['user-1'],
        allowedRoles: ['admin'],
      },
    };

    it('should associate tool with gateway successfully', async () => {
      const mockGateway = {
        id: 'gateway-1',
        name: 'Test Gateway',
        organizationId: 'org-1',
      };

      const mockTool = {
        id: 'tool-1',
        name: 'Test Tool',
        status: ToolStatus.ACTIVE,
      };

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      };

      const mockGatewayTool = {
        id: 'gateway-tool-1',
        gatewayId: 'gateway-1',
        toolId: 'tool-1',
        isActive: true,
        overrides: createGatewayToolDto.overrides,
        permissions: createGatewayToolDto.permissions,
      };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      toolRepository.findOne.mockResolvedValue(mockTool);
      userRepository.findOne.mockResolvedValue(mockUser);
      gatewayToolRepository.findOne.mockResolvedValue(null); // No existing association
      gatewayToolRepository.create.mockReturnValue(mockGatewayTool);
      gatewayToolRepository.save.mockResolvedValue(mockGatewayTool);

      const result = await service.associateTool('gateway-1', createGatewayToolDto, 'org-1', 'user-1');

      expect(result).toBe(mockGatewayTool);
      expect(gatewayRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'gateway-1', organizationId: 'org-1' },
      });
      // Org-scoped, like the gateway lookup above it. Unscoped, an
      // org-A admin holding an org-B tool uuid could write a
      // cross-tenant gateway_tools row — and that table has no
      // organization column, so nothing below rejected it either.
      expect(toolRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'tool-1', organizationId: 'org-1' },
      });
      expect(gatewayToolRepository.create).toHaveBeenCalledWith({
        gatewayId: 'gateway-1',
        ...createGatewayToolDto,
        isActive: true,
      });
      expect(gatewayToolRepository.save).toHaveBeenCalledWith(mockGatewayTool);
    });

    it('should throw NotFoundException when gateway not found', async () => {
      gatewayRepository.findOne.mockResolvedValue(null);

      await expect(
        service.associateTool('gateway-1', createGatewayToolDto, 'org-1', 'user-1')
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when tool not found', async () => {
      const mockGateway = { id: 'gateway-1', organizationId: 'org-1' };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      toolRepository.findOne.mockResolvedValue(null);

      await expect(
        service.associateTool('gateway-1', createGatewayToolDto, 'org-1', 'user-1')
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException for inactive tool', async () => {
      const mockGateway = { id: 'gateway-1', organizationId: 'org-1' };
      const mockTool = { id: 'tool-1', status: ToolStatus.INACTIVE };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      toolRepository.findOne.mockResolvedValue(mockTool);

      await expect(
        service.associateTool('gateway-1', createGatewayToolDto, 'org-1', 'user-1')
      ).rejects.toThrow(BadRequestException);
    });

    it('names draft, and the bulk activation that clears it, when refusing a generated tool', async () => {
      // 'Can only associate active tools' never said which state the
      // tool was in or where to change it -- and since every tool
      // generated from a schema is a draft, this is the first refusal a
      // new user sees on the advertised path.
      const mockGateway = { id: 'gateway-1', organizationId: 'org-1' };
      const mockTool = { id: 'tool-1', name: 'listPets', status: ToolStatus.DRAFT };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      toolRepository.findOne.mockResolvedValue(mockTool);

      await expect(
        service.associateTool('gateway-1', createGatewayToolDto, 'org-1', 'user-1')
      ).rejects.toThrow(BadRequestException);

      const error = await service
        .associateTool('gateway-1', createGatewayToolDto, 'org-1', 'user-1')
        .catch((e) => e);
      expect(error.message).toContain('listPets');
      expect(error.message).toContain('draft');
      expect(error.message).toContain('Activate selected');
    });

    it('should throw BadRequestException for existing association', async () => {
      const mockGateway = { id: 'gateway-1', organizationId: 'org-1' };
      const mockTool = { id: 'tool-1', status: ToolStatus.ACTIVE };
      const existingAssociation = { id: 'existing-1' };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      toolRepository.findOne.mockResolvedValue(mockTool);
      gatewayToolRepository.findOne.mockResolvedValue(existingAssociation);

      await expect(
        service.associateTool('gateway-1', createGatewayToolDto, 'org-1', 'user-1')
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw ForbiddenException for insufficient permissions', async () => {
      const mockGateway = { id: 'gateway-1', organizationId: 'org-1' };
      const mockTool = { id: 'tool-1', status: ToolStatus.ACTIVE };
      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(false),
      };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      toolRepository.findOne.mockResolvedValue(mockTool);
      gatewayToolRepository.findOne.mockResolvedValue(null);
      userRepository.findOne.mockResolvedValue(mockUser);

      await expect(
        service.associateTool('gateway-1', createGatewayToolDto, 'org-1', 'user-1')
      ).rejects.toThrow(ForbiddenException);
    });

    it('should default isActive to true when not specified', async () => {
      const dtoWithoutActive = {
        toolId: 'tool-1',
        overrides: { name: 'Custom Name' },
      };

      const mockGateway = { id: 'gateway-1', name: 'Test Gateway', organizationId: 'org-1' };
      const mockTool = { id: 'tool-1', name: 'Test Tool', status: ToolStatus.ACTIVE };
      const mockUser = { id: 'user-1', hasPermissionInOrganization: jest.fn().mockReturnValue(true) };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      toolRepository.findOne.mockResolvedValue(mockTool);
      userRepository.findOne.mockResolvedValue(mockUser);
      gatewayToolRepository.findOne.mockResolvedValue(null);
      gatewayToolRepository.create.mockReturnValue({ id: 'new-association' });
      gatewayToolRepository.save.mockResolvedValue({ id: 'new-association' });

      await service.associateTool('gateway-1', dtoWithoutActive, 'org-1', 'user-1');

      expect(gatewayToolRepository.create).toHaveBeenCalledWith({
        gatewayId: 'gateway-1',
        ...dtoWithoutActive,
        isActive: true,
      });
    });

    it('should handle database save errors', async () => {
      const mockGateway = { id: 'gateway-1', name: 'Test Gateway', organizationId: 'org-1' };
      const mockTool = { id: 'tool-1', name: 'Test Tool', status: ToolStatus.ACTIVE };
      const mockUser = { id: 'user-1', hasPermissionInOrganization: jest.fn().mockReturnValue(true) };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      toolRepository.findOne.mockResolvedValue(mockTool);
      userRepository.findOne.mockResolvedValue(mockUser);
      gatewayToolRepository.findOne.mockResolvedValue(null);
      gatewayToolRepository.create.mockReturnValue({});
      gatewayToolRepository.save.mockRejectedValue(new Error('Database error'));

      await expect(
        service.associateTool('gateway-1', createGatewayToolDto, 'org-1', 'user-1')
      ).rejects.toThrow('Database error');
    });
  });

  describe('updateGatewayTool', () => {
    const updateDto = {
      isActive: false,
      overrides: {
        name: 'Updated Name',
        timeout: 30000,
      },
    };

    it('should update gateway tool successfully', async () => {
      const mockGatewayTool = {
        id: 'gateway-tool-1',
        gateway: { organizationId: 'org-1' },
        tool: { name: 'Test Tool' },
        isActive: true,
      };

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      };

      const updatedGatewayTool = { ...mockGatewayTool, ...updateDto };

      gatewayToolRepository.findOne.mockResolvedValue(mockGatewayTool);
      userRepository.findOne.mockResolvedValue(mockUser);
      gatewayToolRepository.save.mockResolvedValue(updatedGatewayTool);

      const result = await service.updateGatewayTool('gateway-tool-1', updateDto, 'org-1', 'user-1');

      expect(result).toBe(updatedGatewayTool);
      expect(gatewayToolRepository.save).toHaveBeenCalled();
    });

    it('should throw NotFoundException when gateway tool not found', async () => {
      gatewayToolRepository.findOne.mockResolvedValue(null);

      await expect(
        service.updateGatewayTool('gateway-tool-1', updateDto, 'org-1', 'user-1')
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException for wrong organization', async () => {
      const mockGatewayTool = {
        id: 'gateway-tool-1',
        gateway: { organizationId: 'wrong-org' },
      };

      gatewayToolRepository.findOne.mockResolvedValue(mockGatewayTool);

      await expect(
        service.updateGatewayTool('gateway-tool-1', updateDto, 'org-1', 'user-1')
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException for insufficient permissions', async () => {
      const mockGatewayTool = {
        id: 'gateway-tool-1',
        gateway: { organizationId: 'org-1' },
      };

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(false),
      };

      gatewayToolRepository.findOne.mockResolvedValue(mockGatewayTool);
      userRepository.findOne.mockResolvedValue(mockUser);

      await expect(
        service.updateGatewayTool('gateway-tool-1', updateDto, 'org-1', 'user-1')
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('dissociateTool', () => {
    it('should dissociate tool successfully', async () => {
      const mockGatewayTool = {
        id: 'gateway-tool-1',
        gateway: { organizationId: 'org-1', name: 'Test Gateway' },
        tool: { name: 'Test Tool' },
      };

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      };

      gatewayToolRepository.findOne.mockResolvedValue(mockGatewayTool);
      userRepository.findOne.mockResolvedValue(mockUser);
      gatewayToolRepository.remove.mockResolvedValue(undefined);

      await service.dissociateTool('gateway-tool-1', 'org-1', 'user-1');

      expect(gatewayToolRepository.remove).toHaveBeenCalledWith(mockGatewayTool);
    });

    it('should throw NotFoundException when gateway tool not found', async () => {
      gatewayToolRepository.findOne.mockResolvedValue(null);

      await expect(
        service.dissociateTool('gateway-tool-1', 'org-1', 'user-1')
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException for insufficient permissions', async () => {
      const mockGatewayTool = {
        id: 'gateway-tool-1',
        gateway: { organizationId: 'org-1' },
      };

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(false),
      };

      gatewayToolRepository.findOne.mockResolvedValue(mockGatewayTool);
      userRepository.findOne.mockResolvedValue(mockUser);

      await expect(
        service.dissociateTool('gateway-tool-1', 'org-1', 'user-1')
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('bulkAssociateTools', () => {
    const bulkDto = {
      toolIds: ['tool-1', 'tool-2', 'tool-3'],
      isActive: true,
      permissions: { allowedRoles: ['admin'] },
    };

    it('should bulk associate tools successfully', async () => {
      const mockGateway = { id: 'gateway-1', name: 'Test Gateway', organizationId: 'org-1' };
      const mockUser = { id: 'user-1', hasPermissionInOrganization: jest.fn().mockReturnValue(true) };
      const mockTools = [
        { id: 'tool-1', name: 'Tool 1', status: ToolStatus.ACTIVE },
        { id: 'tool-2', name: 'Tool 2', status: ToolStatus.ACTIVE },
        { id: 'tool-3', name: 'Tool 3', status: ToolStatus.ACTIVE },
      ];

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      userRepository.findOne.mockResolvedValue(mockUser);
      toolRepository.find.mockResolvedValue(mockTools);
      gatewayToolRepository.find.mockResolvedValue([]); // No existing associations
      gatewayToolRepository.create.mockImplementation((data) => ({ id: `new-${data.toolId}`, ...data }));
      gatewayToolRepository.save.mockImplementation((data) => Promise.resolve(data));

      const result = await service.bulkAssociateTools('gateway-1', bulkDto, 'org-1', 'user-1');

      expect(result.associated).toHaveLength(3);
      expect(result.skipped).toHaveLength(0);
      expect(gatewayToolRepository.save).toHaveBeenCalledTimes(3);
    });

    it('should skip already associated tools', async () => {
      const mockGateway = { id: 'gateway-1', name: 'Test Gateway', organizationId: 'org-1' };
      const mockUser = { id: 'user-1', hasPermissionInOrganization: jest.fn().mockReturnValue(true) };
      const mockTools = [
        { id: 'tool-1', name: 'Tool 1', status: ToolStatus.ACTIVE },
        { id: 'tool-2', name: 'Tool 2', status: ToolStatus.ACTIVE },
      ];
      const existingAssociations = [{ toolId: 'tool-1' }];

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      userRepository.findOne.mockResolvedValue(mockUser);
      toolRepository.find.mockResolvedValue(mockTools);
      gatewayToolRepository.find.mockResolvedValue(existingAssociations);
      gatewayToolRepository.create.mockImplementation((data) => ({ id: `new-${data.toolId}`, ...data }));
      gatewayToolRepository.save.mockImplementation((data) => Promise.resolve(data));

      const result = await service.bulkAssociateTools('gateway-1', bulkDto, 'org-1', 'user-1');

      expect(result.associated).toHaveLength(1);
      expect(result.skipped).toHaveLength(2);
      expect(result.skipped[0].toolId).toBe('tool-1');
      expect(result.skipped[0].reason).toBe('Already associated with gateway');
    });

    it('should skip inactive or missing tools', async () => {
      const mockGateway = { id: 'gateway-1', name: 'Test Gateway', organizationId: 'org-1' };
      const mockUser = { id: 'user-1', hasPermissionInOrganization: jest.fn().mockReturnValue(true) };
      const mockTools = [
        { id: 'tool-1', name: 'Tool 1', status: ToolStatus.ACTIVE },
      ];

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      userRepository.findOne.mockResolvedValue(mockUser);
      toolRepository.find.mockResolvedValue(mockTools); // Only tool-1 found
      gatewayToolRepository.find.mockResolvedValue([]);

      const result = await service.bulkAssociateTools('gateway-1', bulkDto, 'org-1', 'user-1');

      expect(result.skipped.some(s => s.toolId === 'tool-2')).toBe(true);
      expect(result.skipped.some(s => s.toolId === 'tool-3')).toBe(true);
    });

    it('names the state a skipped draft tool is in, and where to fix it', async () => {
      // Every tool generated from a schema starts as a draft, so this is
      // the skip reason a new user is guaranteed to hit. 'Tool not found
      // or not active' covered both cases at once and read as the wrong
      // one -- a user who had just generated eighteen tools was told they
      // did not exist.
      const mockGateway = { id: 'gateway-1', name: 'Test Gateway', organizationId: 'org-1' };
      const mockUser = { id: 'user-1', hasPermissionInOrganization: jest.fn().mockReturnValue(true) };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      userRepository.findOne.mockResolvedValue(mockUser);
      toolRepository.find.mockResolvedValue([
        { id: 'tool-1', name: 'listPets', status: ToolStatus.DRAFT },
        { id: 'tool-2', name: 'getPetById', status: ToolStatus.DRAFT },
        { id: 'tool-3', name: 'addPet', status: ToolStatus.ACTIVE },
      ]);
      gatewayToolRepository.find.mockResolvedValue([]);
      gatewayToolRepository.create.mockImplementation((data) => ({ id: `new-${data.toolId}`, ...data }));
      gatewayToolRepository.save.mockImplementation((data) => Promise.resolve(data));

      const result = await service.bulkAssociateTools('gateway-1', bulkDto, 'org-1', 'user-1');

      expect(result.associated).toHaveLength(1);
      const draftSkip = result.skipped.find(s => s.toolId === 'tool-1');
      expect(draftSkip?.reason).toContain('listPets');
      expect(draftSkip?.reason).toContain('draft');
      expect(draftSkip?.reason).toMatch(/Activate/i);
      // A tool that genuinely is not in this org reads differently.
      expect(draftSkip?.reason).not.toContain('not found');
    });

    it('distinguishes a tool that is not in the organization from one that is a draft', async () => {
      const mockGateway = { id: 'gateway-1', name: 'Test Gateway', organizationId: 'org-1' };
      const mockUser = { id: 'user-1', hasPermissionInOrganization: jest.fn().mockReturnValue(true) };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      userRepository.findOne.mockResolvedValue(mockUser);
      // tool-2 and tool-3 are absent from this organization entirely.
      toolRepository.find.mockResolvedValue([
        { id: 'tool-1', name: 'listPets', status: ToolStatus.DRAFT },
      ]);
      gatewayToolRepository.find.mockResolvedValue([]);

      const result = await service.bulkAssociateTools('gateway-1', bulkDto, 'org-1', 'user-1');

      expect(result.skipped.find(s => s.toolId === 'tool-2')?.reason)
        .toBe('Tool not found in this organization');
      expect(result.skipped.find(s => s.toolId === 'tool-1')?.reason).toContain('draft');
    });

    it('should handle save errors gracefully', async () => {
      const mockGateway = { id: 'gateway-1', name: 'Test Gateway', organizationId: 'org-1' };
      const mockUser = { id: 'user-1', hasPermissionInOrganization: jest.fn().mockReturnValue(true) };
      const mockTools = [{ id: 'tool-1', name: 'Tool 1', status: ToolStatus.ACTIVE }];

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      userRepository.findOne.mockResolvedValue(mockUser);
      toolRepository.find.mockResolvedValue(mockTools);
      gatewayToolRepository.find.mockResolvedValue([]);
      gatewayToolRepository.create.mockReturnValue({ id: 'new-tool-1' });
      gatewayToolRepository.save.mockRejectedValue(new Error('Save failed'));

      const result = await service.bulkAssociateTools('gateway-1', bulkDto, 'org-1', 'user-1');

      expect(result.associated).toHaveLength(0);
      expect(result.skipped).toHaveLength(3);
      expect(result.skipped[0].reason).toContain('Failed to associate');
    });

    it('should throw NotFoundException when gateway not found', async () => {
      gatewayRepository.findOne.mockResolvedValue(null);

      await expect(
        service.bulkAssociateTools('gateway-1', bulkDto, 'org-1', 'user-1')
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException for insufficient permissions', async () => {
      const mockGateway = { id: 'gateway-1', organizationId: 'org-1' };
      const mockUser = { id: 'user-1', hasPermissionInOrganization: jest.fn().mockReturnValue(false) };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      userRepository.findOne.mockResolvedValue(mockUser);

      await expect(
        service.bulkAssociateTools('gateway-1', bulkDto, 'org-1', 'user-1')
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('getGatewayTools', () => {
    const filters = {
      gatewayId: 'gateway-1',
      organizationId: 'org-1',
      page: 1,
      limit: 10,
      isActive: true,
      search: 'test',
      sortBy: 'name' as const,
      sortOrder: 'ASC' as const,
    };

    /**
     * The listing query, evaluated against a gateway_tools table. The
     * chains that stood here answered a fixed page whatever the WHERE
     * said, so the `gatewayId` predicate -- the only thing keeping one
     * gateway's (and one tenant's) tools off another's listing -- could
     * be deleted with the suite green. The gateway lookup is a table too.
     */
    const ilike = (value: string | undefined, pattern: string) =>
      new RegExp(`^${pattern.split('%').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i').test(
        value ?? '',
      );
    const GATEWAY_TOOL_CLAUSES: ClauseModel = {
      'gatewayTool.gatewayId = :gatewayId': (row, p) => row.gatewayId === p.gatewayId,
      'gatewayTool.isActive = :isActive': (row, p) => row.isActive === p.isActive,
      'gatewayTool.toolId IN (:...toolIds)': (row, p) => p.toolIds.includes(row.toolId),
      '(tool.name ILIKE :search OR tool.description ILIKE :search)': (row, p) =>
        ilike(row.tool?.name, p.search) || ilike(row.tool?.description, p.search),
    };
    const gatewayTool = (id: string, over: Record<string, any> = {}) => ({
      id,
      gatewayId: 'gateway-1',
      toolId: `tool-of-${id}`,
      isActive: true,
      tool: { name: `Test tool ${id}`, description: '' },
      ...over,
    });
    let qb: RecordingQueryBuilder | undefined;

    const useTables = (rows: any[]) => {
      const gateways = fakeRepository<any>([
        { id: 'gateway-1', organizationId: 'org-1' },
        { id: 'gateway-foreign', organizationId: 'org-2' },
      ]);
      gatewayRepository.findOne.mockImplementation(gateways.findOne);
      qb = undefined;
      gatewayToolRepository.createQueryBuilder.mockImplementation((alias: string) => {
        const builder = new RecordingQueryBuilder(alias, {
          getCount: (query: ExecutedQuery) => matchingRows(query, rows, GATEWAY_TOOL_CLAUSES).length,
          getMany: (query: ExecutedQuery) => {
            const skip = builder.argsOf('skip').slice(-1)[0]?.[0] ?? 0;
            const take = builder.argsOf('take').slice(-1)[0]?.[0] ?? Infinity;
            return matchingRows(query, rows, GATEWAY_TOOL_CLAUSES).slice(skip, skip + take);
          },
        });
        return (qb = builder);
      });
    };

    it('should return paginated gateway tools', async () => {
      useTables([
        gatewayTool('gt-1'),
        gatewayTool('gt-2'),
        gatewayTool('gt-inactive', { isActive: false }),
        gatewayTool('gt-unrelated', { tool: { name: 'Weather', description: 'forecast' } }),
        // Another gateway's association, same name: not on this listing.
        gatewayTool('gt-other-gateway', { gatewayId: 'gateway-foreign' }),
      ]);

      const result = await service.getGatewayTools(filters);

      expect(result.gatewayTools.map((gt) => gt.id)).toEqual(['gt-1', 'gt-2']);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(10);
      expect(result.totalPages).toBe(1);
      expect(qb!.alias).toBe('gatewayTool');
      expect(qb!.executed.map((q) => q.terminal)).toEqual(['getCount', 'getMany']);
      for (const query of qb!.executed) {
        expect(clause(query, 'gatewayTool.gatewayId = :gatewayId')?.params).toEqual({ gatewayId: 'gateway-1' });
        expect(clause(query, 'gatewayTool.isActive = :isActive')?.params).toEqual({ isActive: true });
        expect(clause(query, '(tool.name ILIKE :search OR tool.description ILIKE :search)')?.params).toEqual({
          search: '%test%',
        });
      }
    });

    it('should handle default pagination values', async () => {
      useTables(Array.from({ length: 25 }, (_, i) => gatewayTool(`gt-${i}`)));

      const result = await service.getGatewayTools({ gatewayId: 'gateway-1', organizationId: 'org-1' });

      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
      expect(result.total).toBe(25);
      expect(result.gatewayTools).toHaveLength(20);
      expect(qb!.argsOf('skip')).toEqual([[0]]);
      expect(qb!.argsOf('take')).toEqual([[20]]);
    });

    it('should limit maximum page size to 100', async () => {
      useTables([]);

      const result = await service.getGatewayTools({
        gatewayId: 'gateway-1',
        organizationId: 'org-1',
        limit: 200,
      });

      expect(result.limit).toBe(100);
      expect(qb!.argsOf('take')).toEqual([[100]]);
    });

    it('should throw NotFoundException when gateway not found', async () => {
      useTables([gatewayTool('gt-1')]);

      await expect(service.getGatewayTools({ ...filters, gatewayId: 'gateway-missing' })).rejects.toThrow(
        NotFoundException,
      );
      expect(qb).toBeUndefined();
    });

    it('does not list the tools of another organization gateway', async () => {
      useTables([gatewayTool('gt-foreign', { gatewayId: 'gateway-foreign' })]);

      await expect(service.getGatewayTools({ ...filters, gatewayId: 'gateway-foreign' })).rejects.toThrow(
        NotFoundException,
      );
      expect(qb).toBeUndefined();
    });

    it('should handle toolIds filter', async () => {
      useTables([
        gatewayTool('gt-1', { toolId: 'tool-1' }),
        gatewayTool('gt-2', { toolId: 'tool-2' }),
        gatewayTool('gt-3', { toolId: 'tool-3' }),
      ]);

      const result = await service.getGatewayTools({ ...filters, toolIds: ['tool-1', 'tool-2'] });

      expect(result.gatewayTools.map((gt) => gt.id)).toEqual(['gt-1', 'gt-2']);
      expect(clause(qb!.executed[1], 'gatewayTool.toolId IN (:...toolIds)')?.params).toEqual({
        toolIds: ['tool-1', 'tool-2'],
      });
    });

    it('should handle different sort columns', async () => {
      useTables([]);

      await service.getGatewayTools({
        gatewayId: 'gateway-1',
        organizationId: 'org-1',
        sortBy: 'associatedAt' as const,
      });

      expect(qb!.argsOf('orderBy')).toEqual([['gatewayTool.associatedAt', 'DESC']]);
    });
  });

  describe('getGatewayTool', () => {
    it('should return gateway tool by id', async () => {
      const mockGatewayTool = {
        id: 'gateway-tool-1',
        gateway: { organizationId: 'org-1' },
        tool: { name: 'Test Tool' },
      };

      gatewayToolRepository.findOne.mockResolvedValue(mockGatewayTool);

      const result = await service.getGatewayTool('gateway-tool-1', 'org-1');

      expect(result).toBe(mockGatewayTool);
      expect(gatewayToolRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'gateway-tool-1' },
        relations: { gateway: true, tool: true },
      });
    });

    it('should throw NotFoundException when gateway tool not found', async () => {
      gatewayToolRepository.findOne.mockResolvedValue(null);

      await expect(service.getGatewayTool('gateway-tool-1', 'org-1')).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException for wrong organization', async () => {
      const mockGatewayTool = {
        id: 'gateway-tool-1',
        gateway: { organizationId: 'wrong-org' },
      };

      gatewayToolRepository.findOne.mockResolvedValue(mockGatewayTool);

      await expect(service.getGatewayTool('gateway-tool-1', 'org-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('getAvailableTools', () => {
    /**
     * The picker's candidate query, evaluated against a tools table
     * rather than answered with a canned list: the chain that stood here
     * returned its fixed tools whatever was asked, so the organization,
     * status or visibility clause could go with the suite green. The
     * gateway lookup and the association list are tables too.
     */
    const TOOL_CLAUSES: ClauseModel = {
      'tool.organizationId = :organizationId': (row, p) => row.organizationId === p.organizationId,
      'tool.status = :status': (row, p) => row.status === p.status,
      "tool.visibility <> 'private'": (row) => row.visibility !== 'private',
      '(tool.visibility <> \'private\' OR tool."createdBy" = :gatewayOwner)': (row, p) =>
        row.visibility !== 'private' || row.createdBy === p.gatewayOwner,
      'tool.id NOT IN (:...associatedIds)': (row, p) => !p.associatedIds.includes(row.id),
    };
    const tool = (id: string, over: Record<string, any> = {}) => ({
      id,
      name: `Tool ${id}`,
      organizationId: 'org-1',
      status: ToolStatus.ACTIVE,
      visibility: 'org',
      createdBy: 'user-2',
      ...over,
    });
    const TOOLS = [
      tool('tool-1'),
      tool('tool-3'),
      tool('tool-5'),
      tool('tool-foreign', { organizationId: 'org-2' }),
      tool('tool-draft', { status: ToolStatus.DRAFT }),
      tool('tool-private-mine', { visibility: 'private', createdBy: 'user-1' }),
      tool('tool-private-theirs', { visibility: 'private', createdBy: 'user-2' }),
    ];
    let qb: RecordingQueryBuilder | undefined;

    const useTables = (associations: Array<{ gatewayId: string; toolId: string }>) => {
      const gateways = fakeRepository<any>([
        { id: 'gateway-1', organizationId: 'org-1', visibility: 'org', ownerUserId: 'user-1' },
        { id: 'gateway-private', organizationId: 'org-1', visibility: 'private', ownerUserId: 'user-1' },
        { id: 'gateway-foreign', organizationId: 'org-2', visibility: 'org', ownerUserId: 'user-9' },
      ]);
      const gatewayTools = fakeRepository<any>(associations.map((a, i) => ({ id: `gt-${i}`, ...a })));
      gatewayRepository.findOne.mockImplementation(gateways.findOne);
      gatewayToolRepository.find.mockImplementation(gatewayTools.find);
      qb = undefined;
      toolRepository.createQueryBuilder.mockImplementation(
        (alias: string) =>
          (qb = new RecordingQueryBuilder(alias, {
            getMany: (query: ExecutedQuery) =>
              matchingRows(query, TOOLS, TOOL_CLAUSES).sort((a, b) => a.name.localeCompare(b.name)),
          })),
      );
    };

    it('should return available tools not associated with gateway', async () => {
      useTables([
        { gatewayId: 'gateway-1', toolId: 'tool-1' },
        // Another gateway's association does not take tool-5 off this picker.
        { gatewayId: 'gateway-other', toolId: 'tool-5' },
      ]);

      const result = await service.getAvailableTools('gateway-1', 'org-1');

      // Not org-2's tool, not a draft, not anyone's private tool.
      expect(result.map((t) => t.id)).toEqual(['tool-3', 'tool-5']);
      expect(qb!.alias).toBe('tool');
      expect(organizationScope(qb!.executed[0], 'tool')).toBe('org-1');
      expect(qb!.argsOf('orderBy')).toEqual([['tool.name', 'ASC']]);
    });

    it('offers the owner private tools only for a gateway private to them', async () => {
      useTables([]);

      const result = await service.getAvailableTools('gateway-private', 'org-1');

      expect(result.map((t) => t.id)).toEqual(['tool-1', 'tool-3', 'tool-5', 'tool-private-mine']);
    });

    it('should handle gateway with no associated tools', async () => {
      useTables([]);

      const result = await service.getAvailableTools('gateway-1', 'org-1');

      expect(result.map((t) => t.id)).toEqual(['tool-1', 'tool-3', 'tool-5']);
      // No associations to exclude, so no NOT IN clause.
      expect(clause(qb!.executed[0], 'tool.id NOT IN (:...associatedIds)')).toBeUndefined();
    });

    it('should throw NotFoundException when gateway not found', async () => {
      useTables([]);

      await expect(service.getAvailableTools('gateway-missing', 'org-1')).rejects.toThrow(NotFoundException);
      expect(qb).toBeUndefined();
    });

    it('does not offer tools for another organization gateway', async () => {
      useTables([]);

      await expect(service.getAvailableTools('gateway-foreign', 'org-1')).rejects.toThrow(NotFoundException);
      expect(qb).toBeUndefined();
    });
  });

  describe('activateGatewayTool', () => {
    it('should activate gateway tool successfully', async () => {
      const mockGatewayTool = {
        id: 'gateway-tool-1',
        gateway: { organizationId: 'org-1' },
        tool: { name: 'Test Tool' },
        isActive: false,
      };

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      };

      const activatedGatewayTool = { ...mockGatewayTool, isActive: true };

      jest.spyOn(service, 'getGatewayTool').mockResolvedValue(mockGatewayTool as any);
      userRepository.findOne.mockResolvedValue(mockUser);
      gatewayToolRepository.save.mockResolvedValue(activatedGatewayTool);

      const result = await service.activateGatewayTool('gateway-tool-1', 'org-1', 'user-1');

      expect(result).toBe(activatedGatewayTool);
      expect(mockGatewayTool.isActive).toBe(true);
    });

    it('should return already active gateway tool without changes', async () => {
      const mockGatewayTool = {
        id: 'gateway-tool-1',
        gateway: { organizationId: 'org-1' },
        isActive: true,
      };

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      };

      jest.spyOn(service, 'getGatewayTool').mockResolvedValue(mockGatewayTool as any);
      userRepository.findOne.mockResolvedValue(mockUser);

      const result = await service.activateGatewayTool('gateway-tool-1', 'org-1', 'user-1');

      expect(result).toBe(mockGatewayTool);
      expect(gatewayToolRepository.save).not.toHaveBeenCalled();
    });

    it('should throw ForbiddenException for insufficient permissions', async () => {
      const mockGatewayTool = {
        id: 'gateway-tool-1',
        gateway: { organizationId: 'org-1' },
        isActive: false,
      };

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(false),
      };

      jest.spyOn(service, 'getGatewayTool').mockResolvedValue(mockGatewayTool as any);
      userRepository.findOne.mockResolvedValue(mockUser);

      await expect(
        service.activateGatewayTool('gateway-tool-1', 'org-1', 'user-1')
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('deactivateGatewayTool', () => {
    it('should deactivate gateway tool successfully', async () => {
      const mockGatewayTool = {
        id: 'gateway-tool-1',
        gateway: { organizationId: 'org-1' },
        isActive: true,
      };

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      };

      const deactivatedGatewayTool = { ...mockGatewayTool, isActive: false };

      jest.spyOn(service, 'getGatewayTool').mockResolvedValue(mockGatewayTool as any);
      userRepository.findOne.mockResolvedValue(mockUser);
      gatewayToolRepository.save.mockResolvedValue(deactivatedGatewayTool);

      const result = await service.deactivateGatewayTool('gateway-tool-1', 'org-1', 'user-1');

      expect(result).toBe(deactivatedGatewayTool);
      expect(mockGatewayTool.isActive).toBe(false);
    });

    it('should return already inactive gateway tool without changes', async () => {
      const mockGatewayTool = {
        id: 'gateway-tool-1',
        gateway: { organizationId: 'org-1' },
        isActive: false,
      };

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      };

      jest.spyOn(service, 'getGatewayTool').mockResolvedValue(mockGatewayTool as any);
      userRepository.findOne.mockResolvedValue(mockUser);

      const result = await service.deactivateGatewayTool('gateway-tool-1', 'org-1', 'user-1');

      expect(result).toBe(mockGatewayTool);
      expect(gatewayToolRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('getGatewayToolStats', () => {
    it('should return gateway tool statistics', async () => {
      const mockGateway = { id: 'gateway-1', organizationId: 'org-1' };
      const mockGatewayTools = [
        {
          id: 'gt-1',
          isActive: true,
          usageCount: 100,
          lastUsedAt: new Date('2023-01-15'),
          tool: { name: 'Tool 1' },
        },
        {
          id: 'gt-2',
          isActive: false,
          usageCount: 50,
          lastUsedAt: new Date('2023-01-10'),
          tool: { name: 'Tool 2' },
        },
        {
          id: 'gt-3',
          isActive: true,
          usageCount: 0,
          lastUsedAt: null,
          tool: { name: 'Tool 3' },
        },
      ];

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayToolRepository.find.mockResolvedValue(mockGatewayTools);

      const result = await service.getGatewayToolStats('gateway-1', 'org-1');

      expect(result.totalTools).toBe(3);
      expect(result.activeTools).toBe(2);
      expect(result.inactiveTools).toBe(1);
      expect(result.totalUsage).toBe(150);
      expect(result.mostUsedTools).toHaveLength(2);
      expect(result.mostUsedTools[0].usageCount).toBe(100);
      expect(result.recentlyUsedTools).toHaveLength(2);
    });

    it('should handle gateway with no tools', async () => {
      const mockGateway = { id: 'gateway-1', organizationId: 'org-1' };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayToolRepository.find.mockResolvedValue([]);

      const result = await service.getGatewayToolStats('gateway-1', 'org-1');

      expect(result.totalTools).toBe(0);
      expect(result.activeTools).toBe(0);
      expect(result.inactiveTools).toBe(0);
      expect(result.totalUsage).toBe(0);
      expect(result.mostUsedTools).toHaveLength(0);
      expect(result.recentlyUsedTools).toHaveLength(0);
    });

    it('should throw NotFoundException when gateway not found', async () => {
      gatewayRepository.findOne.mockResolvedValue(null);

      await expect(service.getGatewayToolStats('gateway-1', 'org-1')).rejects.toThrow(NotFoundException);
    });

    it('should limit most used tools to 10', async () => {
      const mockGateway = { id: 'gateway-1', organizationId: 'org-1' };
      const mockGatewayTools = Array.from({ length: 15 }, (_, i) => ({
        id: `gt-${i}`,
        isActive: true,
        usageCount: i + 1,
        lastUsedAt: new Date(),
        tool: { name: `Tool ${i}` },
      }));

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayToolRepository.find.mockResolvedValue(mockGatewayTools);

      const result = await service.getGatewayToolStats('gateway-1', 'org-1');

      expect(result.mostUsedTools).toHaveLength(10);
      expect(result.recentlyUsedTools).toHaveLength(10);
    });
  });

  describe('incrementUsage', () => {
    it('should increment usage count and update last used time', async () => {
      gatewayToolRepository.increment.mockResolvedValue(undefined);
      gatewayToolRepository.update.mockResolvedValue(undefined);

      await service.incrementUsage('gateway-tool-1');

      expect(gatewayToolRepository.increment).toHaveBeenCalledWith(
        { id: 'gateway-tool-1' },
        'usageCount',
        1
      );
      expect(gatewayToolRepository.update).toHaveBeenCalledWith(
        { id: 'gateway-tool-1' },
        { lastUsedAt: expect.any(Date) }
      );
    });

    it('should handle database errors gracefully', async () => {
      gatewayToolRepository.increment.mockRejectedValue(new Error('Database error'));

      // Should not throw error
      await service.incrementUsage('gateway-tool-1');

      expect(gatewayToolRepository.increment).toHaveBeenCalled();
    });
  });

  describe('copyToolsFromGateway', () => {
    it('should copy tools from source to target gateway', async () => {
      const mockSourceGateway = { id: 'gateway-1', name: 'Source', organizationId: 'org-1' };
      const mockTargetGateway = { id: 'gateway-2', name: 'Target', organizationId: 'org-1' };
      const mockUser = { id: 'user-1', hasPermissionInOrganization: jest.fn().mockReturnValue(true) };

      const sourceTools = [
        {
          id: 'st-1',
          toolId: 'tool-1',
          isActive: true,
          overrides: { name: 'Custom Tool 1' },
          permissions: { allowedRoles: ['admin'] },
          transformations: {},
          metadata: { custom: true },
          tool: { name: 'Tool 1' },
        },
        {
          id: 'st-2',
          toolId: 'tool-2',
          isActive: false,
          overrides: {},
          permissions: {},
          transformations: {},
          metadata: {},
          tool: { name: 'Tool 2' },
        },
      ];

      gatewayRepository.findOne.mockImplementation((query) => {
        if (query.where.id === 'gateway-1') return Promise.resolve(mockSourceGateway);
        if (query.where.id === 'gateway-2') return Promise.resolve(mockTargetGateway);
        return Promise.resolve(null);
      });
      userRepository.findOne.mockResolvedValue(mockUser);
      gatewayToolRepository.find.mockImplementation((query) => {
        if (query.where.gatewayId === 'gateway-1') return Promise.resolve(sourceTools);
        if (query.where.gatewayId === 'gateway-2') return Promise.resolve([]);
        return Promise.resolve([]);
      });
      gatewayToolRepository.create.mockImplementation((data) => ({ id: `new-${data.toolId}`, ...data }));
      gatewayToolRepository.save.mockImplementation((data) => Promise.resolve(data));

      const result = await service.copyToolsFromGateway(
        'gateway-1',
        'gateway-2',
        'org-1',
        'user-1'
      );

      expect(result.copied).toHaveLength(2);
      expect(result.skipped).toHaveLength(0);
      expect(gatewayToolRepository.create).toHaveBeenCalledTimes(2);
    });

    it('should skip existing tools when overrideExisting is false', async () => {
      const mockSourceGateway = { id: 'gateway-1', name: 'Source', organizationId: 'org-1' };
      const mockTargetGateway = { id: 'gateway-2', name: 'Target', organizationId: 'org-1' };
      const mockUser = { id: 'user-1', hasPermissionInOrganization: jest.fn().mockReturnValue(true) };

      const sourceTools = [{ toolId: 'tool-1', tool: { name: 'Tool 1' } }];
      const existingTargetTools = [{ toolId: 'tool-1' }];

      gatewayRepository.findOne.mockImplementation((query) => {
        if (query.where.id === 'gateway-1') return Promise.resolve(mockSourceGateway);
        if (query.where.id === 'gateway-2') return Promise.resolve(mockTargetGateway);
        return Promise.resolve(null);
      });
      userRepository.findOne.mockResolvedValue(mockUser);
      gatewayToolRepository.find.mockImplementation((query) => {
        if (query.where.gatewayId === 'gateway-1') return Promise.resolve(sourceTools);
        if (query.where.gatewayId === 'gateway-2') return Promise.resolve(existingTargetTools);
        return Promise.resolve([]);
      });

      const result = await service.copyToolsFromGateway(
        'gateway-1',
        'gateway-2',
        'org-1',
        'user-1',
        false
      );

      expect(result.copied).toHaveLength(0);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].reason).toBe('Tool already exists in target gateway');
    });

    it('should override existing tools when overrideExisting is true', async () => {
      const mockSourceGateway = { id: 'gateway-1', name: 'Source', organizationId: 'org-1' };
      const mockTargetGateway = { id: 'gateway-2', name: 'Target', organizationId: 'org-1' };
      const mockUser = { id: 'user-1', hasPermissionInOrganization: jest.fn().mockReturnValue(true) };

      const sourceTools = [{ toolId: 'tool-1', isActive: true, tool: { name: 'Tool 1' } }];
      const existingTargetTools = [{ toolId: 'tool-1' }];

      gatewayRepository.findOne.mockImplementation((query) => {
        if (query.where.id === 'gateway-1') return Promise.resolve(mockSourceGateway);
        if (query.where.id === 'gateway-2') return Promise.resolve(mockTargetGateway);
        return Promise.resolve(null);
      });
      userRepository.findOne.mockResolvedValue(mockUser);
      gatewayToolRepository.find.mockImplementation((query) => {
        if (query.where.gatewayId === 'gateway-1') return Promise.resolve(sourceTools);
        if (query.where.gatewayId === 'gateway-2') return Promise.resolve(existingTargetTools);
        return Promise.resolve([]);
      });
      gatewayToolRepository.delete.mockResolvedValue(undefined);
      gatewayToolRepository.create.mockReturnValue({ id: 'new-tool-1' });
      gatewayToolRepository.save.mockResolvedValue({ id: 'new-tool-1' });

      const result = await service.copyToolsFromGateway(
        'gateway-1',
        'gateway-2',
        'org-1',
        'user-1',
        true
      );

      expect(result.copied).toHaveLength(1);
      expect(result.skipped).toHaveLength(0);
      expect(gatewayToolRepository.delete).toHaveBeenCalledWith({
        gatewayId: 'gateway-2',
        toolId: 'tool-1',
      });
    });

    it('should handle copy errors gracefully', async () => {
      const mockSourceGateway = { id: 'gateway-1', name: 'Source', organizationId: 'org-1' };
      const mockTargetGateway = { id: 'gateway-2', name: 'Target', organizationId: 'org-1' };
      const mockUser = { id: 'user-1', hasPermissionInOrganization: jest.fn().mockReturnValue(true) };

      const sourceTools = [{ toolId: 'tool-1', tool: { name: 'Tool 1' } }];

      gatewayRepository.findOne.mockImplementation((query) => {
        if (query.where.id === 'gateway-1') return Promise.resolve(mockSourceGateway);
        if (query.where.id === 'gateway-2') return Promise.resolve(mockTargetGateway);
        return Promise.resolve(null);
      });
      userRepository.findOne.mockResolvedValue(mockUser);
      gatewayToolRepository.find.mockImplementation((query) => {
        if (query.where.gatewayId === 'gateway-1') return Promise.resolve(sourceTools);
        if (query.where.gatewayId === 'gateway-2') return Promise.resolve([]);
        return Promise.resolve([]);
      });
      gatewayToolRepository.create.mockReturnValue({});
      gatewayToolRepository.save.mockRejectedValue(new Error('Copy failed'));

      const result = await service.copyToolsFromGateway(
        'gateway-1',
        'gateway-2',
        'org-1',
        'user-1'
      );

      expect(result.copied).toHaveLength(0);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].reason).toContain('Failed to copy');
    });

    it('should throw NotFoundException when source gateway not found', async () => {
      gatewayRepository.findOne.mockImplementation((query) => {
        if (query.where.id === 'gateway-1') return Promise.resolve(null);
        return Promise.resolve({ id: 'gateway-2', organizationId: 'org-1' });
      });

      await expect(
        service.copyToolsFromGateway('gateway-1', 'gateway-2', 'org-1', 'user-1')
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when target gateway not found', async () => {
      gatewayRepository.findOne.mockImplementation((query) => {
        if (query.where.id === 'gateway-1') return Promise.resolve({ id: 'gateway-1', organizationId: 'org-1' });
        if (query.where.id === 'gateway-2') return Promise.resolve(null);
        return Promise.resolve(null);
      });

      await expect(
        service.copyToolsFromGateway('gateway-1', 'gateway-2', 'org-1', 'user-1')
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException for insufficient permissions', async () => {
      const mockSourceGateway = { id: 'gateway-1', organizationId: 'org-1' };
      const mockTargetGateway = { id: 'gateway-2', organizationId: 'org-1' };
      const mockUser = { id: 'user-1', hasPermissionInOrganization: jest.fn().mockReturnValue(false) };

      gatewayRepository.findOne.mockImplementation((query) => {
        if (query.where.id === 'gateway-1') return Promise.resolve(mockSourceGateway);
        if (query.where.id === 'gateway-2') return Promise.resolve(mockTargetGateway);
        return Promise.resolve(null);
      });
      userRepository.findOne.mockResolvedValue(mockUser);

      await expect(
        service.copyToolsFromGateway('gateway-1', 'gateway-2', 'org-1', 'user-1')
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('basic functionality', () => {
    it('should be defined', () => {
      expect(service).toBeDefined();
    });

    it('should have all required dependencies injected', () => {
      expect(gatewayToolRepository).toBeDefined();
      expect(gatewayRepository).toBeDefined();
      expect(toolRepository).toBeDefined();
      expect(userRepository).toBeDefined();
    });
  });
});