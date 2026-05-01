import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { ToolsService, CreateToolDto, UpdateToolDto, ToolSearchFilters } from './tools.service';
import { ToolsOperationHelper } from './tools-operation.helper';
import { ToolsStatsHelper } from './tools-stats.helper';
import { Tool, ToolStatus, ToolType } from '../../entities/tool.entity';
import { ToolVersion } from '../../entities/tool-version.entity';
import { ToolCategory } from '../../entities/tool-category.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import { Api, ApiType } from '../../entities/api.entity';
import { ApiSchema } from '../../entities/api-schema.entity';
import { Operation } from '../../entities/operation.entity';
import { User } from '../../entities/user.entity';
import { Organization } from '../../entities/organization.entity';
import { AuditLogService } from '../audit-log/audit-log.service';

// ─── Helper factories ───────────────────────────────────────────────────────

function makeTool(overrides: Partial<Tool> = {}): Tool {
  const tool = new Tool();
  tool.id = 'tool-1';
  tool.name = 'Test Tool';
  tool.description = 'A test tool';
  tool.type = ToolType.API;
  tool.status = ToolStatus.DRAFT;
  tool.version = '1.0.0';
  tool.organizationId = 'org-1';
  tool.createdBy = 'user-1';
  tool.categories = [];
  tool.parameters = { type: 'object', properties: {}, required: [] };
  tool.configuration = {};
  tool.metadata = {};
  return Object.assign(tool, overrides);
}

function makeOrganization(overrides: Partial<Organization> = {}): Organization {
  const org = new Organization();
  org.id = 'org-1';
  org.name = 'Test Org';
  org.slug = 'test-org';
  org.isActive = true;
  org.settings = {};
  org.tools = [];
  org.apis = [];
  org.gateways = [];
  return Object.assign(org, overrides);
}

function makeUser(overrides: Partial<User> = {}): User {
  const user = new User();
  user.id = 'user-1';
  user.email = 'test@example.com';
  user.firstName = 'Test';
  user.lastName = 'User';
  user.organizationMemberships = [
    { organizationId: 'org-1', role: 'owner' } as any,
  ];
  return Object.assign(user, overrides);
}

function makeOperation(overrides: Partial<Operation> = {}): Operation {
  const op = new Operation();
  op.id = 'op-1';
  op.name = 'listPets';
  op.apiId = 'api-1';
  op.method = 'GET' as any;
  op.endpoint = '/pets';
  op.type = 'query' as any;
  op.parameters = { path: {}, query: {}, body: undefined };
  op.timeoutMs = 30000;
  op.api = {
    id: 'api-1',
    name: 'Petstore',
    baseUrl: 'https://petstore.example.com',
    type: ApiType.OPENAPI,
    organizationId: 'org-1',
    timeoutMs: 30000,
    retryAttempts: 3,
    rateLimits: undefined,
  } as any;
  return Object.assign(op, overrides);
}

function makeQueryBuilder(returnTools: Tool[] = [], total = 0) {
  const qb: any = {
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    addGroupBy: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    clone: jest.fn(),
    getCount: jest.fn().mockResolvedValue(total),
    getMany: jest.fn().mockResolvedValue(returnTools),
    select: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
  };
  // clone returns a copy that also has getCount
  qb.clone.mockReturnValue({ ...qb });
  return qb;
}

// ─── Test suite ──────────────────────────────────────────────────────────────

describe('ToolsService', () => {
  let service: ToolsService;

  let toolRepo: jest.Mocked<any>;
  let toolVersionRepo: jest.Mocked<any>;
  let toolCategoryRepo: jest.Mocked<any>;
  let toolExecutionRepo: jest.Mocked<any>;
  let apiRepo: jest.Mocked<any>;
  let apiSchemaRepo: jest.Mocked<any>;
  let operationRepo: jest.Mocked<any>;
  let userRepo: jest.Mocked<any>;
  let organizationRepo: jest.Mocked<any>;

  beforeEach(async () => {
    toolRepo = {
      create: jest.fn(),
      save: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    toolVersionRepo = {
      create: jest.fn(),
      save: jest.fn(),
      find: jest.fn(),
    };

    toolCategoryRepo = {
      find: jest.fn(),
    };

    toolExecutionRepo = {
      find: jest.fn(),
    };

    apiRepo = {
      create: jest.fn(),
      save: jest.fn(),
    };

    apiSchemaRepo = {
      findOne: jest.fn(),
    };

    operationRepo = {
      findOne: jest.fn(),
    };

    userRepo = {
      findOne: jest.fn(),
    };

    organizationRepo = {
      findOne: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ToolsOperationHelper,
        ToolsStatsHelper,
        ToolsService,
        { provide: getRepositoryToken(Tool), useValue: toolRepo },
        { provide: getRepositoryToken(ToolVersion), useValue: toolVersionRepo },
        { provide: getRepositoryToken(ToolCategory), useValue: toolCategoryRepo },
        { provide: getRepositoryToken(ToolExecution), useValue: toolExecutionRepo },
        { provide: getRepositoryToken(Api), useValue: apiRepo },
        { provide: getRepositoryToken(ApiSchema), useValue: apiSchemaRepo },
        { provide: getRepositoryToken(Operation), useValue: operationRepo },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: getRepositoryToken(Organization), useValue: organizationRepo },
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

    service = module.get<ToolsService>(ToolsService);
  });

  afterEach(() => jest.clearAllMocks());

  // ─── createTool ────────────────────────────────────────────────────────────

  describe('createTool', () => {
    const dto: CreateToolDto = {
      name: 'My Tool',
      description: 'Does stuff',
      type: ToolType.API,
      parameters: { type: 'object', properties: {} },
    };

    it('should create a draft tool successfully', async () => {
      const org = makeOrganization();
      const user = makeUser();
      const tool = makeTool();
      const version = { id: 'v-1' } as ToolVersion;

      organizationRepo.findOne.mockResolvedValue(org);
      userRepo.findOne.mockResolvedValue(user);
      toolRepo.create.mockReturnValue(tool);
      toolRepo.save.mockResolvedValue(tool);
      toolVersionRepo.create.mockReturnValue(version);
      toolVersionRepo.save.mockResolvedValue(version);

      const result = await service.createTool(dto, 'org-1', 'user-1');

      expect(result).toBe(tool);
      expect(toolRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: dto.name,
          organizationId: 'org-1',
          createdBy: 'user-1',
          status: ToolStatus.DRAFT,
        }),
      );
      expect(toolVersionRepo.save).toHaveBeenCalled();
    });

    it('should create an ACTIVE tool for custom tools with code', async () => {
      const org = makeOrganization();
      const user = makeUser();
      const tool = makeTool({ status: ToolStatus.ACTIVE });

      organizationRepo.findOne.mockResolvedValue(org);
      userRepo.findOne.mockResolvedValue(user);
      apiRepo.create.mockReturnValue({});
      apiRepo.save.mockResolvedValue({ id: 'api-custom-1' });
      toolRepo.create.mockReturnValue(tool);
      toolRepo.save.mockResolvedValue(tool);
      toolVersionRepo.create.mockReturnValue({});
      toolVersionRepo.save.mockResolvedValue({});

      const customDto: CreateToolDto = { ...dto, code: 'return 42;' };
      const result = await service.createTool(customDto, 'org-1', 'user-1');

      expect(toolRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ status: ToolStatus.ACTIVE }),
      );
      expect(result).toBe(tool);
    });

    it('should throw NotFoundException when organization is not found', async () => {
      organizationRepo.findOne.mockResolvedValue(null);

      await expect(service.createTool(dto, 'org-999', 'user-1')).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException when user lacks create_tools permission', async () => {
      const org = makeOrganization();
      const user = makeUser({
        organizationMemberships: [{ organizationId: 'org-1', role: 'viewer' } as any],
      });

      organizationRepo.findOne.mockResolvedValue(org);
      userRepo.findOne.mockResolvedValue(user);

      await expect(service.createTool(dto, 'org-1', 'user-1')).rejects.toThrow(ForbiddenException);
    });

    it('should throw ForbiddenException when user has no membership', async () => {
      const org = makeOrganization();
      const user = makeUser({ organizationMemberships: [] });

      organizationRepo.findOne.mockResolvedValue(org);
      userRepo.findOne.mockResolvedValue(user);

      await expect(service.createTool(dto, 'org-1', 'user-1')).rejects.toThrow(ForbiddenException);
    });

    it('should throw BadRequestException when organization has reached tool limit', async () => {
      const org = makeOrganization({ settings: { maxTools: 1 }, tools: [makeTool()] as any });
      const user = makeUser();

      organizationRepo.findOne.mockResolvedValue(org);
      userRepo.findOne.mockResolvedValue(user);

      await expect(service.createTool(dto, 'org-1', 'user-1')).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when some category IDs are not found', async () => {
      const org = makeOrganization();
      const user = makeUser();

      organizationRepo.findOne.mockResolvedValue(org);
      userRepo.findOne.mockResolvedValue(user);
      toolCategoryRepo.find.mockResolvedValue([]); // none found

      const dtoWithCats: CreateToolDto = { ...dto, categoryIds: ['cat-1', 'cat-2'] };
      await expect(service.createTool(dtoWithCats, 'org-1', 'user-1')).rejects.toThrow(BadRequestException);
    });

    it('should resolve categories successfully when all IDs exist', async () => {
      const org = makeOrganization();
      const user = makeUser();
      const cat1 = { id: 'cat-1' } as ToolCategory;
      const cat2 = { id: 'cat-2' } as ToolCategory;
      const tool = makeTool({ categories: [cat1, cat2] });

      organizationRepo.findOne.mockResolvedValue(org);
      userRepo.findOne.mockResolvedValue(user);
      toolCategoryRepo.find.mockResolvedValue([cat1, cat2]);
      toolRepo.create.mockReturnValue(tool);
      toolRepo.save.mockResolvedValue(tool);
      toolVersionRepo.create.mockReturnValue({});
      toolVersionRepo.save.mockResolvedValue({});

      const dtoWithCats: CreateToolDto = { ...dto, categoryIds: ['cat-1', 'cat-2'] };
      const result = await service.createTool(dtoWithCats, 'org-1', 'user-1');

      expect(toolCategoryRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organizationId: 'org-1' }),
        }),
      );
      expect(result).toBe(tool);
    });

    it('should throw BadRequestException when operation does not belong to organization', async () => {
      const org = makeOrganization();
      const user = makeUser();
      const op = makeOperation({ api: { organizationId: 'other-org' } as any });

      organizationRepo.findOne.mockResolvedValue(org);
      userRepo.findOne.mockResolvedValue(user);
      operationRepo.findOne.mockResolvedValue(op);

      const dtoWithOp: CreateToolDto = { ...dto, operationId: 'op-1' };
      await expect(service.createTool(dtoWithOp, 'org-1', 'user-1')).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when operation is not found', async () => {
      const org = makeOrganization();
      const user = makeUser();

      organizationRepo.findOne.mockResolvedValue(org);
      userRepo.findOne.mockResolvedValue(user);
      operationRepo.findOne.mockResolvedValue(null);

      const dtoWithOp: CreateToolDto = { ...dto, operationId: 'op-missing' };
      await expect(service.createTool(dtoWithOp, 'org-1', 'user-1')).rejects.toThrow(BadRequestException);
    });

    it('should continue when auto-creating API for custom tool fails', async () => {
      const org = makeOrganization();
      const user = makeUser();
      const tool = makeTool({ status: ToolStatus.ACTIVE });

      organizationRepo.findOne.mockResolvedValue(org);
      userRepo.findOne.mockResolvedValue(user);
      apiRepo.create.mockReturnValue({});
      apiRepo.save.mockRejectedValue(new Error('DB error'));
      toolRepo.create.mockReturnValue(tool);
      toolRepo.save.mockResolvedValue(tool);
      toolVersionRepo.create.mockReturnValue({});
      toolVersionRepo.save.mockResolvedValue({});

      const customDto: CreateToolDto = { ...dto, code: 'return 1;' };
      const result = await service.createTool(customDto, 'org-1', 'user-1');

      // Should succeed despite the failed auto API creation
      expect(result).toBe(tool);
    });
  });

  // ─── getTool ───────────────────────────────────────────────────────────────

  describe('getTool', () => {
    it('should return a tool with all relations when includeRelations is true', async () => {
      const tool = makeTool();
      toolRepo.findOne.mockResolvedValue(tool);

      const result = await service.getTool('tool-1', 'org-1', true);

      expect(result).toBe(tool);
      expect(toolRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'tool-1', organizationId: 'org-1' },
          relations: expect.arrayContaining(['categories', 'operation', 'versions']),
        }),
      );
    });

    it('should return a tool with no relations when includeRelations is false', async () => {
      const tool = makeTool();
      toolRepo.findOne.mockResolvedValue(tool);

      const result = await service.getTool('tool-1', 'org-1', false);

      expect(result).toBe(tool);
      expect(toolRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ relations: [] }),
      );
    });

    it('should throw NotFoundException when tool is not found', async () => {
      toolRepo.findOne.mockResolvedValue(null);

      await expect(service.getTool('missing', 'org-1')).rejects.toThrow(NotFoundException);
    });

    it('should default includeRelations to true', async () => {
      const tool = makeTool();
      toolRepo.findOne.mockResolvedValue(tool);

      await service.getTool('tool-1', 'org-1');

      expect(toolRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          relations: expect.arrayContaining(['categories', 'versions']),
        }),
      );
    });
  });

  // ─── updateTool ────────────────────────────────────────────────────────────

  describe('updateTool', () => {
    const updateDto: UpdateToolDto = {
      name: 'Updated Name',
      description: 'Updated desc',
    };

    it('should update tool fields successfully', async () => {
      const tool = makeTool();
      const user = makeUser();
      const updatedTool = makeTool({ name: 'Updated Name', version: '1.0.1' });

      toolRepo.findOne.mockResolvedValue(tool);
      userRepo.findOne.mockResolvedValue(user);
      toolRepo.save.mockResolvedValue(updatedTool);
      toolVersionRepo.create.mockReturnValue({});
      toolVersionRepo.save.mockResolvedValue({});

      const result = await service.updateTool('tool-1', updateDto, 'org-1', 'user-1');

      expect(result).toBe(updatedTool);
      expect(toolRepo.save).toHaveBeenCalled();
      // Version should be incremented
      expect(tool.version).toBe('1.0.1');
    });

    it('should throw NotFoundException when tool is not found', async () => {
      toolRepo.findOne.mockResolvedValue(null);

      await expect(service.updateTool('missing', updateDto, 'org-1', 'user-1')).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException when user has no edit permission and is not creator', async () => {
      const tool = makeTool({ createdBy: 'other-user' });
      const user = makeUser({
        organizationMemberships: [{ organizationId: 'org-1', role: 'viewer' } as any],
      });

      toolRepo.findOne.mockResolvedValue(tool);
      userRepo.findOne.mockResolvedValue(user);

      await expect(service.updateTool('tool-1', updateDto, 'org-1', 'user-1')).rejects.toThrow(ForbiddenException);
    });

    it('should allow creator to update even without edit_tools permission', async () => {
      const tool = makeTool({ createdBy: 'user-1' });
      const user = makeUser({
        organizationMemberships: [{ organizationId: 'org-1', role: 'member' } as any],
      });
      const saved = makeTool({ createdBy: 'user-1' });

      toolRepo.findOne.mockResolvedValue(tool);
      userRepo.findOne.mockResolvedValue(user);
      toolRepo.save.mockResolvedValue(saved);
      toolVersionRepo.create.mockReturnValue({});
      toolVersionRepo.save.mockResolvedValue({});

      const result = await service.updateTool('tool-1', updateDto, 'org-1', 'user-1');
      expect(result).toBe(saved);
    });

    it('should update categories when categoryIds are provided', async () => {
      const tool = makeTool();
      const user = makeUser();
      const cat = { id: 'cat-1' } as ToolCategory;
      const saved = makeTool({ categories: [cat] });

      toolRepo.findOne.mockResolvedValue(tool);
      userRepo.findOne.mockResolvedValue(user);
      toolCategoryRepo.find.mockResolvedValue([cat]);
      toolRepo.save.mockResolvedValue(saved);
      toolVersionRepo.create.mockReturnValue({});
      toolVersionRepo.save.mockResolvedValue({});

      const dto: UpdateToolDto = { categoryIds: ['cat-1'] };
      await service.updateTool('tool-1', dto, 'org-1', 'user-1');

      expect(tool.categories).toEqual([cat]);
    });

    it('should clear categories when empty categoryIds array is provided', async () => {
      const cat = { id: 'cat-1' } as ToolCategory;
      const tool = makeTool({ categories: [cat] });
      const user = makeUser();

      toolRepo.findOne.mockResolvedValue(tool);
      userRepo.findOne.mockResolvedValue(user);
      toolRepo.save.mockResolvedValue(tool);
      toolVersionRepo.create.mockReturnValue({});
      toolVersionRepo.save.mockResolvedValue({});

      const dto: UpdateToolDto = { categoryIds: [] };
      await service.updateTool('tool-1', dto, 'org-1', 'user-1');

      expect(tool.categories).toEqual([]);
    });

    it('should throw BadRequestException when some updated category IDs are missing', async () => {
      const tool = makeTool();
      const user = makeUser();

      toolRepo.findOne.mockResolvedValue(tool);
      userRepo.findOne.mockResolvedValue(user);
      toolCategoryRepo.find.mockResolvedValue([]); // none found

      const dto: UpdateToolDto = { categoryIds: ['cat-missing'] };
      await expect(service.updateTool('tool-1', dto, 'org-1', 'user-1')).rejects.toThrow(BadRequestException);
    });

    it('should update parameters when provided', async () => {
      const tool = makeTool();
      const user = makeUser();

      toolRepo.findOne.mockResolvedValue(tool);
      userRepo.findOne.mockResolvedValue(user);
      toolRepo.save.mockResolvedValue(tool);
      toolVersionRepo.create.mockReturnValue({});
      toolVersionRepo.save.mockResolvedValue({});

      const newParams = { type: 'object', properties: { foo: { type: 'string' } }, required: ['foo'] };
      await service.updateTool('tool-1', { parameters: newParams }, 'org-1', 'user-1');

      expect(tool.parameters).toEqual(newParams);
    });

    it('should merge configuration when provided', async () => {
      const tool = makeTool({ configuration: { timeout: 5000, retries: 3 } });
      const user = makeUser();

      toolRepo.findOne.mockResolvedValue(tool);
      userRepo.findOne.mockResolvedValue(user);
      toolRepo.save.mockResolvedValue(tool);
      toolVersionRepo.create.mockReturnValue({});
      toolVersionRepo.save.mockResolvedValue({});

      await service.updateTool('tool-1', { configuration: { timeout: 9000 } }, 'org-1', 'user-1');

      expect(tool.configuration).toEqual({ timeout: 9000, retries: 3 });
    });

    it('should increment patch version on update', async () => {
      const tool = makeTool({ version: '1.2.3' });
      const user = makeUser();

      toolRepo.findOne.mockResolvedValue(tool);
      userRepo.findOne.mockResolvedValue(user);
      toolRepo.save.mockResolvedValue(tool);
      toolVersionRepo.create.mockReturnValue({});
      toolVersionRepo.save.mockResolvedValue({});

      await service.updateTool('tool-1', { name: 'New Name' }, 'org-1', 'user-1');

      expect(tool.version).toBe('1.2.4');
    });
  });

  // ─── deleteTool ────────────────────────────────────────────────────────────

  describe('deleteTool', () => {
    it('should soft-delete a tool by setting status to DELETED', async () => {
      const tool = makeTool({ createdBy: 'user-1', status: ToolStatus.ACTIVE });
      const user = makeUser();

      // getTool internally calls toolRepo.findOne
      toolRepo.findOne.mockResolvedValue(tool);
      userRepo.findOne.mockResolvedValue(user);
      toolRepo.save.mockResolvedValue(tool);

      await service.deleteTool('tool-1', 'org-1', 'user-1');

      expect(tool.status).toBe(ToolStatus.DELETED);
      expect(toolRepo.save).toHaveBeenCalledWith(tool);
    });

    it('should throw NotFoundException when tool does not exist', async () => {
      toolRepo.findOne.mockResolvedValue(null);

      await expect(service.deleteTool('missing', 'org-1', 'user-1')).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException when user lacks delete permission and is not creator', async () => {
      const tool = makeTool({ createdBy: 'another-user' });
      const user = makeUser({
        organizationMemberships: [{ organizationId: 'org-1', role: 'member' } as any],
      });

      toolRepo.findOne.mockResolvedValue(tool);
      userRepo.findOne.mockResolvedValue(user);

      await expect(service.deleteTool('tool-1', 'org-1', 'user-1')).rejects.toThrow(ForbiddenException);
    });

    it('should allow creator to delete even without delete_tools permission', async () => {
      const tool = makeTool({ createdBy: 'user-1' });
      const user = makeUser({
        organizationMemberships: [{ organizationId: 'org-1', role: 'member' } as any],
      });

      toolRepo.findOne.mockResolvedValue(tool);
      userRepo.findOne.mockResolvedValue(user);
      toolRepo.save.mockResolvedValue(tool);

      await service.deleteTool('tool-1', 'org-1', 'user-1');

      expect(tool.status).toBe(ToolStatus.DELETED);
    });
  });

  // ─── activateTool ──────────────────────────────────────────────────────────

  describe('activateTool', () => {
    it('should activate a draft tool', async () => {
      const tool = makeTool({ status: ToolStatus.DRAFT });
      const user = makeUser();

      toolRepo.findOne.mockResolvedValue(tool);
      userRepo.findOne.mockResolvedValue(user);
      toolRepo.save.mockResolvedValue({ ...tool, status: ToolStatus.ACTIVE });
      toolVersionRepo.create.mockReturnValue({});
      toolVersionRepo.save.mockResolvedValue({});

      const result = await service.activateTool('tool-1', 'org-1', 'user-1');

      expect(result.status).toBe(ToolStatus.ACTIVE);
      expect(toolRepo.save).toHaveBeenCalled();
    });

    it('should return tool immediately if already ACTIVE', async () => {
      const tool = makeTool({ status: ToolStatus.ACTIVE });
      const user = makeUser();

      toolRepo.findOne.mockResolvedValue(tool);
      userRepo.findOne.mockResolvedValue(user);

      const result = await service.activateTool('tool-1', 'org-1', 'user-1');

      expect(result.status).toBe(ToolStatus.ACTIVE);
      expect(toolRepo.save).not.toHaveBeenCalled();
    });

    it('should throw ForbiddenException when user lacks manage_tools permission', async () => {
      const tool = makeTool();
      const user = makeUser({
        organizationMemberships: [{ organizationId: 'org-1', role: 'member' } as any],
      });

      toolRepo.findOne.mockResolvedValue(tool);
      userRepo.findOne.mockResolvedValue(user);

      await expect(service.activateTool('tool-1', 'org-1', 'user-1')).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException for missing tool', async () => {
      toolRepo.findOne.mockResolvedValue(null);

      await expect(service.activateTool('missing', 'org-1', 'user-1')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── deactivateTool ────────────────────────────────────────────────────────

  describe('deactivateTool', () => {
    it('should deactivate an active tool', async () => {
      const tool = makeTool({ status: ToolStatus.ACTIVE });
      const user = makeUser();

      toolRepo.findOne.mockResolvedValue(tool);
      userRepo.findOne.mockResolvedValue(user);
      toolRepo.save.mockResolvedValue({ ...tool, status: ToolStatus.INACTIVE });
      toolVersionRepo.create.mockReturnValue({});
      toolVersionRepo.save.mockResolvedValue({});

      const result = await service.deactivateTool('tool-1', 'org-1', 'user-1');

      expect(result.status).toBe(ToolStatus.INACTIVE);
    });

    it('should return tool immediately if already INACTIVE', async () => {
      const tool = makeTool({ status: ToolStatus.INACTIVE });
      const user = makeUser();

      toolRepo.findOne.mockResolvedValue(tool);
      userRepo.findOne.mockResolvedValue(user);

      const result = await service.deactivateTool('tool-1', 'org-1', 'user-1');

      expect(result.status).toBe(ToolStatus.INACTIVE);
      expect(toolRepo.save).not.toHaveBeenCalled();
    });

    it('should throw ForbiddenException when user lacks manage_tools permission', async () => {
      const tool = makeTool({ status: ToolStatus.ACTIVE });
      const user = makeUser({
        organizationMemberships: [{ organizationId: 'org-1', role: 'member' } as any],
      });

      toolRepo.findOne.mockResolvedValue(tool);
      userRepo.findOne.mockResolvedValue(user);

      await expect(service.deactivateTool('tool-1', 'org-1', 'user-1')).rejects.toThrow(ForbiddenException);
    });
  });

  // ─── getTools ─────────────────────────────────────────────────────────────

  describe('getTools', () => {
    const baseFilters: ToolSearchFilters = { organizationId: 'org-1' };

    it('should return paginated tools with defaults', async () => {
      const tools = [makeTool(), makeTool({ id: 'tool-2', name: 'Tool 2' })];
      const qb = makeQueryBuilder(tools, 2);
      toolRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.getTools(baseFilters);

      expect(result.tools).toBe(tools);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
      expect(result.totalPages).toBe(1);
    });

    it('should apply search filter', async () => {
      const qb = makeQueryBuilder([], 0);
      toolRepo.createQueryBuilder.mockReturnValue(qb);

      await service.getTools({ ...baseFilters, search: 'petstore' });

      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('ILIKE'),
        expect.objectContaining({ search: '%petstore%' }),
      );
    });

    it('should apply type filter', async () => {
      const qb = makeQueryBuilder([], 0);
      toolRepo.createQueryBuilder.mockReturnValue(qb);

      await service.getTools({ ...baseFilters, type: ToolType.API });

      expect(qb.andWhere).toHaveBeenCalledWith('tool.type = :type', { type: ToolType.API });
    });

    it('should apply status filter', async () => {
      const qb = makeQueryBuilder([], 0);
      toolRepo.createQueryBuilder.mockReturnValue(qb);

      await service.getTools({ ...baseFilters, status: ToolStatus.ACTIVE });

      expect(qb.andWhere).toHaveBeenCalledWith('tool.status = :status', { status: ToolStatus.ACTIVE });
    });

    it('should apply categoryIds filter', async () => {
      const qb = makeQueryBuilder([], 0);
      toolRepo.createQueryBuilder.mockReturnValue(qb);

      await service.getTools({ ...baseFilters, categoryIds: ['cat-1'] });

      expect(qb.andWhere).toHaveBeenCalledWith(
        'category.id IN (:...categoryIds)',
        { categoryIds: ['cat-1'] },
      );
    });

    it('should apply apiId filter', async () => {
      const qb = makeQueryBuilder([], 0);
      toolRepo.createQueryBuilder.mockReturnValue(qb);

      await service.getTools({ ...baseFilters, apiId: 'api-1' });

      expect(qb.andWhere).toHaveBeenCalledWith('api.id = :apiId', { apiId: 'api-1' });
    });

    it('should apply tags filter', async () => {
      const qb = makeQueryBuilder([], 0);
      toolRepo.createQueryBuilder.mockReturnValue(qb);

      await service.getTools({ ...baseFilters, tags: ['pets', 'store'] });

      expect(qb.andWhere).toHaveBeenCalledWith('tool.tags && :tags', { tags: ['pets', 'store'] });
    });

    it('should sort by usage when sortBy is usage', async () => {
      const qb = makeQueryBuilder([], 0);
      toolRepo.createQueryBuilder.mockReturnValue(qb);

      await service.getTools({ ...baseFilters, sortBy: 'usage', sortOrder: 'DESC' });

      expect(qb.addSelect).toHaveBeenCalledWith('COUNT(execution.id)', 'usageCount');
      expect(qb.orderBy).toHaveBeenCalledWith('usageCount', 'DESC');
    });

    it('should sort by name when sortBy is name', async () => {
      const qb = makeQueryBuilder([], 0);
      toolRepo.createQueryBuilder.mockReturnValue(qb);

      await service.getTools({ ...baseFilters, sortBy: 'name', sortOrder: 'ASC' });

      expect(qb.orderBy).toHaveBeenCalledWith('tool.name', 'ASC');
    });

    it('should cap limit at 100', async () => {
      const qb = makeQueryBuilder([], 0);
      toolRepo.createQueryBuilder.mockReturnValue(qb);

      await service.getTools({ ...baseFilters, limit: 9999 });

      expect(qb.take).toHaveBeenCalledWith(100);
    });

    it('should calculate correct totalPages', async () => {
      const qb = makeQueryBuilder([], 45);
      toolRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.getTools({ ...baseFilters, limit: 10 });

      expect(result.totalPages).toBe(5);
    });

    it('should apply correct pagination offset', async () => {
      const qb = makeQueryBuilder([], 100);
      toolRepo.createQueryBuilder.mockReturnValue(qb);

      await service.getTools({ ...baseFilters, page: 3, limit: 10 });

      expect(qb.skip).toHaveBeenCalledWith(20);
      expect(qb.take).toHaveBeenCalledWith(10);
    });
  });

  // ─── getToolVersions ───────────────────────────────────────────────────────

  describe('getToolVersions', () => {
    it('should return versions for a tool', async () => {
      const tool = makeTool();
      const versions: Partial<ToolVersion>[] = [
        { id: 'v-1', version: '1.0.1', toolId: 'tool-1' },
        { id: 'v-2', version: '1.0.0', toolId: 'tool-1' },
      ];

      toolRepo.findOne.mockResolvedValue(tool);
      toolVersionRepo.find.mockResolvedValue(versions);

      const result = await service.getToolVersions('tool-1', 'org-1');

      expect(result).toBe(versions);
      expect(toolVersionRepo.find).toHaveBeenCalledWith({
        where: { toolId: 'tool-1' },
        order: { createdAt: 'DESC' },
        relations: ['createdByUser'],
      });
    });

    it('should throw NotFoundException when tool does not exist', async () => {
      toolRepo.findOne.mockResolvedValue(null);

      await expect(service.getToolVersions('missing', 'org-1')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── getToolUsageStats ─────────────────────────────────────────────────────

  describe('getToolUsageStats', () => {
    it('should return zeroed stats when no executions exist', async () => {
      const tool = makeTool();
      toolRepo.findOne.mockResolvedValue(tool);
      toolExecutionRepo.find.mockResolvedValue([]);

      const stats = await service.getToolUsageStats('tool-1', 'org-1', 'day');

      expect(stats.totalExecutions).toBe(0);
      expect(stats.successfulExecutions).toBe(0);
      expect(stats.failedExecutions).toBe(0);
      expect(stats.averageExecutionTime).toBe(0);
      expect(stats.cacheHitRate).toBe(0);
      expect(stats.rateLimitedExecutions).toBe(0);
      expect(stats.uniqueUsers).toBe(0);
      expect(stats.executionTrend).toHaveLength(30); // 30 days
    });

    it('uses a TypeORM MoreThanOrEqual operator on createdAt (regression for dead $gte)', async () => {
      // The previous implementation passed `{ $gte: since } as any`,
      // which TypeORM treats as a literal object comparison and
      // matches zero rows — so getToolUsageStats was silently
      // returning all-zeros for every tool in every timeframe.
      // Pin the new shape: the `createdAt` clause must be a
      // TypeORM operator instance (internally tagged with
      // `_type: 'moreThanOrEqual'`), NOT a plain `$gte` object.
      toolRepo.findOne.mockResolvedValue(makeTool());
      toolExecutionRepo.find.mockResolvedValue([]);

      await service.getToolUsageStats('tool-1', 'org-1', 'day');

      const whereArg = (toolExecutionRepo.find.mock.calls[0][0] as any).where;
      expect(whereArg.createdAt).not.toHaveProperty('$gte');
      // TypeORM FindOperator has `_type` and `_value` fields.
      expect(whereArg.createdAt).toHaveProperty('_type', 'moreThanOrEqual');
      expect(whereArg.createdAt._value).toBeInstanceOf(Date);
    });

    it('should compute stats correctly from executions', async () => {
      const tool = makeTool();
      const now = new Date();
      const executions: Partial<ToolExecution>[] = [
        { id: 'e1', toolId: 'tool-1', userId: 'user-1', success: true, executionTime: 100, cached: false, metadata: {}, createdAt: now },
        { id: 'e2', toolId: 'tool-1', userId: 'user-2', success: true, executionTime: 200, cached: true, metadata: {}, createdAt: now },
        { id: 'e3', toolId: 'tool-1', userId: 'user-1', success: false, executionTime: 50, cached: false, metadata: { rateLimited: true }, createdAt: now },
      ];

      toolRepo.findOne.mockResolvedValue(tool);
      toolExecutionRepo.find.mockResolvedValue(executions);

      const stats = await service.getToolUsageStats('tool-1', 'org-1', 'day');

      expect(stats.totalExecutions).toBe(3);
      expect(stats.successfulExecutions).toBe(2);
      expect(stats.failedExecutions).toBe(1);
      expect(stats.averageExecutionTime).toBe(Math.round((100 + 200 + 50) / 3));
      expect(stats.cacheHitRate).toBeCloseTo(33.33, 1);
      expect(stats.rateLimitedExecutions).toBe(1);
      expect(stats.uniqueUsers).toBe(2);
    });

    it('should return 24 trend points for hour timeframe', async () => {
      const tool = makeTool();
      toolRepo.findOne.mockResolvedValue(tool);
      toolExecutionRepo.find.mockResolvedValue([]);

      const stats = await service.getToolUsageStats('tool-1', 'org-1', 'hour');

      expect(stats.executionTrend).toHaveLength(24);
    });

    it('should return 12 trend points for week timeframe', async () => {
      const tool = makeTool();
      toolRepo.findOne.mockResolvedValue(tool);
      toolExecutionRepo.find.mockResolvedValue([]);

      const stats = await service.getToolUsageStats('tool-1', 'org-1', 'week');

      expect(stats.executionTrend).toHaveLength(12);
    });

    it('should return 12 trend points for month timeframe', async () => {
      const tool = makeTool();
      toolRepo.findOne.mockResolvedValue(tool);
      toolExecutionRepo.find.mockResolvedValue([]);

      const stats = await service.getToolUsageStats('tool-1', 'org-1', 'month');

      expect(stats.executionTrend).toHaveLength(12);
    });

    it('should default timeframe to day', async () => {
      const tool = makeTool();
      toolRepo.findOne.mockResolvedValue(tool);
      toolExecutionRepo.find.mockResolvedValue([]);

      const stats = await service.getToolUsageStats('tool-1', 'org-1');

      expect(stats.executionTrend).toHaveLength(30);
    });

    it('should throw NotFoundException for missing tool', async () => {
      toolRepo.findOne.mockResolvedValue(null);

      await expect(service.getToolUsageStats('missing', 'org-1')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── getOrganizationToolStats ──────────────────────────────────────────────

  describe('getOrganizationToolStats', () => {
    it('should return zeroed stats when no tools or executions', async () => {
      const qb = makeQueryBuilder([], 0);
      qb.getRawMany.mockResolvedValue([]);
      toolRepo.createQueryBuilder.mockReturnValue(qb);
      toolExecutionRepo.find.mockResolvedValue([]);
      toolRepo.find.mockResolvedValue([]);

      const stats = await service.getOrganizationToolStats('org-1');

      expect(stats.totalTools).toBe(0);
      expect(stats.activeTools).toBe(0);
      expect(stats.draftTools).toBe(0);
      expect(stats.inactiveTools).toBe(0);
      expect(stats.totalExecutions).toBe(0);
      expect(stats.averageExecutionTime).toBe(0);
      expect(stats.topUsedTools).toEqual([]);
    });

    it('should aggregate tool status counts correctly', async () => {
      const qb = makeQueryBuilder([], 0);
      qb.getRawMany.mockResolvedValue([
        { tool_status: ToolStatus.ACTIVE, count: '5' },
        { tool_status: ToolStatus.DRAFT, count: '3' },
        { tool_status: ToolStatus.INACTIVE, count: '2' },
      ]);
      toolRepo.createQueryBuilder.mockReturnValue(qb);
      toolExecutionRepo.find.mockResolvedValue([]);
      toolRepo.find.mockResolvedValue([]);

      const stats = await service.getOrganizationToolStats('org-1');

      expect(stats.totalTools).toBe(10);
      expect(stats.activeTools).toBe(5);
      expect(stats.draftTools).toBe(3);
      expect(stats.inactiveTools).toBe(2);
    });

    it('should compute average execution time and top tools', async () => {
      const tool1 = makeTool({ id: 'tool-1' });
      const tool2 = makeTool({ id: 'tool-2' });
      const executions: Partial<ToolExecution>[] = [
        { toolId: 'tool-1', executionTime: 100 },
        { toolId: 'tool-1', executionTime: 200 },
        { toolId: 'tool-2', executionTime: 300 },
      ];

      const qb = makeQueryBuilder([], 0);
      qb.getRawMany.mockResolvedValue([]);
      toolRepo.createQueryBuilder.mockReturnValue(qb);
      toolExecutionRepo.find.mockResolvedValue(executions);
      toolRepo.find.mockResolvedValue([tool1, tool2]);

      const stats = await service.getOrganizationToolStats('org-1');

      expect(stats.totalExecutions).toBe(3);
      expect(stats.averageExecutionTime).toBe(Math.round((100 + 200 + 300) / 3));
      expect(stats.topUsedTools).toHaveLength(2);
      const tool1Stats = stats.topUsedTools.find(t => t.tool.id === 'tool-1');
      expect(tool1Stats?.executionCount).toBe(2);
    });
  });

  // ─── findByName ────────────────────────────────────────────────────────────

  describe('findByName', () => {
    it('should return tool by name in organization', async () => {
      const tool = makeTool({ name: 'SpecificTool' });
      toolRepo.findOne.mockResolvedValue(tool);

      const result = await service.findByName('SpecificTool', 'org-1');

      expect(result).toBe(tool);
      expect(toolRepo.findOne).toHaveBeenCalledWith({
        where: { name: 'SpecificTool', organizationId: 'org-1' },
      });
    });

    it('should return null when tool is not found', async () => {
      toolRepo.findOne.mockResolvedValue(null);

      const result = await service.findByName('NonExistent', 'org-1');

      expect(result).toBeNull();
    });
  });

  // ─── createFromOperation ───────────────────────────────────────────────────

  describe('createFromOperation', () => {
    it('should auto-generate a tool from an operation', async () => {
      const op = makeOperation();
      const tool = makeTool({ status: ToolStatus.ACTIVE, createdBy: 'system' });

      operationRepo.findOne.mockResolvedValue(op);
      toolRepo.create.mockReturnValue(tool);
      toolRepo.save.mockResolvedValue(tool);
      toolVersionRepo.create.mockReturnValue({});
      toolVersionRepo.save.mockResolvedValue({});

      const result = await service.createFromOperation(op, {
        name: 'listPets',
        description: 'List all pets',
        organizationId: 'org-1',
      });

      expect(result).toBe(tool);
      expect(toolRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          operationId: op.id,
          status: ToolStatus.ACTIVE,
          createdBy: 'system',
        }),
      );
    });

    it('should throw NotFoundException when operation is not found', async () => {
      const op = makeOperation();
      operationRepo.findOne.mockResolvedValue(null);

      await expect(
        service.createFromOperation(op, { name: 'tool', description: 'desc', organizationId: 'org-1' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should include source operation metadata', async () => {
      const op = makeOperation({ name: 'listPets', method: 'GET' as any, endpoint: '/pets' });
      const tool = makeTool({ status: ToolStatus.ACTIVE });

      operationRepo.findOne.mockResolvedValue(op);
      toolRepo.create.mockReturnValue(tool);
      toolRepo.save.mockResolvedValue(tool);
      toolVersionRepo.create.mockReturnValue({});
      toolVersionRepo.save.mockResolvedValue({});

      await service.createFromOperation(op, { name: 'listPets', description: 'desc', organizationId: 'org-1' });

      expect(toolRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            autoGenerated: true,
            sourceOperation: expect.objectContaining({ id: op.id, name: 'listPets' }),
          }),
        }),
      );
    });

    it('should generate parameters from operation path params', async () => {
      const op = makeOperation({
        parameters: {
          path: { petId: { type: 'integer', description: 'The pet id', required: true } },
          query: {},
          body: undefined,
        },
      });
      const tool = makeTool({ status: ToolStatus.ACTIVE });

      operationRepo.findOne.mockResolvedValue(op);
      toolRepo.create.mockReturnValue(tool);
      toolRepo.save.mockResolvedValue(tool);
      toolVersionRepo.create.mockReturnValue({});
      toolVersionRepo.save.mockResolvedValue({});

      await service.createFromOperation(op, { name: 'getPet', description: 'Get pet', organizationId: 'org-1' });

      const createCall = toolRepo.create.mock.calls[0][0];
      expect(createCall.parameters.properties.petId).toBeDefined();
      expect(createCall.parameters.required).toContain('petId');
    });

    it('should generate parameters from operation query params', async () => {
      const op = makeOperation({
        parameters: {
          path: {},
          query: { status: { type: 'string', description: 'Filter by status', required: false } },
          body: undefined,
        },
      });
      const tool = makeTool({ status: ToolStatus.ACTIVE });

      operationRepo.findOne.mockResolvedValue(op);
      toolRepo.create.mockReturnValue(tool);
      toolRepo.save.mockResolvedValue(tool);
      toolVersionRepo.create.mockReturnValue({});
      toolVersionRepo.save.mockResolvedValue({});

      await service.createFromOperation(op, { name: 'findPets', description: 'Find pets', organizationId: 'org-1' });

      const createCall = toolRepo.create.mock.calls[0][0];
      expect(createCall.parameters.properties.status).toBeDefined();
      expect(createCall.parameters.required).not.toContain('status');
    });

    it('should set cache enabled for GET (query) operations', async () => {
      const op = makeOperation({ type: 'query' as any });
      const tool = makeTool({ status: ToolStatus.ACTIVE });

      operationRepo.findOne.mockResolvedValue(op);
      toolRepo.create.mockReturnValue(tool);
      toolRepo.save.mockResolvedValue(tool);
      toolVersionRepo.create.mockReturnValue({});
      toolVersionRepo.save.mockResolvedValue({});

      await service.createFromOperation(op, { name: 'getPets', description: 'desc', organizationId: 'org-1' });

      const createCall = toolRepo.create.mock.calls[0][0];
      expect(createCall.configuration.cache.enabled).toBe(true);
    });

    it('should set cache disabled for mutation operations', async () => {
      const op = makeOperation({ type: 'mutation' as any });
      const tool = makeTool({ status: ToolStatus.ACTIVE });

      operationRepo.findOne.mockResolvedValue(op);
      toolRepo.create.mockReturnValue(tool);
      toolRepo.save.mockResolvedValue(tool);
      toolVersionRepo.create.mockReturnValue({});
      toolVersionRepo.save.mockResolvedValue({});

      await service.createFromOperation(op, { name: 'createPet', description: 'desc', organizationId: 'org-1' });

      const createCall = toolRepo.create.mock.calls[0][0];
      expect(createCall.configuration.cache.enabled).toBe(false);
    });
  });

  // ─── updateFromOperation ───────────────────────────────────────────────────

  describe('updateFromOperation', () => {
    it('should update an existing tool from operation data', async () => {
      const tool = makeTool();
      const op = makeOperation();
      const saved = makeTool({ name: 'updatedTool' });

      toolRepo.findOne
        .mockResolvedValueOnce(tool)   // findOne for the tool
        .mockResolvedValueOnce(null);  // not called again
      operationRepo.findOne.mockResolvedValue(op);
      toolRepo.save.mockResolvedValue(saved);

      const result = await service.updateFromOperation('tool-1', op, {
        name: 'updatedTool',
        description: 'Updated description',
        organizationId: 'org-1',
      });

      expect(result).toBe(saved);
      expect(toolRepo.save).toHaveBeenCalled();
    });

    it('should throw NotFoundException when tool is not found', async () => {
      const op = makeOperation();
      toolRepo.findOne.mockResolvedValue(null);

      await expect(
        service.updateFromOperation('missing', op, { name: 'x', description: 'x', organizationId: 'org-1' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when operation is not found', async () => {
      const tool = makeTool();
      const op = makeOperation();

      toolRepo.findOne.mockResolvedValue(tool);
      operationRepo.findOne.mockResolvedValue(null);

      await expect(
        service.updateFromOperation('tool-1', op, { name: 'x', description: 'x', organizationId: 'org-1' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should update description and metadata from operation', async () => {
      const tool = makeTool({ metadata: { existingField: 'keep' } });
      const op = makeOperation({ name: 'getPet', method: 'GET' as any, endpoint: '/pets/{id}' });
      const saved = makeTool();

      toolRepo.findOne.mockResolvedValue(tool);
      operationRepo.findOne.mockResolvedValue(op);
      toolRepo.save.mockResolvedValue(saved);

      await service.updateFromOperation('tool-1', op, {
        name: 'getPet',
        description: 'Updated desc',
        organizationId: 'org-1',
      });

      expect(tool.description).toBe('Updated desc');
      expect(tool.metadata.autoGenerated).toBe(true);
      expect(tool.metadata.sourceOperation.id).toBe(op.id);
    });
  });

  // ─── resolveSchemaRef (private) ────────────────────────────────────────────

  describe('resolveSchemaRef (private method)', () => {
    const mockApiSchema = {
      id: 'schema-1',
      apiId: 'api-1',
      rawSchema: JSON.stringify({
        definitions: {
          Order: {
            type: 'object',
            properties: {
              id: { type: 'integer' },
              petId: { type: 'integer' },
              quantity: { type: 'integer' },
              status: { type: 'string', description: 'Order Status' },
              complete: { type: 'boolean' },
            },
            required: ['id'],
          },
        },
      }),
    };

    it('should resolve a valid $ref to its schema', async () => {
      apiSchemaRepo.findOne.mockResolvedValue(mockApiSchema);

      const resolved = await service['resolveSchemaRef']('#/definitions/Order', 'api-1');

      expect(resolved).toBeDefined();
      expect(resolved.type).toBe('object');
      expect(resolved.properties.id).toEqual({ type: 'integer' });
      expect(resolved.properties.status.description).toBe('Order Status');
    });

    it('should return null when api schema is not found', async () => {
      apiSchemaRepo.findOne.mockResolvedValue(null);

      const result = await service['resolveSchemaRef']('#/definitions/Order', 'api-1');

      expect(result).toBeNull();
    });

    it('should return null when rawSchema is null', async () => {
      apiSchemaRepo.findOne.mockResolvedValue({ ...mockApiSchema, rawSchema: null });

      const result = await service['resolveSchemaRef']('#/definitions/Order', 'api-1');

      expect(result).toBeNull();
    });

    it('should return null when $ref path does not exist in schema', async () => {
      apiSchemaRepo.findOne.mockResolvedValue(mockApiSchema);

      const result = await service['resolveSchemaRef']('#/definitions/NonExistent', 'api-1');

      expect(result).toBeNull();
    });

    it('should handle object rawSchema (not string)', async () => {
      const schemaObj = {
        id: 'schema-1',
        apiId: 'api-1',
        rawSchema: {
          definitions: {
            Pet: { type: 'object', properties: { name: { type: 'string' } } },
          },
        },
      };
      apiSchemaRepo.findOne.mockResolvedValue(schemaObj);

      const result = await service['resolveSchemaRef']('#/definitions/Pet', 'api-1');

      expect(result).toBeDefined();
      expect(result.properties.name).toEqual({ type: 'string' });
    });

    it('should return null for invalid JSON rawSchema string', async () => {
      apiSchemaRepo.findOne.mockResolvedValue({ ...mockApiSchema, rawSchema: 'not-valid-json' });

      const result = await service['resolveSchemaRef']('#/definitions/Order', 'api-1');

      expect(result).toBeNull();
    });

    it('should handle deeply nested $ref paths', async () => {
      const schema = {
        id: 'schema-1',
        apiId: 'api-1',
        rawSchema: JSON.stringify({
          components: {
            schemas: {
              Category: {
                type: 'object',
                properties: { id: { type: 'integer' }, name: { type: 'string' } },
              },
            },
          },
        }),
      };
      apiSchemaRepo.findOne.mockResolvedValue(schema);

      const result = await service['resolveSchemaRef']('#/components/schemas/Category', 'api-1');

      expect(result).toBeDefined();
      expect(result.properties.name).toEqual({ type: 'string' });
    });
  });

  // ─── generateToolParametersFromOperation (private) ─────────────────────────

  describe('generateToolParametersFromOperation (private method)', () => {
    it('should generate empty parameters for operation with no params', async () => {
      const op = makeOperation({ parameters: {} });

      const params = await service['generateToolParametersFromOperation'](op);

      expect(params.type).toBe('object');
      expect(params.properties).toEqual({});
      expect(params.required).toEqual([]);
    });

    it('should include path parameters in output', async () => {
      const op = makeOperation({
        parameters: {
          path: {
            petId: { type: 'integer', description: 'The pet ID', required: true },
          },
        },
      });

      const params = await service['generateToolParametersFromOperation'](op);

      expect(params.properties.petId).toBeDefined();
      expect(params.properties.petId.type).toBe('integer');
      expect(params.required).toContain('petId');
    });

    it('should include query parameters in output', async () => {
      const op = makeOperation({
        parameters: {
          query: {
            limit: { type: 'integer', description: 'Max results', required: false },
          },
        },
      });

      const params = await service['generateToolParametersFromOperation'](op);

      expect(params.properties.limit).toBeDefined();
      expect(params.required).not.toContain('limit');
    });

    it('should include enum in parameter when provided', async () => {
      const op = makeOperation({
        parameters: {
          query: {
            status: { type: 'string', enum: ['available', 'sold'], required: false },
          },
        },
      });

      const params = await service['generateToolParametersFromOperation'](op);

      expect(params.properties.status.enum).toEqual(['available', 'sold']);
    });

    it('should resolve body with $ref and include schema properties', async () => {
      const apiSchema = {
        apiId: 'api-1',
        rawSchema: JSON.stringify({
          definitions: {
            Pet: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                age: { type: 'integer' },
              },
              required: ['name'],
            },
          },
        }),
      };
      apiSchemaRepo.findOne.mockResolvedValue(apiSchema);

      const op = makeOperation({
        apiId: 'api-1',
        parameters: {
          body: { schema: { $ref: '#/definitions/Pet' } },
        },
      });

      const params = await service['generateToolParametersFromOperation'](op);

      expect(params.properties.name).toBeDefined();
      expect(params.properties.age).toBeDefined();
      expect(params.required).toContain('name');
    });

    it('should handle body with inline schema properties', async () => {
      const op = makeOperation({
        parameters: {
          body: {
            schema: {
              properties: {
                title: { type: 'string' },
                count: { type: 'integer' },
              },
              required: ['title'],
            },
          },
        },
      });

      const params = await service['generateToolParametersFromOperation'](op);

      expect(params.properties.title).toBeDefined();
      expect(params.properties.count).toBeDefined();
      expect(params.required).toContain('title');
    });
  });

  // ─── $ref Resolution (legacy describe block kept) ─────────────────────────

  describe('ToolsService - $ref Resolution (legacy)', () => {
    it('should resolve $ref to Order schema', async () => {
      const mockSchema = {
        id: 'schema-1',
        apiId: 'api-1',
        rawSchema: JSON.stringify({
          definitions: {
            Order: {
              type: 'object',
              properties: {
                id: { type: 'integer' },
                petId: { type: 'integer' },
                quantity: { type: 'integer' },
                shipDate: { type: 'string' },
                status: { type: 'string', description: 'Order Status' },
                complete: { type: 'boolean' },
              },
            },
          },
        }),
      };
      apiSchemaRepo.findOne.mockResolvedValue(mockSchema);

      const resolved = await service['resolveSchemaRef']('#/definitions/Order', 'api-1');

      expect(resolved).toBeDefined();
      expect(resolved.type).toBe('object');
      expect(resolved.properties.id).toBeDefined();
      expect(resolved.properties.petId).toBeDefined();
      expect(resolved.properties.status.description).toBe('Order Status');
    });
  });
});
