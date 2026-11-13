import { spawn } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import type * as http from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthSessionService } from './auth-session.service';
import { ApiKeyStrategy } from './strategies/api-key.strategy';
import { ApiKey } from '../../entities/api-key.entity';
import { Organization } from '../../entities/organization.entity';
import { User } from '../../entities/user.entity';
import { UserOrganization } from '../../entities/user-organization.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { MailService } from '../mail/mail.service';
import { ReferralsService } from '../referrals/referrals.service';
import { hasEffectiveMembership } from '../../common/authorization/membership';
import { serveOnLoopback } from '../../test/http';

/**
 * `almyty login` then `almyty runner start`, for a member of two orgs.
 *
 * Backend half: the real AuthController.createApiKey and AuthService
 * mint the CLI login key, and the real ApiKeyStrategy authenticates the
 * runner's registration, over in-memory repositories. Runner half: the
 * real @almyty/runner CLI (`runner start`, from packages/runner/src via
 * its own tsx), reading the credentials file the login writes.
 *
 * Before the fix the key came out scoped to no org (the user has two),
 * the runner sent the org picked at login as X-Organization-Id, and
 * registration was refused: "401 API key is not scoped to the requested
 * organization".
 *
 * The runner half needs packages/runner's dependencies installed; the
 * backend CI leg does not install them, so there it is skipped. Run
 * `npm ci` in packages/runner to exercise it.
 */
const REPO = resolve(__dirname, '../../../..');
const RUNNER_DIR = join(REPO, 'packages/runner');
const TSX = join(RUNNER_DIR, 'node_modules/.bin/tsx');
const runnerInstalled =
  existsSync(TSX) && existsSync(join(RUNNER_DIR, 'node_modules/@almyty/client/package.json'));

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ORG_A = '22222222-2222-4222-8222-222222222222';
const ORG_B = '33333333-3333-4333-8333-333333333333';

function inMemoryBackend() {
  const memberships = [
    { userId: USER_ID, organizationId: ORG_A, isActive: true, organization: { id: ORG_A, name: 'Personal' } },
    { userId: USER_ID, organizationId: ORG_B, isActive: true, organization: { id: ORG_B, name: 'Northwind' } },
  ];
  const user = { id: USER_ID, email: 'local@test.example', isActive: true, organizationMemberships: memberships };
  const keys: ApiKey[] = [];
  return {
    user,
    keys,
    userRepository: {
      findOne: async ({ where }: any) => (where?.id === USER_ID ? user : null),
    },
    userOrganizationRepository: {
      findOne: async ({ where }: any) =>
        memberships.find(m => m.userId === where?.userId && m.organizationId === where?.organizationId) ?? null,
    },
    apiKeyRepository: {
      create: (fields: Partial<ApiKey>) => Object.assign(new ApiKey(), { isActive: true }, fields),
      save: async (key: ApiKey) => {
        if (!key.id) {
          key.id = `key-${keys.length + 1}`;
          keys.push(key);
        }
        return key;
      },
      findOne: async ({ where }: any) => {
        const key = keys.find(k => k.keyHash === where?.keyHash);
        if (!key) return null;
        return Object.assign(key, { user, organization: key.organizationId ? { id: key.organizationId } : null });
      },
    },
  };
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

(runnerInstalled ? describe : describe.skip)('CLI login, then runner start, for a member of two orgs', () => {
  jest.setTimeout(90_000);

  let backend: ReturnType<typeof inMemoryBackend>;
  let controller: AuthController;
  let apiKeyStrategy: ApiKeyStrategy;
  let server: http.Server;
  let apiUrl: string;
  let registeredIn: Array<string | undefined>;
  let workDir: string;

  beforeEach(async () => {
    backend = inMemoryBackend();
    registeredIn = [];
    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        ApiKeyStrategy,
        { provide: getRepositoryToken(User), useValue: backend.userRepository },
        { provide: getRepositoryToken(UserOrganization), useValue: backend.userOrganizationRepository },
        { provide: getRepositoryToken(ApiKey), useValue: backend.apiKeyRepository },
        { provide: getRepositoryToken(Organization), useValue: {} },
        // createApiKey and validateApiKey use none of these.
        { provide: JwtService, useValue: {} },
        { provide: AuditLogService, useValue: {} },
        { provide: MailService, useValue: {} },
        { provide: ReferralsService, useValue: {} },
        { provide: AuthSessionService, useValue: {} },
      ],
    }).compile();
    // The controller class itself, without its route guards: the cookie
    // session the guard would resolve is played by the server below.
    controller = new AuthController(module.get(AuthService));
    apiKeyStrategy = module.get(ApiKeyStrategy);

    server = await serveOnLoopback(async (req, res) => {
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      try {
        if (req.method === 'POST' && req.url === '/auth/api-keys') {
          // The browser's cookie session, resolved the way JwtStrategy
          // does: X-Organization-Id names the org the web app is in, and
          // has to be one of the user's.
          const headerOrg = req.headers['x-organization-id'] as string | undefined;
          if (headerOrg && !hasEffectiveMembership(backend.user.organizationMemberships, headerOrg)) {
            return reply(403, { message: 'Not a member of the requested organization' });
          }
          const sessionUser = { ...backend.user, currentOrganizationId: headerOrg } as any;
          return reply(201, await controller.createApiKey(sessionUser, await readBody(req)));
        }
        if (req.method === 'POST' && req.url === '/runners/register') {
          const body = await readBody(req);
          const user = await apiKeyStrategy.validate(req as any);
          registeredIn.push(user.currentOrganizationId);
          return reply(201, {
            data: { runner: { id: 'runner-e2e', name: 'e2e' }, effectiveConfig: body.config },
          });
        }
        reply(404, { message: 'not part of this test' });
      } catch (err: any) {
        reply(err?.getStatus?.() ?? 500, { message: err?.message, statusCode: err?.getStatus?.() ?? 500 });
      }
    });
    apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    workDir = mkdtempSync(join(tmpdir(), 'almyty-cli-login-e2e-'));
  });

  afterEach(async () => {
    await new Promise<void>(done => server.close(() => done()));
    rmSync(workDir, { recursive: true, force: true });
  });

  /** What the CLI login page does: mint the key in the browser session. */
  async function cliLoginPage(sessionOrg: string, body: Record<string, unknown>) {
    const res = await fetch(`${apiUrl}/auth/api-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Organization-Id': sessionOrg },
      body: JSON.stringify({ name: 'CLI login 2026-11-13', ...body }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as any).data as { apiKey: string; keyData: { organizationId: string | null } };
  }

  /** `almyty login` saves this; `almyty runner start` reads it. */
  function saveLogin(token: string, organizationId: string) {
    const home = join(workDir, 'home');
    mkdirSync(join(home, '.almyty'), { recursive: true });
    writeFileSync(
      join(home, '.almyty', 'credentials.json'),
      JSON.stringify({ url: apiUrl, token, organizationId }),
      { mode: 0o600 },
    );
    return home;
  }

  /** Run the real `runner start` until it registers or gives up. */
  function runnerStart(home: string): Promise<{ registered: boolean; output: string }> {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: home,
      ALMYTY_RUNNER_STATE_DIR: join(workDir, 'state'),
    };
    return new Promise(done => {
      const child = spawn(TSX, [join(RUNNER_DIR, 'src/cli.ts'), 'start'], { cwd: workDir, env });
      let output = '';
      let settled = false;
      const finish = (registered: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill('SIGKILL');
        done({ registered, output });
      };
      const timer = setTimeout(() => finish(false), 75_000);
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes('registered as runner-e2e')) finish(true);
        if (output.includes('failed to start')) finish(false);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('exit', () => finish(output.includes('registered as runner-e2e')));
    });
  }

  it('registers when the page sends no org: the key takes the session org', async () => {
    // The page as it was: the org picked (and sent as the session's
    // X-Organization-Id) is not in the body.
    const { apiKey } = await cliLoginPage(ORG_B, {});
    const result = await runnerStart(saveLogin(apiKey, ORG_B));

    expect(result.output).not.toContain('not scoped to the requested organization');
    expect(result.registered).toBe(true);
    expect(registeredIn).toEqual([ORG_B]);
    expect(backend.keys[0].organizationId).toBe(ORG_B);
  });

  it('registers in the org picked on the page, whatever org the web app was in', async () => {
    const { apiKey, keyData } = await cliLoginPage(ORG_A, { organizationId: ORG_B });
    expect(keyData.organizationId).toBe(ORG_B);
    const result = await runnerStart(saveLogin(apiKey, keyData.organizationId!));

    expect(result.registered).toBe(true);
    expect(registeredIn).toEqual([ORG_B]);
  });

  it('tells the user to log in again when the saved org and the key disagree', async () => {
    const { apiKey } = await cliLoginPage(ORG_A, { organizationId: ORG_A });
    const result = await runnerStart(saveLogin(apiKey, ORG_B));

    expect(result.registered).toBe(false);
    expect(result.output).toContain('not scoped to the requested organization');
    expect(result.output).toContain('almyty login');
    expect(registeredIn).toEqual([]);
  });
});
