import { Test, TestingModule } from '@nestjs/testing'
import { getRepositoryToken } from '@nestjs/typeorm'
import { DataSource } from 'typeorm'

import { ApisService } from '../apis.service'
import { Api } from '../../../entities/api.entity'
import { ApiSchema } from '../../../entities/api-schema.entity'
import { Operation } from '../../../entities/operation.entity'
import { Resource } from '../../../entities/resource.entity'
import { Organization } from '../../../entities/organization.entity'
import { SchemaParserService } from '../../schema-parser/schema-parser.service'
import { ToolsService } from '../../tools/tools.service'
import { AuditLogService } from '../../audit-log/audit-log.service'
import { ApisImportHelper } from '../apis-import.helper'
import { ApisToolGeneratorHelper } from '../apis-tool-generator.helper'
import { AccessPolicyService } from '../../../common/authorization/access-policy.service'

// Regression for the team-scoping update behavior. Companion to the
// matching change on agents (#134), credentials (#133), and the
// tools / llm-providers sanitization in this PR. APIs already
// persisted visibility via Object.assign(api, updateApiData) but the
// dangling teamId was never cleared when the user flipped visibility
// back to 'org'.

describe('ApisService.update team-scoping sanitize', () => {
  let service: ApisService
  let apiRepository: any
  let accessPolicy: { canAccess: jest.Mock }

  beforeEach(async () => {
    apiRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      count: jest.fn(),
    }
    accessPolicy = { canAccess: jest.fn().mockResolvedValue({ allowed: true }) }

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApisService,
        { provide: getRepositoryToken(Api), useValue: apiRepository },
        { provide: getRepositoryToken(ApiSchema), useValue: { findOne: jest.fn(), find: jest.fn() } },
        { provide: getRepositoryToken(Operation), useValue: { find: jest.fn() } },
        { provide: getRepositoryToken(Resource), useValue: { find: jest.fn() } },
        { provide: getRepositoryToken(Organization), useValue: { findOne: jest.fn() } },
        { provide: SchemaParserService, useValue: { parseApiSchema: jest.fn() } },
        { provide: ToolsService, useValue: {} },
        { provide: AuditLogService, useValue: { log: jest.fn(), logUpdate: jest.fn(), logCreate: jest.fn(), logDelete: jest.fn() } },
        { provide: DataSource, useValue: { transaction: jest.fn() } },
        { provide: ApisImportHelper, useValue: {} },
        { provide: ApisToolGeneratorHelper, useValue: { generateToolsFromApi: jest.fn() } },
        { provide: AccessPolicyService, useValue: accessPolicy },
      ],
    }).compile()

    service = module.get(ApisService)
  })

  it('flips visibility from team back to org and clears the dangling teamId', async () => {
    const existing: any = { id: 'api-1', organizationId: 'org-1', visibility: 'team', teamId: 'team-old' }
    apiRepository.findOne.mockResolvedValue(existing)
    apiRepository.save.mockImplementation((a: any) => Promise.resolve(a))

    await service.update('api-1', { visibility: 'org' } as any, 'org-1', 'user-1')

    expect(existing.visibility).toBe('org')
    expect(existing.teamId).toBeNull()
  })

  it('flips visibility from org to team and stores the new teamId', async () => {
    const existing: any = { id: 'api-1', organizationId: 'org-1', visibility: 'org', teamId: null }
    apiRepository.findOne.mockResolvedValue(existing)
    apiRepository.save.mockImplementation((a: any) => Promise.resolve(a))

    await service.update('api-1', { visibility: 'team', teamId: 'team-uuid' } as any, 'org-1', 'user-1')

    expect(existing.visibility).toBe('team')
    expect(existing.teamId).toBe('team-uuid')
  })
})
