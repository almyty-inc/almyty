// The tutorials in docs-site/content/tutorials (the founder's associate, the
// biz-dev assistant and new customer onboarding), walked through the UI step
// by step as their text says, one screenshot per picture they show.
//
// They work as Maya Chen in an organization of her own, "Lumen", on the
// lumen profile: fakes/services/lumen.ts stands in for Google Calendar,
// Gmail, Google Tasks, Google Drive, HubSpot, Slack, Resend and the model,
// so nothing reaches a real account and every run answers the same way. A
// fresh stack is needed: the stand-in keeps what was sent in memory. What
// differs from a real account, because the stand-in is on localhost: the
// API addresses are set to the stand-in under Advanced, the model key is
// sent with the stand-in's address, Google's sign-in page is never opened (a
// token is pasted instead), and the Slack messages and emails are shown as
// the stand-in received them, rendered as a page.
//
// The API descriptions are the real public ones (Google's discovery
// documents, HubSpot's published specs), read from their links as a user
// would, so the stack needs the internet; the APIs themselves are never called.
import type { Step } from '../../engine/schema.ts'
import { AGENT, APPROVALS, BUILDER, CHANNEL, LINKS, MODEL_KEY, SETUP, approveOne, button, combo, googleApp, near, ownMemory, pastedToken, pendingApprovals, publishChannel, received, textbox, top, upstream } from './shared.ts'

export const MAYA = { email: 'maya.chen@lumenlabs.example', password: 'Lumen-Labs-2026!', firstName: 'Maya', lastName: 'Chen', organizationName: 'Lumen' }
const SLACK_SIGNING_SECRET = 'local-test-signing-secret-0123456789'
const GOOGLE_APP = '123456789012-abc123def456.apps.googleusercontent.com'
const HUBSPOT_TOKEN = 'local-demo-hubspot-token-0000000000000000000'

const NOTE = 'Tutorial step, walked through the UI on the local demo stack with the lumen profile (scripts/demo-seed, walks/lumen): real public API descriptions, a local stand-in for Google, HubSpot, Slack and Resend, and a scripted stand-in model; fictional people and companies. Not staging or production data. A page of a message shows it exactly as almyty handed it to the provider; that provider was not used.'
const BROWSER = { block: ['accounts.google.com', 'app.hubspot.com'], providerUrl: '{{stack.upstream}}/openai/v1' }
const ALWAYS_ON = ['frontend/src/pages/agent-always-on.tsx']
const API_NEW = ['frontend/src/pages/api-new.tsx']

type ShotRow = [id: string, path: string, title: string, sources: string[], route?: string]
const shots = (rows: ShotRow[]) => Object.fromEntries(rows.map(([id, path, title, sources, route]) => [id, { path: `screenshots/tutorials/${path}`, title, sources, ...(route ? { route } : {}) }]))
const walk = (id: string, title: string, after: string[], rows: ShotRow[], steps: Step[]) => ({ id, title, profile: 'lumen', account: MAYA, after, notes: NOTE, browser: BROWSER, shots: shots(rows), steps })

// ---------- the founder's associate ----------

const FOUNDER_INSTRUCTIONS = `You are Maya's associate at Lumen.

Every morning, write Maya a short brief for the day:
1. Conflicts first: any meetings that overlap, across all her calendars (work, team and personal), with a suggestion for which one to move.
2. Today's meetings from all her calendars, in time order.
3. Open tasks that are due today or overdue.
4. The top three priorities for the day, based on the meetings, the tasks and recent emails.

Before each meeting with someone from outside the company, add a short prep note: who they are, how Maya knows them (check what you remember and past emails), what was discussed last time, and the open points.

Remember new facts about people: who introduced whom, where they work, what they care about.

Only read calendars, emails and tasks. Never send email, answer invitations or change tasks.`
const BRIEF = 'Write my morning brief for today: conflicts first, then meetings, tasks due, top three priorities, and a prep note for every meeting with someone from outside the company.'

const founder = walk('tutorial-founder', "Tutorial: the founder's associate", [], [
  ['founder-00', 'founder/00-morning-brief.png', "Founder's associate: the morning brief email", ['frontend/src/pages/agent-schedule.tsx', 'backend/src/modules/gateways/channels/adapters/email.adapter.ts', 'backend/src/modules/gateways/channels/adapters/channel-markdown.ts'], '/agents/:id/schedule'],
  ['founder-01', 'founder/01-connect-openai.png', 'Connect a provider: OpenAI', ['frontend/src/pages/models-connect.tsx', 'frontend/src/components/llm-providers']],
  ['founder-02', 'founder/02-openai-connected.png', 'OpenAI connected, its models', ['frontend/src/components/llm-providers']],
  ['founder-03', 'founder/03-connect-an-api.png', 'Connect an API', API_NEW],
  ['founder-04', 'founder/04-calendar-link.png', 'Google Calendar description link', API_NEW],
  ['founder-05', 'founder/05-finish-connecting.png', 'Finish connecting Google Calendar', SETUP],
  ['founder-06', 'founder/06-google-sign-in.png', 'Google sign-in: redirect address, client ID, secret and permissions', SETUP],
  ['founder-07', 'founder/07-calendar-signed-in.png', 'Google Calendar signed in', SETUP],
  ['founder-08', 'founder/08-apis.png', 'The three Google APIs', ['frontend/src/pages/apis.tsx']],
  ['founder-09', 'founder/09-tools-search.png', 'Searching the tools', ['frontend/src/pages/tools.tsx']],
  ['founder-10', 'founder/10-test-tool.png', 'Testing a calendar tool', ['frontend/src/pages/tool-detail.tsx']],
  ['founder-11', 'founder/11-agent-instructions.png', "Founder's associate: model and instructions", BUILDER],
  ['founder-12', 'founder/12-agent-memory.png', "Founder's associate: memory", BUILDER],
  ['founder-13', 'founder/13-agent-tools.png', "Founder's associate: tools", BUILDER],
  ['founder-14', 'founder/14-first-run.png', "Founder's associate: first test run", AGENT],
  ['founder-15', 'founder/15-run-steps.png', 'A run, step by step', AGENT],
  ['founder-16', 'founder/16-add-channel.png', 'Add channel', ['frontend/src/pages/agent-channel-new.tsx']],
  ['founder-17', 'founder/17-email-key.png', 'Email channel: the Resend key', CHANNEL],
  ['founder-18', 'founder/18-email-live.png', 'Email channel, live', CHANNEL],
  ['founder-19', 'founder/19-schedule.png', 'Set up a schedule', ['frontend/src/pages/agent-schedule.tsx']],
  ['founder-20', 'founder/20-schedule-card.png', 'The schedule on the agent page', AGENT],
  ['founder-21', 'founder/21-memory.png', 'What the associate remembers', AGENT],
], [
  // A used stand-in would mix an earlier run into these pictures.
  { action: 'freshUpstream' },
  // 1. A model
  { use: 'connectOpenAI', with: { key: MODEL_KEY, shot: 'founder-01' } },
  { shot: 'founder-02' },

  // 3. Google Calendar
  { goto: '/apis/new' },
  { shot: 'founder-03' },
  { click: button(/OpenAPI \/ Swagger/) },
  { fill: { label: 'Link to the description' }, value: LINKS.calendar },
  { shot: 'founder-04' },
  { click: button('Advanced') },
  { fill: { label: 'Name', exact: true }, value: 'Google Calendar' },
  // The local stand-in, not Google.
  { fill: { label: 'Address', exact: true }, value: '{{stack.upstream}}/calendar/v3' },
  { click: button('Connect API') },
  { waitForUrl: /\/setup/, timeout: 60000 },
  // The count is in once the tools are made.
  { waitFor: { text: /Found [1-9]\d* operation/ }, timeout: 120000 },
  { shot: 'founder-05' },
  // Only the two read-only calendar permissions stay ticked.
  ...googleApp(GOOGLE_APP, /calendar\.readonly$|calendar\.events\.readonly$/),
  { shot: 'founder-06' },
  ...pastedToken('Google account (Maya)', 'local-test-google-token'),
  { scrollTop: true },
  { shot: 'founder-07' },

  // 4. Gmail and Google Tasks
  { use: 'importApi', with: { link: LINKS.gmail, name: 'Gmail', address: '{{stack.upstream}}/' } },
  { use: 'pickSignIn', with: { name: /Google account \(Maya\)/ } },
  { use: 'importApi', with: { link: LINKS.tasks, name: 'Google Tasks', address: '{{stack.upstream}}/' } },
  { use: 'pickSignIn', with: { name: /Google account \(Maya\)/ } },
  { goto: '/apis' },
  { shot: 'founder-08' },

  // 5. Check a tool
  { goto: '/tools' },
  { fill: { placeholder: 'Search tools...' }, value: 'calendar_events_list' },
  { settle: true },
  { shot: 'founder-09' },
  // The list shows the tool's display name; its machine name is the title.
  { click: { title: 'google_calendar_calendar_events_list', exact: true } },
  { click: { role: 'tab', name: 'Test tool' } },
  { fill: { placeholder: 'Enter calendarId' }, value: 'primary' },
  { click: button('Execute Tool') },
  { waitFor: { text: 'Response Data:' }, timeout: 20000 },
  near({ text: 'Response Data:' }),
  { shot: 'founder-10' },

  // 6. The assistant
  { use: 'newAgent', with: { name: "Founder's associate", personality: 'Calm, brief and specific, like a trusted chief of staff. Facts first, no filler. If something is unclear or missing, say so instead of guessing.', instructions: FOUNDER_INSTRUCTIONS } },
  { shot: 'founder-11' },
  ...ownMemory,
  near({ role: 'heading', name: 'Memory' }),
  { shot: 'founder-12' },
  { use: 'pickTools', with: { tools: ['google_calendar_calendar_calendar_list_list', 'google_calendar_calendar_events_list', 'gmail_gmail_users_messages_list', 'gmail_gmail_users_messages_get', 'google_tasks_tasks_tasklists_list', 'google_tasks_tasks_tasks_list'] } },
  near({ role: 'heading', name: 'Tools and APIs' }),
  { shot: 'founder-13' },
  { use: 'saveAgent', with: { as: 'agents.founder' } },
  { use: 'activate', with: { agent: '{{agents.founder}}' } },

  // 7. Try it
  { fill: { placeholder: 'Type a message to test this agent...' }, value: 'Write my morning brief for today.' },
  { press: { placeholder: 'Type a message to test this agent...' }, key: 'Enter' },
  { waitFor: { text: /Conflicts/ }, timeout: 90000 },
  near({ role: 'heading', name: 'Try it' }),
  { shot: 'founder-14' },
  { goto: '/agents/{{agents.founder}}' },
  { click: { role: 'tab', name: 'Runs' } },
  { click: { role: 'button', within: { role: 'table' }, nth: 0 } },
  { shot: 'founder-15' },
  { click: { role: 'tab', name: 'Memory' } },
  { shot: 'founder-21' },

  // 8. The email channel
  { goto: '/agents/{{agents.founder}}/channels/new' },
  { shot: 'founder-16' },
  { click: button(/^Email/) },
  { click: button('Create one here') },
  { fill: textbox('Name', 'last'), value: 'Resend (Lumen)' },
  { fill: textbox('API key'), value: 're_localtest_0123456789abcdef' },
  { click: button('More options') },
  { fill: textbox('From address'), value: 'associate@lumen.example' },
  { fill: textbox('Inbound address'), value: 'associate@in.lumen.example' },
  near(textbox('From address')),
  { shot: 'founder-17' },
  ...publishChannel({ text: /Live|Published/ }),
  { shot: 'founder-18' },

  // 9. Every morning
  { use: 'schedule', with: { agent: '{{agents.founder}}', time: '07:00', to: MAYA.email, message: BRIEF, shot: 'founder-19' } },
  near({ role: 'heading', name: 'Schedule' }),
  { shot: 'founder-20' },
  // The brief as it arrives: the schedule set to the next minutes once, then back to 07:00.
  { use: 'schedule', with: { agent: '{{agents.founder}}', time: '{{$now|add:2m|hhmm}}', to: MAYA.email, message: BRIEF } },
  received('outbox', { url: { contains: 'resend' }, body: { contains: MAYA.email } }, 'the morning brief email', { save: 'briefs', timeout: 300000 }),
  { use: 'schedule', with: { agent: '{{agents.founder}}', time: '07:00', to: MAYA.email, message: BRIEF } },
  { remember: 'brief', value: '{{briefs|last|get:body}}' },
  { render: 'email', with: { subject: '{{brief.subject}}', from: '{{brief.from}}', to: '{{brief.to}}', html: '{{brief.html}}', note: 'The email exactly as almyty handed it to the email provider (local demo; nothing was sent).' }, shot: 'founder-00' },
])

// ---------- always on: a service that pushes changes ----------
// The founder's associate wakes when Google Calendar says something changed;
// taken once the biz-dev tutorial is done, as the published picture was.

const pushWakes = {
  id: 'tutorial-push-wakes', title: 'Always on: Google Calendar pushes its changes', profile: 'lumen', account: MAYA, after: ['tutorial-bizdev'],
  notes: 'Local demo stack with the lumen profile (scripts/demo-seed, walks/lumen), with Google Calendar served by the use-case stand-in; fictional people and companies. Not staging or production data.',
  browser: BROWSER,
  shots: { 'always-on-push-wakes': { path: 'screenshots/always-on-push-wakes.png', title: 'Always on: a service that pushes changes', sources: ['frontend/src/pages/agent-always-on.tsx', 'frontend/src/components/agents/always-on'] } },
  steps: [
    { goto: '/agents/{{agents.founder}}/always-on' },
    // Once: a rerun finds the subscription there.
    { if: { not: { visible: { testid: 'push-wake-row' } } }, then: [
      { click: button('Add a service') },
      { select: { label: 'Watch', exact: true }, option: 'When something changes in Google Calendar' },
      { select: { label: 'Connection', exact: true }, option: 'Google Calendar' },
      { click: button('Save and subscribe') },
    ] },
    { waitFor: { testid: 'push-wake-row', hasText: 'Valid' }, timeout: 30000 },
    { click: button(/^Address and setup/) },
    top({ text: 'When a service tells it something changed', exact: true }, 110),
    { shot: 'always-on-push-wakes' },
  ] as Step[],
}

// ---------- the biz-dev assistant ----------

const BIZDEV_INSTRUCTIONS = `You help Maya at Lumen with business development (outreach to new prospects).

Target profile: logistics, trucking or courier companies with 100 or more employees that are still a "lead" in the CRM.

When Maya asks you to find prospects:
1. Search the CRM for companies that match the target profile.
2. For each one, find the decision maker: the COO, a VP or the Head of Operations.
3. Skip anyone Maya has emailed in the last 30 days.
4. Write each person a short, personal email (under 120 words) that mentions something specific about their company, and send it from Maya's Gmail. Every email waits for Maya's approval before it goes out.
5. Add a deal for each company you wrote to, with a note of when to follow up.
6. Write a LinkedIn message for each person for Maya to send herself. Never send anything on LinkedIn.

At every wake, check for replies to your outreach:
- When someone replied, move their deal to "Qualified to buy" and tell Maya what they said.
- When someone has not answered after 3 days, send one short follow-up in the same email thread. It waits for approval too. Never follow up more than once.`
const BIZDEV_STANDING = 'Keep the outreach moving. At every wake, check Maya\'s sent emails for replies from the prospects you wrote to. When someone replied, move their deal to "Qualified to buy" and tell Maya what they said. When someone has not answered for 3 days, send one short, friendly follow-up in the same thread (Maya approves it first). Never follow up twice.'
const SALES_REPORT = { url: { contains: 'chat.postMessage' }, 'body.channel': 'C0SALES', 'body.text': /Outreach, |Follow-up check/ }

const hubspot = (path: string, name: string): Step => ({ use: 'importApi', with: { link: LINKS.hubspot + path, name, address: '{{stack.upstream}}' } })

const bizdev = walk('tutorial-bizdev', 'Tutorial: the biz-dev assistant', ['tutorial-founder'], [
  ['bizdev-00', 'bizdev/00-approve-email.png', 'Approving an outreach email', APPROVALS],
  ['bizdev-01', 'bizdev/01-hubspot-link.png', 'HubSpot Companies description link', API_NEW],
  ['bizdev-02', 'bizdev/02-hubspot-default-key.png', 'HubSpot: a sign-in needed', SETUP],
  ['bizdev-03', 'bizdev/03-hubspot-bearer.png', 'HubSpot sign-in form, with pasting a token instead', SETUP],
  ['bizdev-04', 'bizdev/04-hubspot-token.png', 'HubSpot private app token', SETUP],
  ['bizdev-05', 'bizdev/05-apis.png', 'HubSpot and Google APIs', ['frontend/src/pages/apis.tsx']],
  ['bizdev-06', 'bizdev/06-agent-instructions.png', 'Biz-dev assistant: model, instructions, memory', BUILDER],
  ['bizdev-07', 'bizdev/07-agent-tools.png', 'Biz-dev assistant: tools', BUILDER],
  ['bizdev-08', 'bizdev/08-slack-channel.png', 'Slack channel', CHANNEL],
  ['bizdev-09', 'bizdev/09-slack-token.png', 'Slack bot token', CHANNEL],
  ['bizdev-10', 'bizdev/10-slack-live.png', 'Slack channel, live', CHANNEL],
  ['bizdev-11', 'bizdev/11-always-on.png', 'Always on: standing instructions and timer', ALWAYS_ON],
  ['bizdev-12', 'bizdev/12-ask-first.png', 'Always on: ask before sending email', ALWAYS_ON],
  ['bizdev-13', 'bizdev/13-always-on-card.png', 'Always on, on the agent page', AGENT],
  ['bizdev-14', 'bizdev/14-approve-note.png', 'Approve with a note', APPROVALS],
  ['bizdev-15', 'bizdev/15-followup-approval.png', 'The follow-up waiting for approval', APPROVALS],
  ['bizdev-16', 'bizdev/16-slack-reports.png', 'Biz-dev reports as posted to Slack', ['frontend/src/pages/agent-always-on.tsx', 'backend/src/modules/gateways/channels/adapters/slack.adapter.ts', 'backend/src/modules/gateways/channels/adapters/channel-markdown.ts'], '/agents/:id/always-on'],
  ['bizdev-17', 'bizdev/17-what-woke-it.png', 'What woke it lately', ALWAYS_ON],
], [
  // 1. HubSpot, in three parts
  { use: 'importApi', with: { link: `${LINKS.hubspot}Companies/Rollouts/424/v3/companies.json`, name: 'HubSpot Companies', address: '{{stack.upstream}}', linkShot: 'bizdev-01' } },
  { waitFor: { text: /Found [1-9]\d* operation/ }, timeout: 120000 },
  { shot: 'bizdev-02' },
  { click: button('Create one here') },
  { scrollTo: button('Paste an access token instead'), block: 'end' },
  { scrollBy: 40 },
  { shot: 'bizdev-03' },
  { click: button('Paste an access token instead') },
  { fill: { role: 'textbox', name: 'Name', exact: true, nth: 'last' }, value: 'HubSpot private app' },
  { fill: textbox(/Access token|Key|token/, 'last'), value: HUBSPOT_TOKEN },
  { shot: 'bizdev-04' },
  { use: 'saveSignIn' },
  hubspot('Contacts/Rollouts/424/v3/contacts.json', 'HubSpot Contacts'),
  { use: 'pickSignIn', with: { name: /HubSpot private app/ } },
  hubspot('Deals/Rollouts/424/v3/deals.json', 'HubSpot Deals'),
  { use: 'pickSignIn', with: { name: /HubSpot private app/ } },
  // Gmail is the founder tutorial's: the biz-dev tutorial starts with it connected.
  { goto: '/apis' },
  { shot: 'bizdev-05' },

  // 2. The assistant
  { use: 'newAgent', with: { name: 'Biz-dev assistant', personality: 'Warm, direct and brief. Writes like a founder, not like a marketer: no buzzwords, no exclamation marks, one clear ask.', instructions: BIZDEV_INSTRUCTIONS } },
  ...ownMemory,
  { shot: 'bizdev-06' },
  { use: 'pickTools', with: { tools: [
    'hubspot_companies_post_crm_v3_objects_companies_search_do_search',
    'hubspot_contacts_post_crm_v3_objects_contacts_search_do_search',
    'hubspot_deals_post_crm_v3_objects_0_3_create',
    'hubspot_deals_post_crm_v3_objects_0_3_search_do_search',
    'hubspot_deals_patch_crm_v3_objects_0_3_deal_id_update',
    'gmail_gmail_users_messages_list',
    'gmail_gmail_users_messages_send',
    'gmail_gmail_users_threads_get',
  ] } },
  near({ text: 'Tools and APIs' }),
  { shot: 'bizdev-07' },
  { use: 'saveAgent', with: { as: 'agents.bizdev' } },
  { use: 'activate', with: { agent: '{{agents.bizdev}}' } },

  // 3. Slack
  { goto: '/agents/{{agents.bizdev}}/channels/new' },
  { click: button(/^Slack/) },
  { shot: 'bizdev-08' },
  { click: button(/^Advanced/) },
  { click: { role: 'button', name: 'Create one here', nth: 'last' } },
  { click: button('More options') },
  { click: { role: 'radio', name: 'Bot token' } },
  { fill: { role: 'textbox', name: 'Name', exact: true, nth: 'last' }, value: 'Slack bot (Lumen)' },
  { fill: textbox('Bot user OAuth token'), value: 'xoxb-local-test-0000000000-111111111' },
  { fill: textbox('Signing secret'), value: SLACK_SIGNING_SECRET },
  near(textbox('Bot user OAuth token')),
  { shot: 'bizdev-09' },
  ...publishChannel(button('Unpublish')),
  { shot: 'bizdev-10' },
  // Slack posts its events to the channel's own address.
  { remember: 'channels.slack', fromUrl: /channels\/([0-9a-f-]{36})/ },

  // 4. Always on
  { goto: '/agents/{{agents.bizdev}}/always-on' },
  { fill: textbox('Standing instructions'), value: BIZDEV_STANDING },
  { fill: { role: 'spinbutton', name: 'Every' }, value: '4' },
  { select: combo('Unit'), option: 'hours' },
  { select: combo('Channel'), option: /Slack/ },
  { fill: textbox('Your address there'), value: 'U0MAYA' },
  { select: combo('On its own, it'), option: /Does things/ },
  // Only Gmail's send stays on the ask-first list; it adds and moves deals on its own.
  { uncheck: { role: 'checkbox', name: /^hubspot_/ }, all: true },
  { select: combo('Post reports to'), option: /Slack/ },
  { fill: { placeholder: 'C0123ABCDEF' }, value: 'C0SALES' },
  { click: { role: 'switch', name: 'Always on' } },
  near({ role: 'heading', name: 'What wakes it' }),
  { shot: 'bizdev-11' },
  top({ text: 'Ask me first before', exact: true }, 260),
  { shot: 'bizdev-12' },
  { click: button('Save', true) },
  { goto: '/agents/{{agents.bizdev}}' },
  near({ role: 'heading', name: 'Always on' }),
  { shot: 'bizdev-13' },

  // 5. "Find new prospects" in Slack, then the emails wait for approval
  { action: 'slackEvent', with: { slug: '{{org.slug}}', gateway: '{{channels.slack}}', secret: SLACK_SIGNING_SECRET, text: 'Find new prospects that match our target profile and reach out to them.' } },
  { until: pendingApprovals, timeout: 120000, what: 'the first outreach approval' },
  { goto: '/approvals' },
  { shot: 'bizdev-00' },
  { click: { role: 'button', name: 'Approve', exact: true } },
  { fill: textbox('Note (optional)'), value: 'Looks good, send it.' },
  { shot: 'bizdev-14' },
  { click: { role: 'button', name: 'Approve', within: { role: 'form', name: 'Approve this action' } } },
  { waitFor: { role: 'form', name: 'Approve this action' }, state: 'hidden' },
  { use: 'approveWhileItWorks', with: { agent: '{{agents.bizdev}}', note: 'Looks good, send it.' } },

  // 6. Three days later: one prospect answered, one did not
  // Its reports in the sales channel (it also says there when something waits for approval).
  received('outbox', SALES_REPORT, 'the outreach report in Slack', { timeout: 120000 }),
  upstream('/_admin/age?days=4'),
  upstream('/_admin/reply', { to: 'jonas.weber@bluefin.example', body: 'Hi Maya, good timing: we are adding two depots next quarter and planning is already painful. Could we talk Tuesday afternoon?' }),
  { goto: '/agents/{{agents.bizdev}}' },
  { click: button('Wake now') },
  { until: pendingApprovals, timeout: 120000, what: 'the follow-up approval' },
  { goto: '/approvals' },
  { shot: 'bizdev-15' },
  { use: 'approveWhileItWorks', with: { agent: '{{agents.bizdev}}' } },
  received('outbox', SALES_REPORT, 'the follow-up report in Slack', { min: 2, save: 'reports', timeout: 120000 }),
  { goto: '/agents/{{agents.bizdev}}/always-on' },
  near({ role: 'heading', name: 'What woke it lately' }),
  { shot: 'bizdev-17' },
  { render: 'slack', with: { channel: '#sales', who: 'Biz-dev assistant', messages: '{{reports|map:body.text}}', note: 'The messages exactly as almyty posted them to Slack, shown the way Slack formats them (local demo; Slack itself was not used).' }, shot: 'bizdev-16' },
])

// ---------- the onboarding agent ----------

const ONBOARDING_INSTRUCTIONS = `You onboard Lumen's new customers, from signed deal to kickoff call.

A customer is new when their deal in HubSpot is in the stage "Closed won". For each one:
1. Find their main contact in HubSpot: the COO, a VP or the Head of Operations.
2. Create a folder in Google Drive called "<company> onboarding" and share it with the contact, so they can upload files.
3. Email the contact from Gmail: welcome them, and ask for two files in that folder: their vehicles (plate, type, capacity) and their depots (address, opening hours). Give them the folder link.
4. Wait for both files. Look in the folder at every wake. When they are not there 3 days after your last email, send a short, friendly reminder in the same email thread. Send at most two reminders; after that, ask Maya to call them.
5. When both files are in, book a 45-minute kickoff call in Maya's calendar with the contact and Sam Ortiz (sam.ortiz@lumenlabs.example, customer success), two working days later at 10:00 UTC. Maya approves it first.
6. Hand over to Sam with a short email: the contact, the files, the folder link and the kickoff time.
7. Write every step on the deal's description in HubSpot, one line each, so anyone can see where onboarding stands.

Before you create, share, send or book anything, check the deal, the Drive folder and your sent emails. Never do the same thing twice.
When you search Google Drive, use one condition per search, such as name = 'Bluefin Couriers onboarding' or '<folder id>' in parents.`
const ONBOARDING_STANDING = 'Keep onboarding moving. At every wake, look for deals in "Closed won" that are not handed over yet, and take each one a step further as your instructions say. Check before you act, so nothing is done twice.'
const ONBOARDING_TOOLS = [
  'hubspot_deals_post_crm_v3_objects_0_3_search_do_search',
  'hubspot_deals_patch_crm_v3_objects_0_3_deal_id_update',
  'hubspot_contacts_post_crm_v3_objects_contacts_search_do_search',
  'google_drive_drive_files_list', 'google_drive_drive_files_create',
  'google_drive_drive_permissions_list', 'google_drive_drive_permissions_create',
  'gmail_gmail_users_messages_list', 'gmail_gmail_users_messages_get', 'gmail_gmail_users_messages_send',
  'google_calendar_calendar_events_insert',
]
const ONBOARDING = '{{agents.onboarding}}'
const lastRun = (column: string) => `SELECT ${column} FROM agent_runs WHERE "agentId" = '${ONBOARDING}' ORDER BY "createdAt" DESC LIMIT 1`
const runWas = (status: string, what: string): Step => ({ until: { sql: lastRun('status'), is: status }, timeout: 5000, what })

// The onboarding tutorial starts in an organization that has only what the
// other two connect first (the model, Google Calendar, Gmail, HubSpot
// Contacts and Deals), and a stand-in without their deals and mail: Maya's
// organization goes, and the stand-in starts over.
const fresh = {
  id: 'tutorial-onboarding-fresh', title: 'A fresh start for the onboarding tutorial', profile: 'lumen', headless: true, shots: {},
  steps: [
    { sql: `DELETE FROM organizations WHERE id IN (SELECT uo."organizationId" FROM user_organizations uo JOIN users u ON u.id = uo."userId" WHERE u.email = '${MAYA.email}')` },
    { sql: `DELETE FROM users WHERE email = '${MAYA.email}'` },
    upstream('/_admin/reset'),
  ] as Step[],
}

const onboarding = walk('tutorial-onboarding', 'Tutorial: new customer onboarding', ['tutorial-onboarding-fresh'], [
  ['onboarding-00', 'onboarding/00-approve-kickoff.png', 'Onboarding agent: the kickoff call waiting for approval', APPROVALS],
  ['onboarding-01', 'onboarding/01-drive-link.png', 'Google Drive description link', ['frontend/src/pages/api-new-description.tsx', 'frontend/src/components/apis']],
  ['onboarding-02', 'onboarding/02-drive-sign-in.png', 'Google Drive sign-in: drive.file and drive.readonly', SETUP],
  ['onboarding-03', 'onboarding/03-drive-connected.png', 'Google Drive signed in', SETUP],
  ['onboarding-04', 'onboarding/04-agent-instructions.png', 'Onboarding agent: model and instructions', BUILDER],
  ['onboarding-05', 'onboarding/05-agent-tools.png', 'Onboarding agent: tools', BUILDER],
  ['onboarding-06', 'onboarding/06-always-on.png', 'Always on: standing instructions and a 12-hour timer', ALWAYS_ON],
  ['onboarding-07', 'onboarding/07-ask-first.png', 'Always on: ask before booking a meeting', ALWAYS_ON],
  ['onboarding-08', 'onboarding/08-always-on-card.png', 'Onboarding agent: Always on card', AGENT],
  ['onboarding-09', 'onboarding/09-first-run.png', 'The first onboarding run, step by step', AGENT],
  ['onboarding-10', 'onboarding/10-welcome-email.png', 'The welcome email as the agent sent it', ['backend/src/modules/tools/executors/tool-http.executor.ts'], '/agents/:id/runs/:id'],
  ['onboarding-11', 'onboarding/11-notifications.png', 'Onboarding reports in notifications', ['frontend/src/pages/notifications.tsx', 'frontend/src/components/notifications']],
  ['onboarding-12', 'onboarding/12-handover-run.png', 'The run that booked the kickoff and handed over', AGENT],
  ['onboarding-13', 'onboarding/13-what-woke-it.png', 'What woke it lately, across the onboarding', ALWAYS_ON],
  ['onboarding-14', 'onboarding/14-runs.png', 'Onboarding agent: its runs', AGENT],
  ['onboarding-15', 'onboarding/15-deal-log.png', 'The onboarding log on the CRM deal', ['backend/src/modules/tools/executors/tool-http.executor.ts'], '/agents/:id/runs/:id'],
], [
  // What the other two tutorials connect first, without pictures.
  { use: 'connectOpenAI', with: { key: MODEL_KEY } },
  { use: 'importApi', with: { link: LINKS.calendar, name: 'Google Calendar', address: '{{stack.upstream}}/calendar/v3' } },
  { click: button('Create one here') },
  ...pastedToken('Google account (Maya)', 'local-test-google-token'),
  { use: 'importApi', with: { link: LINKS.gmail, name: 'Gmail', address: '{{stack.upstream}}/' } },
  { use: 'pickSignIn', with: { name: /Google account \(Maya\)/ } },
  hubspot('Contacts/Rollouts/424/v3/contacts.json', 'HubSpot Contacts'),
  { click: button('Create one here') },
  ...pastedToken('HubSpot private app', HUBSPOT_TOKEN, /Access token|Key|token/),
  hubspot('Deals/Rollouts/424/v3/deals.json', 'HubSpot Deals'),
  { use: 'pickSignIn', with: { name: /HubSpot private app/ } },

  // 1. Google Drive, for the folder each customer shares their files in
  { goto: '/apis/new/openapi' },
  { fill: { label: 'Link to the description' }, value: LINKS.drive },
  { click: button('Advanced') },
  { fill: { label: 'Name', exact: true }, value: 'Google Drive' },
  { fill: { label: 'Address', exact: true }, value: '{{stack.upstream}}/drive/v3' },
  { click: button('Advanced') },
  { shot: 'onboarding-01' },
  { click: button('Connect API') },
  { waitForUrl: /\/setup/, timeout: 60000 },
  { waitFor: { text: /Found \d+ operation/ }, timeout: 120000 },
  // It creates and shares its own folders (drive.file) and reads what customers put in them (drive.readonly).
  ...googleApp(GOOGLE_APP, /\/drive\.file$|\/drive\.readonly$/),
  { shot: 'onboarding-02' },
  ...pastedToken('Google Drive (Maya)', 'local-test-google-drive-token'),
  { scrollTop: true },
  { shot: 'onboarding-03' },

  // 2. The agent
  { use: 'newAgent', with: { name: 'Onboarding agent', personality: 'Friendly, clear and patient. Writes to customers like a helpful person, not like a system: short emails, one ask each, never pushy.', instructions: ONBOARDING_INSTRUCTIONS } },
  { shot: 'onboarding-04' },
  { use: 'pickTools', with: { tools: ONBOARDING_TOOLS } },
  near({ text: 'Tools and APIs' }),
  { shot: 'onboarding-05' },
  { use: 'saveAgent', with: { as: 'agents.onboarding' } },
  { use: 'activate', with: { agent: ONBOARDING } },

  // 3. Always on
  { goto: `/agents/${ONBOARDING}/always-on` },
  { fill: textbox('Standing instructions'), value: ONBOARDING_STANDING },
  { fill: { role: 'spinbutton', name: 'Every' }, value: '12' },
  { select: combo('Unit'), option: 'hours' },
  { select: combo('On its own, it'), option: /Does things/ },
  // Only booking the kickoff stays on the ask-first list.
  { uncheck: { role: 'checkbox', name: /^(hubspot_|gmail_|google_drive_)/ }, all: true },
  { select: combo('When'), option: /Only when it did something/ },
  { click: { role: 'switch', name: 'Always on' } },
  near({ role: 'heading', name: 'What wakes it' }),
  { shot: 'onboarding-06' },
  top({ text: 'Ask me first before', exact: true }, 260),
  { shot: 'onboarding-07' },
  { click: button('Save', true) },

  // 4. Day 0: the deal is won in HubSpot
  upstream('/_admin/win?company=Bluefin%20Couriers'),
  { goto: `/agents/${ONBOARDING}` },
  near({ role: 'heading', name: 'Always on' }),
  { shot: 'onboarding-08' },
  { use: 'wake', with: { agent: ONBOARDING, what: 'the first onboarding run' } },
  runWas('completed', 'the first run to have completed'),
  // "See the run" next to Last woke, as the tutorial says.
  { goto: `/agents/${ONBOARDING}` },
  { click: { role: 'link', name: 'See the run' } },
  { waitForUrl: '/runs/{{run.id}}' },
  { shot: 'onboarding-09' },
  { http: { url: '{{stack.upstream}}/_admin/state' }, save: 'day0' },
  { remember: 'welcome', value: '{{day0.sent|where:subject~^Welcome to Lumen|first}}' },
  { render: 'gmail', with: { subject: '{{welcome.subject}}', from: '{{welcome.from}}', to: '{{welcome.to}}', body: '{{welcome.body}}', note: 'The email exactly as the agent sent it through the Gmail API (local demo; the stand-in received it, nothing was sent).' }, shot: 'onboarding-10' },

  // 5. The next day: nothing yet, nothing done
  { use: 'wake', with: { agent: ONBOARDING, what: 'a waiting wake' } },
  // Day 3: still nothing, so a reminder
  upstream('/_admin/age?days=3'),
  { use: 'wake', with: { agent: ONBOARDING, what: 'the reminder wake' } },
  // Jonas answers the reminder; the files come a little later.
  upstream('/_admin/reply', { to: 'jonas.weber@bluefin.example', body: 'Hi, sorry for the wait, our fleet list is being updated. You will have both files on Monday.' }),
  upstream('/_admin/age?days=2'),
  { use: 'wake', with: { agent: ONBOARDING, what: 'a wake after the reply' } },
  { goto: '/notifications' },
  { shot: 'onboarding-11' },

  // 6. The files arrive: the kickoff waits for Maya
  upstream('/_admin/upload?company=Bluefin%20Couriers'),
  { use: 'wake', with: { agent: ONBOARDING, what: 'the kickoff approval' } },
  runWas('waiting_approval', 'the kickoff run to wait for approval'),
  { goto: '/approvals' },
  // The card says what it will do: the event's summary, times and attendees.
  { waitFor: { testid: 'approval-action-preview' } },
  { shot: 'onboarding-00' },
  { use: 'approveAll' },
  received('deals', { 'properties.dealname': /^Bluefin/, 'properties.description': /Handed over/ }, 'the hand-over', { timeout: 600000 }),
  { until: { sql: lastRun('status'), is: 'completed' }, timeout: 600000, every: 3000, what: 'the hand-over run to complete' },
  { sql: lastRun('id'), save: 'run.id' },
  { goto: `/agents/${ONBOARDING}/runs/{{run.id}}` },
  // The end of the run: the event, the handover email, the last note on the deal.
  top({ text: /^#\d+$/, within: { role: 'main' }, nth: 'last' }, 520),
  { shot: 'onboarding-12' },

  // 7. Two weeks in one list
  { goto: `/agents/${ONBOARDING}/always-on` },
  near({ role: 'heading', name: 'What woke it lately' }),
  { shot: 'onboarding-13' },
  { goto: `/agents/${ONBOARDING}` },
  { click: { role: 'tab', name: 'Runs' } },
  { shot: 'onboarding-14' },
  { http: { url: '{{stack.upstream}}/_admin/state' }, save: 'done' },
  { remember: 'deal', value: '{{done.deals|where:properties.dealname~^Bluefin|first|get:properties}}' },
  { render: 'deal', with: { name: '{{deal.dealname}}', stage: '{{deal.dealstage}}', description: '{{deal.description}}', note: "The deal's description exactly as the agent wrote it through the HubSpot API (local demo; HubSpot itself was not used)." }, shot: 'onboarding-15' },
])

// In this order on one stack: the onboarding tutorial starts over, so it comes last.
export const tutorials = [founder, bizdev, pushWakes, fresh, onboarding]
