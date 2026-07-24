/**
 * Branded transactional email templates.
 *
 * One shared base layout (inline CSS only — no external assets, fonts,
 * or images, so the emails render identically in every client and pass
 * strict CSPs/proxies) plus one content template per notification event
 * type. Every render produces both an HTML part and a plain-text
 * alternative part.
 *
 * All user-supplied values are HTML-escaped before interpolation (see
 * the stored-XSS note on MailService.escapeHtml — an inviter named
 * `<a href="http://evil">…</a>` must not rewrite the email body).
 */

const BRAND_PRIMARY = '#7C3AED'; // violet-600 (light backgrounds)
const TEXT_MAIN = '#18181b';
const TEXT_MUTED = '#71717a';
const TEXT_FAINT = '#a1a1aa';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface BaseLayoutInput {
  /** Main heading under the wordmark. Already-escaped HTML is NOT expected — pass plain text. */
  heading: string;
  /** Pre-escaped HTML paragraphs (use esc() on any user-supplied value). */
  bodyHtml: string;
  /** Optional call-to-action button. */
  button?: { label: string; url: string };
  /** Small print under the body (plain text, will be escaped). */
  footerNote?: string;
  /** Organization the email relates to — shown in the footer (plain text, escaped). */
  orgName?: string;
}

export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
}

const esc = escapeHtml;

/** Strip CR/LF so interpolated values can't break the Subject header. */
export function sanitizeSubject(value: string): string {
  return String(value).replace(/[\r\n]+/g, ' ');
}

/** Collapse newlines in plain-text parts (MIME-boundary defense). */
function flattenText(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

export function renderBaseLayout(input: BaseLayoutInput): string {
  const button = input.button
    ? `
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 28px 0;">
            <tr>
              <td style="border-radius: 8px; background: ${BRAND_PRIMARY};">
                <a href="${esc(input.button.url)}"
                   style="display: inline-block; padding: 12px 32px; font-size: 15px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 8px;">
                  ${esc(input.button.label)}
                </a>
              </td>
            </tr>
          </table>`
    : '';

  const footerNote = input.footerNote
    ? `
          <p style="font-size: 13px; line-height: 20px; color: ${TEXT_MUTED}; margin: 24px 0 0;">
            ${esc(input.footerNote)}
          </p>`
    : '';

  const orgLine = input.orgName
    ? `<p style="font-size: 12px; color: ${TEXT_FAINT}; margin: 4px 0 0;">Sent for ${esc(input.orgName)}</p>`
    : '';

  return `
  <div style="background: #fafafa; padding: 32px 16px;">
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; max-width: 520px; margin: 0 auto;">
      <div style="background: #ffffff; border: 1px solid #e4e4e7; border-radius: 12px; padding: 40px 36px;">
        <div style="font-size: 20px; font-weight: 800; letter-spacing: -0.5px; color: ${BRAND_PRIMARY}; margin: 0 0 28px;">almyty</div>
        <h1 style="font-size: 20px; line-height: 28px; font-weight: 700; color: ${TEXT_MAIN}; margin: 0 0 16px;">
          ${esc(input.heading)}
        </h1>
        <div style="font-size: 15px; line-height: 24px; color: ${TEXT_MAIN};">
          ${input.bodyHtml}
        </div>
        ${button}
        ${footerNote}
      </div>
      <div style="text-align: center; padding: 20px 8px 0;">
        <p style="font-size: 12px; color: ${TEXT_FAINT}; margin: 0;">almyty: the full-stack platform for AI agents</p>
        ${orgLine}
      </div>
    </div>
  </div>`;
}

type TemplateRenderer = (params: Record<string, any>) => RenderedEmail;

function para(html: string): string {
  return `<p style="margin: 0 0 12px;">${html}</p>`;
}

/**
 * Per-event content templates. Keys are the notification event types
 * plus the standalone transactional flows. Params are template-specific;
 * unknown params are ignored, missing ones degrade to generic wording.
 */
const TEMPLATES: Record<string, TemplateRenderer> = {
  'invite.received': (p) => {
    const inviter = p.inviterName || 'A team member';
    const org = p.organizationName || 'an organization';
    const role = p.role || 'member';
    return {
      subject: sanitizeSubject(`You're invited to ${org} on almyty`),
      html: renderBaseLayout({
        heading: `Join ${org} on almyty`,
        bodyHtml: para(
          `<strong>${esc(inviter)}</strong> invited you to join <strong>${esc(org)}</strong> as <strong>${esc(role)}</strong>.`,
        ),
        button: { label: p.isNewUser ? 'Create account and join' : 'Accept invitation', url: p.acceptUrl },
        footerNote: "This invitation expires in 7 days. If you didn't expect this, you can ignore it.",
        orgName: org,
      }),
      text: flattenText(
        `${inviter} invited you to join ${org} as ${role}. Accept: ${p.acceptUrl} (expires in 7 days).`,
      ),
    };
  },

  'account.password_reset': (p) => ({
    subject: 'Reset your almyty password',
    html: renderBaseLayout({
      heading: 'Reset your password',
      bodyHtml: para('We received a request to reset your password. Click below to choose a new one.'),
      button: { label: 'Reset password', url: p.resetUrl },
      footerNote: "This link expires in 1 hour. If you didn't request a reset, you can safely ignore this email.",
    }),
    text: flattenText(
      `Reset your almyty password: ${p.resetUrl} (expires in 1 hour). If you didn't request this, ignore this email.`,
    ),
  }),

  'account.verify_email': (p) => ({
    subject: 'Verify your email for almyty',
    html: renderBaseLayout({
      heading: 'Verify your email address',
      bodyHtml: para(
        `${p.firstName ? `Hi ${esc(p.firstName)}, ` : ''}please confirm this email address so we know it's really you.`,
      ),
      button: { label: 'Verify email', url: p.verifyUrl },
      footerNote:
        "This link expires in 7 days. You can keep using almyty while unverified, but some features (like referral rewards) require a verified email.",
    }),
    text: flattenText(
      `Verify your almyty email: ${p.verifyUrl} (expires in 7 days).`,
    ),
  }),

  'account.welcome': (p) => ({
    subject: 'Welcome to almyty',
    html: renderBaseLayout({
      heading: `Welcome to almyty${p.firstName ? `, ${esc(p.firstName)}` : ''}`,
      bodyHtml:
        para(
          `Your organization <strong>${esc(p.organizationName || 'your workspace')}</strong> is ready. Connect an API, generate tools, and build your first agent in minutes.`,
        ) +
        para('If you get stuck, the in-app docs cover every step from schema import to agent deployment.'),
      button: { label: 'Open your dashboard', url: p.dashboardUrl },
      orgName: p.organizationName,
    }),
    text: flattenText(
      `Welcome to almyty. Your organization ${p.organizationName || ''} is ready: ${p.dashboardUrl}`,
    ),
  }),

  'approval.pending': (p) => ({
    subject: sanitizeSubject(`Approval needed${p.agentName ? `: ${p.agentName}` : ''} on almyty`),
    html: renderBaseLayout({
      heading: 'An agent run is waiting for your approval',
      bodyHtml:
        para(
          `${p.agentName ? `Agent <strong>${esc(p.agentName)}</strong>` : 'An agent'} paused a run and needs a decision before it can continue.`,
        ) + (p.reason ? para(`Reason: <em>${esc(p.reason)}</em>`) : ''),
      button: { label: 'Review request', url: p.approvalUrl },
      footerNote: 'The run stays paused until someone approves or rejects, or the request expires.',
      orgName: p.organizationName,
    }),
    text: flattenText(
      `Approval needed${p.agentName ? ` for agent ${p.agentName}` : ''}. Reason: ${p.reason || 'n/a'}. Review: ${p.approvalUrl}`,
    ),
  }),

  'approval.decided': (p) => {
    const outcome = p.status === 'approved' ? 'approved' : p.status === 'expired' ? 'expired' : 'rejected';
    return {
      subject: sanitizeSubject(`Your approval request was ${outcome}`),
      html: renderBaseLayout({
        heading: `Approval ${outcome}`,
        bodyHtml:
          para(
            `The approval gate on your run${p.agentName ? ` of <strong>${esc(p.agentName)}</strong>` : ''} was <strong>${esc(outcome)}</strong>${outcome === 'approved' ? ', the run is resuming' : ', the run was terminated'}.`,
          ) + (p.decisionReason ? para(`Note from the approver: <em>${esc(p.decisionReason)}</em>`) : ''),
        button: p.runUrl ? { label: 'View run', url: p.runUrl } : undefined,
        orgName: p.organizationName,
      }),
      text: flattenText(
        `Your approval request was ${outcome}${p.decisionReason ? ` (${p.decisionReason})` : ''}.${p.runUrl ? ` View: ${p.runUrl}` : ''}`,
      ),
    };
  },

  'run.failed': (p) => ({
    subject: sanitizeSubject(`Run failed: ${p.agentName || 'agent'}`),
    html: renderBaseLayout({
      heading: `A ${p.triggerType === 'webhook' ? 'webhook-triggered' : 'scheduled'} run failed`,
      bodyHtml:
        para(`Agent <strong>${esc(p.agentName || 'unknown')}</strong> failed to complete a run.`) +
        (p.error ? para(`Error: <em>${esc(String(p.error).slice(0, 500))}</em>`) : ''),
      button: p.agentUrl ? { label: 'Inspect agent', url: p.agentUrl } : undefined,
      footerNote: 'You are receiving this because run-failure emails are enabled in your notification preferences.',
      orgName: p.organizationName,
    }),
    text: flattenText(
      `Run failed for agent ${p.agentName || 'unknown'}: ${p.error || 'unknown error'}.${p.agentUrl ? ` Inspect: ${p.agentUrl}` : ''}`,
    ),
  }),

  'budget.alert': (p) => {
    const hard = p.level === 'hard';
    return {
      subject: sanitizeSubject(
        hard
          ? `almyty spend budget reached (${p.spent} of ${p.limit})`
          : `almyty spend at ${p.pct}% of budget (${p.spent} of ${p.limit})`,
      ),
      html: renderBaseLayout({
        heading: hard ? 'Spend budget reached' : `Spend at ${esc(p.pct)}% of budget`,
        bodyHtml:
          para(
            `${hard ? 'The spend budget for' : `Spend has reached ${esc(p.pct)}% of the budget for`} <strong>${esc(p.scope || 'your organization')}</strong> this ${esc(p.periodType || 'period')}.`,
          ) +
          para(
            `<strong>${esc(p.spent)}</strong> of <strong>${esc(p.limit)}</strong> used.${hard && p.behavior === 'reject' ? ' New runs are blocked until the budget resets.' : ''}`,
          ),
        button: p.budgetUrl ? { label: 'Review spend', url: p.budgetUrl } : undefined,
        orgName: p.organizationName,
      }),
      text: flattenText(
        `${hard ? 'Spend budget reached' : `Spend at ${p.pct}% of budget`}: ${p.spent} of ${p.limit} used this ${p.periodType || 'period'} for ${p.scope || 'your organization'}.${hard && p.behavior === 'reject' ? ' New runs are blocked until the budget resets.' : ''}`,
      ),
    };
  },

  'referral.qualified': (p) => ({
    subject: 'Your referral qualified, reward on the way',
    html: renderBaseLayout({
      heading: 'Your referral qualified',
      bodyHtml:
        para('Someone you referred activated their almyty workspace.') +
        (p.days
          ? para(
              `<strong>${esc(p.days)} day${Number(p.days) === 1 ? '' : 's'}</strong> of pro ${p.banked ? 'have been banked to your account (applied when you upgrade to pro)' : 'have been added to your plan'}.`,
            )
          : ''),
      button: p.referralsUrl ? { label: 'View your referrals', url: p.referralsUrl } : undefined,
      orgName: p.organizationName,
    }),
    text: flattenText(
      `Your referral qualified.${p.days ? ` ${p.days} pro day(s) ${p.banked ? 'banked' : 'applied'}.` : ''}${p.referralsUrl ? ` Details: ${p.referralsUrl}` : ''}`,
    ),
  }),

  'referral.rewarded': (p) => ({
    subject: 'Referral reward unlocked',
    html: renderBaseLayout({
      heading: 'Your referral upgraded to a paid plan',
      bodyHtml:
        para('An organization you referred converted to a paid plan. Thank you for spreading the word.') +
        (p.days
          ? para(
              `<strong>${esc(p.days)} day${Number(p.days) === 1 ? '' : 's'}</strong> of pro ${p.banked ? 'have been banked to your account' : 'have been added to your plan'}.`,
            )
          : ''),
      button: p.referralsUrl ? { label: 'View your referrals', url: p.referralsUrl } : undefined,
      orgName: p.organizationName,
    }),
    text: flattenText(
      `Referral reward unlocked.${p.days ? ` ${p.days} pro day(s) ${p.banked ? 'banked' : 'applied'}.` : ''}${p.referralsUrl ? ` Details: ${p.referralsUrl}` : ''}`,
    ),
  }),

  'security.sso_install': (p) => ({
    subject: sanitizeSubject(`Security: ${p.kind === 'channel' ? 'new channel installation' : 'SSO configuration change'} in ${p.organizationName || 'your organization'}`),
    html: renderBaseLayout({
      heading: p.kind === 'channel' ? 'New channel installation' : 'SSO configuration created',
      bodyHtml:
        para(
          p.kind === 'channel'
            ? `A chat channel integration was installed into an external workspace${p.detail ? `: <strong>${esc(p.detail)}</strong>` : ''}.`
            : `Single sign-on was configured for your organization${p.detail ? ` (<strong>${esc(p.detail)}</strong>)` : ''}.`,
        ) + para('If you or another admin made this change, no action is needed.'),
      button: p.settingsUrl ? { label: 'Review settings', url: p.settingsUrl } : undefined,
      footerNote: 'You receive security notifications because you are an organization admin.',
      orgName: p.organizationName,
    }),
    text: flattenText(
      `${p.kind === 'channel' ? 'New channel installation' : 'SSO configuration created'}${p.detail ? `: ${p.detail}` : ''}. If this was expected, no action is needed.${p.settingsUrl ? ` Review: ${p.settingsUrl}` : ''}`,
    ),
  }),

  'security.scim_deprovision': (p) => ({
    subject: sanitizeSubject(`Security: member deprovisioned via SCIM in ${p.organizationName || 'your organization'}`),
    html: renderBaseLayout({
      heading: 'Member deprovisioned via SCIM',
      bodyHtml:
        para(
          `Your identity provider deactivated <strong>${esc(p.memberEmail || 'a member')}</strong> in your organization via SCIM.`,
        ) + para('Their almyty access for this organization has been revoked.'),
      button: p.membersUrl ? { label: 'Review members', url: p.membersUrl } : undefined,
      footerNote: 'You receive security notifications because you are an organization admin.',
      orgName: p.organizationName,
    }),
    text: flattenText(
      `SCIM deprovisioned ${p.memberEmail || 'a member'} from your organization. Access revoked.${p.membersUrl ? ` Review: ${p.membersUrl}` : ''}`,
    ),
  }),

  'retention.sweep': (p) => ({
    subject: sanitizeSubject(`Data retention sweep completed for ${p.organizationName || 'your organization'}`),
    html: renderBaseLayout({
      heading: 'Retention sweep completed',
      bodyHtml:
        para(
          `Your data retention policy deleted <strong>${esc(p.totalDeleted ?? 0)}</strong> expired record${Number(p.totalDeleted) === 1 ? '' : 's'}.`,
        ) + (p.summary ? para(`Breakdown: ${esc(p.summary)}`) : ''),
      button: p.settingsUrl ? { label: 'Review retention policy', url: p.settingsUrl } : undefined,
      footerNote: 'At most one sweep summary per day is sent per organization.',
      orgName: p.organizationName,
    }),
    text: flattenText(
      `Retention sweep deleted ${p.totalDeleted ?? 0} expired records.${p.summary ? ` Breakdown: ${p.summary}.` : ''}`,
    ),
  }),

  // ── Lifecycle activation emails (new-signup cadence) ─────────────────
  // Sent by the lifecycle module: welcome on verify, a state-aware T+2
  // nudge, a T+5 showcase, a T+10 last touch, and a post-activation
  // congrats. Every one carries an unsubscribe link (params.unsubscribeUrl)
  // in the footer. `appUrl` defaults to https://app.almyty.com in the
  // service. Cadence day thresholds are exported constants in
  // lifecycle-email.service.ts.
  // MARKETING: refine copy + cadence

  // Welcome: fires on email verification. Payoff-first, CLI-forward CTA.
  // MARKETING: refine copy + cadence
  'lifecycle.welcome': (p) => ({
    subject: 'Your first agent is minutes away on almyty',
    html: renderBaseLayout({
      heading: `Welcome to almyty${p.firstName ? `, ${esc(p.firstName)}` : ''}`,
      bodyHtml:
        para(
          'almyty turns any API into tools your agents can call, served over MCP, A2A, UTCP, and Agent Skills. No glue code.',
        ) +
        para(
          'The fastest first win: connect a model, point almyty at an API, and call it from Claude Code, usually a few minutes. Install the CLI to start: <code>npm install -g @almyty/cli</code> then <code>almyty login</code>.',
        ),
      button: { label: 'Open your dashboard', url: p.appUrl },
      footerNote: `You are getting almyty setup tips because you just signed up. Not useful right now? Unsubscribe: ${p.unsubscribeUrl}`,
    }),
    text: flattenText(
      `Welcome to almyty${p.firstName ? `, ${p.firstName}` : ''}. almyty turns any API into tools your agents call over MCP, A2A, UTCP, and Agent Skills. Get started: ${p.appUrl} (CLI: npm install -g @almyty/cli, then almyty login). Unsubscribe: ${p.unsubscribeUrl}`,
    ),
  }),

  // State-aware nudge (T+2): no provider connected yet.
  // MARKETING: refine copy + cadence
  'lifecycle.nudge-provider': (p) => ({
    subject: 'Connect a model and almyty comes alive',
    html: renderBaseLayout({
      heading: `One step to a working workspace${p.firstName ? `, ${esc(p.firstName)}` : ''}`,
      bodyHtml:
        para(
          'Everything in almyty runs on a model provider. Add one and your agents can actually think: OpenAI, Anthropic, Mistral, or a local Ollama, whichever you already use.',
        ) +
        para(
          'Ollama needs no key at all, so you can be running fully local in under a minute.',
        ),
      button: { label: 'Add a model provider', url: p.appUrl },
      footerNote: `You are getting almyty setup tips because you signed up recently. Done, or not interested? Unsubscribe: ${p.unsubscribeUrl}`,
    }),
    text: flattenText(
      `Connect a model provider and almyty comes alive: OpenAI, Anthropic, Mistral, or a keyless local Ollama. Add one: ${p.appUrl}. Unsubscribe: ${p.unsubscribeUrl}`,
    ),
  }),

  // State-aware nudge (T+2): provider present but no API yet.
  // MARKETING: refine copy + cadence
  'lifecycle.nudge-api': (p) => ({
    subject: 'Turn any API into agent tools on almyty',
    html: renderBaseLayout({
      heading: 'Import an API, get tools for free',
      bodyHtml:
        para(
          'Paste an OpenAPI, GraphQL, SOAP, or Protobuf schema and almyty turns every operation into a typed tool. No code required.',
        ) +
        para(
          'No schema handy? Load the sample workspace and watch the tools appear.',
        ),
      button: { label: 'Import an API', url: p.appUrl },
      footerNote: `You are getting almyty setup tips because you signed up recently. Not for you? Unsubscribe: ${p.unsubscribeUrl}`,
    }),
    text: flattenText(
      `Paste an OpenAPI, GraphQL, SOAP, or Protobuf schema and almyty turns every operation into a typed tool, no code. Import one: ${p.appUrl}. Unsubscribe: ${p.unsubscribeUrl}`,
    ),
  }),

  // State-aware nudge: api present but no gateway yet.
  // MARKETING: refine copy + cadence
  'lifecycle.nudge-gateway': (p) => ({
    subject: 'Publish a gateway and your tools go live',
    html: renderBaseLayout({
      heading: 'One gateway away from callable tools',
      bodyHtml:
        para(
          'Your tools are generated. A gateway is what serves them: to your agents, over MCP, A2A, UTCP, or an OpenAI-compatible endpoint. Publish one and anything that speaks the protocol can call your tools.',
        ) +
        para(
          'Pick the tools, name the gateway, and almyty gives you the connection string.',
        ),
      button: { label: 'Publish a gateway', url: p.appUrl },
      footerNote: `You are getting almyty setup tips because you signed up recently. Not for you? Unsubscribe: ${p.unsubscribeUrl}`,
    }),
    text: flattenText(
      `Your tools are generated. Publish a gateway to serve them over MCP, A2A, UTCP, or an OpenAI-compatible endpoint: ${p.appUrl}. Unsubscribe: ${p.unsubscribeUrl}`,
    ),
  }),

  // State-aware nudge: gateway published but no external/first call yet.
  // MARKETING: refine copy + cadence
  'lifecycle.nudge-first-call': (p) => ({
    subject: 'Give Claude your API in one command',
    html: renderBaseLayout({
      heading: 'Make the first call: point an agent at your gateway',
      bodyHtml:
        para(
          'Your gateway is live but nothing has called it yet. The payoff moment is one command away: run <code>claude mcp add</code> with your gateway URL and Claude can use every tool you generated.',
        ) +
        para(
          "The exact command, with your gateway URL and key, is on the gateway's Integrations tab.",
        ),
      button: { label: 'Make your first call', url: p.appUrl },
      footerNote: `You are getting almyty setup tips because you signed up recently. Not for you? Unsubscribe: ${p.unsubscribeUrl}`,
    }),
    text: flattenText(
      `Your gateway is live but nothing has called it. Run claude mcp add with your gateway URL (grab it from the gateway's Integrations tab). Details: ${p.appUrl}. Unsubscribe: ${p.unsubscribeUrl}`,
    ),
  }),

  // Showcase (T+5, still not activated): one concrete ~5-min win + docs.
  // MARKETING: refine copy + cadence
  'lifecycle.example-showcase': (p) => ({
    subject: 'Give Claude your API in about five minutes',
    html: renderBaseLayout({
      heading: 'A concrete five-minute win',
      bodyHtml:
        para(
          'Here is the shortest path from zero to a working agent: take any API you already use, import its schema, publish a gateway, and run <code>claude mcp add</code> against it. Five minutes, no glue code, and Claude can call your API.',
        ) +
        para(
          'The in-app docs walk the whole path step by step, from schema import to the first call.',
        ),
      button: { label: 'Try the five-minute path', url: p.appUrl },
      footerNote: `You are getting almyty setup tips because you signed up recently. Not for you? Unsubscribe: ${p.unsubscribeUrl}`,
    }),
    text: flattenText(
      `Give Claude your API in about five minutes: import a schema, publish a gateway, run claude mcp add. Start: ${p.appUrl}. Unsubscribe: ${p.unsubscribeUrl}`,
    ),
  }),

  // Last touch (T+10, still not activated): show range, then stop.
  // MARKETING: refine copy + cadence
  'lifecycle.last-touch': (p) => ({
    subject: 'What people build on almyty (last note)',
    html: renderBaseLayout({
      heading: 'A few things people build on almyty',
      bodyHtml:
        para(
          'Teams use almyty to turn internal APIs into MCP tools their coding agents can call, to wire multi-LLM agent pipelines with the visual builder, and to run those agents on their own machines with the runner.',
        ) +
        para(
          'This is the last setup email we will send. If almyty is not the right fit right now, no worries: everything is here when you come back.',
        ),
      button: { label: 'See what you can build', url: p.appUrl },
      footerNote: `This is the final almyty setup email. Prefer none at all? Unsubscribe: ${p.unsubscribeUrl}`,
    }),
    text: flattenText(
      `What people build on almyty: internal APIs as MCP tools, multi-LLM agent pipelines, agents running on their own machines via the runner. This is the last setup email we will send: ${p.appUrl}. Unsubscribe: ${p.unsubscribeUrl}`,
    ),
  }),

  // Post-activation congrats (fires ON first successful call, once). The
  // one lifecycle email that sends AFTER activation: the good moment.
  // MARKETING: refine copy + cadence
  'lifecycle.activated-congrats': (p) => ({
    subject: 'Your first agent call landed on almyty',
    html: renderBaseLayout({
      heading: `Nicely done${p.firstName ? `, ${esc(p.firstName)}` : ''}: you are live`,
      bodyHtml:
        para(
          'That was your first successful call through almyty. From here it only gets more useful: add verify panels to catch bad runs, give agents memory so they remember across calls, and use runners to execute on your own machines.',
        ) +
        para(
          'The in-app docs cover each of these next steps whenever you are ready.',
        ),
      button: { label: 'Explore what is next', url: p.appUrl },
      footerNote: `You are getting this because you just activated your almyty workspace. Unsubscribe: ${p.unsubscribeUrl}`,
    }),
    text: flattenText(
      `Your first almyty call landed. Next: verify panels, agent memory, and runners for on-machine execution. Explore: ${p.appUrl}. Unsubscribe: ${p.unsubscribeUrl}`,
    ),
  }),
};

/** Generic fallback so an unknown template id still yields a branded email. */
function renderGeneric(params: Record<string, any>): RenderedEmail {
  const title = params.title || 'Notification from almyty';
  const body = params.body || '';
  return {
    subject: sanitizeSubject(String(title)),
    html: renderBaseLayout({
      heading: String(title),
      bodyHtml: para(esc(body)),
      button: params.url ? { label: params.buttonLabel || 'Open almyty', url: params.url } : undefined,
      orgName: params.organizationName,
    }),
    text: flattenText(`${title}. ${body}${params.url ? ` ${params.url}` : ''}`),
  };
}

export function renderEmailTemplate(
  template: string,
  params: Record<string, any> = {},
): RenderedEmail {
  const renderer = TEMPLATES[template];
  return renderer ? renderer(params) : renderGeneric(params);
}

export function hasEmailTemplate(template: string): boolean {
  return !!TEMPLATES[template];
}
