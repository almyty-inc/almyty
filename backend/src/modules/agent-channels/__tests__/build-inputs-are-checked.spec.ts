import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { AppBuild } from '../../../entities/app-build.entity';
import { ChannelType } from '../../../entities/agent-channel.entity';
import { AppBuildsService } from '../app-builds.service';
import { AppBuildProcessor } from '../app-build.processor';
import { AgentChannelsService } from '../agent-channels.service';
import { RecordBuildBodyDto, RequestBuildBodyDto } from '../dto/agent-channels-controller.dto';
import { buildVersionError, bundleIdError } from '../channel-rules';
import { fakeRepository } from '../../../test/fake-repository';

/**
 * A build's version and a desktop build's bundle identifier are written
 * onto electron-builder's and the signer's command lines
 * (`--config.buildVersion=...`, `--config.appId=...`,
 * `--binary-identifier ...`). The version was only length-capped and the
 * bundle id not checked at all before a build; the record-a-build body
 * was an inline type the ValidationPipe passed through whole.
 */

const ORG = 'org-1';

// The app's own global pipe (main.ts).
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const body = (metatype: any, value: unknown) => pipe.transform(value, { type: 'body', metatype });

const BAD_VERSIONS = ['1.0.0 --config.afterPack=x.js', '1.0.0,2', '../1', 'v1.0.0', '1..0', '1.0.0-', 'latest', '1.2.3.4.5', ''];
const GOOD_VERSIONS = ['1', '1.2', '1.2.3', '1.2.3.4', '2.0.0-beta.1', '1.0.0+build.7', '1.0.0-rc.1+sha.abc'];

describe('build version and bundle id rules', () => {
  it.each(BAD_VERSIONS)('refuses version %p', (v) => expect(buildVersionError(v)).not.toBeNull());
  it.each(GOOD_VERSIONS)('accepts version %p', (v) => expect(buildVersionError(v)).toBeNull());
  it('treats an absent version as the default', () => expect(buildVersionError(undefined)).toBeNull());

  it.each(['com.acme', 'app.almyty.supportbot', 'com.acme-corp.assistant'])('accepts bundle id %p', (id) =>
    expect(bundleIdError(id)).toBeNull(),
  );
  it.each(['acme', 'Com.Acme.App', 'com.acme.app --deep', '-com.acme', 'com..acme', `com.${'a'.repeat(160)}`])(
    'refuses bundle id %p',
    (id) => expect(bundleIdError(id)).not.toBeNull(),
  );
});

describe('POST /agents/:agentId/channels/:channelId/builds body', () => {
  it.each(BAD_VERSIONS.filter(Boolean))('refuses version %p', async (version) => {
    await expect(body(RequestBuildBodyDto, { platform: 'linux-x64', version })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses a build type in the body: the channel is the type', async () => {
    await expect(body(RequestBuildBodyDto, { target: 'desktop', platform: 'linux-x64' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a semver-ish version', async () => {
    await expect(body(RequestBuildBodyDto, { platform: 'linux-x64', version: '1.4.0-beta.2' })).resolves.toBeInstanceOf(
      RequestBuildBodyDto,
    );
  });
});

describe('POST /agents/:agentId/channels/:channelId/build-record body', () => {
  it('accepts what a local build reports', async () => {
    const dto = await body(RecordBuildBodyDto, {
      version: '1.0.0',
      platform: 'darwin-arm64',
      checksum: 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      signed: true,
    });
    expect(dto).toBeInstanceOf(RecordBuildBodyDto);
  });

  it.each([
    ['an unknown field', { version: '1.0.0', builtAt: '1999-01-01', status: 'published' }],
    ['a bad version', { version: '1.0.0; rm -rf /' }],
    ['a non-boolean signed', { signed: 'yes' }],
    ['an oversized error', { error: 'x'.repeat(2001) }],
    ['a checksum with spaces', { checksum: 'abc def' }],
  ])('refuses %s', async (_label, value) => {
    await expect(body(RecordBuildBodyDto, value)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('AppBuildsService.request checks the build inputs before queueing', () => {
  function makeService(configuration: Record<string, any>) {
    const builds = fakeRepository<any>({ make: () => new AppBuild() });
    const channel = { id: 'channel-1', agentId: 'agent-1', type: ChannelType.DESKTOP, configuration };
    const queue = { add: jest.fn().mockResolvedValue({ id: 'job' }) };
    const service = new AppBuildsService(builds as any, fakeRepository<any>() as any, queue as any, { canPresign: false } as any);
    (service as any).toolchain = { available: async () => true, run: jest.fn() };
    return { service, queue, channel };
  }

  it('refuses a version that is not semver-ish', async () => {
    const { service, queue, channel } = makeService({ bundleId: 'com.acme.app' });
    const error = await service
      .request(ORG, channel, { platform: 'linux-x64', version: '1.0 --publish always' }, 'u')
      .catch((e) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('refuses a desktop build whose stored bundle id is not reverse-DNS', async () => {
    const { service, queue, channel } = makeService({ bundleId: 'com.acme.app --deep' });
    const error = await service
      .request(ORG, channel, { platform: 'linux-x64' }, 'u')
      .catch((e) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).toMatch(/reverse-domain/);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('lets a valid bundle id through to the later checks', async () => {
    const { service, channel } = makeService({ bundleId: 'com.acme.app' });
    const error = await service
      .request(ORG, channel, { platform: 'linux-x64', version: '1.2.3' }, 'u')
      .catch((e) => e);
    expect(error?.message ?? '').not.toMatch(/reverse-domain|build version/);
  });
});

describe('AppBuildProcessor refuses bad inputs where they reach the packager', () => {
  it('does not package with an invalid bundle id or version', async () => {
    const processor = new AppBuildProcessor({} as any, {} as any, {} as any);
    const build = { channelId: 'channel-1', platform: 'linux-x64', target: 'desktop', version: '1.0.0' };
    await expect((processor as any).packageDesktop(build, '/tmp/w', '/tmp/o', { bundleId: 'x --y' })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/reverse-domain/),
    });
    await expect(
      (processor as any).packageDesktop({ ...build, version: '1 && x' }, '/tmp/w', '/tmp/o', { bundleId: 'com.acme.app' }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/build version/) });
  });
});

describe('AgentChannelsService.recordBuild', () => {
  function makeService() {
    const agents = { findOne: jest.fn().mockResolvedValue({ id: 'agent-1', organizationId: ORG, name: 'Support', visibility: 'org', createdBy: 'u' }) };
    const channels = {
      findOne: jest.fn().mockResolvedValue({ id: 'channel-1', agentId: 'agent-1', organizationId: ORG, type: ChannelType.DESKTOP, configuration: {} }),
      save: jest.fn(async (d: any) => d),
    };
    const gateways = { find: jest.fn().mockResolvedValue([]) };
    const accessPolicy = { canAccess: jest.fn().mockResolvedValue({ allowed: true }) };
    const service = new AgentChannelsService(channels as any, agents as any, gateways as any, {} as any, accessPolicy as any);
    return { service, distributions: channels };
  }

  it('refuses a version that is not semver-ish', async () => {
    const { service, distributions } = makeService();
    await expect(
      service.recordBuild(ORG, 'agent-1', 'channel-1', { id: 'u' }, { version: '1.0.0\nforged: line' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(distributions.save).not.toHaveBeenCalled();
  });

  it('stores the named fields only and stamps the time itself', async () => {
    const { service } = makeService();
    const saved = await service.recordBuild(ORG, 'agent-1', 'channel-1', { id: 'u' }, {
      version: '1.0.0',
      signed: true,
      builtAt: '1999-01-01T00:00:00.000Z',
      extra: 'x',
    } as any);
    expect(Object.keys(saved.lastBuild!).sort()).toEqual(['builtAt', 'signed', 'version']);
    expect(saved.lastBuild!.builtAt).not.toBe('1999-01-01T00:00:00.000Z');
  });
});
