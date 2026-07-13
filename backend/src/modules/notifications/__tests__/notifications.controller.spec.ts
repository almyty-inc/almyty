import { NotificationsController } from '../notifications.controller';

/**
 * Contract-shape tests for the frozen notification API. The controller
 * is thin; these assert the exact envelopes the frontend builds
 * against.
 */
describe('NotificationsController', () => {
  let service: {
    list: jest.Mock;
    markRead: jest.Mock;
    markAllRead: jest.Mock;
    getPreferences: jest.Mock;
    updatePreferences: jest.Mock;
  };
  let controller: NotificationsController;
  const req = { user: { id: 'user-1', currentOrganizationId: 'org-1' } };

  beforeEach(() => {
    service = {
      list: jest.fn().mockResolvedValue({
        notifications: [
          {
            id: 'n-1',
            type: 'approval.pending',
            title: 't',
            body: 'b',
            link: '/approvals/x',
            createdAt: new Date(),
            readAt: null,
          },
        ],
        total: 1,
        unreadCount: 1,
      }),
      markRead: jest.fn().mockResolvedValue(undefined),
      markAllRead: jest.fn().mockResolvedValue(undefined),
      getPreferences: jest.fn().mockResolvedValue({ matrix: {}, defaults: {} }),
      updatePreferences: jest.fn().mockResolvedValue({ matrix: {}, defaults: {} }),
    };
    controller = new NotificationsController(service as any);
  });

  it('GET /notifications returns {success, data: {notifications, total, unreadCount}}', async () => {
    const res = await controller.list(req, 'true', '2', '10');

    expect(service.list).toHaveBeenCalledWith('user-1', {
      unreadOnly: true,
      page: 2,
      limit: 10,
    });
    expect(res.success).toBe(true);
    expect(res.data.total).toBe(1);
    expect(res.data.unreadCount).toBe(1);
    expect(res.data.notifications[0]).toEqual(
      expect.objectContaining({
        id: 'n-1',
        type: 'approval.pending',
        title: 't',
        body: 'b',
        link: '/approvals/x',
      }),
    );
  });

  it('GET /notifications defaults unreadOnly to false and omits page/limit when absent', async () => {
    await controller.list(req, undefined, undefined, undefined);
    expect(service.list).toHaveBeenCalledWith('user-1', {
      unreadOnly: false,
      page: undefined,
      limit: undefined,
    });
  });

  it('POST /notifications/:id/read returns {success} and scopes to the caller', async () => {
    const res = await controller.read(req, 'n-1');
    expect(service.markRead).toHaveBeenCalledWith('user-1', 'n-1');
    expect(res).toEqual({ success: true });
  });

  it('POST /notifications/read-all returns {success}', async () => {
    const res = await controller.readAll(req);
    expect(service.markAllRead).toHaveBeenCalledWith('user-1');
    expect(res).toEqual({ success: true });
  });

  it('GET /notifications/preferences returns {success, data: {matrix, defaults}}', async () => {
    const res = await controller.getPreferences(req);
    expect(service.getPreferences).toHaveBeenCalledWith('user-1');
    expect(res).toEqual({ success: true, data: { matrix: {}, defaults: {} } });
  });

  it('PUT /notifications/preferences passes the partial matrix and returns the merged result', async () => {
    const res = await controller.updatePreferences(req, {
      matrix: { 'run.failed': { email: true } },
    });
    expect(service.updatePreferences).toHaveBeenCalledWith('user-1', {
      'run.failed': { email: true },
    });
    expect(res.success).toBe(true);
  });

  it('PUT /notifications/preferences tolerates a missing body matrix', async () => {
    await controller.updatePreferences(req, {} as any);
    expect(service.updatePreferences).toHaveBeenCalledWith('user-1', {});
  });
});
