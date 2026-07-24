/**
 * Lifecycle-email STAGING verification harness.
 *
 * Seeds throwaway verified users into a *staging* database, drives the
 * real LifecycleEmailService against real onboarding state, and asserts
 * the expected `preferences.lifecycle.*` marker was written (i.e. the
 * email was sent). Emails DO send for real via Resend to plus-aliases of
 * a single inbox you control, so a human can eyeball the rendering.
 *
 * SAFETY: refuses to run unless STAGING_TEST_CONFIRM=1 AND the configured
 * DATABASE_HOST / DATABASE_NAME clearly names a staging DB. It must never
 * be pointed at production. All seeded rows are torn down at the end
 * (even on failure) by matching the plus-alias email prefix.
 *
 * Run (compiled, in the staging pod after `nest build`):
 *   STAGING_TEST_CONFIRM=1 \
 *   LIFECYCLE_TEST_EMAIL='you+test@example.com' \
 *   node dist/scripts/lifecycle-staging-verify.js
 *
 * Or directly with tsx (no build):
 *   STAGING_TEST_CONFIRM=1 \
 *   LIFECYCLE_TEST_EMAIL='you+test@example.com' \
 *   npx tsx src/scripts/lifecycle-staging-verify.ts
 *
 * LIFECYCLE_TEST_EMAIL is REQUIRED: a base address you own whose provider
 * routes plus-addressing back to the same inbox (e.g. Google Workspace).
 * Per-scenario aliases are derived from it at runtime; no address is
 * hardcoded in this file.
 */

/*
 * Cadence + feature-gate env MUST be set before AppModule is imported:
 * the cadence day consts in lifecycle-email.service.ts are evaluated at
 * module load. We keep the production defaults here (assertions rely on
 * backdated createdAt, not on shifted windows) but pin them explicitly so
 * a stray override in the pod env can't skew the run. isEnabled() reads
 * LIFECYCLE_EMAILS_ENABLED live, but we set it here too for clarity.
 */
process.env.LIFECYCLE_EMAILS_ENABLED = 'true';
process.env.LIFECYCLE_STATE_NUDGE_DAY = process.env.LIFECYCLE_STATE_NUDGE_DAY ?? '2';
process.env.LIFECYCLE_SHOWCASE_DAY = process.env.LIFECYCLE_SHOWCASE_DAY ?? '5';
process.env.LIFECYCLE_LAST_TOUCH_DAY = process.env.LIFECYCLE_LAST_TOUCH_DAY ?? '10';
process.env.LIFECYCLE_SWEEP_LOOKBACK_DAYS = process.env.LIFECYCLE_SWEEP_LOOKBACK_DAYS ?? '11';

import { randomBytes } from 'crypto';

import { NestFactory } from '@nestjs/core';
import { DataSource, Repository } from 'typeorm';

import { AppModule } from '../app.module';
import { User } from '../entities/user.entity';
import {
  Organization,
} from '../entities/organization.entity';
import {
  UserOrganization,
  OrganizationRole,
} from '../entities/user-organization.entity';
import {
  LlmProvider,
  LlmProviderType,
  LlmProviderStatus,
} from '../entities/llm-provider.entity';
import { Api, ApiType, ApiStatus } from '../entities/api.entity';
import {
  Gateway,
  GatewayKind,
  GatewayType,
  GatewayStatus,
} from '../entities/gateway.entity';
import { GatewayTool } from '../entities/gateway-tool.entity';
import { Tool, ToolType, ToolStatus } from '../entities/tool.entity';
import { RequestLog } from '../entities/request-log.entity';
import { LifecycleEmailService } from '../modules/lifecycle/lifecycle-email.service';
import { OnboardingService } from '../modules/onboarding/onboarding.service';

// ── Constants ────────────────────────────────────────────────────────────────

/** Local-part tag that marks every user this harness creates. */
const EMAIL_TAG = 'lc-test';
/** LIKE pattern used for teardown. Matches "<local>+lc-test-...@domain". */
const EMAIL_LIKE = `%+${EMAIL_TAG}-%`;

const DAY_MS = 24 * 60 * 60 * 1000;

type Scenario =
  | 'welcome'
  | 'nudge-provider'
  | 'nudge-api'
  | 'nudge-gateway'
  | 'nudge-first-call'
  | 'showcase'
  | 'last-touch'
  | 'congrats'
  | 'opt-out'
  | 'dedupe';

interface Result {
  scenario: string;
  pass: boolean;
  detail: string;
  email: string;
}

// ── Recipient derivation (no hardcoded address) ──────────────────────────────

/**
 * Turn the base LIFECYCLE_TEST_EMAIL into a per-scenario plus-alias.
 * base "you+test@example.com"  + "welcome" -> "you+test-welcome@example.com"
 * base "you@example.com"       + "welcome" -> "you+lc-test-welcome@example.com"
 * The suffix always contains EMAIL_TAG so teardown's LIKE matches.
 */
function aliasFor(base: string, scenario: string): string {
  const at = base.lastIndexOf('@');
  if (at <= 0) {
    throw new Error(`LIFECYCLE_TEST_EMAIL is not a valid address: ${base}`);
  }
  const local = base.slice(0, at);
  const domain = base.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus === -1) {
    // No existing +tag: introduce one carrying the marker.
    return `${local}+${EMAIL_TAG}-${scenario}@${domain}`;
  }
  // Has a +tag (e.g. "you+test"): append "-<tag>-<scenario>" to it so the
  // marker is always present and teardown's "+lc-test-" LIKE still hits.
  const head = local.slice(0, plus); // "you"
  const tag = local.slice(plus + 1); // "test"
  return `${head}+${tag}-${EMAIL_TAG}-${scenario}@${domain}`;
}

// ── Safety guard ─────────────────────────────────────────────────────────────

function assertSafeToRun(): string {
  const problems: string[] = [];

  if (process.env.STAGING_TEST_CONFIRM !== '1') {
    problems.push('STAGING_TEST_CONFIRM must be exactly "1"');
  }

  const base = (process.env.LIFECYCLE_TEST_EMAIL ?? '').trim();
  if (!base) {
    problems.push(
      'LIFECYCLE_TEST_EMAIL must be set to a base inbox you own ' +
        '(e.g. you+test@example.com); per-scenario aliases derive from it',
    );
  }

  const host = (process.env.DATABASE_HOST ?? '').toLowerCase();
  const name = (process.env.DATABASE_NAME ?? '').toLowerCase();
  const looksStaging =
    host.includes('staging') || name.includes('staging');
  if (!looksStaging) {
    problems.push(
      `DATABASE_HOST/DATABASE_NAME must contain "staging" ` +
        `(host="${host}", name="${name}") — refusing to touch a possibly-prod DB`,
    );
  }

  // Belt and suspenders: never run if anything screams prod.
  const prodish = [host, name].some(
    (v) => v.includes('prod') || v.includes('production'),
  );
  if (prodish) {
    problems.push(
      'DATABASE_HOST/DATABASE_NAME contains "prod" — hard abort',
    );
  }

  if (problems.length > 0) {
    console.error('\n[ABORT] Refusing to run the lifecycle staging harness:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      '\nThis harness writes real rows and sends real email; it only runs ' +
        'against a clearly-named staging DB with explicit confirmation.\n',
    );
    process.exit(1);
  }

  return base;
}

// ── Seeding helpers ──────────────────────────────────────────────────────────

interface Repos {
  ds: DataSource;
  users: Repository<User>;
  orgs: Repository<Organization>;
  userOrgs: Repository<UserOrganization>;
  providers: Repository<LlmProvider>;
  apis: Repository<Api>;
  gateways: Repository<Gateway>;
  gatewayTools: Repository<GatewayTool>;
  tools: Repository<Tool>;
  logs: Repository<RequestLog>;
}

function rand(): string {
  return randomBytes(4).toString('hex');
}

/**
 * Create a verified user + own Organization + OWNER membership, then
 * BACKDATE user.createdAt / verifiedAt so cadence math lands naturally.
 * createdAt is a @CreateDateColumn (TypeORM stamps it on insert), so we
 * must UPDATE it with raw SQL after the row exists.
 */
async function seedUser(
  r: Repos,
  scenario: Scenario,
  email: string,
  daysAgo: number,
  lifecyclePrefs?: Record<string, any>,
): Promise<{ user: User; org: Organization }> {
  const suffix = rand();
  const org = await r.orgs.save(
    r.orgs.create({
      name: `lc-test ${scenario} ${suffix}`,
      slug: `lc-test-${scenario}-${suffix}`,
      isActive: true,
    }),
  );

  const user = await r.users.save(
    r.users.create({
      email,
      firstName: 'Lifecycle',
      lastName: `Test-${scenario}`,
      passwordHash: 'x'.repeat(60), // never used; no login in this harness
      isActive: true,
      isVerified: true,
      verifiedAt: new Date(Date.now() - daysAgo * DAY_MS),
      preferences: lifecyclePrefs ? { lifecycle: lifecyclePrefs } : {},
    }),
  );

  await r.userOrgs.save(
    r.userOrgs.create({
      userId: user.id,
      organizationId: org.id,
      role: OrganizationRole.OWNER,
      isActive: true,
    }),
  );

  // Backdate createdAt (CreateDateColumn is set on insert; override it).
  const createdAt = new Date(Date.now() - daysAgo * DAY_MS);
  await r.users.update({ id: user.id }, { createdAt } as any);
  user.createdAt = createdAt;

  return { user, org };
}

/** provider step: an LlmProvider for the org with status != ERROR. */
async function seedProvider(r: Repos, orgId: string): Promise<void> {
  await r.providers.save(
    r.providers.create({
      name: `lc-test-provider-${rand()}`,
      type: LlmProviderType.OPENAI,
      status: LlmProviderStatus.ACTIVE, // any non-ERROR status counts
      organizationId: orgId,
      configuration: { model: 'gpt-4o-mini' },
    }),
  );
}

/** api step: any Api for the org. */
async function seedApi(r: Repos, orgId: string): Promise<void> {
  await r.apis.save(
    r.apis.create({
      name: `lc-test-api-${rand()}`,
      type: ApiType.HTTP,
      status: ApiStatus.ACTIVE,
      organizationId: orgId,
      baseUrl: 'https://example.com',
    } as any),
  );
}

/**
 * gateway step: a non-system Gateway for the org with >= 1 tool linked
 * via a gateway_tools join row. Onboarding's hasGatewayWithTool inner-
 * joins gw.tools and filters gw.isSystem = false.
 */
async function seedGatewayWithTool(r: Repos, orgId: string): Promise<void> {
  const tool = await r.tools.save(
    r.tools.create({
      name: `lc-test-tool-${rand()}`,
      type: ToolType.FUNCTION,
      status: ToolStatus.ACTIVE,
      organizationId: orgId,
    }) as Tool,
  );

  const suffix = rand();
  const gateway = await r.gateways.save(
    r.gateways.create({
      name: `lc-test-gw-${suffix}`,
      kind: GatewayKind.TOOL,
      type: GatewayType.MCP,
      status: GatewayStatus.ACTIVE,
      organizationId: orgId,
      endpoint: `/gateways/lc-test-gw-${suffix}`,
      configuration: {},
      isSystem: false,
    }) as Gateway,
  );

  await r.gatewayTools.save(
    r.gatewayTools.create({
      gatewayId: gateway.id,
      toolId: tool.id,
      isActive: true,
    }),
  );
}

/**
 * first_call step / activation: a successful (2xx) RequestLog scoped to
 * the org. Onboarding scopes RequestLog by its gateway.organizationId OR
 * metadata->>'organizationId'; we use the metadata stamp so no gateway
 * plumbing is required for the activated scenarios.
 */
async function seedSuccessfulCall(r: Repos, orgId: string): Promise<void> {
  await r.logs.save(
    r.logs.create({
      method: 'POST',
      path: '/lc-test/activation',
      statusCode: 200,
      responseTime: 5,
      timestamp: new Date(),
      metadata: { organizationId: orgId },
    } as any),
  );
}

// ── Assertion + one scenario runner ──────────────────────────────────────────

async function lifecycleState(
  r: Repos,
  userId: string,
): Promise<Record<string, any>> {
  const fresh = await r.users.findOne({ where: { id: userId } });
  return (fresh?.preferences?.lifecycle as Record<string, any>) ?? {};
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const base = assertSafeToRun();

  console.log('[lifecycle-staging-verify] starting');
  console.log(`  DB host: ${process.env.DATABASE_HOST}`);
  console.log(`  DB name: ${process.env.DATABASE_NAME}`);
  console.log(`  base inbox (aliases derived): ${base}`);
  console.log(
    `  cadence: nudge=${process.env.LIFECYCLE_STATE_NUDGE_DAY} ` +
      `showcase=${process.env.LIFECYCLE_SHOWCASE_DAY} ` +
      `lastTouch=${process.env.LIFECYCLE_LAST_TOUCH_DAY} ` +
      `lookback=${process.env.LIFECYCLE_SWEEP_LOOKBACK_DAYS}`,
  );

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  const ds = app.get(DataSource);
  const r: Repos = {
    ds,
    users: ds.getRepository(User),
    orgs: ds.getRepository(Organization),
    userOrgs: ds.getRepository(UserOrganization),
    providers: ds.getRepository(LlmProvider),
    apis: ds.getRepository(Api),
    gateways: ds.getRepository(Gateway),
    gatewayTools: ds.getRepository(GatewayTool),
    tools: ds.getRepository(Tool),
    logs: ds.getRepository(RequestLog),
  };
  const lifecycle = app.get(LifecycleEmailService);
  const onboarding = app.get(OnboardingService);

  if (!lifecycle.isEnabled()) {
    console.error(
      '[ABORT] LifecycleEmailService.isEnabled() is false even after ' +
        'setting LIFECYCLE_EMAILS_ENABLED=true — cannot verify sends.',
    );
    await app.close();
    process.exit(1);
  }

  const results: Result[] = [];
  const emailed: string[] = [];
  const record = (res: Result) => {
    results.push(res);
    const mark = res.pass ? 'PASS' : 'FAIL';
    console.log(`  [${mark}] ${res.scenario} <${res.email}> — ${res.detail}`);
  };

  try {
    // Clean any leftovers from a previous aborted run before seeding.
    await teardown(r, /*quiet*/ true);

    // 1) welcome ────────────────────────────────────────────────────────────
    {
      const email = aliasFor(base, 'welcome');
      const { user } = await seedUser(r, 'welcome', email, 0);
      await lifecycle.sendWelcome(user.id);
      const st = await lifecycleState(r, user.id);
      emailed.push(email);
      record({
        scenario: 'welcome',
        email,
        pass: !!st.welcome,
        detail: st.welcome ? `welcome set @ ${st.welcome}` : 'welcome NOT set',
      });
    }

    // 2) nudge-provider (3d old, no provider) → stateNudge ────────────────────
    {
      const email = aliasFor(base, 'nudge-provider');
      const { user, org } = await seedUser(r, 'nudge-provider', email, 3);
      const steps = (await onboarding.getState(org.id, user.id)).steps;
      await lifecycle.runNudgeSweep();
      const st = await lifecycleState(r, user.id);
      emailed.push(email);
      record({
        scenario: 'nudge-provider',
        email,
        pass: !!st.stateNudge && steps.provider === false,
        detail:
          `stateNudge=${st.stateNudge ?? 'unset'}, ` +
          `provider-step=${steps.provider} (expected template lifecycle.nudge-provider)`,
      });
    }

    // 3) nudge-api (3d, has provider, no api) → stateNudge ────────────────────
    {
      const email = aliasFor(base, 'nudge-api');
      const { user, org } = await seedUser(r, 'nudge-api', email, 3);
      await seedProvider(r, org.id);
      const steps = (await onboarding.getState(org.id, user.id)).steps;
      await lifecycle.runNudgeSweep();
      const st = await lifecycleState(r, user.id);
      emailed.push(email);
      record({
        scenario: 'nudge-api',
        email,
        pass: !!st.stateNudge && steps.provider === true && steps.api === false,
        detail:
          `stateNudge=${st.stateNudge ?? 'unset'}, ` +
          `provider=${steps.provider} api=${steps.api} (expected lifecycle.nudge-api)`,
      });
    }

    // 4) nudge-gateway (3d, has api, no gateway) → stateNudge ─────────────────
    {
      const email = aliasFor(base, 'nudge-gateway');
      const { user, org } = await seedUser(r, 'nudge-gateway', email, 3);
      await seedProvider(r, org.id);
      await seedApi(r, org.id);
      const steps = (await onboarding.getState(org.id, user.id)).steps;
      await lifecycle.runNudgeSweep();
      const st = await lifecycleState(r, user.id);
      emailed.push(email);
      record({
        scenario: 'nudge-gateway',
        email,
        pass:
          !!st.stateNudge && steps.api === true && steps.gateway === false,
        detail:
          `stateNudge=${st.stateNudge ?? 'unset'}, ` +
          `api=${steps.api} gateway=${steps.gateway} (expected lifecycle.nudge-gateway)`,
      });
    }

    // 5) nudge-first-call (3d, gateway+tool, no RequestLog) → stateNudge ──────
    {
      const email = aliasFor(base, 'nudge-first-call');
      const { user, org } = await seedUser(r, 'nudge-first-call', email, 3);
      await seedProvider(r, org.id);
      await seedApi(r, org.id);
      await seedGatewayWithTool(r, org.id);
      const steps = (await onboarding.getState(org.id, user.id)).steps;
      await lifecycle.runNudgeSweep();
      const st = await lifecycleState(r, user.id);
      emailed.push(email);
      record({
        scenario: 'nudge-first-call',
        email,
        pass:
          !!st.stateNudge &&
          steps.gateway === true &&
          steps.first_call === false,
        detail:
          `stateNudge=${st.stateNudge ?? 'unset'}, ` +
          `gateway=${steps.gateway} first_call=${steps.first_call} ` +
          `(expected lifecycle.nudge-first-call)`,
      });
    }

    // 6) showcase (6d old, not activated) → showcase ─────────────────────────
    {
      const email = aliasFor(base, 'showcase');
      const { user, org } = await seedUser(r, 'showcase', email, 6);
      const steps = (await onboarding.getState(org.id, user.id)).steps;
      await lifecycle.runNudgeSweep();
      const st = await lifecycleState(r, user.id);
      emailed.push(email);
      record({
        scenario: 'showcase',
        email,
        pass: !!st.showcase && steps.first_call === false,
        detail: st.showcase ? `showcase set @ ${st.showcase}` : 'showcase NOT set',
      });
    }

    // 7) last-touch (11d old, not activated) → lastTouch ─────────────────────
    {
      const email = aliasFor(base, 'last-touch');
      const { user, org } = await seedUser(r, 'last-touch', email, 11);
      const steps = (await onboarding.getState(org.id, user.id)).steps;
      await lifecycle.runNudgeSweep();
      const st = await lifecycleState(r, user.id);
      emailed.push(email);
      record({
        scenario: 'last-touch',
        email,
        pass: !!st.lastTouch && steps.first_call === false,
        detail: st.lastTouch
          ? `lastTouch set @ ${st.lastTouch}`
          : 'lastTouch NOT set',
      });
    }

    // 8) congrats (activated: has 2xx RequestLog) → activatedCongrats, NO nudge
    {
      const email = aliasFor(base, 'congrats');
      const { user, org } = await seedUser(r, 'congrats', email, 3);
      await seedSuccessfulCall(r, org.id);
      const steps = (await onboarding.getState(org.id, user.id)).steps;
      await lifecycle.runNudgeSweep();
      const st = await lifecycleState(r, user.id);
      emailed.push(email);
      record({
        scenario: 'congrats',
        email,
        pass: !!st.activatedCongrats && !st.stateNudge && steps.first_call === true,
        detail:
          `activatedCongrats=${st.activatedCongrats ?? 'unset'}, ` +
          `stateNudge=${st.stateNudge ?? 'unset (expected)'} first_call=${steps.first_call}`,
      });
    }

    // 9) opt-out (3d, no provider, optOut=true) → NOTHING set ─────────────────
    {
      const email = aliasFor(base, 'opt-out');
      const { user } = await seedUser(r, 'opt-out', email, 3, {
        optOut: true,
      });
      await lifecycle.runNudgeSweep();
      const st = await lifecycleState(r, user.id);
      // opted out → no send markers; only optOut itself present.
      const sendKeys = Object.keys(st).filter((k) => k !== 'optOut');
      record({
        scenario: 'opt-out',
        email,
        pass: st.optOut === true && sendKeys.length === 0,
        detail:
          sendKeys.length === 0
            ? 'no send markers written (opt-out honored)'
            : `unexpected markers: ${sendKeys.join(', ')}`,
      });
      // Not pushed to `emailed`: opt-out must not send.
    }

    // 10) dedupe (provider scenario swept TWICE) → 2nd run sets nothing new ────
    {
      const email = aliasFor(base, 'dedupe');
      const { user } = await seedUser(r, 'dedupe', email, 3);
      await lifecycle.runNudgeSweep();
      const first = await lifecycleState(r, user.id);
      const firstStamp = first.stateNudge;
      const secondResult = await lifecycle.runNudgeSweep();
      const second = await lifecycleState(r, user.id);
      emailed.push(email); // first run legitimately emails once
      const unchanged =
        !!firstStamp && second.stateNudge === firstStamp;
      record({
        scenario: 'dedupe',
        email,
        pass: unchanged,
        detail: unchanged
          ? `stateNudge stable across 2 sweeps (@ ${firstStamp}); ` +
            `2nd sweep sent=${secondResult.sent}`
          : `marker changed on 2nd sweep: ${firstStamp} -> ${second.stateNudge}`,
      });
    }
  } finally {
    // Teardown ALWAYS, even on assertion/throw above.
    const cleaned = await teardown(r, /*quiet*/ false);
    console.log(
      `[cleanup] removed ${cleaned.users} users, ${cleaned.orgs} orgs, ` +
        `${cleaned.providers} providers, ${cleaned.apis} apis, ` +
        `${cleaned.gateways} gateways, ${cleaned.tools} tools, ` +
        `${cleaned.logs} request logs`,
    );
    await app.close();
  }

  // Summary ──────────────────────────────────────────────────────────────────
  const passed = results.filter((x) => x.pass).length;
  console.log('\n──────────── SUMMARY ────────────');
  console.log(`  ${passed}/${results.length} scenarios PASSED`);
  if (emailed.length) {
    console.log('\n  Emails dispatched via Resend (eyeball rendering):');
    for (const e of emailed) console.log(`    - ${e}`);
  }
  console.log('─────────────────────────────────\n');

  process.exit(passed === results.length ? 0 : 1);
}

// ── Teardown ─────────────────────────────────────────────────────────────────

interface CleanupCounts {
  users: number;
  orgs: number;
  providers: number;
  apis: number;
  gateways: number;
  tools: number;
  logs: number;
}

/**
 * Delete every row this harness could have created, matched by the
 * plus-alias email prefix (users) and their org ids (everything else).
 * Order respects FK dependencies. Uses raw SQL so it is robust to
 * TypeORM cascade config and works even after a partial run.
 */
async function teardown(r: Repos, quiet: boolean): Promise<CleanupCounts> {
  const counts: CleanupCounts = {
    users: 0,
    orgs: 0,
    providers: 0,
    apis: 0,
    gateways: 0,
    tools: 0,
    logs: 0,
  };

  // Users created by the harness, by email marker.
  const users: Array<{ id: string }> = await r.ds.query(
    `SELECT id FROM users WHERE email LIKE $1`,
    [EMAIL_LIKE],
  );
  const userIds = users.map((u) => u.id);

  // Their orgs (via membership).
  let orgIds: string[] = [];
  if (userIds.length) {
    const orgs: Array<{ organizationId: string }> = await r.ds.query(
      `SELECT DISTINCT "organizationId" FROM user_organizations WHERE "userId" = ANY($1)`,
      [userIds],
    );
    orgIds = orgs.map((o) => o.organizationId);
  }

  // Also catch orgs by slug marker (covers any org whose membership row
  // was already gone but the org lingered from a crash mid-run).
  const orgBySlug: Array<{ id: string }> = await r.ds.query(
    `SELECT id FROM organizations WHERE slug LIKE $1`,
    [`lc-test-%`],
  );
  orgIds = Array.from(new Set([...orgIds, ...orgBySlug.map((o) => o.id)]));

  const del = async (sql: string, params: any[]): Promise<number> => {
    const res = await r.ds.query(sql, params);
    // node-postgres returns rowCount on the driver; TypeORM .query returns
    // the rows array for SELECT and for DELETE...RETURNING. We use RETURNING id.
    return Array.isArray(res) ? res.length : 0;
  };

  if (orgIds.length) {
    // request_logs: by metadata org stamp OR by gateway belonging to org.
    counts.logs += await del(
      `DELETE FROM request_logs
         WHERE metadata->>'organizationId' = ANY($1)
            OR "gatewayId" IN (SELECT id FROM gateways WHERE "organizationId" = ANY($1))
         RETURNING id`,
      [orgIds],
    );
    // gateway_tools join rows for these orgs' gateways.
    await del(
      `DELETE FROM gateway_tools
         WHERE "gatewayId" IN (SELECT id FROM gateways WHERE "organizationId" = ANY($1))
         RETURNING id`,
      [orgIds],
    );
    counts.gateways += await del(
      `DELETE FROM gateways WHERE "organizationId" = ANY($1) RETURNING id`,
      [orgIds],
    );
    counts.tools += await del(
      `DELETE FROM tools WHERE "organizationId" = ANY($1) RETURNING id`,
      [orgIds],
    );
    counts.providers += await del(
      `DELETE FROM llm_providers WHERE "organizationId" = ANY($1) RETURNING id`,
      [orgIds],
    );
    counts.apis += await del(
      `DELETE FROM apis WHERE "organizationId" = ANY($1) RETURNING id`,
      [orgIds],
    );
  }

  if (userIds.length) {
    await del(
      `DELETE FROM user_organizations WHERE "userId" = ANY($1) RETURNING id`,
      [userIds],
    );
    counts.users += await del(
      `DELETE FROM users WHERE id = ANY($1) RETURNING id`,
      [userIds],
    );
  }

  if (orgIds.length) {
    counts.orgs += await del(
      `DELETE FROM organizations WHERE id = ANY($1) RETURNING id`,
      [orgIds],
    );
  }

  if (!quiet) {
    // Summary printed by caller.
  }
  return counts;
}

main().catch((err) => {
  console.error('[lifecycle-staging-verify] fatal error:', err);
  process.exit(1);
});
