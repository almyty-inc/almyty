// The use-case guides in docs-site/content/examples, walked through the UI
// one step at a time as each guide's text says, one screenshot per step. A
// step that cannot be done as written fails here, and the guide is
// rewritten, not the walk.
//
// They work in an organization of their own, "Northwind", signed in as Sam
// Rivera, so every guide starts where a new customer starts. Two things
// differ from a real account, both because the fake systems are on
// localhost: the provider key is sent with the fake vendor's address, and
// API descriptions are uploaded as files (almyty refuses links to local
// addresses). Each guide builds on the ones before it (the model connected
// in the first).
import type { Locator, Step } from '../../engine/schema.ts'

export const SAM = { email: 'sam.rivera@northwind.ai', password: 'Northwind-local-2026!', firstName: 'Sam', lastName: 'Rivera', organizationName: 'Northwind' }

const NOTE = 'Use-case guide step, walked through the UI on the local seeded demo stack (scripts/demo-seed, walks/northwind/guides.ts); fake model vendor and company systems, not staging or production data.'
const BROWSER = { providerUrl: { openai: '{{stack.fake}}/openai/v1', mistral: '{{stack.fake}}/mistral/v1', openrouter: '{{stack.fake}}/openrouter/v1', '*': '{{stack.fake}}/openai/v1' } }

const API_DETAIL = ['frontend/src/pages/api-detail.tsx', 'frontend/src/components/apis']
const BUILDER = ['frontend/src/pages/agent-builder.tsx', 'frontend/src/components/agents']
const DETAIL = ['frontend/src/pages/agent-detail.tsx', 'frontend/src/components/agents']
const CHANNEL = ['frontend/src/pages/agent-channel.tsx', 'frontend/src/components/channels']
const KEYS = [...CHANNEL, 'frontend/src/components/connect']
const CHAT = ['frontend/src/pages/hosted-chat.tsx', 'frontend/src/lib/hosted-chat.ts']

// What reads as a button may be a link underneath; the reader cannot tell and does not care.
const press = (name: string | RegExp, exact = false): Step => ({ click: { role: ['button', 'link'], name, exact } })
const link = (name: string | RegExp): Step => ({ click: { role: 'link', name } })
const tab = (name: string): Step => ({ click: { role: 'tab', name } })
// Bring a section to the top of the screen, as a reader scrolls to it.
const show = (text: string): Step => ({ scrollTo: { text, exact: true }, offset: 90 })
const label = (l: string): Locator => ({ label: l, exact: true })
const TRY = { placeholder: 'Type a message to test this agent...' } as const

// The API descriptions, as files the way a customer downloads them.
const specFile = (key: string): Step[] => [
  { http: { url: `{{stack.fake}}/${key}/openapi.json` }, save: `spec.${key}` },
  { action: 'writeFile', with: { name: `northwind-${key}-openapi.json`, json: `{{spec.${key}}}` }, save: `files.${key}` },
]

const uploadSpec = (key: string): Step[] => [
  { goto: '/apis' },
  link('Connect an API'),
  { click: { testid: 'api-kind-openapi' } },
  tab('File'),
  { upload: { label: 'Choose a file', exact: true }, file: `{{files.${key}}}` },
]

const connected = (summary: string, name: string, key: string): Step[] => [
  press('Connect API'),
  { waitForUrl: /\/apis\/[0-9a-f-]{36}/, timeout: 30000 },
  { waitFor: { text: summary }, timeout: 30000 },
  { remember: `apis.${key}` },
  show('API operations'),
]

const newAgent = (name: string, model: RegExp, personality: string, instructions: string): Step[] => [
  press('Create agent'),
  press('Autonomous'),
  { fill: { placeholder: 'Agent name' }, value: name },
  { select: { role: 'combobox', name: 'Model' }, option: model },
  { fill: { label: 'Personality and style' }, value: personality },
  { fill: { label: 'Instructions' }, value: instructions },
]

const pickApiTools = (name: string, key: string): Step => ({
  click: { role: 'checkbox', name: `All tools of ${name}, including ones added later`, exact: true, within: { testid: `tool-group-{{apis.${key}}}` } },
})

const saveAgent = (as: string): Step[] => [
  press('Save', true),
  { waitForUrl: /\/agents\/[0-9a-f-]{36}\/edit/, timeout: 20000 },
  { remember: `agents.${as}` },
  press('Back to agents'),
]

const openAgent = (name: string): Step => ({ click: { role: 'link', name, exact: true } })

const tryIt = (message: string, answer: RegExp): Step[] => [
  { fill: TRY, value: message },
  press('Run test'),
  { waitFor: { role: 'status', hasText: answer }, timeout: 60000 },
]

const toChannels = (agent: string): Step[] => [link('Agents'), openAgent(agent), tab('Channels')]

const addChannel = (agent: string, kind: RegExp): Step[] => [
  ...toChannels(agent),
  press('Add channel'),
  { click: { role: 'button', name: kind } },
]

const slackKeys = (name: string, n: string): Step[] => [
  // Placeholder Slack app keys, shaped like real ones; nothing is sent to Slack until someone installs it.
  { fill: { label: 'Name', exact: true, within: { testid: 'credential-form' } }, value: name },
  { fill: { label: 'Client ID' }, value: `4312876501.771920334812${n}` },
  { fill: { role: 'textbox', name: 'Client secret' }, value: `demo0client0secret000000${n === '1' ? '0' : '1'}` },
  { fill: { role: 'textbox', name: 'Signing secret' }, value: `demo0signing0secret00000${n === '1' ? '0' : '1'}` },
  { click: { role: 'button', name: 'Save', exact: true } },
  // The picked Slack app is a change to the channel: save it, then publish.
  { click: { role: 'button', name: 'Save', exact: true, nth: 'last' } },
  { click: { role: 'button', name: 'Publish', exact: true } },
  { waitFor: { role: 'button', name: 'Unpublish' }, timeout: 20000 },
]

const publish = (done: Locator): Step[] => [
  { click: { role: 'button', name: 'Publish', exact: true } },
  { waitFor: done, timeout: 20000 },
]

// Open the published web chat at its own address; the local stack serves it by name.
const visitChat = (question: string, answer: RegExp): Step[] => [
  { remember: 'slug', fromInput: { label: 'Address', exact: true } },
  { goto: '/?__slug={{slug}}' },
  { fill: { role: 'textbox', name: 'Message' }, value: question },
  { click: { role: 'button', name: 'Send' } },
  { waitFor: { text: answer, nth: 'last' }, timeout: 60000 },
]

const saveIfChanged = (exact = false): Step => ({
  if: { enabled: { role: 'button', name: 'Save', exact, nth: 'last' } },
  then: [{ click: { role: 'button', name: 'Save', exact, nth: 'last' } }],
})

function guide(id: string, title: string, after: string[], shots: [string, string, string[], Step[]][]) {
  return {
    id, title, profile: 'northwind', account: SAM, after, notes: NOTE, browser: BROWSER,
    shots: Object.fromEntries(shots.map(([shot, t, sources]) => [shot, { path: `screenshots/guides/${shot}.png`, title: t, sources }])),
    steps: shots.flatMap(([shot, , , steps]): Step[] => [...steps, { shot }]),
  }
}

const SUPPORT_INSTRUCTIONS = 'You answer Northwind customers about their orders. Always look the order up before you answer. You can issue refunds. When a refund waits for a manager, tell the customer a person will confirm it within one business day.'
const SALES_INSTRUCTIONS = 'You help Northwind account managers. Before a call, look the account up in the CRM and give a short brief: who they are, renewal date and value, open deals, the last conversation and open tickets. After a call, when someone gives you their notes, save them to the account as a meeting note with the next steps, and confirm what you saved.'
const MARKETING_INSTRUCTIONS = 'You answer questions from visitors to the Northwind website about our coffee equipment. Answer only from the help center: search it first, and name the article you used. If the help center does not answer the question, say so and suggest the contact page. Never promise prices, discounts or delivery dates.'
const OPS_INSTRUCTIONS = 'Check the health of every Northwind system and write one short report: first what needs attention (anything degraded, failing or above 80% full) with the detail, then one line saying everything else is fine. If everything is fine, say so in one line.'
const HELPDESK_INSTRUCTIONS = 'You answer questions from Northwind staff about HR, IT and the office. Look things up before you answer: the staff handbook and policies, their leave balance (ask for their work email if you need it), and the office guide in memory. Say where the answer came from. If someone needs something done by IT, tell them how to open an IT request. Never share one person\'s details with another.'
const OFFICE_GUIDE = 'Office guide, Leipzig office.\n\nWi-Fi: guests use NW-Guest; the password changes every Monday and is on the card at reception. Staff laptops join NW-Staff automatically.\n\nOpening hours: 7:00 to 20:00. After hours, use your badge at the side door.\n\nParking: the courtyard spaces are for visitors. Staff park in the garage on Lindenstrasse; ask reception for a card.\n\nKitchen: coffee and tea are free. Please empty the dishwasher if it is clean.'

const PENDING = { sql: `SELECT count(*) FROM approval_requests WHERE "organizationId" = '{{org.id}}' AND status = 'pending'`, not: '0' } as const

const support = guide('guide-support', 'Customer support: orders, refunds, web chat', [], [
  ['support-1-connect-model', 'Connect an AI model', ['frontend/src/pages/models-connect.tsx', 'frontend/src/components/llm-providers', 'frontend/src/components/connect'], [
    ...['orders', 'crm', 'status', 'kb', 'intranet'].flatMap(specFile),
    { goto: '/dashboard' },
    link('Models'),
    link('Connect a provider'),
    { select: label('Provider'), option: /^OpenAI/ },
    { fill: label('Name'), value: 'Northwind OpenAI' },
    { fill: label('API key'), value: 'sk-demo-openai-0000000000' },
    press('Save', true),
    { waitForUrl: /\/models\/providers\/[0-9a-f-]{36}/, timeout: 20000 },
  ]],
  ['support-2-connect-orders', 'Connect your order system', ['frontend/src/pages/api-new.tsx', 'frontend/src/pages/api-new-description.tsx', 'frontend/src/components/apis'], uploadSpec('orders')],
  ['support-3-orders-tools', 'The order system, with what it can do', API_DETAIL, connected('Get an order by number', 'Northwind Orders', 'orders')],
  ['support-4-new-agent', 'A new autonomous agent', BUILDER, [
    { goto: '/agents' },
    ...newAgent('Customer support assistant', /^gpt-4o(?!-)/, 'Friendly, brief and specific. Apologise once at most.', SUPPORT_INSTRUCTIONS),
    show('Work mode'),
  ]],
  ['support-5-model-and-tools', 'Tick the order tools', BUILDER, [pickApiTools('Northwind Orders', 'orders'), show('Capabilities')]],
  ['support-6-activate', 'Save and turn the agent on', DETAIL, [
    ...saveAgent('support'),
    openAgent('Customer support assistant'),
    press('Activate'),
    { waitFor: { text: 'Active', exact: true }, timeout: 15000 },
    { scrollTop: true },
  ]],
  ['support-7-try-order', 'Ask about an order', DETAIL, [...tryIt('Where is order NW-10428? It was due last week.', /NW-10428/), show('Try it')]],
  ['support-8-amount-rule', 'Ask before refunds over 500', ['frontend/src/pages/approval-rule.tsx', 'frontend/src/components/settings/approval-amount-rule.tsx', 'frontend/src/lib/approval-rules.ts'], [
    link('Settings'),
    tab('Advanced'),
    press('New rule'),
    { fill: label('Name'), value: 'Refunds over 500' },
    { select: label('Tool'), option: /refund/i },
    { select: label('The number'), option: /amount/i },
    { fill: label('Amount'), value: '500' },
    { waitFor: { testid: 'amount-rule-summary' }, timeout: 10000 },
    { scrollTop: true },
  ]],
  ['support-9-refund-waits', 'A big refund waits for approval', ['frontend/src/pages/approvals.tsx'], [
    press('Create rule'),
    { waitFor: { testid: 'amount-rules' }, timeout: 15000 },
    link('Agents'),
    openAgent('Customer support assistant'),
    { fill: TRY, value: 'Brightway Logistics wants a refund of $820 on order NW-44120, it arrived defective.' },
    press('Run test'),
    { until: PENDING, timeout: 60000, what: 'the refund to wait for approval' },
    link('Approvals'),
    { waitFor: { role: 'button', name: 'Approve' }, timeout: 30000 },
  ]],
  ['support-10-approve', 'Approve the refund', ['frontend/src/pages/approvals.tsx'], [
    press('Approve'),
    { fill: { label: 'Note (optional)' }, value: 'Defective on arrival, confirmed with the carrier.' },
  ]],
  ['support-11-add-channel', 'Pick where customers reach it', ['frontend/src/pages/agent-channel-new.tsx', 'frontend/src/components/channels'], [
    { if: { visible: { role: 'form', name: 'Approve this action' } }, then: [
      { click: { role: 'button', name: 'Approve', within: { role: 'form', name: 'Approve this action' } } },
      { waitFor: { text: 'No pending approvals' }, timeout: 15000 },
    ] },
    ...toChannels('Customer support assistant'),
    press('Add channel'),
  ]],
  ['support-12-web-chat', 'Publish the web chat', CHANNEL, [
    { click: { role: 'button', name: /^Web chat/ } },
    ...publish({ role: 'button', name: 'Unpublish' }),
    { scrollTop: true },
  ]],
  ['support-13-widget', 'Put the chat bubble on your website', [...CHANNEL, 'frontend/src/components/gateways/widget-builder.tsx'], [
    ...addChannel('Customer support assistant', /^Website widget/),
    ...publish({ text: 'Add it to your site' }),
    show('Add it to your site'),
  ]],
  ['support-14-whatsapp', 'Add WhatsApp with your Twilio keys', KEYS, [
    ...addChannel('Customer support assistant', /^WhatsApp\s*Via Twilio/),
    press('Create one here'),
    show('Keys'),
  ]],
  ['support-15-email', 'Add email with your Resend key', KEYS, [
    ...addChannel('Customer support assistant', /^Email/),
    press('Create one here'),
    show('Keys'),
  ]],
  ['support-16-branding', 'Name, greeting and limits', ['frontend/src/pages/agent-public-settings.tsx', 'frontend/src/components/channels'], [
    ...toChannels('Customer support assistant'),
    link('Branding and visitor rules'),
    { fill: label('Name people see'), value: 'Northwind Help' },
    { fill: label('Greeting'), value: 'Hi! I can check your order, shipping and refunds.' },
    { fill: { label: 'Suggested prompts' }, value: 'Where is my order?' },
    press('Advanced'),
    { fill: label('Spend limit per day'), value: '20' },
    show('What it may cost'),
  ]],
  ['support-17-customer-view', 'What a customer sees', CHAT, [
    saveIfChanged(),
    ...toChannels('Customer support assistant'),
    { click: { role: 'row', name: /Web chat/ } },
    ...visitChat('Where is order NW-10428? It was due last week.', /held at customs|DHL Express/),
  ]],
])

const sales = guide('guide-sales', 'Sales: a brief before the call, notes after', ['guide-support'], [
  ['sales-1-connect-crm', 'Connect your CRM', API_DETAIL, [...uploadSpec('crm'), ...connected('Add a meeting note to an account', 'Northwind CRM', 'crm')]],
  ['sales-2-agent', 'The sales assistant and its CRM tools', BUILDER, [
    link('Agents'),
    ...newAgent('Sales assistant', /^gpt-4o(?!-)/, 'Short and practical. Numbers first, no small talk.', SALES_INSTRUCTIONS),
    pickApiTools('Northwind CRM', 'crm'),
    show('Capabilities'),
  ]],
  ['sales-3-brief', 'A brief before the call', DETAIL, [
    ...saveAgent('sales'),
    openAgent('Sales assistant'),
    press('Activate'),
    ...tryIt('I have a call with Kestrel Coffee in ten minutes. What should I know?', /Kestrel/),
    show('Try it'),
  ]],
  ['sales-4-notes', 'Meeting notes saved to the CRM', DETAIL, [
    ...tryIt('Save my notes from the Kestrel call: Dana wants volume pricing for 12 more grinders before the renewal. Next step: I send a quote by Friday.', /Saved/),
    show('Try it'),
  ]],
  ['sales-5-slack-keys', 'Add Slack with your Slack app', KEYS, [
    ...addChannel('Sales assistant', /^Slack/),
    press('Create one here'),
    show('Add to Slack'),
  ]],
  ['sales-6-slack-live', 'Published: the install link and redirect URL', CHANNEL, [...slackKeys('Northwind Slack app', '1'), show('Add to Slack')]],
])

const marketing = guide('guide-marketing', 'Marketing: product questions from the help center', ['guide-sales'], [
  ['marketing-1-connect-docs', 'Connect your help center', API_DETAIL, [...uploadSpec('kb'), ...connected('Search the product documentation and help articles', 'Northwind Help Center', 'kb')]],
  ['marketing-2-agent', 'A product assistant that answers from the help center', BUILDER, [
    link('Agents'),
    ...newAgent('Product questions', /^gpt-4o-mini/, 'Warm and clear. Short answers, plain words.', MARKETING_INSTRUCTIONS),
    pickApiTools('Northwind Help Center', 'kb'),
    show('Capabilities'),
  ]],
  ['marketing-3-try', 'An answer with its source', DETAIL, [
    ...saveAgent('marketing'),
    openAgent('Product questions'),
    press('Activate'),
    ...tryIt('Does the Brew 2 grinder work in the UK?', /240 V/),
    show('Try it'),
  ]],
  ['marketing-4-limits', 'A daily spending cap for visitors', ['frontend/src/pages/agent-public-settings.tsx', 'frontend/src/components/channels'], [
    tab('Channels'),
    link('Branding and visitor rules'),
    { fill: label('Name people see'), value: 'Ask Northwind' },
    { fill: label('Greeting'), value: 'Questions about our grinders and espresso machines? Ask away.' },
    { fill: { label: 'Suggested prompts' }, value: 'Which grinder is right for me?' },
    press('Advanced'),
    { fill: label('Spend limit per run'), value: '0.10' },
    { fill: label('Spend limit per day'), value: '10' },
    { fill: label('Spend limit per month'), value: '200' },
    { fill: label('Messages per visitor, per hour'), value: '20' },
    show('What it may cost'),
  ]],
  ['marketing-5-widget', 'The chat bubble, only on your own site', [...CHANNEL, 'frontend/src/components/gateways/widget-builder.tsx'], [
    { click: { role: 'button', name: 'Save', nth: 'last' } },
    ...addChannel('Product questions', /^Website widget/),
    ...publish({ text: 'Add it to your site' }),
    { fill: { placeholder: /https:\/\/www\.example\.com|example\.com/, nth: 'last' }, value: 'https://www.northwind.example' },
    { click: { role: 'button', name: 'Add', exact: true, nth: 'last' } },
    show('Allowed sites'),
  ]],
  ['marketing-6-visitor', 'A visitor asks a product question', CHAT, [
    saveIfChanged(true),
    ...addChannel('Product questions', /^Web chat/),
    ...publish({ role: 'button', name: 'Unpublish' }),
    ...visitChat('Does the Brew 2 grinder work in the UK?', /240 V/),
  ]],
])

const operations = guide('guide-operations', 'Operations: a nightly systems check', ['guide-marketing'], [
  ['ops-1-connect-status', 'Connect the system you check', API_DETAIL, [...uploadSpec('status'), ...connected('Check the health of every system', 'Northwind Status', 'status')]],
  ['ops-2-agent', 'The nightly check and its status tools', BUILDER, [
    link('Agents'),
    ...newAgent('Nightly systems check', /^gpt-4o-mini/, 'Plain and short. Lead with what needs attention.', OPS_INSTRUCTIONS),
    pickApiTools('Northwind Status', 'status'),
    show('Capabilities'),
  ]],
  ['ops-3-try', 'A test run writes the report', DETAIL, [
    ...saveAgent('ops'),
    openAgent('Nightly systems check'),
    press('Activate'),
    ...tryIt('Run the nightly check.', /4 of 5 systems/),
    show('Try it'),
  ]],
  ['ops-4-slack', 'Slack, published for the report', KEYS, [
    { goto: '/agents' },
    openAgent('Nightly systems check'),
    tab('Channels'),
    press('Add channel'),
    { click: { role: 'button', name: /^Slack/ } },
    press('Create one here'),
    ...slackKeys('Nightly Slack app', '2'),
    show('Add to Slack'),
  ]],
  ['ops-5-schedule', 'Every day at 6:00, to the Slack channel', ['frontend/src/pages/agent-schedule.tsx', 'frontend/src/lib/schedule.ts', 'frontend/src/components/settings/time-zone-select.tsx'], [
    link('Agents'),
    openAgent('Nightly systems check'),
    press(/^(Set up a schedule|Edit schedule)$/),
    { select: label('Days'), option: 'Every day' },
    { fill: label('Time'), value: '06:00' },
    { select: label('Where'), option: /^Slack/ },
    // The channel ID of #ops; the bot has to be invited there.
    { fill: { label: /Channel/ }, value: 'C07NWOPS01' },
    { fill: label('Message'), value: 'Run the nightly check.' },
    show('When it runs'),
  ]],
  ['ops-6-schedule-card', 'The schedule on the agent', ['frontend/src/pages/agent-detail.tsx', 'frontend/src/components/agents/detail/schedule-card.tsx'], [
    press('Save schedule'),
    { waitFor: { testid: 'schedule-card-summary' }, timeout: 20000 },
    { scrollTo: { testid: 'schedule-card-summary' }, block: 'center' },
  ]],
  ['ops-7-report-run', 'A report run, step by step', DETAIL, [
    { scrollTop: true },
    tab('Runs'),
    { click: { role: 'button', within: { role: 'table' }, nth: 0 } },
    show('Autonomous runs'),
  ]],
])

const helpdesk = guide('guide-helpdesk', 'Internal help desk: HR, IT and the office', ['guide-operations'], [
  ['helpdesk-1-connect-intranet', 'Connect your intranet', API_DETAIL, [...uploadSpec('intranet'), ...connected('Search the staff handbook and HR and IT policies', 'Northwind Intranet', 'intranet')]],
  ['helpdesk-2-office-guide', 'The office guide, added as a document', ['frontend/src/pages/memory-new.tsx', 'frontend/src/components/memory'], [
    link('Memory'),
    press('Add memory'),
    { fill: label('What should your agents remember?'), value: OFFICE_GUIDE },
    { fill: label('Tags'), value: 'office, wifi' },
    press('Advanced'),
    // A document in the organization's memory: what an agent with shared memory searches before it answers.
    { select: label('Kind'), option: 'Document' },
  ]],
  ['helpdesk-3-agent', 'The help desk assistant reads shared memory', BUILDER, [
    press('Save memory'),
    link('Agents'),
    ...newAgent('Ask HR and IT', /^gpt-4o(?!-)/, 'Friendly and to the point, like a helpful colleague.', HELPDESK_INSTRUCTIONS),
    { if: { not: { checked: { role: 'switch', name: 'Remember between conversations' } } }, then: [{ click: { role: 'switch', name: 'Remember between conversations' } }] },
    { select: label('Whose memory'), option: 'Shared by all agents' },
    { select: label('What it saves'), option: 'Only when asked' },
    pickApiTools('Northwind Intranet', 'intranet'),
    show('Remember between conversations'),
  ]],
  ['helpdesk-4-leave', 'A question answered from the HR system', DETAIL, [
    ...saveAgent('helpdesk'),
    openAgent('Ask HR and IT'),
    press('Activate'),
    ...tryIt('How many vacation days do I have left? My email is sam.rivera@northwind.example.', /vacation days left/),
    show('Try it'),
  ]],
  ['helpdesk-5-wifi', 'A question answered from the office guide', DETAIL, [...tryIt('What is the guest Wi-Fi at the office?', /NW-Guest/), show('Try it')]],
  ['helpdesk-6-teams', 'Add Microsoft Teams', KEYS, [
    ...addChannel('Ask HR and IT', /^Microsoft Teams/),
    press('Create one here'),
    show('Keys'),
  ]],
])

const developers = guide('guide-developers', 'Developers: the order tools in coding assistants, a runner', ['guide-helpdesk'], [
  ['dev-1-gateway', 'Serve the order tools to coding assistants', ['frontend/src/pages/gateway-new.tsx', 'frontend/src/components/gateways'], [
    { goto: '/gateways' },
    press('Create gateway'),
    { click: { role: 'button', name: /^MCP/ } },
    { click: { testid: 'share-api-{{apis.orders}}' } },
    { fill: label('Name'), value: 'Northwind Orders' },
    // Repeated local walks need their own endpoint path.
    { click: { role: 'button', name: /^Advanced/ } },
    { fill: { label: 'Path' }, value: '/northwind-orders-{{$ms}}' },
    { click: { role: 'button', name: /^Advanced/ } },
    show('Protocol'),
  ]],
  ['dev-2-gateway-setup', 'The address, the key and a ready-made setup', ['frontend/src/pages/gateway-detail.tsx', 'frontend/src/components/gateways'], [
    press('Create gateway'),
    { waitForUrl: /\/gateways\/[0-9a-f-]{36}/, timeout: 20000 },
  ]],
  ['dev-3-runner', 'Start a runner on your own machine', ['frontend/src/pages/runner-new.tsx', 'frontend/src/components/runners'], [
    link('Runners'),
    press('Start a runner'),
    { waitFor: { text: 'npm i -g @almyty/cli', exact: true } },
  ]],
  ['dev-4-runner-command', 'The commands to run on the machine', ['frontend/src/pages/runner-new.tsx', 'frontend/src/components/runners'], [
    { waitFor: { text: 'almyty runner start', exact: true } },
  ]],
])

export const guides = [support, sales, marketing, operations, helpdesk, developers]
