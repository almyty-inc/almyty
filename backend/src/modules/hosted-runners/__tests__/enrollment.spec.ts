import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { EnrollmentService, sha256 } from '../enrollment.service';
import { RunnerCredentialGuard, RunnerCredentialService, runnerIdOfSessionUser } from '../../runner/runner-credential';
import { DEFAULT_HOSTED_RUNNER_SETTINGS, HostedRunnerSettingsService } from '../hosted-runner-settings';
import { ACCESS_TOKEN_AUDIENCE, JWT_ISSUER } from '../../auth/token-kinds';
import { DEV_ONLY_JWT_SECRET } from '../../auth/dev-jwt-secret';
import { RunnerIsolationTier, RunnerState } from '../../../entities/runner.entity';

const RUNNER_ID = '6f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b';
const HR_ID = 'hr-0000-0001';
const ORG = 'org-1';

/**
 * Enrollment: a hosted pod's single-use token buys one runner credential,
 * and that credential is good for its own runner's stream and nothing
 * else. The token table is modelled with the one conditional UPDATE the
 * service runs (unused, unexpired), so single use is the store's answer,
 * as it is in Postgres.
 */
describe('hosted runner enrollment', () => {
  let tokens: Array<{ hostedRunnerId: string; organizationId: string; tokenHash: string; expiresAt: Date; usedAt: Date | null }>;
  let runnerRow: any;
  let hostedRow: any;
  let service: EnrollmentService;
  let credentials: RunnerCredentialService;
  const env = { HOSTED_RUNNERS_ENABLED: 'true' } as NodeJS.ProcessEnv;
  const settings = new HostedRunnerSettingsService(DEFAULT_HOSTED_RUNNER_SETTINGS, env);

  const runtimeInfo = { os: 'linux', arch: 'x64', hostname: 'hr-pod', cpuCount: 2, memoryMb: 4096, runnerVersion: '1.5.3', binaries: {} };

  beforeEach(() => {
    tokens = [];
    runnerRow = { id: RUNNER_ID, organizationId: ORG, kind: 'hosted', hostedRunnerId: HR_ID, ownerUserId: 'user-1', name: 'env-app-44444444', state: RunnerState.OFFLINE };
    hostedRow = { id: HR_ID, organizationId: ORG, runnerId: RUNNER_ID, state: 'provisioning', desired: { replicas: 1, resourceClass: 'small' }, environmentId: 'env-1', workspaceId: 'ws-1' };
    const tokenRepo: any = {
      insert: jest.fn(async (row: any) => {
        tokens.push({ ...row });
      }),
      query: jest.fn(async (_sql: string, [hash, now]: [string, Date]) => {
        const row = tokens.find((t) => t.tokenHash === hash && t.usedAt === null && t.expiresAt > now);
        if (!row) return [[], 0];
        row.usedAt = now;
        return [[{ hostedRunnerId: row.hostedRunnerId, organizationId: row.organizationId }], 1];
      }),
    };
    const hostedRepo: any = { findOne: jest.fn(async ({ where }: any) => (where.id === hostedRow.id && where.organizationId === hostedRow.organizationId ? hostedRow : null)) };
    const runnerRepo: any = {
      findOne: jest.fn(async ({ where }: any) => (Object.entries(where).every(([k, v]) => runnerRow[k] === v) ? runnerRow : null)),
      update: jest.fn(async (_c: any, patch: any) => Object.assign(runnerRow, patch)),
    };
    credentials = new RunnerCredentialService();
    service = new EnrollmentService(tokenRepo, hostedRepo, runnerRepo, credentials, settings);
  });

  it('stores only the hash of a minted token, expiring after the configured minutes', async () => {
    const now = new Date('2026-10-08T10:00:00Z');
    const token = await service.mint(hostedRow, now);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].tokenHash).toBe(sha256(token));
    expect(JSON.stringify(tokens)).not.toContain(token);
    expect(tokens[0].expiresAt.getTime() - now.getTime()).toBe(DEFAULT_HOSTED_RUNNER_SETTINGS.enrollment.tokenTtlMinutes * 60_000);
  });

  it('trades a token once for a credential naming that one runner, and pins the runner to its workspace', async () => {
    const token = await service.mint(hostedRow);
    const result = await service.enroll({ token, runtimeInfo, config: { defaultIsolation: RunnerIsolationTier.CONTAINER, allowedCwdRoots: ['/'] } as any });
    expect(result.runnerId).toBe(RUNNER_ID);
    expect(result.streamPath).toBe('/runners/hosted/stream');
    expect(credentials.verify(result.credential)).toEqual({ runnerId: RUNNER_ID, organizationId: ORG, hostedRunnerId: HR_ID, actUserId: 'user-1' });
    // The pod is the sandbox: host isolation inside it, the workspace volume only.
    expect(result.effectiveConfig).toMatchObject({ defaultIsolation: RunnerIsolationTier.HOST, allowedCwdRoots: ['/workspace'] });
    expect(runnerRow).toMatchObject({ state: RunnerState.REGISTERED, lastHeartbeatAt: null, runtimeInfo });

    await expect(service.enroll({ token, runtimeInfo })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses an expired token, an unknown one, and every token while hosted runners are off', async () => {
    const old = await service.mint(hostedRow, new Date(Date.now() - 60 * 60_000));
    await expect(service.enroll({ token: old, runtimeInfo })).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.enroll({ token: 'made-up', runtimeInfo })).rejects.toBeInstanceOf(UnauthorizedException);

    const off = new EnrollmentService({} as any, {} as any, {} as any, credentials, new HostedRunnerSettingsService(DEFAULT_HOSTED_RUNNER_SETTINGS, {}));
    await expect(off.enroll({ token: 'anything', runtimeInfo })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses a token of a machine that is being torn down', async () => {
    const token = await service.mint(hostedRow);
    hostedRow.desired = { ...hostedRow.desired, teardownRequested: true };
    await expect(service.enroll({ token, runtimeInfo })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('renews a credential only while its hosted runner lives', async () => {
    const claims = { runnerId: RUNNER_ID, organizationId: ORG, hostedRunnerId: HR_ID, actUserId: 'user-1' };
    const renewed = await service.renew(claims);
    expect(credentials.verify(renewed.credential)).toEqual(claims);
    hostedRow.state = 'torn_down';
    await expect(service.renew(claims)).rejects.toThrow(/not found/);
  });

  describe('the runner credential', () => {
    const claims = { runnerId: RUNNER_ID, organizationId: ORG, hostedRunnerId: HR_ID, actUserId: 'user-1' };

    it('is refused as a session: its audience is not the API\'s', () => {
      const { token } = credentials.sign(claims, 60);
      const session = new JwtService({ secret: DEV_ONLY_JWT_SECRET });
      expect(() => session.verify(token, { audience: ACCESS_TOKEN_AUDIENCE, issuer: JWT_ISSUER })).toThrow(/audience/);
    });

    it('is not mistaken for a session token, and a session token is not a runner credential', () => {
      const session = new JwtService({ secret: DEV_ONLY_JWT_SECRET }).sign({ sub: 'user-1' }, { audience: ACCESS_TOKEN_AUDIENCE, issuer: JWT_ISSUER });
      expect(credentials.verify(session)).toBeNull();
      expect(credentials.verify('garbage')).toBeNull();
    });

    it('is known on the stream as runner:<id>, which names no person', () => {
      expect(runnerIdOfSessionUser(`runner:${RUNNER_ID}`)).toBe(RUNNER_ID);
      expect(runnerIdOfSessionUser('user-1')).toBeNull();
      expect(runnerIdOfSessionUser('runner:not-a-uuid')).toBeNull();
    });

    it('opens the guard only for a hosted runner that exists in the credential\'s organization', async () => {
      const { token } = credentials.sign(claims, 60);
      const ctx = (authorization?: string) => {
        const req: any = { headers: authorization ? { authorization } : {} };
        return { req, context: { switchToHttp: () => ({ getRequest: () => req }) } as any };
      };
      const present = new RunnerCredentialGuard(credentials, { findOne: jest.fn(async () => ({ id: RUNNER_ID })) } as any);
      const ok = ctx(`Bearer ${token}`);
      await expect(present.canActivate(ok.context)).resolves.toBe(true);
      expect(ok.req.runnerCredential).toEqual(claims);
      expect(ok.req.user).toBeUndefined();

      const gone = new RunnerCredentialGuard(credentials, { findOne: jest.fn(async () => null) } as any);
      await expect(gone.canActivate(ctx(`Bearer ${token}`).context)).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(present.canActivate(ctx().context)).rejects.toBeInstanceOf(UnauthorizedException);
      const session = new JwtService({ secret: DEV_ONLY_JWT_SECRET }).sign({ sub: 'user-1' }, { audience: ACCESS_TOKEN_AUDIENCE, issuer: JWT_ISSUER });
      await expect(present.canActivate(ctx(`Bearer ${session}`).context)).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });
});
