import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { ToolsService, CreateToolDto, UpdateToolDto, ToolSearchFilters } from './tools.service';
import { Tool, ToolStatus, ToolType } from '../../entities/tool.entity';
import { ToolVersion } from '../../entities/tool-version.entity';
import { ToolCategory } from '../../entities/tool-category.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import { Api } from '../../entities/api.entity';
import { Operation } from '../../entities/operation.entity';
import { User } from '../../entities/user.entity';
import { Organization } from '../../entities/organization.entity';

describe('ToolsService', () => {
  let service: ToolsService;
  let toolRepository: any;
  let toolVersionRepository: any;
  let toolCategoryRepository: any;
  let toolExecutionRepository: any;
  let apiRepository: any;
  let operationRepository: any;
  let userRepository: any;
  let organizationRepository: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ToolsService,
        {
          provide: getRepositoryToken(Tool),
          useValue: {
            findOne: jest.fn(),
            find: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            remove: jest.fn(),
            createQueryBuilder: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(ToolVersion),
          useValue: {
            find: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(ToolCategory),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(ToolExecution),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Api),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Operation),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(User),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Organization),
          useValue: {
            findOne: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<ToolsService>(ToolsService);
    toolRepository = module.get(getRepositoryToken(Tool));
    toolVersionRepository = module.get(getRepositoryToken(ToolVersion));
    toolCategoryRepository = module.get(getRepositoryToken(ToolCategory));
    toolExecutionRepository = module.get(getRepositoryToken(ToolExecution));
    apiRepository = module.get(getRepositoryToken(Api));
    operationRepository = module.get(getRepositoryToken(Operation));
    userRepository = module.get(getRepositoryToken(User));
    organizationRepository = module.get(getRepositoryToken(Organization));
  });

  describe('createTool', () => {
    const createToolDto: CreateToolDto = {
      name: 'Test Tool',
      description: 'A test tool',
      type: ToolType.API,
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string' },
        },
        required: ['input'],
      },
      configuration: {
        timeout: 30000,
        retries: 3,
        cache: { enabled: true, ttl: 300 },
      },
      categoryIds: ['cat-1'],
      operationId: 'op-1',
      metadata: { source: 'manual' },
    };

    it('should create tool successfully', async () => {
      const mockOrganization = {
        id: 'org-1',
        canAddMoreTools: jest.fn().mockReturnValue(true),
      };

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      };

      const mockCategories = [
        { id: 'cat-1', name: 'Category 1', organizationId: 'org-1' },
      ];

      const mockOperation = {
        id: 'op-1',
        name: 'Test Operation',
        api: { organizationId: 'org-1' },
      };

      const mockTool = {
        id: 'tool-1',
        ...createToolDto,
        organizationId: 'org-1',
        createdBy: 'user-1',
        status: ToolStatus.DRAFT,
        version: '1.0.0',
        categories: mockCategories,
      };

      organizationRepository.findOne.mockResolvedValue(mockOrganization);
      userRepository.findOne.mockResolvedValue(mockUser);
      toolCategoryRepository.find.mockResolvedValue(mockCategories);
      operationRepository.findOne.mockResolvedValue(mockOperation);
      toolRepository.create.mockReturnValue(mockTool);
      toolRepository.save.mockResolvedValue(mockTool);
      toolVersionRepository.create.mockReturnValue({});
      toolVersionRepository.save.mockResolvedValue({});

      const result = await service.createTool(createToolDto, 'org-1', 'user-1');

      expect(result).toBe(mockTool);
      expect(toolRepository.create).toHaveBeenCalledWith({
        ...createToolDto,
        organizationId: 'org-1',
        createdBy: 'user-1',
        status: ToolStatus.DRAFT,
        version: '1.0.0',
        categories: mockCategories,
        operationId: 'op-1',
      });
    });

    it('should throw NotFoundException for invalid organization', async () => {
      organizationRepository.findOne.mockResolvedValue(null);

      await expect(
        service.createTool(createToolDto, 'org-1', 'user-1')
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException for insufficient permissions', async () => {
      const mockOrganization = { id: 'org-1', canAddMoreTools: jest.fn().mockReturnValue(true) };
      const mockUser = { id: 'user-1', hasPermissionInOrganization: jest.fn().mockReturnValue(false) };

      organizationRepository.findOne.mockResolvedValue(mockOrganization);
      userRepository.findOne.mockResolvedValue(mockUser);

      await expect(
        service.createTool(createToolDto, 'org-1', 'user-1')
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw BadRequestException when organization reaches tool limit', async () => {
      const mockOrganization = { id: 'org-1', canAddMoreTools: jest.fn().mockReturnValue(false) };
      const mockUser = { id: 'user-1', hasPermissionInOrganization: jest.fn().mockReturnValue(true) };

      organizationRepository.findOne.mockResolvedValue(mockOrganization);
      userRepository.findOne.mockResolvedValue(mockUser);

      await expect(
        service.createTool(createToolDto, 'org-1', 'user-1')
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException for invalid categories', async () => {
      const mockOrganization = { id: 'org-1', canAddMoreTools: jest.fn().mockReturnValue(true) };
      const mockUser = { id: 'user-1', hasPermissionInOrganization: jest.fn().mockReturnValue(true) };

      organizationRepository.findOne.mockResolvedValue(mockOrganization);
      userRepository.findOne.mockResolvedValue(mockUser);
      toolCategoryRepository.find.mockResolvedValue([]); // No categories found

      await expect(
        service.createTool(createToolDto, 'org-1', 'user-1')
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException for invalid operation', async () => {
      const mockOrganization = { id: 'org-1', canAddMoreTools: jest.fn().mockReturnValue(true) };
      const mockUser = { id: 'user-1', hasPermissionInOrganization: jest.fn().mockReturnValue(true) };
      const mockCategories = [{ id: 'cat-1', organizationId: 'org-1' }];

      organizationRepository.findOne.mockResolvedValue(mockOrganization);
      userRepository.findOne.mockResolvedValue(mockUser);
      toolCategoryRepository.find.mockResolvedValue(mockCategories);
      operationRepository.findOne.mockResolvedValue(null);

      await expect(
        service.createTool(createToolDto, 'org-1', 'user-1')
      ).rejects.toThrow(BadRequestException);
    });

    it('should create tool without categories and operation', async () => {
      const minimalDto = {
        name: 'Minimal Tool',
        description: 'A minimal tool',
        type: ToolType.API,
        parameters: { type: 'object' },
      };

      const mockOrganization = { id: 'org-1', canAddMoreTools: jest.fn().mockReturnValue(true) };
      const mockUser = { id: 'user-1', hasPermissionInOrganization: jest.fn().mockReturnValue(true) };
      const mockTool = { id: 'tool-1', ...minimalDto };

      organizationRepository.findOne.mockResolvedValue(mockOrganization);
      userRepository.findOne.mockResolvedValue(mockUser);
      toolRepository.create.mockReturnValue(mockTool);
      toolRepository.save.mockResolvedValue(mockTool);
      toolVersionRepository.create.mockReturnValue({});
      toolVersionRepository.save.mockResolvedValue({});

      const result = await service.createTool(minimalDto, 'org-1', 'user-1');

      expect(result).toBe(mockTool);
    });
  });

  describe('updateTool', () => {
    const updateToolDto: UpdateToolDto = {
      name: 'Updated Tool',
      description: 'Updated description',
      parameters: { type: 'object', properties: { newParam: { type: 'string' } } },
      configuration: { timeout: 45000 },
      categoryIds: ['cat-2'],
      metadata: { updated: true },
    };

    it('should update tool successfully', async () => {
      const mockTool = {
        id: 'tool-1',
        name: 'Original Tool',
        organizationId: 'org-1',
        createdBy: 'user-1',
        version: '1.0.0',
        configuration: { timeout: 30000 },
        metadata: { original: true },
        categories: [],
      };

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      };

      const mockCategories = [
        { id: 'cat-2', name: 'Category 2', organizationId: 'org-1' },
      ];

      const updatedTool = {
        ...mockTool,
        ...updateToolDto,
        version: '1.0.1',
        updatedBy: 'user-1',
        categories: mockCategories,
      };

      toolRepository.findOne.mockResolvedValue(mockTool);
      userRepository.findOne.mockResolvedValue(mockUser);
      toolCategoryRepository.find.mockResolvedValue(mockCategories);
      toolRepository.save.mockResolvedValue(updatedTool);
      toolVersionRepository.create.mockReturnValue({});
      toolVersionRepository.save.mockResolvedValue({});

      const result = await service.updateTool('tool-1', updateToolDto, 'org-1', 'user-1');

      expect(mockTool.name).toBe('Updated Tool');
      expect(mockTool.version).toBe('1.0.1');
      expect(mockTool.configuration.timeout).toBe(45000);
      expect(result.metadata.updated).toBe(true);
      expect(mockTool.categories).toBe(mockCategories);
    });

    it('should throw NotFoundException for non-existent tool', async () => {
      toolRepository.findOne.mockResolvedValue(null);

      await expect(
        service.updateTool('tool-1', updateToolDto, 'org-1', 'user-1')
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException for insufficient permissions', async () => {
      const mockTool = {
        id: 'tool-1',
        organizationId: 'org-1',
        createdBy: 'other-user',
      };

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(false),
      };

      toolRepository.findOne.mockResolvedValue(mockTool);
      userRepository.findOne.mockResolvedValue(mockUser);

      await expect(
        service.updateTool('tool-1', updateToolDto, 'org-1', 'user-1')
      ).rejects.toThrow(ForbiddenException);
    });

    it('should allow owner to update tool without manage_tools permission', async () => {
      const mockTool = {
        id: 'tool-1',
        name: 'Tool',
        organizationId: 'org-1',
        createdBy: 'user-1', // Same as updating user
        version: '1.0.0',
        configuration: {},
        metadata: {},
        categories: [],
      };

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(false),
      };

      toolRepository.findOne.mockResolvedValue(mockTool);
      userRepository.findOne.mockResolvedValue(mockUser);
      toolRepository.save.mockResolvedValue(mockTool);
      toolVersionRepository.create.mockReturnValue({});
      toolVersionRepository.save.mockResolvedValue({});

      const result = await service.updateTool('tool-1', { name: 'Updated' }, 'org-1', 'user-1');

      expect(mockTool.name).toBe('Updated');
      expect(toolRepository.save).toHaveBeenCalled();
    });

    it('should clear categories when empty array provided', async () => {
      const mockTool = {
        id: 'tool-1',
        organizationId: 'org-1',
        createdBy: 'user-1',
        version: '1.0.0',
        configuration: {},
        metadata: {},
        categories: [{ id: 'cat-1' }],
      };

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      };

      toolRepository.findOne.mockResolvedValue(mockTool);
      userRepository.findOne.mockResolvedValue(mockUser);
      toolRepository.save.mockResolvedValue(mockTool);
      toolVersionRepository.create.mockReturnValue({});
      toolVersionRepository.save.mockResolvedValue({});

      await service.updateTool('tool-1', { categoryIds: [] }, 'org-1', 'user-1');

      expect(mockTool.categories).toEqual([]);
    });

    it('should increment patch version correctly', async () => {
      const mockTool = {
        id: 'tool-1',
        organizationId: 'org-1',
        createdBy: 'user-1',
        version: '2.5.9',
        configuration: {},
        metadata: {},
        categories: [],
      };

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      };

      toolRepository.findOne.mockResolvedValue(mockTool);
      userRepository.findOne.mockResolvedValue(mockUser);
      toolRepository.save.mockResolvedValue(mockTool);
      toolVersionRepository.create.mockReturnValue({});
      toolVersionRepository.save.mockResolvedValue({});

      await service.updateTool('tool-1', { name: 'Updated' }, 'org-1', 'user-1');

      expect(mockTool.version).toBe('2.5.10');
    });
  });

  describe('getTool', () => {
    const mockTool = {
      id: 'tool-1',
      name: 'Test Tool',
      organizationId: 'org-1',
    };

    it('should return tool with relations by default', async () => {
      toolRepository.findOne.mockResolvedValue(mockTool);

      const result = await service.getTool('tool-1', 'org-1');

      expect(result).toBe(mockTool);
      expect(toolRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'tool-1', organizationId: 'org-1' },
        relations: [
          'categories',
          'operation',
          'operation.api',
          'inputSchema',
          'outputSchema',
          'versions',
        ],
      });
    });

    it('should return tool without relations when specified', async () => {
      toolRepository.findOne.mockResolvedValue(mockTool);

      const result = await service.getTool('tool-1', 'org-1', false);

      expect(result).toBe(mockTool);
      expect(toolRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'tool-1', organizationId: 'org-1' },
        relations: [],
      });
    });

    it('should throw NotFoundException when tool not found', async () => {
      toolRepository.findOne.mockResolvedValue(null);

      await expect(
        service.getTool('tool-1', 'org-1')
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getTools', () => {
    const filters: ToolSearchFilters = {
      organizationId: 'org-1',
      page: 1,
      limit: 10,
      search: 'test',
      type: ToolType.API,
      status: ToolStatus.ACTIVE,
      categoryIds: ['cat-1'],
      apiId: 'api-1',
      tags: ['tag1'],
      sortBy: 'name',
      sortOrder: 'ASC',
    };

    const mockTools = [
      { id: 'tool-1', name: 'Tool 1' },
      { id: 'tool-2', name: 'Tool 2' },
    ];

    const mockQueryBuilder = {
      createQueryBuilder: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      addGroupBy: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      clone: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(2),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(mockTools),
      getRawMany: jest.fn().mockResolvedValue([]),
    };

    it('should return paginated tools with all filters', async () => {
      toolRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      const result = await service.getTools(filters);

      expect(result.tools).toBe(mockTools);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(10);
      expect(result.totalPages).toBe(1);

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        '(tool.name ILIKE :search OR tool.description ILIKE :search)',
        { search: '%test%' }
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith('tool.type = :type', { type: ToolType.API });
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith('tool.status = :status', { status: ToolStatus.ACTIVE });
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith('category.id IN (:...categoryIds)', { categoryIds: ['cat-1'] });
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith('api.id = :apiId', { apiId: 'api-1' });
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith('tool.tags && :tags', { tags: ['tag1'] });
    });

    it('should handle default pagination values', async () => {
      const minimalFilters = { organizationId: 'org-1' };
      toolRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      const result = await service.getTools(minimalFilters);

      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
      expect(mockQueryBuilder.skip).toHaveBeenCalledWith(0);
      expect(mockQueryBuilder.take).toHaveBeenCalledWith(20);
    });

    it('should limit maximum page size to 100', async () => {
      const filtersWithLargeLimit = { organizationId: 'org-1', limit: 200 };
      toolRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      const result = await service.getTools(filtersWithLargeLimit);

      expect(result.limit).toBe(100);
      expect(mockQueryBuilder.take).toHaveBeenCalledWith(100);
    });

    it('should handle usage-based sorting', async () => {
      const usageFilters = { ...filters, sortBy: 'usage' as const };
      toolRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      await service.getTools(usageFilters);

      expect(mockQueryBuilder.leftJoin).toHaveBeenCalledWith('tool.executions', 'execution');
      expect(mockQueryBuilder.addSelect).toHaveBeenCalledWith('COUNT(execution.id)', 'usageCount');
      expect(mockQueryBuilder.groupBy).toHaveBeenCalledWith('tool.id');
      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith('usageCount', 'ASC');
    });

    it('should handle default sorting', async () => {
      const defaultFilters = { organizationId: 'org-1' };
      toolRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      await service.getTools(defaultFilters);

      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith('tool.createdAt', 'DESC');
    });
  });

  describe('activateTool', () => {
    it('should activate tool successfully', async () => {
      const mockTool = {
        id: 'tool-1',
        name: 'Test Tool',
        status: ToolStatus.DRAFT,
      };

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      };

      const activatedTool = { ...mockTool, status: ToolStatus.ACTIVE, updatedBy: 'user-1' };

      jest.spyOn(service, 'getTool').mockResolvedValue(mockTool as any);
      userRepository.findOne.mockResolvedValue(mockUser);
      toolRepository.save.mockResolvedValue(activatedTool);
      toolVersionRepository.create.mockReturnValue({});
      toolVersionRepository.save.mockResolvedValue({});

      const result = await service.activateTool('tool-1', 'org-1', 'user-1');

      expect(result.status).toBe(ToolStatus.ACTIVE);
      expect(result.updatedBy).toBe('user-1');
      expect(toolRepository.save).toHaveBeenCalled();
    });

    it('should return already active tool without changes', async () => {
      const mockTool = {
        id: 'tool-1',
        status: ToolStatus.ACTIVE,
      };

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      };

      jest.spyOn(service, 'getTool').mockResolvedValue(mockTool as any);
      userRepository.findOne.mockResolvedValue(mockUser);

      const result = await service.activateTool('tool-1', 'org-1', 'user-1');

      expect(result).toBe(mockTool);
      expect(toolRepository.save).not.toHaveBeenCalled();
    });

    it('should throw ForbiddenException for insufficient permissions', async () => {
      const mockTool = { id: 'tool-1', status: ToolStatus.DRAFT };
      const mockUser = { id: 'user-1', hasPermissionInOrganization: jest.fn().mockReturnValue(false) };

      jest.spyOn(service, 'getTool').mockResolvedValue(mockTool as any);
      userRepository.findOne.mockResolvedValue(mockUser);

      await expect(
        service.activateTool('tool-1', 'org-1', 'user-1')
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('deactivateTool', () => {
    it('should deactivate tool successfully', async () => {
      const mockTool = {
        id: 'tool-1',
        name: 'Test Tool',
        status: ToolStatus.ACTIVE,
      };

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      };

      const deactivatedTool = { ...mockTool, status: ToolStatus.INACTIVE, updatedBy: 'user-1' };

      jest.spyOn(service, 'getTool').mockResolvedValue(mockTool as any);
      userRepository.findOne.mockResolvedValue(mockUser);
      toolRepository.save.mockResolvedValue(deactivatedTool);
      toolVersionRepository.create.mockReturnValue({});
      toolVersionRepository.save.mockResolvedValue({});

      const result = await service.deactivateTool('tool-1', 'org-1', 'user-1');

      expect(result.status).toBe(ToolStatus.INACTIVE);
      expect(result.updatedBy).toBe('user-1');
    });

    it('should return already inactive tool without changes', async () => {
      const mockTool = { id: 'tool-1', status: ToolStatus.INACTIVE };
      const mockUser = { id: 'user-1', hasPermissionInOrganization: jest.fn().mockReturnValue(true) };

      jest.spyOn(service, 'getTool').mockResolvedValue(mockTool as any);
      userRepository.findOne.mockResolvedValue(mockUser);

      const result = await service.deactivateTool('tool-1', 'org-1', 'user-1');

      expect(result).toBe(mockTool);
      expect(toolRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('deleteTool', () => {
    it('should soft delete tool successfully', async () => {
      const mockTool = {
        id: 'tool-1',
        name: 'Test Tool',
        status: ToolStatus.ACTIVE,
        createdBy: 'user-1',
      };

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(false), // No general delete permission
      };

      jest.spyOn(service, 'getTool').mockResolvedValue(mockTool as any);
      userRepository.findOne.mockResolvedValue(mockUser);
      const deletedTool = { ...mockTool, status: ToolStatus.DELETED, updatedBy: 'user-1' };
      toolRepository.save.mockResolvedValue(deletedTool);

      await service.deleteTool('tool-1', 'org-1', 'user-1');

      expect(toolRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: ToolStatus.DELETED,
          updatedBy: 'user-1'
        })
      );
    });

    it('should throw ForbiddenException for insufficient permissions', async () => {
      const mockTool = {
        id: 'tool-1',
        createdBy: 'other-user',
      };

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(false),
      };

      jest.spyOn(service, 'getTool').mockResolvedValue(mockTool as any);
      userRepository.findOne.mockResolvedValue(mockUser);

      await expect(
        service.deleteTool('tool-1', 'org-1', 'user-1')
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('getToolVersions', () => {
    it('should return tool versions', async () => {
      const mockTool = { id: 'tool-1', organizationId: 'org-1' };
      const mockVersions = [
        { id: 'v1', version: '1.0.1', toolId: 'tool-1' },
        { id: 'v2', version: '1.0.0', toolId: 'tool-1' },
      ];

      jest.spyOn(service, 'getTool').mockResolvedValue(mockTool as any);
      toolVersionRepository.find.mockResolvedValue(mockVersions);

      const result = await service.getToolVersions('tool-1', 'org-1');

      expect(result).toBe(mockVersions);
      expect(toolVersionRepository.find).toHaveBeenCalledWith({
        where: { toolId: 'tool-1' },
        order: { createdAt: 'DESC' },
        relations: ['createdByUser'],
      });
    });
  });

  describe('getToolUsageStats', () => {
    const mockTool = { id: 'tool-1', organizationId: 'org-1' };

    const mockExecutions = [
      {
        id: 'exec-1',
        toolId: 'tool-1',
        success: true,
        executionTime: 1000,
        cached: false,
        userId: 'user-1',
        createdAt: new Date(),
        metadata: {},
      },
      {
        id: 'exec-2',
        toolId: 'tool-1',
        success: false,
        executionTime: 2000,
        cached: true,
        userId: 'user-2',
        createdAt: new Date(),
        metadata: { rateLimited: true },
      },
      {
        id: 'exec-3',
        toolId: 'tool-1',
        success: true,
        executionTime: 1500,
        cached: true,
        userId: 'user-1',
        createdAt: new Date(),
        metadata: {},
      },
    ];

    it('should return comprehensive usage statistics', async () => {
      jest.spyOn(service, 'getTool').mockResolvedValue(mockTool as any);
      toolExecutionRepository.find.mockResolvedValue(mockExecutions);

      const result = await service.getToolUsageStats('tool-1', 'org-1', 'day');

      expect(result.totalExecutions).toBe(3);
      expect(result.successfulExecutions).toBe(2);
      expect(result.failedExecutions).toBe(1);
      expect(result.averageExecutionTime).toBe(1500); // (1000 + 2000 + 1500) / 3
      expect(result.cacheHitRate).toBe(66.67); // 2/3 * 100, rounded
      expect(result.rateLimitedExecutions).toBe(1);
      expect(result.uniqueUsers).toBe(2);
      expect(result.executionTrend).toBeDefined();
    });

    it('should handle empty execution history', async () => {
      jest.spyOn(service, 'getTool').mockResolvedValue(mockTool as any);
      toolExecutionRepository.find.mockResolvedValue([]);

      const result = await service.getToolUsageStats('tool-1', 'org-1', 'hour');

      expect(result.totalExecutions).toBe(0);
      expect(result.successfulExecutions).toBe(0);
      expect(result.failedExecutions).toBe(0);
      expect(result.averageExecutionTime).toBe(0);
      expect(result.cacheHitRate).toBe(0);
      expect(result.uniqueUsers).toBe(0);
    });

    it('should handle different timeframes', async () => {
      jest.spyOn(service, 'getTool').mockResolvedValue(mockTool as any);
      toolExecutionRepository.find.mockResolvedValue(mockExecutions);

      const timeframes: Array<'hour' | 'day' | 'week' | 'month'> = ['hour', 'day', 'week', 'month'];

      for (const timeframe of timeframes) {
        const result = await service.getToolUsageStats('tool-1', 'org-1', timeframe);
        expect(result.executionTrend).toBeDefined();
      }
    });
  });

  describe('getOrganizationToolStats', () => {
    it('should return organization-wide tool statistics', async () => {
      const mockToolCounts = [
        { tool_status: ToolStatus.ACTIVE, count: '5' },
        { tool_status: ToolStatus.DRAFT, count: '3' },
        { tool_status: ToolStatus.INACTIVE, count: '2' },
      ];

      const mockExecutions = [
        { id: 'e1', toolId: 'tool-1', executionTime: 1000, tool: { id: 'tool-1', name: 'Tool 1' } },
        { id: 'e2', toolId: 'tool-1', executionTime: 2000, tool: { id: 'tool-1', name: 'Tool 1' } },
        { id: 'e3', toolId: 'tool-2', executionTime: 1500, tool: { id: 'tool-2', name: 'Tool 2' } },
      ];

      const mockTopTools = [
        { id: 'tool-1', name: 'Tool 1' },
        { id: 'tool-2', name: 'Tool 2' },
      ];

      const mockQueryBuilder = {
        createQueryBuilder: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue(mockToolCounts),
      };

      toolRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);
      toolExecutionRepository.find.mockResolvedValue(mockExecutions);
      toolRepository.find.mockResolvedValue(mockTopTools);

      const result = await service.getOrganizationToolStats('org-1');

      expect(result.totalTools).toBe(10); // 5 + 3 + 2
      expect(result.activeTools).toBe(5);
      expect(result.draftTools).toBe(3);
      expect(result.inactiveTools).toBe(2);
      expect(result.totalExecutions).toBe(3);
      expect(result.averageExecutionTime).toBe(1500); // (1000 + 2000 + 1500) / 3
      expect(result.topUsedTools).toHaveLength(2);
      expect(result.topUsedTools[0].tool.id).toBe('tool-1');
      expect(result.topUsedTools[0].executionCount).toBe(2);
    });

    it('should handle organization with no tools', async () => {
      const mockQueryBuilder = {
        createQueryBuilder: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      };

      toolRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);
      toolExecutionRepository.find.mockResolvedValue([]);
      toolRepository.find.mockResolvedValue([]);

      const result = await service.getOrganizationToolStats('org-1');

      expect(result.totalTools).toBe(0);
      expect(result.activeTools).toBe(0);
      expect(result.totalExecutions).toBe(0);
      expect(result.averageExecutionTime).toBe(0);
      expect(result.topUsedTools).toHaveLength(0);
    });
  });

  describe('findByName', () => {
    it('should find tool by name', async () => {
      const mockTool = { id: 'tool-1', name: 'Test Tool', organizationId: 'org-1' };

      toolRepository.findOne.mockResolvedValue(mockTool);

      const result = await service.findByName('Test Tool', 'org-1');

      expect(result).toBe(mockTool);
      expect(toolRepository.findOne).toHaveBeenCalledWith({
        where: {
          name: 'Test Tool',
          organizationId: 'org-1',
        },
      });
    });

    it('should return null when tool not found', async () => {
      toolRepository.findOne.mockResolvedValue(null);

      const result = await service.findByName('Non-existent', 'org-1');

      expect(result).toBeNull();
    });
  });

  describe('createFromOperation', () => {
    const mockOperation = {
      id: 'op-1',
      name: 'getUserById',
      method: 'GET',
      endpoint: '/users/{id}',
      type: 'query',
      timeoutMs: 10000,
      parameters: {
        path: {
          id: { type: 'string', required: true, description: 'User ID' },
        },
        query: {
          include: { type: 'array', items: { type: 'string' }, description: 'Fields to include' },
        },
      },
      api: {
        id: 'api-1',
        name: 'User API',
        type: 'openapi',
        baseUrl: 'https://api.users.com',
        organizationId: 'org-1',
        timeoutMs: 30000,
        retryAttempts: 2,
      },
    };

    const options = {
      name: 'Get User By ID',
      description: 'Retrieve a user by their ID',
      organizationId: 'org-1',
    };

    it('should create tool from operation successfully', async () => {
      const mockGeneratedTool = {
        id: 'tool-1',
        name: 'Get User By ID',
        type: ToolType.API,
        status: ToolStatus.ACTIVE,
        version: '1.0.0',
        createdBy: 'system',
        operationId: 'op-1',
        organizationId: 'org-1',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Path parameter: User ID' },
            include: { type: 'array', items: { type: 'string' }, description: 'Query parameter: Fields to include' },
          },
          required: ['id'],
        },
        configuration: {
          timeout: 10000,
          retries: 2,
          cache: { enabled: true, ttl: 300 },
        },
        metadata: {
          autoGenerated: true,
          sourceOperation: {
            id: 'op-1',
            name: 'getUserById',
            method: 'GET',
            endpoint: '/users/{id}',
          },
          sourceApi: {
            id: 'api-1',
            name: 'User API',
            type: 'openapi',
            baseUrl: 'https://api.users.com',
          },
        },
      };

      operationRepository.findOne.mockResolvedValue(mockOperation);
      toolRepository.create.mockReturnValue(mockGeneratedTool);
      toolRepository.save.mockResolvedValue(mockGeneratedTool);
      toolVersionRepository.create.mockReturnValue({});
      toolVersionRepository.save.mockResolvedValue({});

      const result = await service.createFromOperation(mockOperation as any, options);

      expect(result).toBe(mockGeneratedTool);
      expect(result.parameters.properties.id).toBeDefined();
      expect(result.parameters.properties.include).toBeDefined();
      expect(result.parameters.required).toContain('id');
      expect(result.configuration.cache.enabled).toBe(true); // Query operation cached by default
    });

    it('should throw NotFoundException for invalid operation', async () => {
      operationRepository.findOne.mockResolvedValue(null);

      await expect(
        service.createFromOperation({ id: 'op-1' } as any, options)
      ).rejects.toThrow(NotFoundException);
    });

    it('should handle operation with body parameters', async () => {
      const operationWithBody = {
        ...mockOperation,
        method: 'POST',
        type: 'mutation',
        parameters: {
          body: {
            user: {
              type: 'object',
              properties: {
                name: { type: 'string', required: true },
                email: { type: 'string', required: true },
              },
              required: ['name', 'email'],
            },
          },
        },
      };

      operationRepository.findOne.mockResolvedValue(operationWithBody);
      toolRepository.create.mockImplementation((data) => ({ id: 'tool-1', ...data }));
      toolRepository.save.mockImplementation((data) => Promise.resolve(data));
      toolVersionRepository.create.mockReturnValue({});
      toolVersionRepository.save.mockResolvedValue({});

      const result = await service.createFromOperation(operationWithBody as any, options);

      expect(result.parameters.properties.name).toBeDefined();
      expect(result.parameters.properties.email).toBeDefined();
      expect(result.parameters.required).toContain('name');
      expect(result.parameters.required).toContain('email');
      expect(result.configuration.cache.enabled).toBe(false); // Mutation not cached by default
    });

    it('should handle operation with multiple body parameters', async () => {
      const operationWithMultipleBody = {
        ...mockOperation,
        parameters: {
          body: {
            userData: { type: 'object', properties: { name: { type: 'string' } } },
            preferences: { type: 'object', properties: { theme: { type: 'string' } } },
          },
        },
      };

      operationRepository.findOne.mockResolvedValue(operationWithMultipleBody);
      toolRepository.create.mockImplementation((data) => ({ id: 'tool-1', ...data }));
      toolRepository.save.mockImplementation((data) => Promise.resolve(data));
      toolVersionRepository.create.mockReturnValue({});
      toolVersionRepository.save.mockResolvedValue({});

      const result = await service.createFromOperation(operationWithMultipleBody as any, options);

      expect(result.parameters.properties.userData).toBeDefined();
      expect(result.parameters.properties.preferences).toBeDefined();
    });

    it('should handle operation with single flattened body parameter', async () => {
      const operationWithFlatBody = {
        ...mockOperation,
        parameters: {
          body: {
            userRequest: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                email: { type: 'string' },
              },
              required: ['name'],
            },
          },
        },
      };

      operationRepository.findOne.mockResolvedValue(operationWithFlatBody);
      toolRepository.create.mockImplementation((data) => ({ id: 'tool-1', ...data }));
      toolRepository.save.mockImplementation((data) => Promise.resolve(data));
      toolVersionRepository.create.mockReturnValue({});
      toolVersionRepository.save.mockResolvedValue({});

      const result = await service.createFromOperation(operationWithFlatBody as any, options);

      expect(result.parameters.properties.name).toBeDefined();
      expect(result.parameters.properties.email).toBeDefined();
      expect(result.parameters.required).toContain('name');
    });
  });

  describe('Helper Methods', () => {
    describe('createToolVersion', () => {
      it('should create tool version', async () => {
        const mockTool = {
          id: 'tool-1',
          name: 'Test Tool',
          version: '1.0.1',
          description: 'Test description',
          type: ToolType.API,
          parameters: { type: 'object' },
          configuration: { timeout: 30000 },
          metadata: { source: 'manual' },
        };

        const mockVersion = {
          id: 'version-1',
          toolId: 'tool-1',
          version: '1.0.1',
          definition: {
            name: 'Test Tool',
            description: 'Test description',
            type: ToolType.API,
            parameters: { type: 'object' },
            configuration: { timeout: 30000 },
            metadata: { source: 'manual' },
          },
          changelog: 'Test update',
          createdBy: 'user-1',
        };

        toolVersionRepository.create.mockReturnValue(mockVersion);
        toolVersionRepository.save.mockResolvedValue(mockVersion);

        const result = await service['createToolVersion'](mockTool as any, 'Test update', 'user-1');

        expect(result).toBe(mockVersion);
        expect(toolVersionRepository.create).toHaveBeenCalledWith({
          toolId: 'tool-1',
          version: '1.0.1',
          definition: {
            name: 'Test Tool',
            description: 'Test description',
            type: ToolType.API,
            parameters: { type: 'object' },
            configuration: { timeout: 30000 },
            metadata: { source: 'manual' },
          },
          changelog: 'Test update',
          createdBy: 'user-1',
        });
      });
    });

    describe('calculateExecutionTrend', () => {
      const mockExecutions = [
        { success: true, createdAt: new Date() },
        { success: false, createdAt: new Date() },
      ] as ToolExecution[];

      it('should calculate hourly trend', async () => {
        const result = service['calculateExecutionTrend'](mockExecutions, 'hour');

        expect(result).toHaveLength(24);
        expect(result[0]).toHaveProperty('date');
        expect(result[0]).toHaveProperty('executions');
        expect(result[0]).toHaveProperty('success');
        expect(result[0]).toHaveProperty('failed');
      });

      it('should calculate daily trend', async () => {
        const result = service['calculateExecutionTrend'](mockExecutions, 'day');

        expect(result).toHaveLength(30);
        expect(result[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      });

      it('should calculate weekly trend', async () => {
        const result = service['calculateExecutionTrend'](mockExecutions, 'week');

        expect(result).toHaveLength(12);
        expect(result[0].date).toMatch(/^\d{4}-W\d+$/);
      });

      it('should calculate monthly trend', async () => {
        const result = service['calculateExecutionTrend'](mockExecutions, 'month');

        expect(result).toHaveLength(12);
        expect(result[0].date).toMatch(/^\d{4}-\d{2}$/);
      });
    });

    describe('generateToolParametersFromOperation', () => {
      it('should generate parameters from path and query parameters', async () => {
        const operation = {
          id: 'op-1',
          name: 'Get User',
          operationId: 'getUser',
          description: 'Get user by ID',
          apiId: 'api-1',
          endpoint: '/users/{id}',
          type: 'query' as any,
          method: 'GET' as any,
          isActive: true,
          deprecated: false,
          timeoutMs: 30000,
          createdAt: new Date(),
          updatedAt: new Date(),
          parameters: {
            path: {
              id: { type: 'string', required: true, description: 'User ID' },
            },
            query: {
              include: { type: 'array', description: 'Fields to include' },
              limit: { type: 'integer', required: false },
            },
          },
        } as unknown as Operation;

        const result = service['generateToolParametersFromOperation'](operation);

        expect(result.type).toBe('object');
        expect(result.properties.id).toEqual({
          type: 'string',
          description: 'User ID',
        });
        expect(result.properties.include).toEqual({
          type: 'array',
          description: 'Fields to include',
        });
        expect(result.required).toContain('id');
        expect(result.required).not.toContain('include');
      });

      it('should handle enum and example parameters', async () => {
        const operation = {
          id: 'op-2',
          name: 'Filter Status',
          operationId: 'filterByStatus',
          description: 'Filter by status',
          apiId: 'api-1',
          endpoint: '/filter',
          type: 'query' as any,
          method: 'GET' as any,
          isActive: true,
          deprecated: false,
          timeoutMs: 30000,
          createdAt: new Date(),
          updatedAt: new Date(),
          parameters: {
            query: {
              status: {
                type: 'string',
                enum: ['active', 'inactive'],
                example: 'active',
                description: 'Filter by status',
              },
            },
          },
        } as unknown as Operation;

        const result = service['generateToolParametersFromOperation'](operation);

        expect(result.properties.status.enum).toEqual(['active', 'inactive']);
        expect(result.properties.status.example).toBe('active');
      });

      it('should handle empty parameters', async () => {
        const operation = {
          id: 'op-3',
          name: 'Empty Operation',
          operationId: 'emptyOp',
          description: 'Operation with no parameters',
          apiId: 'api-1',
          endpoint: '/empty',
          type: 'query' as any,
          method: 'GET' as any,
          isActive: true,
          deprecated: false,
          timeoutMs: 30000,
          createdAt: new Date(),
          updatedAt: new Date(),
          parameters: {},
        } as unknown as Operation;

        const result = service['generateToolParametersFromOperation'](operation);

        expect(result.type).toBe('object');
        expect(result.properties).toEqual({});
        expect(result.required).toEqual([]);
      });
    });

    describe('mapOperationToToolType', () => {
      it('should map GET operations to API type', async () => {
        const operation = { method: 'GET' } as Operation;
        const result = service['mapOperationToToolType'](operation);
        expect(result).toBe(ToolType.API);
      });

      it('should map POST operations to API type', async () => {
        const operation = { method: 'POST' } as Operation;
        const result = service['mapOperationToToolType'](operation);
        expect(result).toBe(ToolType.API);
      });

      it('should map PUT operations to API type', async () => {
        const operation = { method: 'PUT' } as Operation;
        const result = service['mapOperationToToolType'](operation);
        expect(result).toBe(ToolType.API);
      });

      it('should map DELETE operations to API type', async () => {
        const operation = { method: 'DELETE' } as Operation;
        const result = service['mapOperationToToolType'](operation);
        expect(result).toBe(ToolType.API);
      });

      it('should default unknown methods to API type', async () => {
        const operation = { method: 'UNKNOWN' } as any;
        const result = service['mapOperationToToolType'](operation);
        expect(result).toBe(ToolType.API);
      });
    });

    describe('getWeekNumber', () => {
      it('should calculate week number correctly', async () => {
        const date1 = new Date('2023-01-01'); // Week 1
        const date2 = new Date('2023-01-08'); // Week 2
        const date3 = new Date('2023-12-31'); // Week 53

        const week1 = service['getWeekNumber'](date1);
        const week2 = service['getWeekNumber'](date2);
        const week3 = service['getWeekNumber'](date3);

        expect(week1).toBe(1);
        expect(week2).toBe(2);
        expect(week3).toBeGreaterThan(50);
      });
    });
  });

  describe('Complex Scenarios and Edge Cases', () => {
    it('should handle concurrent tool creation', async () => {
      const mockOrganization = { id: 'org-1', canAddMoreTools: jest.fn().mockReturnValue(true) };
      const mockUser = { id: 'user-1', hasPermissionInOrganization: jest.fn().mockReturnValue(true) };

      organizationRepository.findOne.mockResolvedValue(mockOrganization);
      userRepository.findOne.mockResolvedValue(mockUser);
      toolRepository.create.mockImplementation((data) => ({ id: `tool-${Date.now()}`, ...data }));
      toolRepository.save.mockImplementation((data) => Promise.resolve(data));
      toolVersionRepository.create.mockReturnValue({});
      toolVersionRepository.save.mockResolvedValue({});

      const createPromises = Array.from({ length: 5 }, (_, i) =>
        service.createTool(
          {
            name: `Tool ${i}`,
            description: `Tool ${i} description`,
            type: ToolType.API,
            parameters: { type: 'object' },
          },
          'org-1',
          'user-1'
        )
      );

      const results = await Promise.all(createPromises);

      expect(results).toHaveLength(5);
      results.forEach((result, index) => {
        expect(result.name).toBe(`Tool ${index}`);
      });
    });

    it('should handle complex search and filtering', async () => {
      const complexFilters: ToolSearchFilters = {
        organizationId: 'org-1',
        search: 'complex search term',
        type: ToolType.API,
        status: ToolStatus.ACTIVE,
        categoryIds: ['cat-1', 'cat-2', 'cat-3'],
        apiId: 'api-1',
        tags: ['tag1', 'tag2', 'tag3'],
        sortBy: 'usage',
        sortOrder: 'DESC',
        page: 3,
        limit: 50,
      };

      const mockQueryBuilder = {
        createQueryBuilder: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        leftJoin: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        addGroupBy: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        clone: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(150),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };

      toolRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      const result = await service.getTools(complexFilters);

      expect(result.page).toBe(3);
      expect(result.limit).toBe(50);
      expect(result.total).toBe(150);
      expect(result.totalPages).toBe(3);
      expect(mockQueryBuilder.skip).toHaveBeenCalledWith(100); // (3-1) * 50
      expect(mockQueryBuilder.take).toHaveBeenCalledWith(50);
    });

    it('should handle large-scale statistics calculation', async () => {
      const largeExecutionSet = Array.from({ length: 10000 }, (_, i) => ({
        id: `exec-${i}`,
        toolId: `tool-${i % 100}`, // 100 different tools
        success: i % 10 !== 0, // 90% success rate
        executionTime: Math.random() * 5000,
        cached: i % 3 === 0, // 33% cache hit rate
        userId: `user-${i % 50}`, // 50 different users
        createdAt: new Date(Date.now() - i * 60000), // Spread over time
        metadata: i % 20 === 0 ? { rateLimited: true } : {},
      }));

      const mockToolCounts = [
        { tool_status: ToolStatus.ACTIVE, count: '80' },
        { tool_status: ToolStatus.DRAFT, count: '15' },
        { tool_status: ToolStatus.INACTIVE, count: '5' },
      ];

      const mockQueryBuilder = {
        createQueryBuilder: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue(mockToolCounts),
      };

      toolRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);
      toolExecutionRepository.find.mockResolvedValue(largeExecutionSet);
      toolRepository.find.mockResolvedValue([]);

      const result = await service.getOrganizationToolStats('org-1');

      expect(result.totalTools).toBe(100);
      expect(result.activeTools).toBe(80);
      expect(result.totalExecutions).toBe(10000);
      expect(result.averageExecutionTime).toBeDefined();
    });

    it('should handle tools with no execution history', async () => {
      const mockTool = { id: 'tool-1', organizationId: 'org-1' };

      jest.spyOn(service, 'getTool').mockResolvedValue(mockTool as any);
      toolExecutionRepository.find.mockResolvedValue([]);

      const result = await service.getToolUsageStats('tool-1', 'org-1', 'month');

      expect(result.totalExecutions).toBe(0);
      expect(result.averageExecutionTime).toBe(0);
      expect(result.cacheHitRate).toBe(0);
      expect(result.uniqueUsers).toBe(0);
      expect(result.executionTrend).toHaveLength(12); // 12 months
    });
  });

  describe('basic functionality', () => {
    it('should be defined', () => {
      expect(service).toBeDefined();
    });

    it('should have all required dependencies injected', () => {
      expect(toolRepository).toBeDefined();
      expect(toolVersionRepository).toBeDefined();
      expect(toolCategoryRepository).toBeDefined();
      expect(toolExecutionRepository).toBeDefined();
      expect(apiRepository).toBeDefined();
      expect(operationRepository).toBeDefined();
      expect(userRepository).toBeDefined();
      expect(organizationRepository).toBeDefined();
    });
  });
});