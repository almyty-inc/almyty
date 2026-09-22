import { HttpException, HttpStatus } from '@nestjs/common';

import { MonitoringController } from '../monitoring.controller';
import type { MonitoringService } from '../monitoring.service';

/**
 * Alert endpoints must refuse an unscoped caller rather than widen.
 *
 * `JwtStrategy` sets `currentOrganizationId` to undefined for a user in
 * more than one org who did not send `X-Organization-Id`. Three handlers
 * read that value and handed it to `getActiveAlerts(organizationId?)`,
 * whose org filter is `if (organizationId)` — so undefined meant "every
 * tenant's alerts", returned to a signed-in user of any org. Same shape
 * as a TypeORM `where` whose undefined key drops the condition.
 */
describe('MonitoringController alert endpoints — org scoping', () => {
  const otherOrgAlert = { id: 'a-other', organizationId: 'org-b', severity: 'critical', isResolved: false };
  const ownAlert = { id: 'a-own', organizationId: 'org-a', severity: 'warning', isResolved: false };

  let getActiveAlerts: jest.Mock;
  let controller: MonitoringController;

  beforeEach(() => {
    // Stands in for the real filter: an org id narrows, undefined does not.
    getActiveAlerts = jest.fn(async (organizationId?: string) => {
      const all = [ownAlert, otherOrgAlert];
      return organizationId ? all.filter((a) => a.organizationId === organizationId) : all;
    });
    controller = new MonitoringController({ getActiveAlerts } as unknown as MonitoringService);
  });

  const unscoped = { user: { id: 'u1', organizationMemberships: [{}, {}] } };
  const scoped = { user: { id: 'u1', currentOrganizationId: 'org-a' } };

  const endpoints: Array<[string, (req: any) => Promise<unknown>]> = [
    ['GET /monitoring/alerts', (req) => controller.getAlerts(req)],
    ['GET /monitoring/stats/live', (req) => controller.getLiveStats(req)],
    ['GET /monitoring/enterprise/dashboard', (req) => controller.getEnterpriseDashboard(req)],
  ];

  describe.each(endpoints)('%s', (_name, call) => {
    it('refuses a caller with no organization context instead of answering for every tenant', async () => {
      await expect(call(unscoped)).rejects.toBeInstanceOf(HttpException);
      await expect(call(unscoped)).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
        response: { error: 'NO_ORGANIZATION' },
      });
      // The leak is the call itself: an unscoped read must never reach the service.
      expect(getActiveAlerts).not.toHaveBeenCalled();
    });

    it('scopes to the caller organization when one is resolved', async () => {
      await call(scoped);
      expect(getActiveAlerts).toHaveBeenCalledWith('org-a');
    });
  });

  it('counts only the caller organization alerts in the live rollup', async () => {
    const res: any = await controller.getLiveStats(scoped);
    expect(res.data.summary.activeAlerts).toBe(1);
    expect(res.data.summary.criticalAlerts).toBe(0);
  });
});
