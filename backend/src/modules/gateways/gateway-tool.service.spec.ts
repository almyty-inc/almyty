import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { GatewayToolService } from './gateway-tool.service';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { Gateway } from '../../entities/gateway.entity';
import { Tool, ToolStatus } from '../../entities/tool.entity';
import { User } from '../../entities/user.entity';
import { AuditLogService } from '../audit-log/audit-log.service';

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
      ],
    }).compile();

    service = module.get<GatewayToolService>(GatewayToolService);
    gatewayToolRepository = module.get(getRepositoryToken(GatewayTool));
    gatewayRepository = module.get(getRepositoryToken(Gateway));
    toolRepository = module.get(getRepositoryToken(Tool));
    userRepository = module.get(getRepositoryToken(User));
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
      expect(toolRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'tool-1' },
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

    it('should return paginated gateway tools', async () => {
      const mockGateway = { id: 'gateway-1', organizationId: 'org-1' };
      const mockGatewayTools = [
        { id: 'gt-1', toolId: 'tool-1', isActive: true },
        { id: 'gt-2', toolId: 'tool-2', isActive: true },
      ];

      const mockQueryBuilder = {
        createQueryBuilder: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(2),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(mockGatewayTools),
      };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayToolRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      const result = await service.getGatewayTools(filters);

      expect(result.gatewayTools).toBe(mockGatewayTools);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(10);
      expect(result.totalPages).toBe(1);
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith('gatewayTool.isActive = :isActive', { isActive: true });
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        '(tool.name ILIKE :search OR tool.description ILIKE :search)',
        { search: '%test%' }
      );
    });

    it('should handle default pagination values', async () => {
      const mockGateway = { id: 'gateway-1', organizationId: 'org-1' };
      const filtersWithoutPagination = {
        gatewayId: 'gateway-1',
        organizationId: 'org-1',
      };

      const mockQueryBuilder = {
        createQueryBuilder: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(5),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayToolRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      const result = await service.getGatewayTools(filtersWithoutPagination);

      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
      expect(mockQueryBuilder.skip).toHaveBeenCalledWith(0);
      expect(mockQueryBuilder.take).toHaveBeenCalledWith(20);
    });

    it('should limit maximum page size to 100', async () => {
      const mockGateway = { id: 'gateway-1', organizationId: 'org-1' };
      const filtersWithLargeLimit = {
        gatewayId: 'gateway-1',
        organizationId: 'org-1',
        limit: 200,
      };

      const mockQueryBuilder = {
        createQueryBuilder: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayToolRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      const result = await service.getGatewayTools(filtersWithLargeLimit);

      expect(result.limit).toBe(100);
      expect(mockQueryBuilder.take).toHaveBeenCalledWith(100);
    });

    it('should throw NotFoundException when gateway not found', async () => {
      gatewayRepository.findOne.mockResolvedValue(null);

      await expect(service.getGatewayTools(filters)).rejects.toThrow(NotFoundException);
    });

    it('should handle toolIds filter', async () => {
      const mockGateway = { id: 'gateway-1', organizationId: 'org-1' };
      const filtersWithToolIds = {
        ...filters,
        toolIds: ['tool-1', 'tool-2'],
      };

      const mockQueryBuilder = {
        createQueryBuilder: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayToolRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      await service.getGatewayTools(filtersWithToolIds);

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'gatewayTool.toolId IN (:...toolIds)',
        { toolIds: ['tool-1', 'tool-2'] }
      );
    });

    it('should handle different sort columns', async () => {
      const mockGateway = { id: 'gateway-1', organizationId: 'org-1' };
      const filtersWithAssociatedAtSort = {
        gatewayId: 'gateway-1',
        organizationId: 'org-1',
        sortBy: 'associatedAt' as const,
      };

      const mockQueryBuilder = {
        createQueryBuilder: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayToolRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      await service.getGatewayTools(filtersWithAssociatedAtSort);

      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith('gatewayTool.associatedAt', 'DESC');
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
        relations: ['gateway', 'tool'],
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
    it('should return available tools not associated with gateway', async () => {
      const mockGateway = { id: 'gateway-1', organizationId: 'org-1' };
      const mockAssociatedTools = [{ toolId: 'tool-1' }, { toolId: 'tool-2' }];
      const mockAvailableTools = [
        { id: 'tool-3', name: 'Available Tool 1' },
        { id: 'tool-4', name: 'Available Tool 2' },
      ];

      const mockQueryBuilder = {
        createQueryBuilder: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(mockAvailableTools),
      };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayToolRepository.find.mockResolvedValue(mockAssociatedTools);
      toolRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      const result = await service.getAvailableTools('gateway-1', 'org-1');

      expect(result).toBe(mockAvailableTools);
      expect(mockQueryBuilder.where).toHaveBeenCalledWith('tool.status = :status', { status: ToolStatus.ACTIVE });
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'tool.id NOT IN (:...associatedIds)',
        { associatedIds: ['tool-1', 'tool-2'] }
      );
    });

    it('should handle gateway with no associated tools', async () => {
      const mockGateway = { id: 'gateway-1', organizationId: 'org-1' };
      const mockAvailableTools = [{ id: 'tool-1', name: 'Tool 1' }];

      const mockQueryBuilder = {
        createQueryBuilder: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(mockAvailableTools),
      };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayToolRepository.find.mockResolvedValue([]);
      toolRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      const result = await service.getAvailableTools('gateway-1', 'org-1');

      expect(result).toBe(mockAvailableTools);
      expect(mockQueryBuilder.andWhere).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException when gateway not found', async () => {
      gatewayRepository.findOne.mockResolvedValue(null);

      await expect(service.getAvailableTools('gateway-1', 'org-1')).rejects.toThrow(NotFoundException);
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