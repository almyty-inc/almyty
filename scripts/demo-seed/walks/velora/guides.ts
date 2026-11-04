// The five governance example guides in docs-site/content/examples, walked
// through the UI step by step as their text says: multi-team-rbac,
// approval-policies, audit-to-siem, sso-scim-onboarding and
// eu-ai-act-compliance. Each builds on the one before it.
//
// They work as Sanne Visser, head of IT at Velora Energy (made up), with
// colleagues. What differs from a real account, because the outside services
// are the local fake (fakes/services/velora.ts): the API addresses are set to
// the fake under Advanced, the model key is sent with the fake's address,
// Microsoft's sign-in page is answered by the fake without a screen, an
// action plays Entra ID's provisioning service (the same SCIM requests Entra
// sends), and what Splunk received is shown as a page. The API descriptions
// are the real public ones, read from their links as a user would.
import type { Locator, Step } from '../../engine/schema.ts'

const DOMAIN = 'veloraenergy.example'
const PASSWORD = 'Velora-2026!'
const email = (first: string, last: string) => `${first.toLowerCase()}.${last.toLowerCase().replace(/\s+/g, '')}@${DOMAIN}`

export const SANNE = { email: email('Sanne', 'Visser'), password: PASSWORD, firstName: 'Sanne', lastName: 'Visser', organizationName: 'Velora Energy' }
// Colleagues are added straight to the database with Sanne's password (sign-ups are rate limited,
// and how they got an account is not what these guides show), then invited from the UI.
const colleague = (first: string, last: string) => ({ email: email(first, last), password: PASSWORD, firstName: first, lastName: last, organizationName: 'Velora Energy', register: false })
const LOTTE = colleague('Lotte', 'Jansen')
const JOOST = colleague('Joost', 'Bakker')
const MEHMET = colleague('Mehmet', 'Yilmaz')
// People Entra ID signs in, and a visitor of the web chat: nobody signs them in with a password.
const outsider = (address: string, first: string, last: string) => ({ email: address, password: 'not-used-0000', firstName: first, lastName: last, organizationName: 'Velora Energy', signIn: 'none' as const, register: false })
export const EVA = { email: `eva.degroot@${DOMAIN}`, given_name: 'Eva', family_name: 'de Groot', oid: '9d3e1f52-7a0b-4c88-9e21-5b6a0f4d2c13' }
export const TOM = { email: `tom.hendriks@${DOMAIN}`, given_name: 'Tom', family_name: 'Hendriks', oid: '2a7c4e90-1b3d-4f6e-8c52-7d9e0a1b3c64' }

const NOTE = 'Example guide step, walked through the UI on the local demo stack (scripts/demo-seed, walks/velora): real public API descriptions, a local stand-in for Stripe, Microsoft Entra ID and Splunk, and a scripted stand-in model; fictional people and companies. Not staging or production data.'
const RENDERED_NOTE = `${NOTE} The page shows what the local stand-in received, laid out as a page; the real service was not used.`

const BROWSER = {
  timezone: 'Europe/Amsterdam',
  providerUrl: '{{stack.upstream}}/openai/v1',
  // Microsoft's sign-in page is answered by the fake: it signs in whoever /_admin/idp-user names.
  forward: { 'login.microsoftonline.com': '{{stack.upstream}}/entra' },
  // A busy machine answers slowly.
  timeout: 90000,
}

// The shared UI (components/ui, components/layout, index.css) is never a source: check-screenshots rejects it as too broad.
const AGENT = ['frontend/src/pages/agent-detail.tsx', 'frontend/src/components/agents']
const BUILDER = ['frontend/src/pages/agent-builder.tsx', 'frontend/src/components/agents']
const NEW_API = ['frontend/src/pages/api-new.tsx']
const SETUP = ['frontend/src/pages/api-setup.tsx', 'frontend/src/components/apis/api-key-form.tsx']
const SETTINGS = ['frontend/src/pages/settings.tsx']
const MEMBERS = [...SETTINGS, 'frontend/src/components/MembersAndTeamsTab.tsx']
const APPROVALS = ['frontend/src/pages/approvals.tsx']
const POLICY = ['frontend/src/pages/approval-policy.tsx', 'frontend/src/components/settings/approval-policy-form.tsx']
const POLICIES = [...SETTINGS, 'frontend/src/components/settings/approval-policies-settings.tsx', 'frontend/src/components/settings/amount-rules-card.tsx']
const STREAMS = [...SETTINGS, 'frontend/src/components/settings/audit-streams-settings.tsx']
const ANALYTICS = ['frontend/src/pages/analytics.tsx', 'frontend/src/components/analytics']
const SSO = [...SETTINGS, 'frontend/src/components/settings/sso-settings.tsx', 'frontend/src/components/settings/sso-domains.tsx']
const COMPLIANCE = [...SETTINGS, 'frontend/src/components/settings/compliance-settings.tsx']
const CHANNEL = ['frontend/src/pages/agent-channel.tsx', 'frontend/src/components/channels']
const AUDIT_EVENT = ['backend/ee/modules/audit-export/audit-stream.service.ts', 'backend/src/modules/audit-log']
const TECHDOC = ['backend/src/modules/agents/agent-tech-doc.helper.ts']

type ShotDef = { path: string; title: string; sources: string[]; route?: string; notes?: string }
const shot = (path: string, title: string, sources: string[], more: Partial<ShotDef> = {}): ShotDef => ({ path: `screenshots/examples/${path}`, title, sources, ...more })

function guide(id: string, title: string, after: string[], shots: Record<string, ShotDef>, steps: Step[], people: Record<string, unknown> = {}) {
  return { id, title, profile: 'velora', account: SANNE, people, after, notes: NOTE, browser: BROWSER, shots, steps }
}

// Bring something to the top of the screen, as a reader scrolls to it.
const top = (target: Locator, offset = 120): Step => ({ scrollTo: target, offset })
const text = (t: string | RegExp, exact = false): Locator => ({ text: t, exact })
const button = (name: string | RegExp, exact = false): Locator => ({ role: 'button', name, exact })
const TRY = { placeholder: 'Type a message to test this agent...' } as const
const STATE = { url: '{{stack.upstream}}/_admin/state' }

// ---------- 1. Keep each team's assistants to that team (multi-team-rbac) ----------

const BILLING_INSTRUCTIONS = `You help Velora Energy's finance team with customers' bills. Find the customer in Stripe by the email address on their account, and look at their charges before you answer.

You can refund a charge in Stripe. Before any refund over €500, ask for approval first with request_approval: in the reason, say who the customer is, which charge, how much and why. In the payload, put the amount in euros as amount_eur, and the customer, charge and invoice. Only make the refund once it is approved. Never refund more than was charged.

Amounts in euros with two decimals.`
const SUPPORT_INSTRUCTIONS = `You help Velora Energy's support team answer customers about contracts, meter readings and moving house. Look the customer's tickets up in Zendesk before you answer, and write replies the agent can send as they are. You never change bills or refunds: send those to the finance team.`

const createTeam = (name: string, description: string): Step[] => [
  { click: button('Create team') },
  { fill: { label: 'Team name' }, value: name },
  { fill: { label: 'Description (optional)' }, value: description },
  { click: { role: 'button', name: 'Create team', within: { role: 'form', name: 'Create team' } } },
  { waitFor: { role: 'heading', name, exact: true } },
]

const invite = (p: { email: string; password: string }, role: string, shotId?: string): Step[] => [
  { click: button('Invite member') },
  { fill: { placeholder: 'user@example.com' }, value: p.email },
  { select: { label: 'Role', exact: true }, option: role },
  ...(shotId ? [{ shot: shotId }] : []),
  { click: button('Send invitation') },
  { waitFor: { role: 'form', name: 'Invite member' }, state: 'hidden' },
  // The colleague accepts the way the in-app notification does.
  { action: 'acceptInvite', with: { email: p.email, password: p.password } },
]

const addToTeam = (team: string, p: { email: string }, role?: string): Step[] => {
  const form: Locator = { role: 'form', name: `Add member to ${team}` }
  return [
    { click: { role: 'button', name: `Add a member to ${team}` } },
    { select: { label: /^Member/, within: form }, option: new RegExp(p.email.replace(/\./g, '\\.')) },
    { click: { role: 'button', name: 'Add member', within: form } },
    { waitFor: form, state: 'hidden' },
    // The role in the team is set on the member's row. Its select has no accessible name, only the role
    // it shows; the teams listed above this one have nobody in them yet, so the first is the new member's.
    ...(role ? [{ select: { role: 'combobox', hasText: /^Member$/ }, option: role } as Step] : []),
  ]
}

const agent = (name: string, instructions: string, tools: string[], team: string, personality?: string): Step[] => [
  { use: 'newAgent', with: { name, instructions, ...(personality ? { personality } : {}) } },
  { use: 'pickTools', with: { tools } },
  { click: button('Visibility: Everyone') },
  { use: 'chooseTeam', with: { team } },
]

const rbac = guide('example-multi-team-rbac', 'Keep each team\'s assistants to that team', [], {
  'rbac-00': shot('multi-team-rbac/00-support-view.png', "Agents as a support team member sees them: only his team's assistant", AGENT),
  'rbac-01': shot('multi-team-rbac/01-teams.png', 'Two teams, Finance and Customer support', MEMBERS),
  'rbac-02': shot('multi-team-rbac/02-invite.png', 'Inviting a colleague as a member', MEMBERS),
  'rbac-03': shot('multi-team-rbac/03-team-members.png', 'Finance with Joost as lead, Customer support with Mehmet', MEMBERS),
  'rbac-04': shot('multi-team-rbac/04-stripe-finance.png', 'Connecting Stripe for the Finance team only', NEW_API),
  'rbac-04b': shot('multi-team-rbac/04b-stripe-key-finance.png', 'The Stripe key, usable by the Finance team only', SETUP),
  'rbac-05': shot('multi-team-rbac/05-agent-team.png', 'The billing assistant, usable by the Finance team only', BUILDER),
  'rbac-06': shot('multi-team-rbac/06-support-denied.png', "A support member opening the billing assistant's link", AGENT),
}, [
  { sql: `INSERT INTO users (email, "normalizedEmail", "passwordHash", "firstName", "lastName", "isVerified", "verifiedAt")
    SELECT x.email, x.email, u."passwordHash", x.first, x.last, true, now() FROM users u,
      (VALUES ('${LOTTE.email}', 'Lotte', 'Jansen'), ('${JOOST.email}', 'Joost', 'Bakker'), ('${MEHMET.email}', 'Mehmet', 'Yilmaz')) AS x(email, first, last)
    WHERE u.email = '${SANNE.email}' AND NOT EXISTS (SELECT 1 FROM users WHERE email = x.email)` },
  { goto: '/settings/members' },
  ...createTeam('Finance', 'Billing, refunds and payments. Owns the Stripe connection and the billing assistant.'),
  ...createTeam('Customer support', 'Answers customers by email and chat. Owns the Zendesk connection and the support assistant.'),
  top({ role: 'region', name: 'Teams' }, 100),
  { shot: 'rbac-01' },
  ...invite(LOTTE, 'Admin'),
  ...invite(JOOST, 'Member', 'rbac-02'),
  ...invite(MEHMET, 'Member'),
  { reload: true },
  ...addToTeam('Finance', JOOST, 'Lead'),
  ...addToTeam('Customer support', MEHMET),
  { reload: true },
  top({ role: 'heading', name: 'Finance', exact: true }, 140),
  { shot: 'rbac-03' },

  { use: 'connectOpenAI', with: { key: 'sk-proj-0000000000000000000000000000000000000000' } },
  { use: 'connectApiFor', with: { link: 'https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json', name: 'Stripe', address: '{{stack.upstream}}/stripe', team: 'Finance', shot: 'rbac-04' } },
  { click: { role: 'button', name: 'Change', exact: true, within: { testid: 'api-key-sent-as' } } },
  { select: { label: 'How it is sent' }, option: 'As a bearer token' },
  { click: button('Create one here') },
  { fill: { role: 'textbox', name: 'Name', exact: true, nth: 'last' }, value: 'Stripe restricted key (billing assistant)' },
  { fill: { role: 'textbox', name: /token|key/i, nth: 'last' }, value: 'rk_live_local-demo-velora-billing' },
  { use: 'chooseTeam', with: { team: 'Finance' } },
  { shot: 'rbac-04b' },
  { use: 'saveSignIn' },
  { use: 'connectApiFor', with: { link: 'https://developer.zendesk.com/zendesk/oas.yaml', name: 'Zendesk', address: '{{stack.upstream}}/zendesk', team: 'Customer support' } },

  ...agent('Billing assistant', BILLING_INSTRUCTIONS, ['stripe_get_customers', 'stripe_get_charges', 'stripe_post_refunds'], 'Finance', 'Clear and exact. Amounts always with the euro sign and two decimals.'),
  { shot: 'rbac-05' },
  { use: 'saveAgent', with: { as: 'agents.billing' } },
  { use: 'activate', with: { agent: '{{agents.billing}}' } },
  ...agent('Support assistant', SUPPORT_INSTRUCTIONS, ['zendesk_list_tickets', 'zendesk_show_ticket'], 'Customer support'),
  { use: 'saveAgent', with: { as: 'agents.support' } },
  { use: 'activate', with: { agent: '{{agents.support}}' } },

  // What Mehmet, in Customer support, sees.
  { action: 'unthrottle' },
  { as: 'mehmet', do: [
    { goto: '/agents' },
    { waitFor: { role: 'link', name: 'Support assistant' } },
    { shot: 'rbac-00' },
    { goto: '/agents/{{agents.billing}}' },
    // The page asks again a few times before it says so.
    { waitFor: { text: "Couldn't load agent" }, timeout: 60000 },
    { shot: 'rbac-06' },
  ] },
  { action: 'unthrottle' },
], { mehmet: MEHMET })

// ---------- 2. Who signs off (approval-policies) ----------

const PENDING = (who: RegExp): Step => ({ waitFor: text(who), timeout: 120000 })
const approve = (who: RegExp, note?: string): Step[] => [
  { click: { role: 'button', name: 'Approve', exact: true } },
  ...(note ? [{ fill: { label: 'Note (optional)' }, value: note } as Step] : []),
  { click: { role: 'button', name: 'Approve', exact: true, within: { role: 'form', name: 'Approve this action' } } },
  { waitFor: { role: 'form', name: 'Approve this action' }, state: 'hidden' },
]

const approvals = guide('example-approval-policies', 'Who signs off on what', ['example-multi-team-rbac'], {
  'ap-00': shot('approval-policies/00-two-step.png', 'A €6,240.00 refund after the finance lead and an admin both approved', AGENT),
  'ap-01': shot('approval-policies/01-big-refunds.png', 'Policy: refunds over €5,000 need the finance lead, then an admin', POLICY),
  'ap-02': shot('approval-policies/02-policies.png', 'Two approval policies for the Finance team', POLICIES),
  'ap-03': shot('approval-policies/03-try.png', 'The billing assistant stops before a €6,240.00 refund', AGENT),
  'ap-04': shot('approval-policies/04-waiting.png', 'The refund waiting on the Approvals page, as the finance lead sees it', APPROVALS),
  'ap-05': shot('approval-policies/05-after-first.png', 'After the finance lead approved: still waiting, for an admin', APPROVALS),
  'ap-06': shot('approval-policies/06-small.png', 'A €740.60 refund: one approval, from the finance lead', APPROVALS),
}, [
  { use: 'policy', with: {
    name: 'Refunds over €5,000',
    description: 'Large refunds: the finance lead checks the customer and the charge, then an admin signs off.',
    team: 'Finance',
    conditions: [['payload.amount_eur', 'greater than', '5000']],
    steps: [['Finance lead', 'team_lead', 1], ['Admin', 'admin', 1]],
    priority: 10,
    shot: 'ap-01',
  } },
  { use: 'policy', with: {
    name: 'Refunds over €500',
    description: "Every other refund that needs a person: the Finance team's lead decides.",
    team: 'Finance',
    conditions: [['payload.amount_eur', 'greater than', '500']],
    steps: [['Finance lead', 'team_lead', 1]],
  } },
  { goto: '/settings/approvals' },
  top({ text: 'Approval policies', nth: 'last' }, 120),
  { shot: 'ap-02' },

  { goto: '/agents/{{agents.billing}}' },
  { use: 'tryIt', with: { message: 'Bakkerij De Zon B.V. (administratie@bakkerijdezon.example) was charged twice for their September bill. Please refund the duplicate.', answer: /approval|approved|Refunded/i, shot: 'ap-03' } },

  // Joost, the Finance team's lead: step 1.
  { action: 'unthrottle' },
  { as: 'joost', do: [
    { goto: '/approvals' },
    PENDING(/Bakkerij De Zon/),
    { shot: 'ap-04' },
    ...approve(/Bakkerij De Zon/, 'Checked in Stripe: the September invoice was collected twice.'),
    // The request stays pending after the first step.
    { goto: '/approvals' },
    PENDING(/Bakkerij De Zon/),
    { shot: 'ap-05' },
  ] },
  // Lotte, an admin: step 2.
  { action: 'unthrottle' },
  { as: 'lotte', do: [
    { goto: '/approvals' },
    PENDING(/Bakkerij De Zon/),
    ...approve(/Bakkerij De Zon/, 'Approved.'),
  ] },
  { until: { http: STATE, at: 'refunds', min: 1 }, timeout: 180000, what: 'the refund' },
  { goto: '/agents/{{agents.billing}}' },
  { click: { role: 'tab', name: 'Runs' } },
  { click: { role: 'button', name: /Bakkerij De Zon/ } },
  top(text(/request_approval/), 160),
  { shot: 'ap-00' },

  // A smaller one: only the finance lead.
  { goto: '/agents/{{agents.billing}}' },
  { use: 'tryIt', with: { message: 'Anna Kowalski (anna.kowalski@mailbox.example) was billed €1,124.00 on an estimated meter reading. Her actual reading gives €383.40. Refund €740.60.', answer: /approval|approved|Refunded/i } },
  { action: 'unthrottle' },
  { as: 'joost', do: [
    { goto: '/approvals' },
    PENDING(/Anna Kowalski/),
    { shot: 'ap-06' },
    ...approve(/Anna Kowalski/),
  ] },
  { until: { http: STATE, at: 'refunds', min: 2 }, timeout: 180000, what: 'the second refund' },
  { action: 'unthrottle' },
], { joost: JOOST, lotte: LOTTE })

// ---------- 3. Audit trail to Splunk (audit-to-siem) ----------

const SPLUNK_HEC = 'https://http-inputs-velora-energy.splunkcloud.com/services/collector/event'
const SPLUNK_TOKEN = '7c2e9a41-5b1d-4f6a-9e03-8d4b2c1f6a70'

const siem = guide('example-audit-to-siem', 'The audit trail, streamed to Splunk', ['example-approval-policies'], {
  'si-00': shot('audit-to-siem/00-splunk-events.png', 'Audit events as Splunk received them: a refund and the approvals before it', AUDIT_EVENT, { route: '/settings/audit-streams', notes: RENDERED_NOTE }),
  'si-01': shot('audit-to-siem/01-audit-trail.png', 'Analytics, Audit trail: who did what, and when', ANALYTICS),
  'si-02': shot('audit-to-siem/02-splunk-target.png', 'Audit streaming: a Splunk HTTP Event Collector target', STREAMS),
  'si-03': shot('audit-to-siem/03-streaming.png', 'Audit streaming, sending to Splunk', STREAMS),
}, [
  { goto: '/settings/audit-streams' },
  { select: { label: 'Target' }, option: /Splunk HEC/ },
  { fill: { label: 'Endpoint', exact: true }, value: SPLUNK_HEC },
  { fill: { label: 'Token (optional)' }, value: SPLUNK_TOKEN },
  { shot: 'si-02' },
  { click: { testid: 'add-stream' } },
  { waitFor: { testid: 'audit-streams' } },
  { shot: 'si-03' },

  // Something worth recording: a refund under €500.
  { goto: '/agents/{{agents.billing}}' },
  { use: 'tryIt', with: { message: 'Maarten de Vries (maarten.devries@mailbox.example) moved out on 30 September but was charged the full October advance. Refund €136.50.', answer: /Refunded|approval/i } },
  { until: { http: STATE, at: 'splunk', where: { 'body.event.action': 'tool_execute' } }, timeout: 180000, what: 'events at Splunk' },

  { goto: '/analytics' },
  { click: { role: 'tab', name: /Audit/ } },
  { shot: 'si-01' },

  { http: STATE, save: 'state' },
  { render: 'velora-splunk', with: { events: '{{state.splunk}}', height: 300 }, shot: 'si-00' },
])

// ---------- 4. Company sign-in with Microsoft Entra ID (sso-scim-onboarding) ----------

const ENTRA_TENANT = '4f9c2b17-8e3a-4d61-b5a2-0c7e91d3f846'
const ENTRA_CLIENT = 'b6e1f3a2-47c9-4d0e-9a18-3f5c7d2e8b41'
const DOMAIN_ITEM: Locator = { role: 'listitem', name: DOMAIN }
const signInAt = (who: object): Step => ({ http: { method: 'POST', url: '{{stack.upstream}}/_admin/idp-user', body: who } })
const SSO_LOGIN = '{{stack.api}}/sso/{{org.id}}/oidc/login'

const sso = guide('example-sso-scim-onboarding', 'Company sign-in with Microsoft Entra ID', ['example-audit-to-siem'], {
  'sso-00': shot('sso-scim-onboarding/00-signed-in.png', 'Eva, a new starter, signed in with her Microsoft account', ['frontend/src/pages/dashboard.tsx', 'backend/ee/modules/sso/sso.controller.ts']),
  'sso-01': shot('sso-scim-onboarding/01-domain-record.png', 'Email domains: the TXT record to add', SSO),
  'sso-02': shot('sso-scim-onboarding/02-domain-verified.png', 'The domain, verified', SSO),
  'sso-03': shot('sso-scim-onboarding/03-entra-oidc.png', 'Single sign-on with Microsoft Entra ID over OpenID Connect', SSO),
  'sso-04': shot('sso-scim-onboarding/04-scim-token.png', 'SCIM: the base URL and a new token for Entra', SSO),
  'sso-05': shot('sso-scim-onboarding/05-members.png', 'Members after Entra provisioned two people and removed one', MEMBERS),
}, [
  // 1. The email domain.
  { goto: '/settings/sso' },
  { fill: { label: 'Add a domain' }, value: DOMAIN },
  { click: button('Add domain') },
  { waitFor: DOMAIN_ITEM },
  top(text('Email domains'), 120),
  { shot: 'sso-01' },
  // At the DNS provider: the TXT record the page shows (here, the fake's DNS).
  { http: { url: '/sso/settings/domains' }, save: 'domains' },
  { http: { method: 'POST', url: '{{stack.upstream}}/_dns/txt', body: {
    name: `{{domains|rows|where:domain=${DOMAIN}|first|get:record.name}}`,
    value: `{{domains|rows|where:domain=${DOMAIN}|first|get:record.value}}`,
  } } },
  { click: { role: 'button', name: 'Check DNS', within: DOMAIN_ITEM } },
  { waitFor: { text: /Verified\./, within: DOMAIN_ITEM }, timeout: 20000 },
  top(text('Email domains'), 120),
  { shot: 'sso-02' },

  // 2. Entra ID over OpenID Connect.
  { goto: '/settings/sso' },
  { select: { label: 'Protocol' }, option: 'OpenID Connect' },
  { fill: { label: 'Issuer URL' }, value: `https://login.microsoftonline.com/${ENTRA_TENANT}/v2.0` },
  { fill: { label: 'Client ID', exact: true }, value: ENTRA_CLIENT },
  { fill: { label: /^Client secret/ }, value: 'Qx98Q~local.demo-secret-value-0123456789abc' },
  { fill: { label: 'Redirect URI' }, value: '{{stack.api}}/sso/{{org.id}}/oidc/callback' },
  { use: 'setSwitch', with: { nth: 1, on: false } }, // Add people when they first sign in
  { use: 'setSwitch', with: { nth: 0, on: true } }, // Use single sign-on
  // Taller, so the form and the addresses for Entra are in one picture.
  { viewport: { width: 1440, height: 1500 } },
  top({ label: 'Protocol' }, 140),
  { shot: 'sso-03' },
  { viewport: { width: 1440, height: 900 } },
  { click: button('Save SSO settings') },

  // 3. SCIM.
  { reload: true },
  { click: button(/(Generate|Rotate) SCIM token/) },
  { if: { visible: button('Rotate token') }, then: [{ click: button('Rotate token') }] },
  { waitFor: { label: 'New SCIM token (shown once)' } },
  { remember: 'scim', fromInput: { label: 'New SCIM token (shown once)' } },
  top(text('Automatic member sync (SCIM)'), 120),
  { shot: 'sso-04' },
  { action: 'entraProvisioning', with: { token: '{{scim}}', ops: ['test', 'users'] } },

  // 4. Eva signs in with her Microsoft account.
  signInAt(EVA),
  { as: 'eva', do: [
    { goto: SSO_LOGIN },
    { waitForUrl: '{{stack.web}}', timeout: 30000 },
    { goto: '/dashboard' },
    { shot: 'sso-00' },
  ] },

  // 5. Tom leaves: Entra disables him, and he can no longer sign in.
  { action: 'entraProvisioning', with: { token: '{{scim}}', ops: ['leaver'] } },
  signInAt(TOM),
  { as: 'tom', do: [{ goto: SSO_LOGIN }] },

  { goto: '/settings/members' },
  { shot: 'sso-05' },
  { action: 'unthrottle' },
], { eva: outsider(EVA.email, 'Eva', 'de Groot'), tom: outsider(TOM.email, 'Tom', 'Hendriks') })

// ---------- 5. Ready for the EU AI Act (eu-ai-act-compliance) ----------

const HELP_INSTRUCTIONS = `You answer Velora Energy's customers on our website about tariffs, meter readings, moving house and paying bills. Velora has two tariffs: Fixed (one price per kWh for 12 months) and Dynamic (the hourly market price plus €0.021 per kWh). A customer can switch tariff once a month; the switch starts on the first day of the next month.

You cannot see anyone's account. For a question about a particular bill, a refund or a change to a contract, ask for the customer's email address and tell them our billing team will reply by email within one working day. Never promise a refund.`
const DISCLOSURE = "You're chatting with Velora's AI assistant. Ask for a person at any time."
const on = (name: string): Step => ({ if: { not: { checked: { role: 'switch', name } } }, then: [{ click: { role: 'switch', name } }] })

const aiact = guide('example-eu-ai-act-compliance', 'Ready for the EU AI Act', ['example-sso-scim-onboarding'], {
  'ai-00': shot('eu-ai-act-compliance/00-web-chat.png', 'The public web chat, with the AI notice under the message box', ['frontend/src/pages/hosted-chat.tsx', 'frontend/src/lib/hosted-chat.ts']),
  'ai-01': shot('eu-ai-act-compliance/01-branding.png', 'Branding: the AI notice in your own words', ['frontend/src/pages/agent-public-settings.tsx', 'frontend/src/components/channels']),
  'ai-02': shot('eu-ai-act-compliance/02-channel-notice.png', 'The web chat channel, with the AI notice switched on', CHANNEL),
  'ai-03': shot('eu-ai-act-compliance/03-tech-doc.png', "The billing assistant's technical documentation", TECHDOC, { route: '/agents/:id', notes: RENDERED_NOTE }),
  'ai-04': shot('eu-ai-act-compliance/04-compliance-policy.png', 'Compliance: personal data hidden in records across the organization', COMPLIANCE),
  'ai-05': shot('eu-ai-act-compliance/05-posture.png', 'The compliance report', COMPLIANCE),
}, [
  { use: 'newAgent', with: { name: 'Velora help', personality: 'Warm, plain and short. Use the customer\'s words, not energy jargon.', instructions: HELP_INSTRUCTIONS } },
  { use: 'saveAgent', with: { as: 'agents.help' } },
  { use: 'activate', with: { agent: '{{agents.help}}' } },

  // Branding: the notice in Velora's words.
  { goto: '/agents/{{agents.help}}/channels/settings' },
  { fill: { label: 'Name people see', exact: true }, value: 'Velora Energy help' },
  { fill: { label: 'Greeting', exact: true }, value: 'Hi! Ask me about tariffs, meter readings, moving house or paying your bill.' },
  { fill: { label: 'AI disclosure', exact: true }, value: DISCLOSURE },
  top({ label: 'AI disclosure', exact: true }, 260),
  { shot: 'ai-01' },
  { if: { enabled: { role: 'button', name: 'Save', nth: 'last' } }, then: [{ click: { role: 'button', name: 'Save', nth: 'last' } }] },

  // The web chat.
  { goto: '/agents/{{agents.help}}/channels/new' },
  { click: button(/^Web chat/) },
  { click: { role: 'button', name: 'Publish', exact: true } },
  { waitFor: button('Unpublish'), timeout: 20000 },
  top(text('AI disclosure', true), 200),
  { shot: 'ai-02' },
  { remember: 'slug', fromInput: { label: 'Address', exact: true } },

  // What a visitor sees.
  { as: 'visitor', do: [
    { goto: '/?__slug={{slug}}' },
    { fill: { role: 'textbox', name: 'Message' }, value: 'Can I switch to the dynamic tariff from next month?' },
    { click: button('Send') },
    { waitFor: { text: /first day of the next month|Dynamic/, nth: 'last' }, timeout: 90000 },
    { shot: 'ai-00' },
  ] },

  // The technical documentation of the billing assistant, as downloaded.
  { goto: '/agents/{{agents.billing}}' },
  { download: button('Tech doc'), save: 'techdoc' },
  { action: 'readFile', with: { file: '{{techdoc}}' }, save: 'techdocText' },
  { render: 'velora-techdoc', with: { md: '{{techdocText}}', height: 300 }, shot: 'ai-03' },

  // The compliance pack: personal data hidden in records, organization-wide.
  { goto: '/settings/compliance' },
  on('Hide personal data'),
  on('Scan for attacks'),
  top(text('Compliance policy'), 120),
  { shot: 'ai-04' },
  { if: { enabled: button('Save compliance policy') }, then: [{ click: button('Save compliance policy') }] },
  { reload: true },
  top(text('Score', true), 200),
  { shot: 'ai-05' },
], { visitor: outsider('visitor@mailbox.example', 'A', 'Visitor') })

export const guides = [rbac, approvals, siem, sso, aiact]
