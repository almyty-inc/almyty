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
import { OrganizationRole } from '../../../entities/user-organization.entity'
import { fakeRepository } from '../../../test/fake-repository'
import { RecordingQueryBuilder, organizationScope } from './recording-query-builder'

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
//
// The list that follows the heal is the same org's list. The builder
// records the query that ran and the list filter is the real
// AccessPolicyService over a membership table; the match-anything chain
// and the `applyListFilter: qb => qb` stub that were here passed with
// the organization scoping gone.

describe('GatewaysService.getGateways self-heal (#105)', () => {
  let service: GatewaysService
  let initHelper: { ensureSystemGateway: jest.Mock }
  let builders: RecordingQueryBuilder[]

  beforeEach(async () => {
    initHelper = { ensureSystemGateway: jest.fn().mockResolvedValue(undefined) }
    builders = []
    const gatewayRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      createQueryBuilder: jest.fn((alias: string) => {
        const qb = new RecordingQueryBuilder(alias, {
          getCount: 0,
          getRawAndEntities: { entities: [], raw: [] },
        })
        builders.push(qb)
        return qb
      }),
    }
    const memberships = fakeRepository<any>([
      { userId: 'user-1', organizationId: 'org-77', role: OrganizationRole.MEMBER, isActive: true },
      { userId: 'user-1', organizationId: 'org-99', role: OrganizationRole.OWNER, isActive: true },
    ])
    // A plain member resolves their teams; user-1 is on none.
    const teams = {
      createQueryBuilder: jest.fn((alias: string) => new RecordingQueryBuilder(alias, { getRawMany: [] })),
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
        { provide: AccessPolicyService, useValue: new AccessPolicyService(memberships as any, teams as any) },
      ],
    }).compile()

    service = module.get(GatewaysService)
  })

  /** Every gateway query the listing ran, with the org each was scoped to. */
  const listedOrganizations = () =>
    builders
      .filter((qb) => qb.alias === 'gateway')
      .flatMap((qb) => qb.executed.map((query) => organizationScope(query, 'gateway')))

  it('calls ensureSystemGateway with the requesting orgId, then lists that org', async () => {
    await service.getGateways({ organizationId: 'org-77', caller: { id: 'user-1' } } as any)

    expect(initHelper.ensureSystemGateway).toHaveBeenCalledWith('org-77')
    expect(listedOrganizations()).toEqual(['org-77', 'org-77'])
  })

  it('swallows ensureSystemGateway errors and still returns the org list', async () => {
    initHelper.ensureSystemGateway.mockRejectedValueOnce(new Error('boom'))

    await expect(
      service.getGateways({ organizationId: 'org-99', caller: { id: 'user-1' } } as any),
    ).resolves.toMatchObject({ gateways: [], total: 0 })
    expect(listedOrganizations()).toEqual(['org-99', 'org-99'])
  })
})
