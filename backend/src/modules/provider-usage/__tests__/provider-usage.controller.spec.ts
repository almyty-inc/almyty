import { HttpException } from '@nestjs/common';

import { ProviderUsageController } from '../provider-usage.controller';

/**
 * The controller had no tests, and everything it does with the caller's
 * `from`/`to` happens before the service sees them: an unparseable date
 * used to reach the query builder as an `Invalid Date` (a Postgres cast
 * error, i.e. a 500 for a bad request), and an unbounded window turned
 * one POST into decades of daily buckets pulled from a third-party admin
 * API and written back as snapshot rows.
 */
describe('ProviderUsageController', () => {
  let usage: any;
  let controller: ProviderUsageController;

  const req = { user: { currentOrganizationId: 'org-1' } };

  beforeEach(() => {
    usage = {
      getReconciliation: jest.fn().mockResolvedValue([]),
      syncOrganization: jest.fn().mockResolvedValue([]),
    };
    controller = new ProviderUsageController(usage);
  });

  const day = 24 * 60 * 60 * 1000;

  it('rejects an unparseable from date instead of querying with it', async () => {
    await expect(
      controller.reconciliation(undefined, 'yesterday', undefined, req),
    ).rejects.toThrow(HttpException);
    expect(usage.getReconciliation).not.toHaveBeenCalled();
  });

  it('rejects an unparseable to date', async () => {
    await expect(
      controller.reconciliation(undefined, '2026-01-01', 'soon', req),
    ).rejects.toThrow(HttpException);
    expect(usage.getReconciliation).not.toHaveBeenCalled();
  });

  it('rejects an inverted window', async () => {
    await expect(
      controller.reconciliation(undefined, '2026-02-01', '2026-01-01', req),
    ).rejects.toThrow(HttpException);
    expect(usage.getReconciliation).not.toHaveBeenCalled();
  });

  it('refuses a window longer than a year', async () => {
    await expect(
      controller.reconciliation(undefined, '1970-01-01', '2026-01-01', req),
    ).rejects.toThrow(HttpException);
    expect(usage.getReconciliation).not.toHaveBeenCalled();
  });

  it('refuses an unbounded sync window before calling any provider API', async () => {
    await expect(controller.sync({ from: '1900-01-01' }, req)).rejects.toThrow(HttpException);
    expect(usage.syncOrganization).not.toHaveBeenCalled();
  });

  it('passes a valid explicit window straight through', async () => {
    const from = new Date(Date.now() - 7 * day).toISOString();
    const to = new Date().toISOString();

    await controller.reconciliation(undefined, from, to, req);

    expect(usage.getReconciliation).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ from: new Date(from), to: new Date(to) }),
      null,
    );
  });

  it('defaults to the current period when no explicit window is given', async () => {
    await controller.reconciliation('day', undefined, undefined, req);

    const [, window] = usage.getReconciliation.mock.calls[0];
    expect(Number.isNaN(window.from.getTime())).toBe(false);
    expect(window.to.getTime()).toBeGreaterThanOrEqual(window.from.getTime());
  });

  it('requires an organization context', async () => {
    await expect(
      controller.reconciliation(undefined, undefined, undefined, { user: {} }),
    ).rejects.toThrow(HttpException);
  });
});
