import { Test, TestingModule } from '@nestjs/testing'
import { getRepositoryToken } from '@nestjs/typeorm'

import { GatewaysService } from '../gateways.service'
import { GatewayInitHelper } from '../gateway-init.helper'
import { GatewaysStatsHelper } from '../gateways-stats.helper'
import { Gateway } from '../../../entities/gateway.entity'
import { GatewayTool } from '../../../entities/gateway-tool.entity'
import { GatewayAuth } from '../../../entities/gateway-auth.entity'
import { User } from '../../../entities/user.entity'
import { Organization } from '../../../entities/organization.entity'
import { UsageMetric } from '../../../entities/usage-metric.entity'
import { AuditLogService } from '../../audit-log/audit-log.service'
import { AccessPolicyService } from '../../../common/authorization/access-policy.service'

// Regression for #105. createOrganization() inlines ensureSystemGateway
// but auth.register() doesn't go through that path, so freshly-signed
// orgs rendered the Gateways page empty until they hit a code path
// that re-provisioned the system gateway. getGateways() now invokes
// ensureSystemGateway() up-front (idempotent on existing isSystem=true
// rows) so the list endpoint is always self-healing. This test pins
// that down: every getGateways call must run ensureSystemGateway for
// the org, and a thrown error from ensureSystemGateway must NOT
// propagate (logged-and-swallowed so a transient init failure can't
// take down listing).

describe('GatewaysService.getGateways self-heal (#105)', () => {
  let service: GatewaysService
  let initHelper: { ensureSystemGateway: jest.Mock }
  let gatewayRepository: any

  beforeEach(async () => {
    initHelper = { ensureSystemGateway: jest.fn().mockResolvedValue(undefined) }
    const qbStub: any = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      getRawAndEntities: jest.fn().mockResolvedValue({ entities: [], raw: [] }),
      getMany: jest.fn().mockResolvedValue([]),
      getCount: jest.fn().mockResolvedValue(0),
    }
    gatewayRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      createQueryBuilder: jest.fn(() => qbStub),
    }

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GatewaysStatsHelper,
        GatewaysService,
        { provide: GatewayInitHelper, useValue: initHelper },
        { provide: getRepositoryToken(Gateway), useValue: gatewayRepository },
        { provide: getRepositoryToken(GatewayTool), useValue: { find: jest.fn().mockResolvedValue([]) } },
        { provide: getRepositoryToken(GatewayAuth), useValue: { find: jest.fn().mockResolvedValue([]) } },
        { provide: getRepositoryToken(User), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(Organization), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(UsageMetric), useValue: { find: jest.fn() } },
        { provide: AuditLogService, useValue: { log: jest.fn() } },
        { provide: AccessPolicyService, useValue: { applyListFilter: jest.fn(qb => qb) } },
      ],
    }).compile()

    service = module.get(GatewaysService)
  })

  it('calls ensureSystemGateway with the requesting orgId', async () => {
    await service.getGateways({ organizationId: 'org-77' } as any)
    expect(initHelper.ensureSystemGateway).toHaveBeenCalledWith('org-77')
  })

  it('swallows ensureSystemGateway errors and still returns a result', async () => {
    initHelper.ensureSystemGateway.mockRejectedValueOnce(new Error('boom'))

    await expect(service.getGateways({ organizationId: 'org-99' } as any)).resolves.toBeDefined()
  })
})
