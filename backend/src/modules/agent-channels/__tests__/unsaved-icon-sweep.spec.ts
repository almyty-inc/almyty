import { AgentChannelsService, UNSAVED_ICON_TTL_MS } from '../agent-channels.service';
import { AppBuildProcessor } from '../app-build.processor';
import { AgentChannel } from '../../../entities/agent-channel.entity';
import { FilesController } from '../../files/files.controller';
import { fakeRepository } from '../../../test/fake-repository';

/**
 * An app icon chosen on the branding page is uploaded before the page is
 * saved. One that is never saved is cleared a day later by the hourly
 * channel housekeeping sweep, unless some agent's or channel's branding
 * names it by then.
 */
describe('unsaved app icons', () => {
  const NOW = new Date('2026-09-30T12:00:00Z');
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000);

  function setup() {
    const uploads = [
      { id: 'icon-stale', organizationId: 'org-1', createdAt: hoursAgo(30), metadata: { purpose: 'app_icon' } },
      { id: 'icon-saved', organizationId: 'org-1', createdAt: hoursAgo(30), metadata: { purpose: 'app_icon' } },
      { id: 'icon-on-a-channel', organizationId: 'org-2', createdAt: hoursAgo(48), metadata: { purpose: 'app_icon' } },
      { id: 'icon-other-org', organizationId: 'org-2', createdAt: hoursAgo(26), metadata: { purpose: 'app_icon' } },
      { id: 'icon-fresh', organizationId: 'org-1', createdAt: hoursAgo(2), metadata: { purpose: 'app_icon' } },
      { id: 'a-report', organizationId: 'org-1', createdAt: hoursAgo(90), metadata: null },
    ];
    const files = {
      // As FilesService.findForPurposeBefore: that purpose, created before the cut-off.
      findForPurposeBefore: jest.fn(async (purpose: string, before: Date) =>
        uploads.filter((f) => f.metadata?.purpose === purpose && f.createdAt < before)),
      remove: jest.fn(async () => undefined),
    };
    const agents = fakeRepository<any>([
      { id: 'agent-1', organizationId: 'org-1', branding: { iconFileId: 'icon-saved' } },
      { id: 'agent-2', organizationId: 'org-2', branding: null },
    ]);
    const channels = fakeRepository<AgentChannel>({ make: () => new AgentChannel(), idPrefix: 'channel' });
    channels.seed({ id: 'ch-1', organizationId: 'org-2', agentId: 'agent-2', branding: { iconFileId: 'icon-on-a-channel' } } as any);
    const service = new AgentChannelsService(
      channels as any, agents as any, fakeRepository<any>() as any, {} as any, {} as any, undefined, undefined, undefined, files as any,
    );
    return { service, files };
  }

  it('clears icon uploads older than a day that no branding names, and nothing else', async () => {
    const { service, files } = setup();
    const removed = await service.sweepUnsavedIcons(NOW);
    expect(removed).toBe(2);
    expect(files.findForPurposeBefore).toHaveBeenCalledWith('app_icon', new Date(NOW.getTime() - UNSAVED_ICON_TTL_MS));
    expect(files.remove.mock.calls).toEqual(expect.arrayContaining([['icon-stale', 'org-1'], ['icon-other-org', 'org-2']]));
    const gone = files.remove.mock.calls.map((c: any[]) => c[0]);
    for (const kept of ['icon-saved', 'icon-on-a-channel', 'icon-fresh', 'a-report']) expect(gone).not.toContain(kept);
  });

  it('waits a day, so a branding page still being filled in keeps its icon', () => {
    expect(UNSAVED_ICON_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('runs with the hourly channel housekeeping sweep', async () => {
    const builds = { failStaleBuilds: jest.fn().mockResolvedValue(0), sweepExpiredArtifacts: jest.fn().mockResolvedValue(0) };
    const channels = { sweepUnsavedIcons: jest.fn().mockResolvedValue(3) };
    const processor = new AppBuildProcessor(builds as any, {} as any, {} as any, undefined, channels as any);
    await processor.sweep();
    expect(channels.sweepUnsavedIcons).toHaveBeenCalled();
  });

  it('marks the upload as an app icon, and refuses a purpose it does not know', async () => {
    const service = { upload: jest.fn().mockResolvedValue({ id: 'f-1' }) };
    const controller = new FilesController(service as any);
    const req = { user: { id: 'u-1', currentOrganizationId: 'org-1' } };
    const png = { path: '/tmp/x', originalname: 'app-icon.png', mimetype: 'image/png', size: 10 };
    await controller.upload(png, undefined as any, undefined as any, req, 'app_icon');
    expect(service.upload.mock.calls[0][2]).toMatchObject({ purpose: 'app_icon' });
    await expect(controller.upload(png, undefined as any, undefined as any, req, 'anything')).rejects.toMatchObject({ status: 400 });
    expect(service.upload).toHaveBeenCalledTimes(1);
  });
});
