// The five engineering examples in docs-site/content/examples, walked
// through the UI step by step as their text says: sort GitHub issues
// (triage), a first pass on pull requests (review), on-call summaries from
// PagerDuty (oncall), an old SOAP service (soap) and several coding
// assistants through a runner (fleet).
//
// They work as Ines Duarte of "Tidewater Labs", and each starts where a new
// customer starts: her organization is made afresh first (tidewaterStart).
// The fake tidewater service stands in for GitHub, PagerDuty, the SOAP stock
// system and the model; the API descriptions of GitHub and PagerDuty are
// their real public ones (GitHub's cut down by github-subset.mjs here);
// only the address is the fake's, set under Advanced when connecting. Slack
// goes to the outbox. Each walk resets the fakes first. In the fleet
// walk a real runner (@almyty/runner, ALMYTY_RUNNER_BIN or PATH) runs the
// Claude Code and Codex installed and signed in on this machine, on a small
// sample library it writes to /tmp/tidewater/ledgerly-utils.
import type { Locator, Step } from '../../engine/schema.ts'
import { demoPassword } from '../../engine/password.ts'

export const INES = { email: 'ines.duarte@tidewater.example', password: demoPassword(), firstName: 'Ines', lastName: 'Duarte', organizationName: 'Tidewater Labs', signIn: 'none' as const }

const NOTE = 'Example guide step, walked through the UI on the local demo stack (scripts/demo-seed, walks/tidewater): real public API descriptions (GitHub, PagerDuty), a local stand-in for GitHub, PagerDuty, Slack and a SOAP stock system, a scripted stand-in model, and for the coding fleet the real Claude Code and Codex CLIs on the runner machine; fictional people and companies. Not staging or production data.'
const RENDERED_NOTE = `${NOTE} The page renders the message exactly as almyty handed it to the provider; that provider was not used.`

// The shared UI (components/ui, components/layout, index.css) is never a source: check-screenshots rejects it as too broad.
const AGENT = ['frontend/src/pages/agent-detail.tsx', 'frontend/src/components/agents']
const BUILDER = ['frontend/src/pages/agent-builder.tsx', 'frontend/src/components/agents']
const MODELS = ['frontend/src/pages/models-connect.tsx', 'frontend/src/components/llm-providers']
const API_NEW = ['frontend/src/pages/api-new-description.tsx']
const API_PAGE = ['frontend/src/pages/api-detail.tsx', 'frontend/src/components/apis']
const SETUP = ['frontend/src/pages/api-setup.tsx', 'frontend/src/components/apis/api-key-form.tsx']
const TOOL = ['frontend/src/pages/tool-detail.tsx']
const SCHEDULE = ['frontend/src/pages/agent-schedule.tsx']
const CHANNEL = ['frontend/src/pages/agent-channel.tsx', 'frontend/src/components/channels']
const ALWAYS_ON = ['frontend/src/pages/agent-always-on.tsx']
const RUNNERS = ['frontend/src/pages/runners.tsx', 'frontend/src/pages/runner-new.tsx', 'frontend/src/pages/runner-detail.tsx']
const GATEWAYS = ['frontend/src/pages/gateway-new.tsx', 'frontend/src/pages/gateway-detail.tsx', 'frontend/src/components/gateways']

type ShotRow = [string, string, string, string[], string?]
function walk(id: string, title: string, dir: string, shots: ShotRow[], steps: Step[], notes = NOTE) {
  return {
    id, title, profile: 'tidewater', account: INES, notes,
    // The model key goes to the fake instead of OpenAI.
    browser: { providerUrl: '{{tw.url}}/openai/v1' },
    shots: Object.fromEntries(shots.map(([shot, file, t, sources, route]) => [shot, { path: `screenshots/examples/${dir}/${file}.png`, title: t, sources, ...(route ? { route } : {}) }])),
    steps: [{ action: 'tidewaterStart', save: 'tw' }, ...steps],
  }
}

const shot = (id: string): Step => ({ shot: id })
const press = (name: string | RegExp, exact = false): Step => ({ click: { role: 'button', name, exact } })
const field = (name: string | RegExp): Locator => ({ role: 'textbox', name, exact: typeof name === 'string' })
const TOOLS_HEADING = { scrollTo: { role: 'heading', name: 'Tools and APIs' }, block: 'nearest' } as const
const KEY_FIELD: Locator = { label: 'Key', exact: true, within: { testid: 'credential-form' } }

const openAI = (shotId?: string): Step[] => [
  { use: 'connectOpenAI', with: { key: 'sk-proj-0000000000000000000000000000000000000000' } },
  ...(shotId ? [shot(shotId)] : []),
]

// "Add a key" on an API's page: pick how it is sent, then a new credential.
const addKey = (how: string, name: string, fill: Step[], shotId: string): Step[] => [
  press('Add a key'),
  { select: { role: 'combobox', name: 'How it is sent' }, option: how },
  press('Create one here'),
  { fill: { ...field('Name'), nth: 'last' }, value: name },
  ...fill,
  { scrollTo: { text: 'How it is sent' }, offset: 200 },
  shot(shotId),
  { click: { role: 'button', name: 'Save', exact: true, nth: 'first' } },
  // Saved: the key card names the credential it sends.
  { waitFor: { role: 'link', name: 'Open credential' }, timeout: 15000 },
]

const connectGitHub = (shots: { connect: string; key: string; api: string }): Step[] => [
  { goto: '/apis/new/openapi' },
  { click: { role: 'tab', name: 'File' } },
  { upload: { label: 'Choose a file', exact: true }, file: '{{tw.githubFile}}' },
  press('Advanced'),
  { fill: { label: 'Name', exact: true }, value: 'GitHub' },
  shot(shots.connect),
  // The local stand-in, not api.github.com.
  { fill: { label: 'Address', exact: true }, value: '{{tw.url}}' },
  press('Connect API'),
  { waitForUrl: /\/apis\/[0-9a-f-]{36}/, timeout: 120000 },
  { waitFor: { text: 'Tools generated' }, timeout: 120000 },
  ...addKey('As a bearer token', 'GitHub token (ledgerly)', [
    { fill: KEY_FIELD, value: 'github_pat_11BTWLABS0dEmO0nLyLocalTestToken0000000000000000000000000000' },
  ], shots.key),
  { scrollTop: true },
  shot(shots.api),
]

const newAgent = (name: string, personality: string, instructions: string): Step =>
  ({ use: 'newAgent', with: { name, model: /gpt-4\.1(?!-mini)/, personality, instructions } })

const tools = (list: string[], shotId: string): Step[] => [{ use: 'pickTools', with: { tools: list } }, TOOLS_HEADING, shot(shotId)]

const saveAndActivate = (as: string): Step[] => [
  { use: 'saveAgent', with: { as } },
  { goto: `/agents/{{${as}}}` },
  press('Activate'),
  { waitFor: { role: 'button', name: 'Deactivate' }, timeout: 15000 },
]

// Ask in Try it; the hero is the whole card, answer included, for the top of the guide.
// Without a message, the question was asked by the steps before.
const tryIt = (message: string | undefined, answer: RegExp, shotId: string, hero?: string, timeout = 120000): Step[] => [
  ...(message === undefined ? [] : [
    { fill: { placeholder: 'Type a message to test this agent...' }, value: message },
    { press: { placeholder: 'Type a message to test this agent...' }, key: 'Enter' },
  ] as Step[]),
  { waitFor: { role: 'status', hasText: answer }, timeout },
  { scrollTo: { role: 'heading', name: 'Try it' }, block: 'nearest' },
  shot(shotId),
  ...(hero ? [
    { viewport: { width: 1440, height: 2600 } },
    { action: 'tryItCard' },
    { shot: hero, clip: { testid: 'demo-clip' }, pad: 16 },
    { viewport: { width: 1440, height: 900 } },
  ] as Step[] : []),
]

const runSteps = (agent: string, shotId: string): Step[] => [
  { goto: `/agents/{{${agent}}}` },
  { click: { role: 'tab', name: 'Runs' } },
  // The newest run: its row opens it.
  { click: { role: 'button', name: /^(completed|failed)/, within: { role: 'tabpanel', name: 'Runs' } } },
  shot(shotId),
]

const everyFew = (agent: string, every: number, unit: string, message: string, shotId: string): Step[] => [
  { goto: `/agents/{{${agent}}}/schedule` },
  { select: { role: 'combobox', name: 'Repeat' }, option: 'Every few minutes or hours' },
  { fill: { role: 'spinbutton', name: 'Every' }, value: String(every) },
  { select: { role: 'combobox', name: 'Unit' }, option: unit },
  { fill: field('Message'), value: message },
  shot(shotId),
  press('Save schedule'),
]

const testTool = (search: string, name: string, params: Step[], shotId: string): Step[] => [
  { goto: '/tools' },
  { fill: { placeholder: 'Search tools...' }, value: search },
  { settle: true },
  // The list shows the tool by its title, with its machine name as the tooltip.
  { click: { title: name, exact: true } },
  { click: { role: 'tab', name: 'Test tool' } },
  ...params,
  press('Execute Tool'),
  { waitFor: { text: 'Response Data:' }, timeout: 20000 },
  { scrollTo: { text: 'Response Data:' }, block: 'nearest' },
  shot(shotId),
]

// ---------- sort new GitHub issues ----------

const TRIAGE_INSTRUCTIONS = `You triage new issues in the GitHub repository tidewater-labs/ledgerly.

Every time you run:
1. Read the repository's labels, then list the open issues created in the last 24 hours that have no labels yet.
2. For each one, search the repository for an older issue about the same problem.
3. Add labels: exactly one of bug, feature or question; the area label that fits (area: pdf-export, area: payments, area: invoices, area: mobile); duplicate if an older issue covers it; needs-repro for a bug report without steps to reproduce. Pass the labels as "labels", a list of label names.
4. Comment only in two cases: on a duplicate, link the older issue; on a bug report without steps, ask for them (what they did, web or app and which version, whether it happens every time).
5. Never close, assign or edit an issue, and never use the core-team label.

Finish with a short list: each issue, the labels you added, and who should look at it:
- area: pdf-export: @ines-duarte
- area: payments: @tomas-reyes
- area: invoices: @lena-fischer
- area: mobile: @kai-nakamura
Point out anything that looks urgent, such as something that broke in the last release.`

const triage = walk('example-issue-triage', 'Sort new GitHub issues', 'github-issue-triage', [
  ['triage-00-result', '00-result', 'Issue triage: the report of a run', AGENT],
  ['triage-01-model', '01-model', 'OpenAI connected', MODELS],
  ['triage-02-connect', '02-connect', 'Connect an API: the GitHub file', API_NEW],
  ['triage-03-key', '03-key', 'GitHub token as a bearer token', SETUP],
  ['triage-04-api', '04-api', 'GitHub connected: 12 tools', API_PAGE],
  ['triage-05-test-tool', '05-test-tool', 'Testing github_issues_list_for_repo', TOOL],
  ['triage-06-agent', '06-agent', 'Issue triage: model and instructions', BUILDER],
  ['triage-07-tools', '07-tools', 'Issue triage: five tools', BUILDER],
  ['triage-08-try', '08-try', 'Issue triage: Try it', AGENT],
  ['triage-09-run', '09-run', 'Issue triage: the run step by step', AGENT],
  ['triage-10-schedule', '10-schedule', 'Issue triage: every hour', SCHEDULE],
], [
  ...openAI('triage-01-model'),
  ...connectGitHub({ connect: 'triage-02-connect', key: 'triage-03-key', api: 'triage-04-api' }),
  ...testTool('issues_list_for_repo', 'github_issues_list_for_repo', [
    { fill: { placeholder: 'Enter owner' }, value: 'tidewater-labs' },
    { fill: { placeholder: 'Enter repo' }, value: 'ledgerly' },
  ], 'triage-05-test-tool'),
  newAgent('Issue triage', 'Friendly and short. Thanks people for reporting, never blames them.', TRIAGE_INSTRUCTIONS),
  shot('triage-06-agent'),
  ...tools(['github_issues_list_labels_for_repo', 'github_issues_list_for_repo', 'github_search_issues_and_pull_requests', 'github_issues_add_labels', 'github_issues_create_comment'], 'triage-07-tools'),
  ...saveAndActivate('agents.triage'),
  ...tryIt('Triage the new issues in tidewater-labs/ledgerly.', /I did not close/, 'triage-08-try', 'triage-00-result'),
  ...runSteps('agents.triage', 'triage-09-run'),
  ...everyFew('agents.triage', 1, 'hours', 'Triage the new issues in tidewater-labs/ledgerly.', 'triage-10-schedule'),
])

// ---------- a first pass on pull requests ----------

const REVIEW_INSTRUCTIONS = `You give pull requests in tidewater-labs/ledgerly a first review, before a person looks at them.

For each open pull request you have not reviewed yet:
1. Read the pull request and the files it changes.
2. Look for: bugs in the changed lines, money amounts that are not rounded to cents, secrets or keys in the code, new dependencies that are not on our list, and new code without tests.
3. Post one review with event COMMENT: a short summary at the top and a comment on each line concerned (path, line, side RIGHT). Say why it matters and what to do instead.
4. Never approve or request changes, and leave style and formatting alone.
5. Put code names in double quotes, never in backticks.

Allowed dependencies: date-fns, zod, pdfkit, pg, stripe, express.

Finish with the pull requests you reviewed and what you found.`

const review = walk('example-pr-review', 'A first pass on pull requests', 'pr-review-bot', [
  ['review-00-on-github', '00-review-on-github', 'The review as sent to GitHub', ['backend/src/modules/tools/executors/tool-http.executor.ts'], '/agents/:id'],
  ['review-01-model', '01-model', 'OpenAI connected', MODELS],
  ['review-02-connect', '02-connect', 'Connect an API: the GitHub file', API_NEW],
  ['review-03-key', '03-key', 'GitHub token as a bearer token', SETUP],
  ['review-04-api', '04-api', 'GitHub connected: 12 tools', API_PAGE],
  ['review-05-agent', '05-agent', 'Pull request review: model and instructions', BUILDER],
  ['review-06-tools', '06-tools', 'Pull request review: five tools', BUILDER],
  ['review-07-try', '07-try', 'Pull request review: Try it', AGENT],
  ['review-08-run', '08-run', 'Pull request review: the run step by step', AGENT],
  ['review-09-schedule', '09-schedule', 'Pull request review: every 30 minutes', SCHEDULE],
], [
  ...openAI('review-01-model'),
  ...connectGitHub({ connect: 'review-02-connect', key: 'review-03-key', api: 'review-04-api' }),
  newAgent('Pull request review', 'Direct and kind, like a senior colleague. Explains why, suggests the fix, no nitpicks.', REVIEW_INSTRUCTIONS),
  shot('review-05-agent'),
  ...tools(['github_pulls_list', 'github_pulls_list_reviews', 'github_pulls_get', 'github_pulls_list_files', 'github_pulls_create_review'], 'review-06-tools'),
  ...saveAndActivate('agents.review'),
  ...tryIt('Review the open pull requests in tidewater-labs/ledgerly.', /Posted as a comment review/, 'review-07-try'),
  ...runSteps('agents.review', 'review-08-run'),
  ...everyFew('agents.review', 30, 'minutes', 'Review the open pull requests in tidewater-labs/ledgerly that you have not reviewed yet.', 'review-09-schedule'),
  // What GitHub received, laid out the way GitHub shows a review.
  { http: { url: '{{tw.url}}/_admin/state' }, save: 'github' },
  { http: { url: '{{tw.url}}/_admin/files' }, save: 'patch' },
  { render: 'githubReview', with: { review: '{{github.reviews|first}}', patch: '{{patch}}' }, shot: 'review-00-on-github', clip: { testid: 'clip' } },
], RENDERED_NOTE)

// ---------- on-call summaries from PagerDuty ----------

const ONCALL_INSTRUCTIONS = `You help whoever is on call for Ledgerly. Incidents are in PagerDuty.

Every time you wake:
1. List the incidents that are triggered or acknowledged on the Ledgerly API service (PLDG3RA).
2. Skip any incident that already has a note from you.
3. For each new one, read its alerts: they carry the monitor's details. Then list the resolved incidents on the same service from the last 90 days, and read the notes of those with the same title: they say what fixed it last time.
4. Add a note to the incident, written as oncall-bot@tidewater.example (the From field): what fired, the most likely cause, what fixed it last time and the first thing to check. Under 120 words.
5. Report the same summary, with the links to the incident, the runbook and the dashboard.

Only read incidents and add notes. Never acknowledge, resolve, reassign or change an incident.`

const oncall = walk('example-oncall', 'On-call summaries from PagerDuty', 'oncall-alert-triage', [
  ['oncall-00-slack', '00-slack', 'The on-call summary as posted to Slack', ['frontend/src/pages/agent-always-on.tsx', 'backend/src/modules/gateways/channels/adapters/slack.adapter.ts', 'backend/src/modules/gateways/channels/adapters/channel-markdown.ts'], '/agents/:id/always-on'],
  ['oncall-01-model', '01-model', 'OpenAI connected', MODELS],
  ['oncall-02-connect', '02-connect', "PagerDuty's description link", API_NEW],
  ['oncall-03-found', '03-found', 'PagerDuty: 473 tools made, a key needed', SETUP],
  ['oncall-04-key', '04-key', 'The PagerDuty key', SETUP],
  ['oncall-05-agent', '05-agent', 'On-call summaries: model and instructions', BUILDER],
  ['oncall-06-tools', '06-tools', 'On-call summaries: four PagerDuty tools', BUILDER],
  ['oncall-07-slack-key', '07-slack-key', 'Slack bot token and signing secret', CHANNEL],
  ['oncall-08-slack-live', '08-slack-live', 'Slack channel, live', CHANNEL],
  ['oncall-09-always-on', '09-always-on', 'Always on: every 15 minutes', ALWAYS_ON],
  ['oncall-10-act', '10-act', 'Always on: acts on its own', ALWAYS_ON],
  ['oncall-11-card', '11-card', 'The Always on card', AGENT],
], [
  ...openAI('oncall-01-model'),
  // PagerDuty's real description, read from its public address; calls go to the local stand-in.
  { goto: '/apis/new/openapi' },
  { fill: { label: 'Link to the description' }, value: 'https://raw.githubusercontent.com/PagerDuty/api-schema/main/reference/REST/openapiv3.json' },
  press('Advanced'),
  { fill: { label: 'Name', exact: true }, value: 'PagerDuty' },
  shot('oncall-02-connect'),
  { fill: { label: 'Address', exact: true }, value: '{{tw.url}}' },
  press('Connect API'),
  { waitForUrl: /\/setup/, timeout: 120000 },
  { waitFor: { text: /Found \d+ operation/ }, timeout: 600000 },
  shot('oncall-03-found'),
  press('Create one here'),
  { fill: { ...field('Name'), nth: 'last' }, value: 'PagerDuty API key' },
  { fill: KEY_FIELD, value: 'Token token=y_NbAkKc66ryYTWUXYEu' },
  shot('oncall-04-key'),
  { click: { role: 'button', name: 'Save', exact: true, nth: 'first' } },
  { waitFor: { text: 'Saved. Tools send it with every call.' }, timeout: 15000 },

  newAgent('On-call summaries', 'Calm and to the point. Facts from the alert first, then the likely cause. Says when it is not sure.', ONCALL_INSTRUCTIONS),
  shot('oncall-05-agent'),
  ...tools(['pagerduty_list_incidents', 'pagerduty_list_incident_alerts', 'pagerduty_list_incident_notes', 'pagerduty_create_incident_note'], 'oncall-06-tools'),
  ...saveAndActivate('agents.oncall'),

  // Slack, with a bot token (its calls land in the outbox).
  { goto: '/agents/{{agents.oncall}}/channels/new' },
  press(/^Slack/),
  press(/^Advanced/),
  { click: { role: 'button', name: 'Create one here', nth: 'last' } },
  press('More options'),
  { click: { role: 'radio', name: 'Bot token' } },
  { fill: { ...field('Name'), nth: 'last' }, value: 'Slack bot (Tidewater)' },
  { fill: field('Bot user OAuth token'), value: 'xoxb-local-test-0000000000-222222222' },
  { fill: field('Signing secret'), value: 'local-test-signing-secret-0123456789' },
  { scrollTo: field('Bot user OAuth token'), block: 'nearest' },
  shot('oncall-07-slack-key'),
  { click: { role: 'button', name: 'Save', exact: true, nth: 'first' } },
  { waitFor: { role: 'textbox', name: 'Bot user OAuth token' }, state: 'hidden', timeout: 15000 },
  { if: { enabled: { role: 'button', name: 'Save', exact: true, nth: 'last' } }, then: [{ click: { role: 'button', name: 'Save', exact: true, nth: 'last' } }] },
  press('Publish', true),
  { waitFor: { role: 'button', name: 'Unpublish' }, timeout: 20000 },
  { scrollTop: true },
  shot('oncall-08-slack-live'),

  // Always on
  { goto: '/agents/{{agents.oncall}}/always-on' },
  { fill: field('Standing instructions'), value: 'Watch PagerDuty for new incidents on the Ledgerly API. For each one you have not seen, add your summary as a note and report it.' },
  { fill: { role: 'spinbutton', name: 'Every' }, value: '15' },
  { select: { role: 'combobox', name: 'Unit' }, option: 'minutes' },
  { select: { role: 'combobox', name: 'On its own, it' }, option: /Does things/ },
  { uncheck: { role: 'checkbox', name: /^pagerduty_/ }, all: true },
  { select: { role: 'combobox', name: 'Post reports to' }, option: /Slack/ },
  { fill: { placeholder: 'C0123ABCDEF' }, value: 'C07INCIDNTS' },
  { click: { role: 'switch', name: 'Always on' } },
  { scrollTo: { role: 'heading', name: 'What wakes it' }, block: 'nearest' },
  shot('oncall-09-always-on'),
  { scrollTo: { text: 'Ask me first before', exact: true }, offset: 260 },
  shot('oncall-10-act'),
  press('Save', true),
  { goto: '/agents/{{agents.oncall}}' },
  press('Wake now'),
  { until: { http: { url: '{{stack.upstream}}/_admin/state' }, at: 'outbox', where: { url: { contains: 'chat.postMessage' }, 'body.channel': 'C07INCIDNTS', 'body.text': /#1187/ } }, timeout: 180000, every: 3000, save: 'posted', what: 'the report in Slack' },
  { goto: '/agents/{{agents.oncall}}' },
  { scrollTo: { role: 'heading', name: 'Always on' }, block: 'nearest' },
  shot('oncall-11-card'),
  { render: 'slackIncident', with: { text: '{{posted|first|get:body.text}}' }, shot: 'oncall-00-slack', clip: { testid: 'clip' } },
], RENDERED_NOTE)

// ---------- the old SOAP stock service ----------

const STOCK_INSTRUCTIONS = `You answer the sales team's questions about stock at Harbor Supply, from the stock system.

Warehouses: RTM is Rotterdam, ANR is Antwerp, HAM is Hamburg.
Article numbers look like HS-10442.

When someone asks you to reserve stock, reserve it only if that warehouse has enough on hand, and always give the order reference. Answer with the reservation number. If the stock system refuses, say why in plain words.`

const soap = walk('example-legacy-soap', 'Modernize an old SOAP service', 'modernize-legacy-soap', [
  ['soap-00-result', '00-result', 'Stock assistant: an answer from the SOAP system', AGENT],
  ['soap-01-connect', '01-connect', 'Connect an API: the WSDL file', ['frontend/src/pages/api-new-description.tsx']],
  ['soap-02-api', '02-api', 'The SOAP service connected: three tools', API_PAGE],
  ['soap-03-key', '03-key', 'The service account as a username and password', SETUP],
  ['soap-04-test-tool', '04-test-tool', 'Testing the stock level tool', TOOL],
  ['soap-05-agent', '05-agent', 'Stock assistant: model and instructions', BUILDER],
  ['soap-06-tools', '06-tools', 'Stock assistant: three tools', BUILDER],
  ['soap-07-try', '07-try', 'Stock assistant: Try it', AGENT],
  ['soap-08-run', '08-run', 'Stock assistant: the run step by step', AGENT],
  ['soap-09-gateway-new', '09-gateway-new', 'Create gateway: MCP with the stock tools', GATEWAYS],
  ['soap-10-gateway', '10-gateway', 'The MCP gateway and its Claude Code command', GATEWAYS],
], [
  // The WSDL as IT would hand it over: a file, since the service is on an internal address.
  { http: { url: '{{tw.url}}/StockService.asmx?wsdl' }, save: 'wsdl' },
  { action: 'writeFile', with: { name: 'StockService.wsdl', text: '{{wsdl}}' }, save: 'files.wsdl' },
  ...openAI(),
  { goto: '/apis/new/soap' },
  { click: { role: 'tab', name: 'File' } },
  { upload: { label: 'Choose a file', exact: true }, file: '{{files.wsdl}}' },
  press('Advanced'),
  { fill: { label: 'Name', exact: true }, value: 'Harbor stock system' },
  shot('soap-01-connect'),
  press('Connect API'),
  { waitForUrl: /\/apis\/[0-9a-f-]{36}/, timeout: 120000 },
  { waitFor: { text: 'Tools generated' }, timeout: 120000 },
  shot('soap-02-api'),
  ...addKey('As a username and password', 'Stock system service account', [
    { fill: { role: 'textbox', name: /user ?name/i, nth: 'last' }, value: 'svc-almyty' },
    { fill: { label: /^Password/, within: { testid: 'credential-form' } }, value: 'Harbor-2009!' },
  ], 'soap-03-key'),
  ...testTool('get_stock_level', 'harbor_stock_system_get_stock_level', [{ fill: { placeholder: /Sku/ }, value: 'HS-10442' }], 'soap-04-test-tool'),
  newAgent('Stock assistant', 'Short and exact. Numbers first.', STOCK_INSTRUCTIONS),
  shot('soap-05-agent'),
  ...tools(['harbor_stock_system_get_stock_level', 'harbor_stock_system_reserve_stock', 'harbor_stock_system_list_warehouses'], 'soap-06-tools'),
  ...saveAndActivate('agents.stock'),
  ...tryIt('Do we have 600 rolls of pallet wrap HS-10442 in Rotterdam? If yes, reserve them for order SO-55120.', /reservation|refused|Not enough/i, 'soap-07-try', 'soap-00-result'),
  ...runSteps('agents.stock', 'soap-08-run'),
  // An MCP gateway, so coding assistants can use the old system too.
  { goto: '/gateways/new' },
  { click: { role: 'button', name: /^MCP/ } },
  { click: { role: 'button', name: /Harbor stock system/ } },
  { fill: { label: 'Name', exact: true }, value: 'Harbor stock' },
  shot('soap-09-gateway-new'),
  press('Create gateway'),
  { waitForUrl: /\/gateways\/[0-9a-f-]{36}/, timeout: 30000 },
  shot('soap-10-gateway'),
])

// ---------- several coding assistants on one task ----------

const FLEET_INSTRUCTIONS = `You lead a small team of coding assistants on the machine ines-macbook. You plan and check; the assistants write the code.

For each task:
1. List the coding assistants on the machine.
2. Get the code: cp -R /tmp/tidewater/ledgerly-utils app && cd app && git init -q && git add -A && git commit -qm start
3. Split the task in two: the code, and the tests for it.
4. Give the code to Claude Code: cd app && claude -p "<the code part>" --permission-mode acceptEdits
5. Give the tests to Codex: cd app && codex exec --sandbox workspace-write "<the test part>" < /dev/null
6. Run the tests: cd app && npm test
7. Show what changed: cd app && git add -A && git diff --cached --stat

Then report who did what, whether the tests pass, and which files changed. Never push or publish anything.`
const FLEET_TASK = 'Add formatIban(iban) to ledgerly-utils: it removes spaces, makes the letters upper case, checks the IBAN checksum (mod 97) and returns the IBAN in groups of four, or throws an Error for an invalid IBAN. Export it from src/index.js.'
// How long the coding run may take: the agent's run timeout and the walk's
// wait for it. Claude Code and Codex at work on a loaded machine take from
// a few minutes to well past the 15 a run gets by default; set
// DEMO_FLEET_RUN_MINUTES to wait longer (the deployment's ceiling on a run,
// RUN_LIMIT_MAX_DURATION_MS, is an hour unless set).
export const FLEET_RUN = {
  minutes: Number(process.env.DEMO_FLEET_RUN_MINUTES) || 45,
  // Try it polls a long run every few seconds; on a loaded machine the page may lag behind the run.
  answerMs: 180_000,
}

const fleet = walk('example-coding-fleet', 'Several coding assistants on one task', 'multi-vendor-coding-fleet', [
  ['fleet-00-result', '00-result', 'Coding lead: the report of a run', AGENT],
  ['fleet-01-model', '01-model', 'OpenAI connected', MODELS],
  ['fleet-02-start-runner', '02-start-runner', 'Start a runner: the commands', RUNNERS],
  ['fleet-03-runners', '03-runners', 'The runner, online', RUNNERS],
  ['fleet-04-runner', '04-runner', 'The coding assistants the runner found', RUNNERS],
  ['fleet-05-agent', '05-agent', 'Coding lead: model and instructions', BUILDER],
  ['fleet-06-tools', '06-tools', 'Coding lead: the runner tools', BUILDER],
  ['fleet-07-only-you', '07-only-you', 'Coding lead: only you', BUILDER],
  ['fleet-08-try', '08-try', 'Coding lead: Try it', AGENT],
  ['fleet-09-run', '09-run', 'Coding lead: the run step by step', AGENT],
], [
  { action: 'sampleLibrary' },
  ...openAI('fleet-01-model'),
  { goto: '/runners' },
  { click: { role: ['link', 'button'], name: 'Start a runner' } },
  shot('fleet-02-start-runner'),
  // Ines starts the runner on her laptop; "almyty login" opens a browser, here her token stands in.
  { action: 'startRunner', with: { name: 'ines-macbook' } },
  { until: { sql: "SELECT count(*) FROM runners WHERE name = 'ines-macbook' AND state = 'online'", not: '0' }, timeout: 180000, what: 'the runner to come online' },
  { goto: '/runners' },
  shot('fleet-03-runners'),
  { click: { role: ['link', 'row'], name: /ines-macbook/ } },
  { scrollTo: { text: /^Coding agents/ }, offset: 140 },
  shot('fleet-04-runner'),
  newAgent('Coding lead', 'Plans before acting, keeps each assistant to one clear job, reports plainly what changed.', FLEET_INSTRUCTIONS),
  shot('fleet-05-agent'),
  { fill: { role: 'textbox', name: 'Search tools' }, value: 'ines-macbook' },
  { settle: true },
  { expand: { role: 'button', name: /\d+ tools?/ } },
  { check: { role: 'checkbox', name: /runner\.ines-macbook\.(agent\.list|shell\.exec)/ }, all: true },
  TOOLS_HEADING,
  shot('fleet-06-tools'),
  { fill: { role: 'textbox', name: 'Search tools' }, value: '' },
  // The runner is private to Ines; picking its tools makes the agent private to her too.
  press('Only you'),
  shot('fleet-07-only-you'),
  { key: 'Escape' },
  // Real coding assistants at work take minutes, more than a run's default 15: give the run the time.
  { click: { role: 'button', name: /^Advanced.*cost, time/ } },
  { fill: { label: 'Timeout (seconds)' }, value: String(FLEET_RUN.minutes * 60) },
  ...saveAndActivate('agents.fleet'),
  // Wait on the run itself, as long as it may take, then on Try it showing its answer.
  { fill: { placeholder: 'Type a message to test this agent...' }, value: FLEET_TASK },
  { press: { placeholder: 'Type a message to test this agent...' }, key: 'Enter' },
  { until: { sql: `SELECT count(*) FROM agent_runs WHERE "agentId" = '{{agents.fleet}}' AND status NOT IN ('pending', 'running')`, not: '0' }, timeout: FLEET_RUN.minutes * 60_000, every: 10_000, what: 'the coding run to finish' },
  // git's own summary line: a run whose commands failed reports no files changed and stops the walk here.
  ...tryIt(undefined, /\d+ files? changed, \d+ insertion/, 'fleet-08-try', 'fleet-00-result', FLEET_RUN.answerMs),
  ...runSteps('agents.fleet', 'fleet-09-run'),
  { action: 'stopRunner' },
])

export const guides = [triage, review, oncall, soap, fleet]
