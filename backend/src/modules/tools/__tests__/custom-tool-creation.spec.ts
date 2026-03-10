import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ToolsService } from '../tools.service';
import { Tool, ToolType } from '../../../entities/tool.entity';
import { ToolVersion } from '../../../entities/tool-version.entity';
import { ToolCategory } from '../../../entities/tool-category.entity';
import { ToolExecution } from '../../../entities/tool-execution.entity';
import { Api } from '../../../entities/api.entity';
import { ApiSchema } from '../../../entities/api-schema.entity';
import { Operation } from '../../../entities/operation.entity';
import { Organization } from '../../../entities/organization.entity';
import { User } from '../../../entities/user.entity';

describe('ToolsService - Custom Tool Creation', () => {
  let service: ToolsService;
  let toolRepository: any;
  let apiRepository: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ToolsService,
        {
          provide: getRepositoryToken(Tool),
          useValue: {
            create: jest.fn((data) => ({ ...data, id: 'tool-123' })),
            save: jest.fn((tool) => Promise.resolve(tool)),
            find: jest.fn(),
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Api),
          useValue: {
            create: jest.fn((data) => ({ ...data, id: 'api-123' })),
            save: jest.fn((api) => Promise.resolve(api)),
          },
        },
        {
          provide: getRepositoryToken(Organization),
          useValue: {
            findOne: jest.fn(() => Promise.resolve({
              id: 'org-123',
              canAddMoreTools: () => true,
            })),
          },
        },
        {
          provide: getRepositoryToken(User),
          useValue: {
            findOne: jest.fn(() => Promise.resolve({
              id: 'user-123',
              hasPermissionInOrganization: () => true,
            })),
          },
        },
        // Add other required repositories as mocks
        { provide: getRepositoryToken(ToolVersion), useValue: { create: jest.fn(() => ({})), save: jest.fn((v) => Promise.resolve(v)) } },
        { provide: getRepositoryToken(ToolCategory), useValue: { find: jest.fn(() => Promise.resolve([])) } },
        { provide: getRepositoryToken(Operation), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(ToolExecution), useValue: {} },
        { provide: getRepositoryToken(ApiSchema), useValue: {} },
      ],
    }).compile();

    service = module.get<ToolsService>(ToolsService);
    toolRepository = module.get(getRepositoryToken(Tool));
    apiRepository = module.get(getRepositoryToken(Api));
  });

  it('should create custom JavaScript tool with executionMethod', async () => {
    const createDto = {
      name: 'Test Custom Tool',
      description: 'Test tool',
      type: ToolType.FUNCTION,
      parameters: { type: 'object', properties: { name: { type: 'string' } } },
      code: 'return { greeting: "Hello " + name };',
      executionMethod: 'custom',
    };

    const result = await service.createTool(createDto as any, 'org-123', 'user-123');

    expect(result).toHaveProperty('id');
    expect(toolRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Test Custom Tool',
        code: expect.any(String),
        executionMethod: 'custom',
      })
    );
  });

  it('should create HTTP tool and auto-create API', async () => {
    const createDto = {
      name: 'HTTP Tool',
      description: 'HTTP request tool',
      type: ToolType.ACTION,
      parameters: { type: 'object', properties: {} },
      code: 'const response = await axios.get("https://api.example.com"); return response.data;',
      executionMethod: 'http',
    };

    await service.createTool(createDto as any, 'org-123', 'user-123');

    // Should auto-create API
    expect(apiRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: expect.stringContaining('Custom'),
        type: 'other',
      })
    );
    expect(apiRepository.save).toHaveBeenCalled();
  });

  it('should create GraphQL tool with executionMethod', async () => {
    const createDto = {
      name: 'GraphQL Tool',
      description: 'GraphQL query tool',
      type: ToolType.QUERY,
      parameters: { type: 'object', properties: {} },
      code: 'const response = await axios.post(...); return response.data;',
      executionMethod: 'graphql',
    };

    const result = await service.createTool(createDto as any, 'org-123', 'user-123');

    expect(result).toBeDefined();
    expect(toolRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        executionMethod: 'graphql',
      })
    );
  });

  it('should accept authConfig in tool creation', async () => {
    const createDto = {
      name: 'Auth Tool',
      description: 'Tool with auth',
      type: ToolType.FUNCTION,
      parameters: { type: 'object', properties: {} },
      code: 'return {};',
      executionMethod: 'http',
      authConfig: {
        type: 'bearer',
        token: 'test-token',
      },
    };

    await service.createTool(createDto as any, 'org-123', 'user-123');

    expect(toolRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        authConfig: expect.objectContaining({
          type: 'bearer',
        }),
      })
    );
  });
});
