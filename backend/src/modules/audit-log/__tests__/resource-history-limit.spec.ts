import { AuditLogService } from '../audit-log.service';
import { AuditResource } from '../../../entities/audit-log.entity';

/**
 * `GET /audit-logs/resource?limit=` handed `parseInt(limit)` straight to
 * `take` with no upper bound, while the sibling `GET /audit-logs` has
 * always clamped to 200. One request could therefore ask for an
 * organization's entire audit table, and a non-numeric `limit` produced
 * `take: NaN`, which TypeORM drops -- an unbounded read of the same
 * table.
 */
describe('AuditLogService.getResourceHistory bounds its reads', () => {
  function serviceWith(find: jest.Mock) {
    return new AuditLogService(
      { find } as any,
      { find: jest.fn(), findOne: jest.fn() } as any,
    );
  }

  async function takeFor(limit: any): Promise<number> {
    const find = jest.fn().mockResolvedValue([]);
    await serviceWith(find).getResourceHistory(
      'org-1',
      AuditResource.TOOL,
      'tool-1',
      limit,
    );
    return find.mock.calls[0][0].take;
  }

  it('caps a caller asking for the whole table', async () => {
    await expect(takeFor(1_000_000)).resolves.toBe(200);
  });

  it('honours a reasonable limit as given', async () => {
    await expect(takeFor(25)).resolves.toBe(25);
    await expect(takeFor(200)).resolves.toBe(200);
  });

  it('falls back to the default rather than an unbounded take', async () => {
    for (const bad of [NaN, Infinity, undefined, 'all', null, 0, -5]) {
      await expect(takeFor(bad)).resolves.toBe(50);
    }
  });

  it('never returns a non-finite or unbounded take for any input', async () => {
    for (const input of [1e9, '9999999999', -1, 0.5, 'abc']) {
      const take = await takeFor(input);
      expect(Number.isFinite(take)).toBe(true);
      expect(take).toBeGreaterThanOrEqual(1);
      expect(take).toBeLessThanOrEqual(200);
    }
  });

  it('still scopes the read to the caller organization', async () => {
    const find = jest.fn().mockResolvedValue([]);
    await serviceWith(find).getResourceHistory('org-1', AuditResource.TOOL, 'tool-1', 10);
    expect(find.mock.calls[0][0].where).toEqual({
      organizationId: 'org-1',
      resourceType: AuditResource.TOOL,
      resourceId: 'tool-1',
    });
  });
});
