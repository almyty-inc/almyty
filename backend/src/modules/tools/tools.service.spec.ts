import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ToolsService } from './tools.service';
import { Tool } from '../../entities/tool.entity';
import { ToolVersion } from '../../entities/tool-version.entity';
import { ToolCategory } from '../../entities/tool-category.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import { Api } from '../../entities/api.entity';
import { ApiSchema } from '../../entities/api-schema.entity';
import { Operation } from '../../entities/operation.entity';
import { User } from '../../entities/user.entity';
import { Organization } from '../../entities/organization.entity';

describe('ToolsService - $ref Resolution', () => {
  let service: ToolsService;

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
            shipDate: { type: 'string' },
            status: { type: 'string', description: 'Order Status' },
            complete: { type: 'boolean' }
          }
        }
      }
    })
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ToolsService,
        { provide: getRepositoryToken(Tool), useClass: Repository },
        { provide: getRepositoryToken(ToolVersion), useClass: Repository },
        { provide: getRepositoryToken(ToolCategory), useClass: Repository },
        { provide: getRepositoryToken(ToolExecution), useClass: Repository },
        { provide: getRepositoryToken(Api), useClass: Repository },
        {
          provide: getRepositoryToken(ApiSchema),
          useValue: { findOne: jest.fn().mockResolvedValue(mockApiSchema) },
        },
        { provide: getRepositoryToken(Operation), useClass: Repository },
        { provide: getRepositoryToken(User), useClass: Repository },
        { provide: getRepositoryToken(Organization), useClass: Repository },
      ],
    }).compile();

    service = module.get<ToolsService>(ToolsService);
  });

  it('should resolve $ref to Order schema', async () => {
    const resolved = await service['resolveSchemaRef']('#/definitions/Order', 'api-1');
    
    expect(resolved).toBeDefined();
    expect(resolved.type).toBe('object');
    expect(resolved.properties.id).toBeDefined();
    expect(resolved.properties.petId).toBeDefined();
    expect(resolved.properties.status.description).toBe('Order Status');
  });
});
