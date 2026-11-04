// The data and finance example guides in docs-site/content/examples, walked
// through the UI step by step as their text says:
// stripe-payout-reconciliation, nl-query-your-database,
// nightly-data-quality-digest, cross-vendor-contract-review and
// govern-ai-spend. Each builds on the ones before it (the model connected in
// the first, the Slack bot token saved in the first, BigQuery connected in
// the second).
//
// They work as Ines Duarte, head of finance and operations at Larkspur Home
// (made up), in an organization of her own. What differs from a real
// account, because the stand-in is on localhost: the API addresses are set
// to the stand-in under Advanced, the model keys are sent with the
// stand-in's address, Google's and Xero's sign-in pages are never opened (a
// token is pasted instead), and Slack messages are shown as the stand-in
// received them, rendered as a page. The API descriptions are the real
// public ones, read from their links as a user would.
import type { Step } from '../../engine/schema.ts'
import { demoPassword } from '../../engine/password.ts'

export const INES = { email: 'ines.duarte@larkspurhome.example', password: demoPassword(), firstName: 'Ines', lastName: 'Duarte', organizationName: 'Larkspur Home' }
export const SLACK_SIGNING_SECRET = 'local-test-signing-secret-larkspur-01'

const NOTE = 'Example guide step, walked through the UI on the local demo stack (scripts/demo-seed, walks/larkspur): real public API descriptions, a local stand-in for Stripe, Xero, BigQuery and Slack, and scripted stand-in models; fictional people and companies. Not staging or production data. Slack messages are rendered exactly as almyty handed them to Slack; Slack itself was not used.'
const BROWSER = {
  // Model keys go to the stand-in instead of the vendor.
  providerUrl: { anthropic: '{{stack.upstream}}/anthropic/v1', mistral: '{{stack.upstream}}/mistral/v1', '*': '{{stack.upstream}}/openai/v1' },
  // Real sign-in pages are never opened.
  block: ['accounts.google.com', 'login.xero.com', 'dashboard.stripe.com'],
}

// The shared UI (components/ui, components/layout, index.css) is never a source: check-screenshots rejects it as too broad.
const AGENT = ['frontend/src/pages/agent-detail.tsx', 'frontend/src/components/agents']
const BUILDER = ['frontend/src/pages/agent-builder.tsx', 'frontend/src/components/agents']
const NEW_API = ['frontend/src/pages/api-new.tsx']
const SETUP = ['frontend/src/pages/api-setup.tsx', 'frontend/src/components/apis/api-key-form.tsx']
const CHANNEL = ['frontend/src/pages/agent-channel.tsx', 'frontend/src/components/channels']
const SCHEDULE = ['frontend/src/pages/agent-schedule.tsx']
const MODELS = ['frontend/src/pages/models-connect.tsx', 'frontend/src/components/llm-providers']
const SLACK_RENDER = ['backend/src/modules/gateways/channels/adapters/slack.adapter.ts', 'backend/src/modules/gateways/channels/adapters/channel-markdown.ts']
const ANALYTICS = ['frontend/src/pages/analytics.tsx', 'frontend/src/components/analytics']
const BUDGET = ['frontend/src/pages/analytics-budget.tsx', 'frontend/src/components/analytics/budget-form.tsx']

/** Wait for what the agent posted to Slack (chat.postMessage) and keep it under `as`. */
export function waitForPost(as: string, match: RegExp, what: string, timeout: number): Step[] {
  return [{
    until: { http: { url: '{{stack.upstream}}/_admin/state' }, at: 'outbox', where: { url: { contains: 'chat.postMessage' }, 'body.text': match } },
    timeout, every: 3000, what, save: as,
  }]
}

type Shots = Record<string, [string, string, string[], string?]>

function guide(id: string, title: string, dir: string, after: string[], shots: Shots, steps: Step[]) {
  return {
    id, title, profile: 'larkspur', account: INES, after, notes: NOTE, browser: BROWSER,
    shots: Object.fromEntries(Object.entries(shots).map(([shot, [file, t, sources, route]]) => [shot, { path: `screenshots/examples/${dir}/${file}`, title: t, sources, ...(route ? { route } : {}) }])),
    steps,
  }
}

const apiMissing = (name: string) => ({ sql: `SELECT count(*) FROM apis WHERE name = '${name}' AND "organizationId" = '{{org.id}}'`, is: '0' })
const toolsShown: Step = { scrollTo: { text: 'Tools and APIs' }, block: 'nearest' }
const saveAndActivate = (as: string): Step[] => [
  { use: 'saveAgent', with: { as } },
  { use: 'activate', with: { agent: `{{${as}}}` } },
]

// ---------- 1. Stripe payouts against Xero (stripe-payout-reconciliation) ----------
const XERO_TENANT = '7a3c51e2-0d4b-4c7e-9a52-6f1e8b2d4c90'
const PAYOUT_INSTRUCTIONS = `You check Larkspur Home's Stripe payouts against Xero every morning and report only what needs a person.

1. List yesterday's Stripe payouts: status "paid", arrival_date set to yesterday 00:00 UTC as a Unix timestamp. Stripe pays out once a day per currency (EUR, GBP and USD).
2. For each payout, list its balance transactions (payout set to the payout id, limit 100) and add up the charges, refunds and fees.
3. In Xero, list the bank transactions with xero-tenant-id ${XERO_TENANT} and where set to: Type=="RECEIVE" AND Contact.Name=="Stripe" AND Date>=DateTime(yesterday's year, month, day).
4. Match each payout to the Xero transaction whose Reference is the payout id. It matches when the Xero total equals the payout amount to the cent.
5. Report the payouts that need a look first: not in Xero, or a different amount (give the difference and the breakdown from step 2). Then the ones that match, one line each. Then every refund of 500 or more in any currency, with the order number.

You only read. Never create, change or delete anything in Stripe or Xero.`

const payouts = guide('larkspur-payouts', 'Stripe payouts checked against Xero', 'stripe-payout-reconciliation', [], {
  'pay-00': ['00-slack-report.png', 'The morning payout check in #finance-ops', SLACK_RENDER, '/agents/:id/schedule'],
  'pay-01': ['01-stripe-link.png', "Stripe's API description link", NEW_API],
  'pay-02': ['02-stripe-key.png', 'The Stripe restricted key, saved as the username', SETUP],
  'pay-03': ['03-xero-sign-in.png', 'Xero sign-in: client ID, secret and one scope', SETUP],
  'pay-04': ['04-agent.png', 'Payout check: instructions', BUILDER],
  'pay-05': ['05-tools.png', 'Payout check: three read-only tools', BUILDER],
  'pay-06': ['06-try.png', 'Payout check: a test run', AGENT],
  'pay-07': ['07-run-steps.png', 'Payout check: the Stripe and Xero calls of the run', AGENT],
  'pay-08': ['08-schedule.png', 'Schedule: weekdays at 07:00, posted to #finance-ops', SCHEDULE],
}, [
  {
    if: { sql: `SELECT count(*) FROM llm_providers WHERE "organizationId" = '{{org.id}}' AND name = 'OpenAI'`, is: '0' },
    then: [{ use: 'connectProvider', with: { name: 'OpenAI', provider: 'OpenAI', key: 'sk-proj-0000000000000000000000000000000000000000' } }],
  },
  {
    if: apiMissing('Stripe'),
    then: [
      { use: 'connectApi', with: { link: 'https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json', name: 'Stripe', address: '{{stack.upstream}}/stripe', linkShot: 'pay-01' } },
      // Stripe's description offers a bearer token next to basic auth; almyty picks the token.
      { waitFor: { text: 'Sent as a bearer token', within: { testid: 'api-key-sent-as' } }, timeout: 15000 },
      { click: { role: 'button', name: 'Create one here', nth: 'first' } },
      { fill: { role: 'textbox', name: 'Name', exact: true, nth: 'last' }, value: 'Stripe restricted key (read only)' },
      { fill: { role: 'textbox', name: /token|key/i, nth: 'last' }, value: 'local-demo-stripe-restricted-key' },
      { shot: 'pay-02' },
      { use: 'saveSignIn' },
    ],
  },
  {
    if: apiMissing('Xero Accounting'),
    then: [
      { use: 'connectApi', with: { link: 'https://raw.githubusercontent.com/XeroAPI/Xero-OpenAPI/master/xero_accounting.yaml', name: 'Xero Accounting', address: '{{stack.upstream}}/xero/api.xro/2.0' } },
      { use: 'oauthSignIn', with: { clientId: '3F9A1C0E7B2D4E5F8A6B9C0D1E2F3A4B', secret: 'local-test-xero-client-secret', scope: 'accounting.transactions.read', shot: 'pay-03', name: 'Xero (Larkspur Home B.V.)', token: 'local-test-xero-token' } },
    ],
  },
  { use: 'newAgent', with: { name: 'Payout check', personality: 'Precise and brief, like a good bookkeeper. Amounts always with currency and two decimals.', instructions: PAYOUT_INSTRUCTIONS } },
  { scrollTop: true },
  { shot: 'pay-04' },
  { use: 'pickTools', with: { tools: ['stripe_get_payouts', 'stripe_get_balance_transactions', 'xero_accounting_get_bank_transactions'] } },
  toolsShown,
  { shot: 'pay-05' },
  ...saveAndActivate('agents.payouts'),
  { use: 'ask', with: { agent: '{{agents.payouts}}', message: "Check yesterday's payouts.", answer: /need a look|match Xero|could not/, shot: 'pay-06' } },
  { use: 'latestRun', with: { agent: '{{agents.payouts}}', shot: 'pay-07' } },
  { use: 'slackChannel', with: { agent: '{{agents.payouts}}', as: 'channels.payouts' } },
  { use: 'schedule', with: { agent: '{{agents.payouts}}', channel: 'finance-ops', message: "Check yesterday's payouts.", days: 'Weekdays (Monday to Friday)', time: '07:00', shot: 'pay-08' } },
  { use: 'scheduledPost', with: { agent: '{{agents.payouts}}', channel: 'finance-ops', message: "Check yesterday's payouts.", days: 'Weekdays (Monday to Friday)', time: '07:00', match: /need a look|match Xero/, as: 'posts.payouts' } },
  { render: 'larkspurSlack', with: { channel: 'finance-ops', agent: 'Payout check', text: '{{posts.payouts|first|get:body.text}}', height: 300 }, shot: 'pay-00' },
])

// ---------- 2. Ask the data warehouse in Slack (nl-query-your-database) ----------
const ASK_INSTRUCTIONS = `You answer questions about Larkspur Home's shop data from BigQuery (project larkspur-analytics, dataset shop), for colleagues in Slack.

Tables:
- shop.orders: order_id, created_at, customer_id, shipping_country (ISO code, for example DE), channel (web or app), status (paid, shipped, delivered, cancelled), total_eur, shipped_at
- shop.order_items: order_id, sku, quantity, line_total_eur
- shop.products: sku, name, category, price_eur
- shop.payments: payment_id, order_id, created_at, payment_method, amount_eur, status

For every question:
1. Write one standard SQL SELECT and run it with the query tool: projectId larkspur-analytics, defaultDataset with projectId larkspur-analytics and datasetId shop, useLegacySql false, maximumBytesBilled 1000000000, maxResults 100. Name tables without project or backticks, like orders.
2. Answer in one or two sentences with the numbers, then show the query you ran in a code block, so anyone can check it.

"Last week" means Monday to Sunday of the previous week. Money is in euros.
Only ever run SELECT. If someone asks you to change or delete data, say that you only read, and run nothing.`

// The BigQuery query tool, by the name it was given when the API was connected.
const bqTool: Step = { sql: `SELECT name FROM tools WHERE "organizationId" = '{{org.id}}' AND name LIKE 'bigquery%jobs_query' LIMIT 1`, save: 'bqTool' }
const ASK_QUESTION = 'how many orders did we ship to Germany last week, and what was the revenue?'

const ask = guide('larkspur-ask', 'Ask the data warehouse in Slack', 'nl-query-your-database', ['larkspur-payouts'], {
  'ask-00': ['00-slack-answer.png', 'A question in #ask-data, answered with the number and the query', SLACK_RENDER, '/agents/:id/channels/:id'],
  'ask-01': ['01-bigquery-link.png', 'BigQuery API description link', NEW_API],
  'ask-02': ['02-google-sign-in.png', 'Google sign-in for BigQuery: one read-only scope', SETUP],
  'ask-03': ['03-agent.png', 'Data questions: instructions with the tables', BUILDER],
  'ask-04': ['04-tools.png', 'Data questions: the BigQuery query tool', BUILDER],
  'ask-05': ['05-try.png', 'Data questions: best sellers, with the query', AGENT],
  'ask-06': ['06-try-delete.png', 'Data questions: a request to delete data, refused', AGENT],
  'ask-07': ['07-slack-live.png', 'Slack channel for Data questions, live', CHANNEL],
  'ask-08': ['08-access.png', 'Access: let the agent use BigQuery for everyone who asks', [...AGENT, 'frontend/src/components/agents/builder/capabilities-section.tsx']],
}, [
  {
    if: apiMissing('BigQuery'),
    then: [
      { use: 'connectApi', with: { link: 'https://www.googleapis.com/discovery/v1/apis/bigquery/v2/rest', name: 'BigQuery', address: '{{stack.upstream}}/bigquery/v2', linkShot: 'ask-01' } },
      { use: 'oauthSignIn', with: { clientId: '482910375521-lh0data7questions.apps.googleusercontent.com', secret: 'GOCSPX-local-test-secret', scope: /cloud-platform\.read-only$/, shot: 'ask-02', name: 'Google (data-agent@larkspurhome.example)', token: 'local-test-google-token' } },
    ],
  },
  bqTool,
  { use: 'newAgent', with: { name: 'Data questions', personality: 'Plain and exact. Numbers first, no hedging, no filler.', instructions: ASK_INSTRUCTIONS } },
  { scrollTop: true },
  { shot: 'ask-03' },
  { use: 'pickTools', with: { tools: ['{{bqTool}}'] } },
  toolsShown,
  { shot: 'ask-04' },
  ...saveAndActivate('agents.ask'),
  { use: 'ask', with: { agent: '{{agents.ask}}', message: 'Which five products sold best in Germany last week?', answer: /best sellers|refused|no BigQuery/, shot: 'ask-05' } },
  { use: 'ask', with: { agent: '{{agents.ask}}', message: 'Please delete the test orders from yesterday.', answer: /only read/, shot: 'ask-06' } },
  { use: 'slackChannel', with: { agent: '{{agents.ask}}', as: 'channels.ask', shot: 'ask-07' } },
  // Who writes on a channel is not the owner: the agent may use only what it was given.
  { goto: '/agents/{{agents.ask}}' },
  { scrollTo: { testid: 'agent-access-card' }, offset: 140 },
  { shot: 'ask-08' },
  {
    repeat: [{ click: { role: 'button', name: /^Let this agent use/, within: { testid: 'agent-access-card' } } }],
    while: { visible: { role: 'button', name: /^Let this agent use/, within: { testid: 'agent-access-card' } } },
    max: 6,
  },
  { http: { method: 'POST', url: '{{stack.upstream}}/_admin/reset' } },
  { action: 'slackMention', with: { slug: '{{org.slug}}', gateway: '{{channels.ask}}', text: `<@U0BOT> ${ASK_QUESTION}` } },
  ...waitForPost('posts.ask', /query I ran|refused/, 'the Slack answer', 150000),
  { render: 'larkspurSlack', with: { channel: 'ask-data', agent: 'Data questions', from: 'Fenna de Wit', question: ASK_QUESTION, text: '{{posts.ask|first|get:body.text}}', height: 300 }, shot: 'ask-00' },
])

// ---------- 3. A nightly data check (nightly-data-quality-digest) ----------
const QUALITY_INSTRUCTIONS = `You check Larkspur Home's shop data in BigQuery every night and report what is wrong.

Run each check as one query with the query tool: projectId larkspur-analytics, defaultDataset with projectId larkspur-analytics and datasetId shop, useLegacySql false, maximumBytesBilled 1000000000. Name tables without project or backticks.
1. Freshness: from shop.__TABLES__, every table except products must have been updated in the last 6 hours.
2. Volume: yesterday's orders in shop.orders (by created_at) against the daily average of the 7 days before. Flag a change of more than 30%.
3. Empty values: the share of yesterday's payments in shop.payments without a payment_method, and of yesterday's orders without a customer_id or shipping_country. Flag anything above 1%.

Report the problems first, each with the number you found and the limit it breaks. Then the checks that passed, in one line. If nothing is wrong, say "All checks passed."
Only ever run SELECT.`

const quality = guide('larkspur-quality', 'A nightly data check, posted to Slack', 'nightly-data-quality-digest', ['larkspur-ask'], {
  'dq-00': ['00-slack-report.png', 'The nightly data check in #data-alerts', SLACK_RENDER, '/agents/:id/schedule'],
  'dq-01': ['01-agent.png', 'Data check: the three checks as instructions', BUILDER],
  'dq-02': ['02-try.png', 'Data check: a test run finds two problems', AGENT],
  'dq-03': ['03-run-steps.png', 'Data check: the three queries of the run', AGENT],
  'dq-04': ['04-schedule.png', 'Schedule: every day at 06:30, posted to #data-alerts', SCHEDULE],
}, [
  bqTool,
  { use: 'newAgent', with: { name: 'Data check', personality: 'Short and factual. Problems first, with numbers.', instructions: QUALITY_INSTRUCTIONS } },
  { use: 'pickTools', with: { tools: ['{{bqTool}}'] } },
  { scrollTop: true },
  { shot: 'dq-01' },
  ...saveAndActivate('agents.quality'),
  { use: 'ask', with: { agent: '{{agents.quality}}', message: 'Run the nightly checks.', answer: /Shop data check|failed|no BigQuery/, shot: 'dq-02' } },
  { use: 'latestRun', with: { agent: '{{agents.quality}}', shot: 'dq-03' } },
  { use: 'slackChannel', with: { agent: '{{agents.quality}}', as: 'channels.quality' } },
  { use: 'schedule', with: { agent: '{{agents.quality}}', channel: 'data-alerts', message: 'Run the nightly checks.', days: 'Every day', time: '06:30', shot: 'dq-04' } },
  { use: 'scheduledPost', with: { agent: '{{agents.quality}}', channel: 'data-alerts', message: 'Run the nightly checks.', days: 'Every day', time: '06:30', match: /Shop data check/, as: 'posts.quality' } },
  { render: 'larkspurSlack', with: { channel: 'data-alerts', agent: 'Data check', text: '{{posts.quality|first|get:body.text}}', height: 300 }, shot: 'dq-00' },
])

// ---------- 4. Contract review by a panel of models (cross-vendor-contract-review) ----------
const CONTRACT_INSTRUCTIONS = `You review supplier contracts for Larkspur Home B.V., an online homeware shop in Amsterdam, before anyone signs them.

When someone attaches a contract, write a risk memo:
1. One line: sign as drafted, or not yet.
2. "Must change before signing": the clauses that put real money or data at risk.
3. "Worth negotiating": the rest.
For each clause give its number, what it says in one sentence, why it matters to us, and what to ask for instead. Use the contract's own numbers and dates.
Then say where the readers disagreed.

This memo prepares the conversation with our lawyer. It is not legal advice, and you never say a contract is safe to sign.`

// The main model stays as picked; two panelists from two vendors and a judge, each with its own angle.
const ROLES: { slot: string; model: RegExp; name: string; instructions: string }[] = [
  { slot: 'panelist_1', model: /claude-sonnet-4-5/, name: 'Northgate side', instructions: "Read the contract as Northgate's lawyer: which clauses they will defend hardest, and where they can give way." },
  { slot: 'panelist_2', model: /gpt-4\.1/, name: 'Dutch and EU law', instructions: 'Check the contract against Dutch and EU law: GDPR (a data processing agreement, sub-processors), governing law and courts, and clauses a Dutch court may not enforce.' },
  { slot: 'judge', model: /claude-sonnet-4-5/, name: 'Judge', instructions: 'Do not pick one reading. Combine every clause the readers raised into one risk memo: one line (sign as drafted, or not yet), then "Must change before signing", then "Worth negotiating", each with the clause number, what it says, why it matters and what to ask for. End with where the readers disagreed.' },
]
const slotModel = (slot: string, model: RegExp): Step => ({ select: { role: 'combobox', within: { testid: `slot-${slot}` } }, option: model })
const CONTRACT_QUESTION = 'Northgate sent their draft for the Venlo warehouse. Can you review it before my call with them on Friday?'
const CONTRACT_FILE = 'northgate-fulfilment-agreement.pdf'

const contract = guide('larkspur-contract', 'A contract reviewed by a panel of models', 'cross-vendor-contract-review', ['larkspur-quality'], {
  'con-00': ['00-slack-memo.png', 'The risk memo for the Northgate draft, in a Slack thread', SLACK_RENDER, '/agents/:id/channels/:id'],
  'con-01': ['01-connect-anthropic.png', 'Connect a second provider: Anthropic', MODELS],
  'con-02': ['02-agent.png', 'Contract review: instructions', BUILDER],
  'con-03': ['03-panel.png', 'Work mode Panel: a main model, two panelists from two vendors, a judge', BUILDER],
  'con-04': ['04-panelist-angle.png', "A panelist's extra instructions: read it as the supplier's lawyer", BUILDER],
  'con-05': ['05-slack-live.png', 'Slack channel for Contract review, live', CHANNEL],
  'con-06': ['06-run-roles.png', 'The run: what each model did and what it cost', AGENT],
}, [
  {
    if: { sql: `SELECT count(*) FROM llm_providers WHERE "organizationId" = '{{org.id}}' AND name = 'Anthropic'`, is: '0' },
    then: [{ use: 'connectProvider', with: { name: 'Anthropic', provider: 'Anthropic', key: 'sk-ant-local-demo-key', shot: 'con-01' } }],
  },
  { action: 'contractPdf', save: 'contract' },
  { use: 'newAgent', with: { name: 'Contract review', personality: 'Plain English, no legalese. Short sentences. Numbers exactly as the contract has them.', instructions: CONTRACT_INSTRUCTIONS } },
  { scrollTop: true },
  { shot: 'con-02' },
  { select: { testid: 'work-mode-select' }, option: /^Panel/ },
  slotModel('panelist_1', ROLES[0].model),
  slotModel('panelist_2', ROLES[1].model),
  { click: { role: 'button', name: /Add a judge/ } },
  slotModel('judge', ROLES[2].model),
  ...ROLES.flatMap((r): Step[] => [
    { click: { role: 'button', name: /Name, sampling, extra instructions/, within: { testid: `slot-${r.slot}` } } },
    { fill: { label: 'Name', exact: true, within: { testid: `slot-${r.slot}` } }, value: r.name },
    { fill: { label: 'Extra instructions', within: { testid: `slot-${r.slot}` } }, value: r.instructions },
  ]),
  { scrollTo: { testid: 'work-mode-card' }, offset: 90 },
  { shot: 'con-03' },
  { scrollTo: { testid: 'slot-panelist_1' }, offset: 90 },
  { shot: 'con-04' },
  ...saveAndActivate('agents.contract'),
  { use: 'slackChannel', with: { agent: '{{agents.contract}}', as: 'channels.contract', shot: 'con-05' } },
  { http: { method: 'POST', url: '{{stack.upstream}}/_admin/reset' } },
  {
    action: 'slackMention',
    with: {
      slug: '{{org.slug}}', gateway: '{{channels.contract}}', text: `<@U0BOT> ${CONTRACT_QUESTION}`, channel: 'C0LEGAL', user: 'U0INES',
      files: [{
        id: 'F0NGF0412', name: CONTRACT_FILE, title: CONTRACT_FILE, mimetype: 'application/pdf', filetype: 'pdf', size: '{{contract.size}}',
        url_private: `https://files.slack.com/files-pri/T0LARKSPUR-F0NGF0412/${CONTRACT_FILE}`,
        url_private_download: `https://files.slack.com/files-pri/T0LARKSPUR-F0NGF0412/download/${CONTRACT_FILE}`,
      }],
    },
  },
  ...waitForPost('posts.contract', /Risk memo|cannot see a contract/, 'the memo in Slack', 240000),
  { render: 'larkspurSlack', with: { channel: 'legal-review', agent: 'Contract review', from: 'Ines Duarte', question: CONTRACT_QUESTION, file: CONTRACT_FILE, text: '{{posts.contract|first|get:body.text}}', height: 300 }, shot: 'con-00' },
  { use: 'latestRun', with: { agent: '{{agents.contract}}', shot: 'con-06' } },
])

// ---------- 5. Cap AI spending (govern-ai-spend) ----------
const COPY_INSTRUCTIONS = `You write product descriptions for new products in the Larkspur Home shop.

For each product in the message, write a bold product name and one paragraph of 50 to 70 words: what it is made of, its size, how to care for it. Plain and warm, no superlatives, no exclamation marks. Never invent a material, a size or a certificate the message does not give.`
const COPY_MESSAGE = 'Write product descriptions for: oak serving board (FSC European oak, linseed oil, fits a cheese board for six); linen napkins (set of 4, stonewashed, 45x45 cm, 40 degree wash); ceramic pendant lamp (chalk glaze, 28 cm, 1.5 m cotton cord, E27 up to 60 W).'
const TRY = { placeholder: 'Type a message to test this agent...' } as const
const editAgentBudget: Step[] = [
  { goto: '/analytics/budgets' },
  { click: { role: 'link', name: 'Edit budget', within: { role: 'row', hasText: 'Product copy drafts' } } },
]

const spend = guide('larkspur-spend', 'Cap AI spending with budgets', 'govern-ai-spend', ['larkspur-contract'], {
  'spend-00': ['00-budgets.png', 'Two budgets and the alert from the one that blocked', ANALYTICS],
  'spend-01': ['01-cost.png', 'Analytics, Cost: spend per day and per agent', ANALYTICS],
  'spend-02': ['02-org-budget.png', 'New budget: the whole organization, $300 a month, warn only', BUDGET],
  'spend-03': ['03-agent-budget.png', 'New budget: one agent, $5 a day, block new runs', BUDGET],
  'spend-04': ['04-run-limit.png', 'Run limits: a spending cap of $0.50 per run', BUILDER],
  'spend-05': ['05-blocked.png', 'A run refused because the daily budget is used up', AGENT],
  'spend-06': ['06-notification.png', 'The alert in notifications', ['frontend/src/pages/notifications.tsx']],
}, [
  { use: 'newAgent', with: { name: 'Product copy drafts', personality: 'Warm and plain.', instructions: COPY_INSTRUCTIONS } },
  ...saveAndActivate('agents.spend'),
  { use: 'ask', with: { agent: '{{agents.spend}}', message: COPY_MESSAGE, answer: /Oak serving board/ } },
  { goto: '/analytics/cost' },
  { shot: 'spend-01' },
  { use: 'budget', with: { limit: '300', period: 'Per month', behavior: 'Warn only', shot: 'spend-02' } },
  { use: 'budget', with: { agent: 'Product copy drafts', limit: '5', period: 'Per day', behavior: 'Block new runs', shot: 'spend-03' } },
  // The per-run cap, on the agent's edit page.
  { goto: '/agents/{{agents.spend}}/edit' },
  { scrollTo: { text: 'Run limits', exact: true }, block: 'nearest' },
  { click: { role: 'button', name: /Change steps, cost, time/ } },
  { fill: { label: 'Spending cap ($)' }, value: '0.50' },
  { scrollTo: { text: 'Run limits', exact: true }, offset: 100 },
  { shot: 'spend-04' },
  { click: { role: 'button', name: 'Save', exact: true } },
  // See the block work: lower the agent's budget below what it already spent today, try it, then put it back.
  ...editAgentBudget,
  { use: 'budget', with: { limit: '0.02', edit: true } },
  {
    repeat: [
      { goto: '/agents/{{agents.spend}}' },
      { fill: TRY, value: COPY_MESSAGE },
      { press: TRY, key: 'Enter' },
      { waitFor: { role: ['status', 'alert'], hasText: /Oak serving board|budget/i }, timeout: 120000 },
    ],
    while: { not: { visible: { role: 'alert', hasText: /budget/i } } },
    max: 10,
  },
  { scrollTo: { text: 'Try it', exact: true }, offset: 90 },
  { shot: 'spend-05' },
  { goto: '/notifications' },
  { shot: 'spend-06' },
  // Back to the real limit.
  ...editAgentBudget,
  { use: 'budget', with: { limit: '5', edit: true } },
  { goto: '/analytics/budgets' },
  { shot: 'spend-00' },
])

export const guides = [payouts, ask, quality, contract, spend]
