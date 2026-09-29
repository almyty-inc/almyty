import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import { DistributionTarget } from '../../../entities/agent-app-distribution.entity';
import { AuditAction, AuditResource } from '../../../entities/audit-log.entity';
import { OrganizationRole } from '../../../entities/user-organization.entity';
import { AppVisitorRequestsService, subjectRef, visitorPlaceKind } from '../app-visitor-requests.service';

/**
 * An owner answering one person's data request: who may, how the person is
 * found on each kind of place, and that nothing leaves or is erased without
 * its audit row. The real-Postgres behaviour is in
 * test/integration/app-visitor-data.integration.spec.ts.
 */
describe('AppVisitorRequestsService', () => {
  const app = {
    id: 'app-1',
    organizationId: 'org-1',
    name: 'Front desk',
    branding: { appName: 'Acme help' },
    distributions: [
      { target: 'telegram', gatewayId: 'gw-tg' },
      { target: 'web', gatewayId: 'gw-web' },
      { target: 'widget', gatewayId: 'gw-widget' },
      { target: 'a2a', gatewayId: 'gw-a2a' },
      // A place set up but never published has no gateway: nobody used it.
      { target: 'slack', gatewayId: null },
    ],
  };
  const footprint = { organizationId: 'org-1', gatewayIds: ['gw-tg'], endUserIds: [], runIds: ['r1'], conversationIds: ['c1'], widgetThreads: [] };
  const summary = { found: true, conversations: 1, messages: 2, firstAt: null, lastAt: null, memories: 1, storedReplies: 1, files: 0, runs: 1, recent: [] };
  const erased = { conversations: 1, messages: 2, runs: 1, memories: 1, storedReplies: 1, files: 0, visitors: 0 };

  let apps: { findOne: jest.Mock };
  let data: Record<string, jest.Mock>;
  let audit: { log: jest.Mock; logInTransaction: jest.Mock; publishCommitted: jest.Mock };
  let service: AppVisitorRequestsService;
  const owner = { userId: 'u-1', organizationId: 'org-1', role: OrganizationRole.OWNER };

  beforeEach(() => {
    apps = { findOne: jest.fn(async () => app) };
    data = {
      findWebVisitors: jest.fn(async () => ['eu-1']),
      forWebVisitors: jest.fn(async () => footprint),
      forWidgetThread: jest.fn(async () => footprint),
      forChannelSender: jest.fn(async () => footprint),
      forA2ACaller: jest.fn(async () => footprint),
      summarize: jest.fn(async () => summary),
      export: jest.fn(async () => ({ conversations: [{ id: 'c1' }] })),
      erase: jest.fn(async (_f: unknown, within?: (tx: unknown, removed: unknown) => Promise<void>) => {
        await within?.('tx', erased);
        return erased;
      }),
    };
    audit = {
      log: jest.fn(async () => ({ id: 'audit-1' })),
      logInTransaction: jest.fn(async () => ({ id: 'audit-2' })),
      publishCommitted: jest.fn(),
    };
    service = new AppVisitorRequestsService(apps as any, data as any, audit as any);
  });

  it('knows which places a person can talk to', () => {
    expect(visitorPlaceKind('web')).toBe('web');
    expect(visitorPlaceKind('widget')).toBe('widget');
    expect(visitorPlaceKind('a2a')).toBe('a2a');
    for (const channel of ['slack', 'telegram', 'sms', 'email', 'whatsapp_cloud', 'webhook']) expect(visitorPlaceKind(channel)).toBe('channel');
    for (const artifact of ['tui', 'desktop', 'binary', 'fax']) expect(visitorPlaceKind(artifact)).toBeNull();
  });

  it('refers to the person in the audit log by a hash that is stable and holds nothing of them', () => {
    const ref = subjectRef('org-1', 'sms', '+14155550100');
    expect(ref).toMatch(/^sha256:[0-9a-f]{24}$/);
    expect(ref).not.toContain('4155550100');
    expect(subjectRef('org-1', 'sms', ' +14155550100 ')).toBe(ref);
    expect(subjectRef('org-1', 'email', 'Ann@Example.com')).toBe(subjectRef('org-1', 'email', 'ann@example.com'));
    expect(subjectRef('org-2', 'sms', '+14155550100')).not.toBe(ref);
    expect(subjectRef('org-1', 'whatsapp', '+14155550100')).not.toBe(ref);
  });

  it.each([OrganizationRole.MEMBER, OrganizationRole.VIEWER, null, undefined])(
    'answers a caller with role %s as if the app did not exist, before reading anything',
    async (role) => {
      const caller = { userId: 'u-2', organizationId: 'org-1', role };
      for (const call of [service.lookup, service.export, service.erase]) {
        await expect(call.call(service, caller, 'acme', { place: 'telegram', id: 'tg-1' })).rejects.toBeInstanceOf(NotFoundException);
      }
      expect(apps.findOne).not.toHaveBeenCalled();
      expect(data.erase).not.toHaveBeenCalled();
    },
  );

  it('finds the person the way each kind of place identifies them', async () => {
    await service.lookup(owner, 'acme', { place: DistributionTarget.WEB, id: 'ann@example.com' });
    expect(data.findWebVisitors).toHaveBeenCalledWith({ id: 'gw-web', organizationId: 'org-1' }, 'ann@example.com');
    expect(data.forWebVisitors).toHaveBeenCalledWith({ id: 'gw-web', organizationId: 'org-1' }, ['eu-1']);
    await service.lookup(owner, 'acme', { place: DistributionTarget.WIDGET, id: ' thread-1 ' });
    expect(data.forWidgetThread).toHaveBeenCalledWith({ id: 'gw-widget', organizationId: 'org-1' }, 'thread-1');
    await service.lookup(owner, 'acme', { place: DistributionTarget.TELEGRAM, id: '1001' });
    expect(data.forChannelSender).toHaveBeenCalledWith({ id: 'gw-tg', organizationId: 'org-1' }, 'telegram', '1001');
    await service.lookup(owner, 'acme', { place: DistributionTarget.A2A, id: 'key-1' });
    expect(data.forA2ACaller).toHaveBeenCalledWith({ id: 'gw-a2a', organizationId: 'org-1' }, 'key-1');
    expect(apps.findOne).toHaveBeenCalledWith('org-1', 'acme');
  });

  it('says so when the app is not on the place, or the place talks to nobody, or nobody is named', async () => {
    await expect(service.lookup(owner, 'acme', { place: DistributionTarget.SLACK, id: 'U1' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.lookup(owner, 'acme', { place: DistributionTarget.DISCORD, id: 'U1' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.lookup(owner, 'acme', { place: DistributionTarget.DESKTOP, id: 'x' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.lookup(owner, 'acme', { place: DistributionTarget.TELEGRAM, id: '   ' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('records an export with who, whom (hashed), what and the counts, then hands it over', async () => {
    const out: any = await service.export(owner, 'acme', { place: DistributionTarget.TELEGRAM, id: 'tg-1' });

    expect(out).toMatchObject({ app: 'Acme help', place: 'telegram', conversations: [{ id: 'c1' }] });
    expect(audit.log).toHaveBeenCalledWith({
      organizationId: 'org-1',
      userId: 'u-1',
      action: AuditAction.VISITOR_DATA_EXPORT,
      resourceType: AuditResource.APP,
      resourceId: 'app-1',
      resourceName: 'Front desk',
      details: {
        request: 'export',
        place: 'telegram',
        kind: 'channel',
        subject: subjectRef('org-1', 'telegram', 'tg-1'),
        counts: { conversations: 1, messages: 2, memories: 1, storedReplies: 1, files: 0, runs: 1 },
      },
    });
    expect(JSON.stringify(audit.log.mock.calls[0][0])).not.toContain('tg-1"');
  });

  it('exports nothing when the audit row cannot be written', async () => {
    audit.log.mockResolvedValue(null);
    await expect(service.export(owner, 'acme', { place: DistributionTarget.TELEGRAM, id: 'tg-1' })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('writes the erasure audit row inside the erasure transaction, and streams it after commit', async () => {
    const removed = await service.erase(owner, 'acme', { place: DistributionTarget.TELEGRAM, id: 'tg-1' });

    expect(removed).toEqual(erased);
    expect(data.erase).toHaveBeenCalledWith(footprint, expect.any(Function));
    expect(audit.logInTransaction).toHaveBeenCalledWith(
      'tx',
      expect.objectContaining({
        action: AuditAction.VISITOR_DATA_ERASE,
        details: expect.objectContaining({ request: 'erase', counts: erased, subject: subjectRef('org-1', 'telegram', 'tg-1') }),
      }),
    );
    expect(audit.publishCommitted).toHaveBeenCalledWith([{ id: 'audit-2' }]);
    expect(audit.log).not.toHaveBeenCalled();
  });
});
