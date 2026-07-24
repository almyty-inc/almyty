/**
 * Lifecycle-email STAGING verification harness.
 *
 * Seeds throwaway verified users into a *staging* database, drives the
 * real LifecycleEmailService against real onboarding state, and verifies
 * each scenario across THREE layers:
 *   1. logic        — the expected `preferences.lifecycle.*` marker was
 *                     written (the service decided to send).
 *   2. local-render — renderEmailTemplate() output for that template
 *                     carries the expected subject/CTA copy + the
 *                     unsubscribe URL and contains no em-dash. Always
 *                     runs; pure, no network.
 *   3. resend       — the message id captured from MailService's recent-
 *                     sends buffer is looked up via the Resend API
 *                     (GET https://api.resend.com/emails/{id}): HTTP 200,
 *                     delivery state not bounced/failed/complained, and
 *                     the stored html carries the same copy + unsubscribe
 *                     URL + no em-dash. SKIPPED when RESEND_API_KEY unset.
 *
 * Emails DO send for real via Resend to plus-aliases of a single inbox you
 * control, so a human can also eyeball the rendering.
 *
 * NETWORK: layer 3 needs egress to api.resend.com from wherever this runs
 * (e.g. the staging pod). Without a key / egress, layers 1+2 still run.
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
import { MailService } from '../modules/mail/mail.service';
import { renderEmailTemplate } from '../modules/mail/email-templates';

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

/** Outcome of one verification layer. status 'skip' = not applicable/no key. */
interface LayerResult {
  status: 'pass' | 'fail' | 'skip';
  detail: string;
}

interface Result {
  scenario: string;
  email: string;
  /** Layer 1: the expected preferences.lifecycle key was written. */
  logic: LayerResult;
  /** Layer 2: local renderEmailTemplate() html has the right copy. */
  localRender: LayerResult;
  /** Layer 3: Resend accepted + rendered the message (network). */
  resend: LayerResult;
}

/** A scenario passes overall when no layer failed (skips are OK). */
function overallPass(r: Result): boolean {
  return (
    r.logic.status !== 'fail' &&
    r.localRender.status !== 'fail' &&
    r.resend.status !== 'fail' &&
    // logic must actively pass; render/resend may legitimately skip.
    r.logic.status === 'pass'
  );
}

const EM_DASH = '—'; // — : templates deliberately use commas, never this.

/**
 * Per-template rendering expectations. `subject` and every `markers`
 * entry must appear verbatim in the rendered output; the unsubscribe URL
 * (passed in params) must appear too, and the html must contain no
 * em-dash. Copy pulled from email-templates.ts so a copy edit that drops
 * a CTA is caught here.
 */
const TEMPLATE_EXPECT: Record<
  string,
  { subject: string; markers: string[] }
> = {
  'lifecycle.welcome': {
    subject: 'Your first agent is minutes away on almyty',
    markers: ['Welcome to almyty', 'Open your dashboard'],
  },
  'lifecycle.nudge-provider': {
    subject: 'Connect a model and almyty comes alive',
    markers: ['Add a model provider', 'Ollama'],
  },
  'lifecycle.nudge-api': {
    subject: 'Turn any API into agent tools on almyty',
    markers: ['Import an API', 'OpenAPI'],
  },
  'lifecycle.nudge-gateway': {
    subject: 'Publish a gateway and your tools go live',
    markers: ['Publish a gateway', 'callable tools'],
  },
  'lifecycle.nudge-first-call': {
    subject: 'Give Claude your API in one command',
    markers: ['Make your first call', 'claude mcp add'],
  },
  'lifecycle.example-showcase': {
    subject: 'Give Claude your API in about five minutes',
    markers: ['Try the five-minute path', 'five-minute'],
  },
  'lifecycle.last-touch': {
    subject: 'What people build on almyty (last note)',
    markers: ['See what you can build', 'final almyty setup email'],
  },
  'lifecycle.activated-congrats': {
    subject: 'Your first agent call landed on almyty',
    markers: ['you are live', 'Explore what is next'],
  },
};

/**
 * Layer 2 — local render. Renders the template with the same params the
 * service uses and asserts subject + copy markers + unsubscribe URL are
 * present and no em-dash appears. Pure, no network.
 */
function checkLocalRender(
  templateKey: string,
  params: { firstName?: string; appUrl: string; unsubscribeUrl: string },
): LayerResult {
  const expect = TEMPLATE_EXPECT[templateKey];
  if (!expect) {
    return { status: 'fail', detail: `no expectation for ${templateKey}` };
  }
  const rendered = renderEmailTemplate(templateKey, params);
  const problems: string[] = [];

  if (!rendered.subject.includes(expect.subject)) {
    problems.push(`subject missing "${expect.subject}"`);
  }
  for (const m of expect.markers) {
    if (!rendered.html.includes(m)) problems.push(`html missing "${m}"`);
  }
  if (!rendered.html.includes(params.unsubscribeUrl)) {
    problems.push('html missing unsubscribe URL');
  }
  if (rendered.html.includes(EM_DASH)) {
    problems.push('html contains an em-dash');
  }

  return problems.length === 0
    ? { status: 'pass', detail: `${templateKey} rendered OK` }
    : { status: 'fail', detail: `${templateKey}: ${problems.join('; ')}` };
}

/**
 * Layer 3 — Resend delivery + rendered content. Looks up the message by
 * id via the Resend API and asserts it was accepted (HTTP 200), not
 * bounced/failed/complained, and its stored html carries the expected
 * copy + unsubscribe URL + no em-dash. Skips (no fail) when unset key.
 */
async function checkResendDelivery(
  id: string | null,
  templateKey: string,
  unsubscribeUrl: string,
  apiKey: string | undefined,
): Promise<LayerResult> {
  if (!apiKey) {
    return { status: 'skip', detail: 'RESEND_API_KEY unset' };
  }
  if (!id) {
    return {
      status: 'fail',
      detail: 'no Resend message id captured for this send',
    };
  }

  let res: Response;
  try {
    res = await fetch(`https://api.resend.com/emails/${id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (err: any) {
    return { status: 'fail', detail: `Resend fetch error: ${err?.message}` };
  }

  if (res.status !== 200) {
    return { status: 'fail', detail: `Resend GET returned HTTP ${res.status}` };
  }

  const body: any = await res.json().catch(() => ({}));
  const problems: string[] = [];

  // Resend returns last_event (e.g. delivered/bounced) and/or a status.
  const state = String(body.last_event ?? body.status ?? '').toLowerCase();
  if (['bounced', 'failed', 'complained'].includes(state)) {
    problems.push(`delivery state is "${state}"`);
  }

  const html = String(body.html ?? '');
  const expect = TEMPLATE_EXPECT[templateKey];
  if (expect) {
    for (const m of expect.markers) {
      if (!html.includes(m)) problems.push(`resend html missing "${m}"`);
    }
  }
  if (unsubscribeUrl && !html.includes(unsubscribeUrl)) {
    problems.push('resend html missing unsubscribe URL');
  }
  if (html.includes(EM_DASH)) {
    problems.push('resend html contains an em-dash');
  }

  return problems.length === 0
    ? {
        status: 'pass',
        detail: `Resend id ${id} state="${state || 'accepted'}" render OK`,
      }
    : { status: 'fail', detail: `id ${id}: ${problems.join('; ')}` };
}

/**
 * Find the most recent send whose recipient matches `email` and return
 * its Resend id (may be null on the dev/no-key path). Reads the live
 * MailService buffer; the harness drains between scenarios so at most the
 * current scenario's sends are present.
 */
function idForRecipient(
  sends: { to: string; id: string | null }[],
  email: string,
): { found: boolean; id: string | null } {
  const matches = sends.filter((s) => s.to === email);
  if (matches.length === 0) return { found: false, id: null };
  return { found: true, id: matches[matches.length - 1].id };
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

  // Never run against prod. On this infra all envs share ONE managed DB
  // server (apifai-db-…) with separate databases per env (staging=apifai,
  // prod=almyty, dev=almyty_dev), so a host substring can't distinguish
  // them — we hard-block the prod database name explicitly, plus any
  // prod-ish token anywhere.
  const prodish = [host, name].some(
    (v) => v.includes('prod') || v.includes('production'),
  );
  if (prodish || name === 'almyty') {
    problems.push(
      `DATABASE looks like prod (host="${host}", name="${name}") — hard abort`,
    );
  }

  // Accept only a clearly-staging name, OR an explicit operator confirmation
  // of the exact DB being targeted: STAGING_TEST_DB must equal DATABASE_NAME.
  // This forces the runner to name the non-prod DB on purpose.
  const looksStaging = host.includes('staging') || name.includes('staging');
  const confirmedDb = (process.env.STAGING_TEST_DB ?? '').trim().toLowerCase();
  if (!looksStaging && confirmedDb !== name) {
    problems.push(
      `DATABASE_NAME "${name}" is not obviously staging — set ` +
        `STAGING_TEST_DB=${name} to confirm you are targeting the intended ` +
        `non-prod DB (refusing to touch a possibly-prod DB otherwise)`,
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
  const mail = app.get(MailService);

  if (!lifecycle.isEnabled()) {
    console.error(
      '[ABORT] LifecycleEmailService.isEnabled() is false even after ' +
        'setting LIFECYCLE_EMAILS_ENABLED=true — cannot verify sends.',
    );
    await app.close();
    process.exit(1);
  }

  const apiKey = process.env.RESEND_API_KEY;
  // Mirror LifecycleEmailService.appUrl() so local-render params match the
  // service's. Kept in sync with lifecycle-email.service.ts.
  const appUrl =
    process.env.APP_URL || process.env.FRONTEND_URL || 'https://app.almyty.com';

  const results: Result[] = [];
  const emailed: string[] = [];

  const record = (res: Result) => {
    results.push(res);
    const cell = (l: LayerResult) =>
      l.status === 'pass' ? 'PASS' : l.status === 'skip' ? 'SKIP' : 'FAIL';
    const overall = overallPass(res) ? 'PASS' : 'FAIL';
    console.log(
      `  [${overall}] ${res.scenario} <${res.email}>\n` +
        `        logic=${cell(res.logic)} (${res.logic.detail})\n` +
        `        local-render=${cell(res.localRender)} (${res.localRender.detail})\n` +
        `        resend=${cell(res.resend)} (${res.resend.detail})`,
    );
  };

  /**
   * Shared layer-2 + layer-3 verification for a scenario that SHOULD have
   * sent `templateKey` to `email` for user `userId`. Drains the mail
   * buffer, matches the send, runs local render + Resend checks. Callers
   * still compute the layer-1 (prefs key) result themselves.
   */
  const verifySend = async (
    userId: string,
    email: string,
    templateKey: string,
  ): Promise<{ localRender: LayerResult; resend: LayerResult }> => {
    const params = {
      firstName: 'Lifecycle',
      appUrl,
      unsubscribeUrl: lifecycle.unsubscribeUrl(userId),
    };
    const localRender = checkLocalRender(templateKey, params);

    const sends = mail.drainRecentSends();
    const { found, id } = idForRecipient(sends, email);
    if (!found) {
      return {
        localRender,
        resend: {
          status: 'fail',
          detail: `no send recorded to ${email} (expected ${templateKey})`,
        },
      };
    }
    emailed.push(email);
    const resend = await checkResendDelivery(
      id,
      templateKey,
      params.unsubscribeUrl,
      apiKey,
    );
    return { localRender, resend };
  };

  /** For scenarios that must NOT send: assert the buffer is empty. */
  const skipSendLayers = (
    reason: string,
  ): { localRender: LayerResult; resend: LayerResult } => {
    mail.drainRecentSends();
    return {
      localRender: { status: 'skip', detail: reason },
      resend: { status: 'skip', detail: reason },
    };
  };

  try {
    // Clean any leftovers from a previous aborted run before seeding.
    await teardown(r, /*quiet*/ true);
    mail.drainRecentSends(); // start from a clean buffer

    // 1) welcome ────────────────────────────────────────────────────────────
    {
      const email = aliasFor(base, 'welcome');
      const { user } = await seedUser(r, 'welcome', email, 0);
      await lifecycle.sendWelcome(user.id);
      const st = await lifecycleState(r, user.id);
      const { localRender, resend } = await verifySend(
        user.id,
        email,
        'lifecycle.welcome',
      );
      record({
        scenario: 'welcome',
        email,
        logic: {
          status: st.welcome ? 'pass' : 'fail',
          detail: st.welcome ? `welcome set @ ${st.welcome}` : 'welcome NOT set',
        },
        localRender,
        resend,
      });
    }

    // 2) nudge-provider (3d old, no provider) → stateNudge ────────────────────
    {
      const email = aliasFor(base, 'nudge-provider');
      const { user, org } = await seedUser(r, 'nudge-provider', email, 3);
      const steps = (await onboarding.getState(org.id, user.id)).steps;
      await lifecycle.runNudgeSweep();
      const st = await lifecycleState(r, user.id);
      const { localRender, resend } = await verifySend(
        user.id,
        email,
        'lifecycle.nudge-provider',
      );
      record({
        scenario: 'nudge-provider',
        email,
        logic: {
          status: !!st.stateNudge && steps.provider === false ? 'pass' : 'fail',
          detail:
            `stateNudge=${st.stateNudge ?? 'unset'}, provider-step=${steps.provider} ` +
            `(expected lifecycle.nudge-provider)`,
        },
        localRender,
        resend,
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
      const { localRender, resend } = await verifySend(
        user.id,
        email,
        'lifecycle.nudge-api',
      );
      record({
        scenario: 'nudge-api',
        email,
        logic: {
          status:
            !!st.stateNudge && steps.provider === true && steps.api === false
              ? 'pass'
              : 'fail',
          detail:
            `stateNudge=${st.stateNudge ?? 'unset'}, provider=${steps.provider} ` +
            `api=${steps.api} (expected lifecycle.nudge-api)`,
        },
        localRender,
        resend,
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
      const { localRender, resend } = await verifySend(
        user.id,
        email,
        'lifecycle.nudge-gateway',
      );
      record({
        scenario: 'nudge-gateway',
        email,
        logic: {
          status:
            !!st.stateNudge && steps.api === true && steps.gateway === false
              ? 'pass'
              : 'fail',
          detail:
            `stateNudge=${st.stateNudge ?? 'unset'}, api=${steps.api} ` +
            `gateway=${steps.gateway} (expected lifecycle.nudge-gateway)`,
        },
        localRender,
        resend,
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
      const { localRender, resend } = await verifySend(
        user.id,
        email,
        'lifecycle.nudge-first-call',
      );
      record({
        scenario: 'nudge-first-call',
        email,
        logic: {
          status:
            !!st.stateNudge &&
            steps.gateway === true &&
            steps.first_call === false
              ? 'pass'
              : 'fail',
          detail:
            `stateNudge=${st.stateNudge ?? 'unset'}, gateway=${steps.gateway} ` +
            `first_call=${steps.first_call} (expected lifecycle.nudge-first-call)`,
        },
        localRender,
        resend,
      });
    }

    // 6) showcase (6d old, not activated) → showcase ─────────────────────────
    {
      const email = aliasFor(base, 'showcase');
      const { user, org } = await seedUser(r, 'showcase', email, 6);
      const steps = (await onboarding.getState(org.id, user.id)).steps;
      await lifecycle.runNudgeSweep();
      const st = await lifecycleState(r, user.id);
      const { localRender, resend } = await verifySend(
        user.id,
        email,
        'lifecycle.example-showcase',
      );
      record({
        scenario: 'showcase',
        email,
        logic: {
          status: !!st.showcase && steps.first_call === false ? 'pass' : 'fail',
          detail: st.showcase ? `showcase set @ ${st.showcase}` : 'showcase NOT set',
        },
        localRender,
        resend,
      });
    }

    // 7) last-touch (11d old, not activated) → lastTouch ─────────────────────
    {
      const email = aliasFor(base, 'last-touch');
      const { user, org } = await seedUser(r, 'last-touch', email, 11);
      const steps = (await onboarding.getState(org.id, user.id)).steps;
      await lifecycle.runNudgeSweep();
      const st = await lifecycleState(r, user.id);
      const { localRender, resend } = await verifySend(
        user.id,
        email,
        'lifecycle.last-touch',
      );
      record({
        scenario: 'last-touch',
        email,
        logic: {
          status: !!st.lastTouch && steps.first_call === false ? 'pass' : 'fail',
          detail: st.lastTouch
            ? `lastTouch set @ ${st.lastTouch}`
            : 'lastTouch NOT set',
        },
        localRender,
        resend,
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
      const { localRender, resend } = await verifySend(
        user.id,
        email,
        'lifecycle.activated-congrats',
      );
      record({
        scenario: 'congrats',
        email,
        logic: {
          status:
            !!st.activatedCongrats && !st.stateNudge && steps.first_call === true
              ? 'pass'
              : 'fail',
          detail:
            `activatedCongrats=${st.activatedCongrats ?? 'unset'}, ` +
            `stateNudge=${st.stateNudge ?? 'unset (expected)'} first_call=${steps.first_call}`,
        },
        localRender,
        resend,
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
      const sends = mail.drainRecentSends();
      const sentToUser = sends.some((s) => s.to === email);
      record({
        scenario: 'opt-out',
        email,
        logic: {
          status:
            st.optOut === true && sendKeys.length === 0 && !sentToUser
              ? 'pass'
              : 'fail',
          detail:
            sendKeys.length === 0 && !sentToUser
              ? 'no send markers written and no email dispatched (opt-out honored)'
              : `unexpected markers: ${sendKeys.join(', ')}; sent=${sentToUser}`,
        },
        // Nothing should have been sent, so render/resend are N/A.
        localRender: { status: 'skip', detail: 'no send expected (opt-out)' },
        resend: { status: 'skip', detail: 'no send expected (opt-out)' },
      });
    }

    // 10) dedupe (provider scenario swept TWICE) → 2nd run sets nothing new ────
    {
      const email = aliasFor(base, 'dedupe');
      const { user } = await seedUser(r, 'dedupe', email, 3);
      await lifecycle.runNudgeSweep();
      const first = await lifecycleState(r, user.id);
      const firstStamp = first.stateNudge;
      // First sweep sent one email; verify it before the 2nd sweep so the
      // buffer is scoped to run #1.
      const firstVerify = await verifySend(
        user.id,
        email,
        'lifecycle.nudge-provider',
      );
      const secondResult = await lifecycle.runNudgeSweep();
      const second = await lifecycleState(r, user.id);
      const secondSends = mail.drainRecentSends();
      const secondSent = secondSends.some((s) => s.to === email);
      const unchanged =
        !!firstStamp && second.stateNudge === firstStamp && !secondSent;
      record({
        scenario: 'dedupe',
        email,
        logic: {
          status: unchanged ? 'pass' : 'fail',
          detail: unchanged
            ? `stateNudge stable across 2 sweeps (@ ${firstStamp}); ` +
              `2nd sweep sent=${secondResult.sent}, 2nd email dispatched=${secondSent}`
            : `changed on 2nd sweep: marker ${firstStamp} -> ${second.stateNudge}, ` +
              `2nd email dispatched=${secondSent}`,
        },
        // Layer 2/3 validate the single legit first-run send.
        localRender: firstVerify.localRender,
        resend: firstVerify.resend,
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
  const passed = results.filter(overallPass).length;
  const layerTally = (pick: (r: Result) => LayerResult) => {
    const p = results.filter((r) => pick(r).status === 'pass').length;
    const f = results.filter((r) => pick(r).status === 'fail').length;
    const s = results.filter((r) => pick(r).status === 'skip').length;
    return `pass=${p} fail=${f} skip=${s}`;
  };
  console.log('\n──────────── SUMMARY ────────────');
  console.log(`  ${passed}/${results.length} scenarios PASSED`);
  console.log(`  logic:        ${layerTally((r) => r.logic)}`);
  console.log(`  local-render: ${layerTally((r) => r.localRender)}`);
  console.log(`  resend:       ${layerTally((r) => r.resend)}`);
  if (!apiKey) {
    console.log(
      '  (resend layer SKIPPED: RESEND_API_KEY unset — layers 1+2 still ran)',
    );
  }
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
      `SELECT DISTINCT "organizationId" FROM user_organizations WHERE "userId" = ANY($1::uuid[])`,
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
            OR "gatewayId" IN (SELECT id FROM gateways WHERE "organizationId" = ANY($1::uuid[]))
         RETURNING id`,
      [orgIds],
    );
    // gateway_tools join rows for these orgs' gateways.
    await del(
      `DELETE FROM gateway_tools
         WHERE "gatewayId" IN (SELECT id FROM gateways WHERE "organizationId" = ANY($1::uuid[]))
         RETURNING id`,
      [orgIds],
    );
    counts.gateways += await del(
      `DELETE FROM gateways WHERE "organizationId" = ANY($1::uuid[]) RETURNING id`,
      [orgIds],
    );
    counts.tools += await del(
      `DELETE FROM tools WHERE "organizationId" = ANY($1::uuid[]) RETURNING id`,
      [orgIds],
    );
    counts.providers += await del(
      `DELETE FROM llm_providers WHERE "organizationId" = ANY($1::uuid[]) RETURNING id`,
      [orgIds],
    );
    counts.apis += await del(
      `DELETE FROM apis WHERE "organizationId" = ANY($1::uuid[]) RETURNING id`,
      [orgIds],
    );
  }

  if (userIds.length) {
    await del(
      `DELETE FROM user_organizations WHERE "userId" = ANY($1::uuid[]) RETURNING id`,
      [userIds],
    );
    counts.users += await del(
      `DELETE FROM users WHERE id = ANY($1::uuid[]) RETURNING id`,
      [userIds],
    );
  }

  if (orgIds.length) {
    counts.orgs += await del(
      `DELETE FROM organizations WHERE id = ANY($1::uuid[]) RETURNING id`,
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
