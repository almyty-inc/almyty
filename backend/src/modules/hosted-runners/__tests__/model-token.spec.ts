import { createHash } from 'crypto';
import { UnauthorizedException } from '@nestjs/common';

import { AuditAction } from '../../../entities/audit-log.entity';
import { WorkspaceStatus } from '../../../entities/workspace.entity';
import { DEFAULT_HOSTED_RUNNER_SETTINGS, HostedRunnerSettingsService, deepMerge, settingsProblems } from '../hosted-runner-settings';
import { HostedModelTokenService } from '../hosted-model-token.service';
import { HOSTED_MODEL_TOKEN_PREFIX, hostedAttributionHeaders, isHostedModelToken, presentedToken } from '../hosted-model-token.contract';
import { modelBaseUrls, modelTokenEnv } from '../hosted-runners.processor';

/**
 * The pod-scoped model token (Decision 6) on its own: minted with only its
 * hash stored, accepted while its pod runs for its owner, refused the
 * moment anything it is bound to stops being true.
 */
const ORG = '22222222-2222-4222-8222-222222222222';
const OWNER = '66666666-6666-4666-8666-666666666666';
const HR = '11111111-1111-4111-8111-111111111111';
const ENV = '33333333-3333-4333-8333-333333333333';
const WS = '44444444-4444-4444-8444-444444444444';

const sha = (t: string) => createHash('sha256').update(t).digest('hex');

function harness(opts: { enabled?: boolean } = {}) {
  const rows: any[] = [];
  const tokens: any = {
    insert: jest.fn(async (row: any) => {
      const saved = { id: `tok-${rows.length + 1}`, createdAt: new Date(), ...row };
      rows.push(saved);
      return { identifiers: [{ id: saved.id }] };
    }),
    update: jest.fn(async (where: any, patch: any) => {
      let affected = 0;
      for (const r of rows) {
        const match = Object.entries(where).every(([k, v]) => (v && typeof v === 'object' ? r[k] === null || r[k] === undefined : r[k] === v));
        if (match) {
          Object.assign(r, patch);
          affected++;
        }
      }
      return { affected };
    }),
    findOne: jest.fn(async ({ where }: any) => rows.find((r) => r.tokenHash === where.tokenHash) ?? null),
  };
  const state = {
    hr: { id: HR, organizationId: ORG, environmentId: ENV, workspaceId: WS, state: 'ready', desired: { replicas: 1, resourceClass: 'small' } } as any,
    ws: { id: WS, organizationId: ORG, ownerUserId: OWNER, status: WorkspaceStatus.ACTIVE } as any,
    env: { id: ENV, organizationId: ORG } as any,
    user: { id: OWNER, isActive: true, organizationMemberships: [{ organizationId: ORG, isActive: true, inviteAccepted: true }] } as any,
  };
  const repo = (key: keyof typeof state) => ({ findOne: jest.fn(async () => state[key]) });
  const audit = { log: jest.fn(async () => undefined) };
  const settings = new HostedRunnerSettingsService(DEFAULT_HOSTED_RUNNER_SETTINGS, { HOSTED_RUNNERS_ENABLED: opts.enabled === false ? 'false' : 'true' });
  const service = new HostedModelTokenService(tokens, repo('hr') as any, repo('ws') as any, repo('env') as any, repo('user') as any, settings, audit as any);
  return { service, rows, tokens, state, audit, settings };
}

describe('the pod-scoped model token', () => {
  const hr = { id: HR, organizationId: ORG, environmentId: ENV, workspaceId: WS };

  it('is minted with its prefix, stored only as a hash, bound to the pod, workspace, environment and owner', async () => {
    const t = harness();
    const token = await t.service.mint(hr, OWNER, new Date());
    expect(isHostedModelToken(token)).toBe(true);
    expect(token.startsWith(HOSTED_MODEL_TOKEN_PREFIX)).toBe(true);
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]).toMatchObject({ tokenHash: sha(token), hostedRunnerId: HR, workspaceId: WS, environmentId: ENV, organizationId: ORG, ownerUserId: OWNER, revokedAt: null });
    expect(JSON.stringify(t.rows)).not.toContain(token);
    const ttl = t.rows[0].expiresAt.getTime() - Date.now();
    expect(ttl).toBeLessThanOrEqual(t.settings.minutes(DEFAULT_HOSTED_RUNNER_SETTINGS.modelAccess.tokenTtlMinutes));
    expect(t.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.HOSTED_MODEL_TOKEN_ISSUED, resourceId: HR }));
  });

  it('works for the owner while the pod runs, and says which machine the call came from', async () => {
    const t = harness();
    const token = await t.service.mint(hr, OWNER);
    const key: any = await t.service.authenticate(token);
    expect(key).toMatchObject({ organizationId: ORG, userId: OWNER, agentId: null, gatewayId: null, hostedModelToken: { hostedRunnerId: HR, environmentId: ENV, workspaceId: WS } });
    expect(hostedAttributionHeaders(key)).toEqual({ 'X-Almyty-Hosted-Runner': HR, 'X-Almyty-Environment': ENV, 'X-Almyty-Workspace': WS });
    t.service.recordCall(key, { protocol: 'anthropic_messages', model: 'agent:x', agentId: 'agent-1' });
    expect(t.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.HOSTED_MODEL_CALL, resourceId: HR, details: expect.objectContaining({ workspaceId: WS, protocol: 'anthropic_messages' }) }));
  });

  it('is not its business when the bearer is anything else (an API key goes its own way)', async () => {
    const t = harness();
    await expect(t.service.authenticate('ak_live_not_a_pod_token')).resolves.toBeNull();
    await expect(t.service.authenticate(undefined)).resolves.toBeNull();
  });

  it.each([
    ['revoked when the pod stopped', async (t: any, token: string) => { await t.service.revoke(HR, 'pod_stopped'); return token; }],
    ['replaced by the next start', async (t: any) => { await t.service.mint(hr, OWNER); return null; }],
    ['expired', async (t: any, token: string) => { t.rows[0].expiresAt = new Date(Date.now() - 1); return token; }],
    ['for a pod asked to stop', async (t: any, token: string) => { t.state.hr.desired = { replicas: 0 }; return token; }],
    ['for a machine torn down', async (t: any, token: string) => { t.state.hr.state = 'torn_down'; return token; }],
    ['for a workspace no longer active', async (t: any, token: string) => { t.state.ws.status = WorkspaceStatus.SUSPENDED; return token; }],
    ['for a workspace handed to someone else', async (t: any, token: string) => { t.state.ws.ownerUserId = 'someone-else'; return token; }],
    ['for an owner who left the organization', async (t: any, token: string) => { t.state.user.organizationMemberships = []; return token; }],
    ['for a deactivated owner', async (t: any, token: string) => { t.state.user.isActive = false; return token; }],
    ['for a deleted environment', async (t: any, token: string) => { t.state.env = null; return token; }],
  ])('is refused once %s', async (_label, change) => {
    const t = harness();
    const token = await t.service.mint(hr, OWNER);
    const used = (await change(t, token)) ?? token;
    await expect(t.service.authenticate(used)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('is refused while hosted runners are off', async () => {
    const t = harness({ enabled: false });
    const token = await t.service.mint(hr, OWNER);
    await expect(t.service.authenticate(token)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('reaches the pod only through its Secret: the plain variables carry base URLs, never the token', () => {
    const token = `${HOSTED_MODEL_TOKEN_PREFIX}plainly-fake-test-value`;
    expect(modelTokenEnv(token)).toEqual({ ALMYTY_MODEL_TOKEN: token, ANTHROPIC_API_KEY: token, OPENAI_API_KEY: token });
    expect(modelTokenEnv(null)).toEqual({});
    const plain = modelBaseUrls('https://api.almyty.test', { envBindings: [] });
    expect(plain).toEqual({ ANTHROPIC_BASE_URL: 'https://api.almyty.test', OPENAI_BASE_URL: 'https://api.almyty.test/v1' });
    expect(JSON.stringify(plain)).not.toContain(token);
    // A vendor key the environment binds itself (allowVendorKeys) takes that
    // vendor's CLI off almyty's endpoint.
    expect(modelBaseUrls('https://api.almyty.test', { envBindings: [{ connectionId: 'c', field: 'apiKey', envVar: 'ANTHROPIC_API_KEY' }] })).toEqual({ OPENAI_BASE_URL: 'https://api.almyty.test/v1' });
  });

  it('is read from Authorization or x-api-key, as the two endpoints receive it', () => {
    expect(presentedToken('Bearer abc')).toBe('abc');
    expect(presentedToken(undefined, 'xyz')).toBe('xyz');
    expect(presentedToken('Basic abc', undefined)).toBeNull();
  });
});

describe('the follow-up settings', () => {
  it('ship 13 months of usage, a queue for the shared folder and a model token lifetime, all positive', () => {
    expect(DEFAULT_HOSTED_RUNNER_SETTINGS.usageRetention.months).toBe(13);
    expect(settingsProblems(DEFAULT_HOSTED_RUNNER_SETTINGS)).toEqual([]);
  });

  it('refuse an install that zeroes any of them', () => {
    const bad = deepMerge(DEFAULT_HOSTED_RUNNER_SETTINGS, { usageRetention: { months: 0 }, workspaceQueue: { pollSeconds: 0 }, modelAccess: { tokenTtlMinutes: -1 } });
    const problems = settingsProblems(bad).join(' ');
    expect(problems).toMatch(/usageRetention\.months/);
    expect(problems).toMatch(/workspaceQueue/);
    expect(problems).toMatch(/modelAccess/);
  });
});
