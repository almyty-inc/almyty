import { BadRequestException, NotFoundException } from '@nestjs/common';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readFileSync } from 'fs';

import { AgentChannelsService } from '../agent-channels.service';
import { AgentChannel, ChannelType } from '../../../entities/agent-channel.entity';
import { ICON_RELATIVE_PATH, MAX_ICON_BYTES, writeBrandingIcon } from '../build-icon';
import { normalizeBranding, effectiveBranding } from '../channel-rules';
import { fakeRepository, type FakeRepository } from '../../../test/fake-repository';

/**
 * The app icon uploaded on Branding and visitor rules: a PNG in the
 * organization's files, named by id on the agent's branding (or a
 * channel's, over it), and what a desktop build wears. The id is checked
 * where it is saved, so a build never finds out too late that it names
 * another organization's file, a JPG, or something far too big.
 */
describe('the uploaded app icon', () => {
  const ORG = 'org-1';
  const ME = { id: 'user-1' };
  const ICON = '11111111-1111-4111-8111-111111111111';
  const THEIRS = '22222222-2222-4222-8222-222222222222';
  const JPEG = '33333333-3333-4333-8333-333333333333';
  const HUGE = '44444444-4444-4444-8444-444444444444';

  let agents: FakeRepository<any>;
  let channels: FakeRepository<AgentChannel>;
  let fileRows: Array<{ id: string; organizationId: string; mimeType: string; size: number }>;

  const files = {
    // Organization-scoped, like FilesService.findById.
    findById: jest.fn(async (id: string, organizationId: string) => {
      const row = fileRows.find((f) => f.id === id && f.organizationId === organizationId);
      if (!row) throw new NotFoundException('File not found');
      return row;
    }),
  };

  const build = (withFiles = true) =>
    new AgentChannelsService(
      channels as any,
      agents as any,
      fakeRepository<any>() as any,
      { upsertForChannel: jest.fn(), activateGateway: jest.fn(), deactivateGateway: jest.fn(), deleteGateway: jest.fn() } as any,
      { canAccess: jest.fn(async () => ({ allowed: true })) } as any,
      { hasForOrg: async () => false } as any,
      undefined,
      undefined,
      withFiles ? (files as any) : undefined,
    );

  beforeEach(() => {
    agents = fakeRepository<any>([
      { id: 'agent-1', organizationId: ORG, name: 'Support agent', visibility: 'org', teamId: null, mode: 'autonomous', createdBy: 'user-1', branding: null, visitorRules: null },
    ]);
    channels = fakeRepository<AgentChannel>({ make: () => new AgentChannel(), idPrefix: 'channel' });
    fileRows = [
      { id: ICON, organizationId: ORG, mimeType: 'image/png', size: 40_000 },
      { id: THEIRS, organizationId: 'org-2', mimeType: 'image/png', size: 40_000 },
      { id: JPEG, organizationId: ORG, mimeType: 'image/jpeg', size: 40_000 },
      { id: HUGE, organizationId: ORG, mimeType: 'image/png', size: MAX_ICON_BYTES + 1 },
    ];
    files.findById.mockClear();
  });

  it('is kept on the agent when it is a PNG of this organization, and removed with null', async () => {
    const saved = await build().updatePublicSettings(ORG, 'agent-1', ME, { branding: { appName: 'Help', iconFileId: ICON } });
    expect(saved.branding).toMatchObject({ iconFileId: ICON });
    expect(agents.rows()[0].branding).toMatchObject({ iconFileId: ICON });

    const removed = await build().updatePublicSettings(ORG, 'agent-1', ME, { branding: { appName: 'Help', iconFileId: null } });
    expect(removed.effective.branding.iconFileId).toBeNull();
  });

  it.each([
    ["another organization's file", THEIRS, 'That icon was not found'],
    ['a JPG that was never made a PNG', JPEG, 'has to be a PNG'],
    ['a file bigger than a build takes', HUGE, 'larger than 4 MB'],
    ['an id of no file at all', '55555555-5555-4555-8555-555555555555', 'That icon was not found'],
  ])('refuses %s and leaves the branding as it was', async (_label, fileId, message) => {
    await expect(build().updatePublicSettings(ORG, 'agent-1', ME, { branding: { iconFileId: fileId } })).rejects.toThrow(message);
    expect(agents.rows()[0].branding).toBeNull();
  });

  it('refuses anything that is not a file id before looking anywhere', async () => {
    expect(() => normalizeBranding({ iconFileId: '../../etc/passwd' })).toThrow('not a file uploaded here');
    expect(() => normalizeBranding({ iconFileId: 42 })).toThrow('not a file uploaded here');
    expect(normalizeBranding({ iconFileId: null })).toEqual({ iconFileId: null });
    await expect(build().updatePublicSettings(ORG, 'agent-1', ME, { branding: { iconFileId: 'https://evil.example/x.png' } })).rejects.toBeInstanceOf(BadRequestException);
    expect(files.findById).not.toHaveBeenCalled();
  });

  it('is refused, not stored unchecked, where the files module is not wired', async () => {
    await expect(build(false).updatePublicSettings(ORG, 'agent-1', ME, { branding: { iconFileId: ICON } })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('can be set on one channel over the agent, with the same checks', async () => {
    const service = build();
    await service.updatePublicSettings(ORG, 'agent-1', ME, { branding: { iconFileId: ICON } });
    const channel = await service.add(ORG, 'agent-1', ME, { type: ChannelType.DESKTOP });
    await expect(service.update(ORG, 'agent-1', channel.id, ME, { branding: { iconFileId: THEIRS } })).rejects.toThrow('That icon was not found');
    const cleared = await service.update(ORG, 'agent-1', channel.id, ME, { branding: { iconFileId: null } });
    expect(cleared.effective.branding.iconFileId).toBeNull();
    // Without an override the channel wears the agent's.
    expect(effectiveBranding({ name: 'Support agent', branding: { iconFileId: ICON } }, { branding: null }).iconFileId).toBe(ICON);
  });
});

describe('a desktop build with an uploaded icon', () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('an uploaded png')]);
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(join(tmpdir(), 'icon-upload-'));
  });
  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('wears the uploaded icon, read from storage, before any icon address, and fetches nothing', async () => {
    const fetcher = jest.fn();
    const read = jest.fn(async () => PNG);
    const outcome = await writeBrandingIcon({ iconFileId: 'file-1', iconUrl: 'https://cdn.example/old.png' }, projectDir, read, fetcher);
    expect(outcome).toEqual({ written: true, reason: null });
    expect(read).toHaveBeenCalledWith('file-1');
    expect(fetcher).not.toHaveBeenCalled();
    expect(await fs.readFile(join(projectDir, ICON_RELATIVE_PATH))).toEqual(PNG);
  });

  it('ships the default icon, and says why, when the upload cannot be read or is not a PNG', async () => {
    expect((await writeBrandingIcon({ iconFileId: 'file-1' }, projectDir, null)).written).toBe(false);
    expect((await writeBrandingIcon({ iconFileId: 'file-1' }, projectDir, async () => { throw new Error('gone'); })).reason).toMatch(/could not be read/);
    expect((await writeBrandingIcon({ iconFileId: 'file-1' }, projectDir, async () => Buffer.from('<html>'))).reason).toMatch(/not a PNG/);
    await expect(fs.stat(join(projectDir, ICON_RELATIVE_PATH))).rejects.toThrow();
  });

  it('still uses the icon address when nothing was uploaded', async () => {
    const outcome = await writeBrandingIcon({ iconUrl: 'https://cdn.example/logo.png' }, projectDir, jest.fn(), async () => PNG);
    expect(outcome.written).toBe(true);
  });

  it('is what the build processor reads, from the channel organization files', () => {
    const src = readFileSync(join(__dirname, '..', 'app-build.processor.ts'), 'utf8');
    expect(src).toMatch(/writeBrandingIcon\(\s*branding,/);
    expect(src).toMatch(/this\.files!\.download\(fileId, channel\.organizationId\)/);
    expect(src).not.toMatch(/writeIcon\(branding\.iconUrl/);
  });
});
