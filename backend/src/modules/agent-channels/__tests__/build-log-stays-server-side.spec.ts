import { AgentChannelsController } from '../agent-channels.controller';
import { BuildStatus } from '../../../entities/app-build.entity';

/**
 * The build log is the toolchain's raw output: electron-builder and bun
 * print absolute host paths, and the signing tool's output names where
 * the certificate was written. The processor and the signer both treat
 * it as server-side only (operatorMessage strips paths from `error` for
 * exactly that reason), yet the build history was member-readable
 * and returned the row with `log` in it. The channel's build history is
 * member-readable too.
 */

const req = { user: { id: 'user-1', email: 'a@b.c', currentOrganizationId: 'org-1' } };
const LOG = 'signing /tmp/almyty-build-1f2e/signing-certificate.p12 on /opt/almyty/node_modules';

describe('the build log stays server side', () => {
  const build = {
    id: 'build-1',
    organizationId: 'org-1',
    channelId: 'channel-1',
    agentId: 'agent-1',
    target: 'tui',
    platform: 'linux-x64',
    status: BuildStatus.FAILED,
    version: '1.0.0',
    signed: false,
    signingNote: null,
    error: 'bun exited with code 1.',
    log: LOG,
    artifactKey: null,
  };

  const makeController = () => {
    const channel = { id: 'channel-1', agentId: 'agent-1', slug: 'acme', type: 'tui', branding: null };
    const channels = {
      readableAgent: jest.fn().mockResolvedValue({ id: 'agent-1', name: 'Acme', branding: {} }),
      manageableAgent: jest.fn().mockResolvedValue({ id: 'agent-1', name: 'Acme', branding: {} }),
      get: jest.fn().mockResolvedValue(channel),
    };
    const builds = {
      list: jest.fn().mockResolvedValue([{ ...build }]),
      request: jest.fn().mockResolvedValue({ ...build, status: BuildStatus.QUEUED }),
    };
    return new AgentChannelsController(channels as any, builds as any);
  };

  it('is not in the build history', async () => {
    const { data } = await makeController().listBuilds('agent-1', 'channel-1', req);

    expect(JSON.stringify(data)).not.toContain(LOG);
    expect(data[0]).not.toHaveProperty('log');
    // What the panel does show is still there.
    expect(data[0]).toMatchObject({ id: 'build-1', error: 'bun exited with code 1.' });
    expect(data[0].handoff).toBeDefined();
  });

  it('is not in the response to queueing a build', async () => {
    const { data } = await makeController().requestBuild(
      'agent-1',
      'channel-1',
      { platform: 'linux-x64' } as any,
      req,
    );

    expect(data).not.toHaveProperty('log');
  });
});
