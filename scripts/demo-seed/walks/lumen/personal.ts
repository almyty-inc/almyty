// The personal-assistant tutorial (docs-site/content/tutorials/
// personal-assistant.mdx), walked through the UI, one screenshot per picture.
//
// It works as Elena Park, in an organization of her own, on the elena
// profile: the same stand-in as the other tutorials, serving her calendars,
// mail and tasks, and the API started with its public address, so publishing
// the Telegram channel registers its webhook (with the stand-in instead of
// Telegram). What differs from a real account, because the stand-in is on
// localhost: the API addresses are set to the stand-in under Advanced, the
// model key is sent with the stand-in's address, Google's sign-in page is
// never opened (a token is pasted instead), her Telegram messages are posted
// to the channel the way Telegram posts them (with the secret token it was
// given), and the Telegram chat is shown as the stand-in received it.
import type { Step } from '../../engine/schema.ts'
import { AGENT, APPROVALS, BUILDER, CHANNEL, LINKS, MODEL_KEY, SETUP, approveOne, button, combo, googleApp, near, ownMemory, pastedToken, pendingApprovals, publishChannel, received, textbox, top } from './shared.ts'

export const ELENA = { email: 'elena.park@example.com', password: 'Elena-Park-2026!', firstName: 'Elena', lastName: 'Park', organizationName: 'Elena Park' }
// Her Telegram account: the number Telegram gives it, which is also her 1:1 chat with the bot.
export const TG_USER = 581234907
const GOOGLE_APP = '123456789012-elenapark0001.apps.googleusercontent.com'

export const PERSONALITY = 'Friendly, calm and short. Lead with the news, then one clear question. No filler, no exclamation marks.'
export const INSTRUCTIONS = `You are Elena Park's personal assistant. You look after her calendar, her email and her tasks.

Get to know her. When she tells you something about herself (what she likes, her routines, the people in her life, how she wants things done), remember it. When she says yes or no to something you offered, remember that too, and use it next time.

Look ahead. At every wake, check the next two days of her calendars, her new email and her open tasks. Tell her only about what needs her: a clash, a change (a moved flight, a cancelled meeting), something due soon, an email that needs an answer. If nothing needs her, stay quiet.

When you see a problem, offer one concrete fix and ask: "Shall I ...?". Never change anything before she says yes: no email, no calendar change, no task change.

If you cannot see something because you have no access to it, say so plainly.`
export const STANDING = 'Look after Elena. At every wake, check the next two days of her calendars, her email from the last day and her open tasks. If something needs her (a clash, a change, something due soon), tell her in one or two sentences and offer one fix. If nothing needs her, answer only: Nothing needs you right now.'
export const INTRO = "Hi, a few things about me. I don't take meetings before 9, except when I travel. Keep your messages short. Tom Becker is my manager at Northwind Studio; he is fine with short-notice changes if I tell him early. Ana is my sister, we have lunch whenever I am in Berlin. I always take a window seat, and it takes me about 40 minutes from Berlin airport to the office."
export const TOOLS = [
  'google_calendar_calendar_calendar_list_list',
  'google_calendar_calendar_events_list',
  'google_calendar_calendar_events_patch',
  'gmail_gmail_users_messages_list',
  'gmail_gmail_users_messages_get',
  'gmail_gmail_users_messages_send',
  'google_tasks_tasks_tasks_list',
]

const ALWAYS_ON = ['frontend/src/pages/agent-always-on.tsx', 'frontend/src/lib/always-on.ts']
const TELEGRAM = ['backend/src/modules/gateways/channels/adapters/telegram.adapter.ts', 'backend/src/modules/agents/always-on/always-on.service.ts', 'backend/src/modules/gateways/channels/adapters/channel-markdown.ts']
const NOTE = 'Tutorial step, walked through the UI on the local demo stack with the elena profile (scripts/demo-seed, walks/lumen): real public API descriptions, a local stand-in for Google and Telegram, and a scripted stand-in model; a fictional person. Not staging or production data. A page of Telegram messages lays them out exactly as almyty sent them; Telegram was not used.'

type ShotRow = [id: string, path: string, title: string, sources: string[], route?: string]
const ROWS: ShotRow[] = [
  ['pa-00', 'personal/00-telegram-flight.png', 'Personal assistant: the flight change in Telegram', TELEGRAM, '/agents/:id/always-on'],
  ['pa-01', 'personal/01-calendar-scopes.png', 'Google Calendar sign-in: permission to change events', SETUP],
  ['pa-02', 'personal/02-apis.png', 'Google Calendar, Gmail and Google Tasks connected', ['frontend/src/pages/apis.tsx']],
  ['pa-03', 'personal/03-agent-instructions.png', 'Personal assistant: model, personality and instructions', BUILDER],
  ['pa-04', 'personal/04-agent-memory.png', 'Personal assistant: memory', BUILDER],
  ['pa-05', 'personal/05-agent-tools.png', 'Personal assistant: tools', BUILDER],
  ['pa-06', 'personal/06-telegram-token.png', 'Telegram channel: the bot token', CHANNEL],
  ['pa-07', 'personal/07-telegram-live.png', 'Telegram channel, live and registered with Telegram', CHANNEL],
  ['pa-08', 'personal/08-always-on.png', 'Always on: standing instructions and what wakes it', ALWAYS_ON],
  ['pa-09', 'personal/09-talk-and-ask-first.png', 'Always on: talk to it in Telegram, ask first before every change', ALWAYS_ON],
  ['pa-10', 'personal/10-reports.png', 'Always on: reports to Telegram', ALWAYS_ON],
  ['pa-11', 'personal/11-always-on-card.png', 'Always on, on the agent page', AGENT],
  ['pa-12', 'personal/12-privacy.png', 'Settings, Compliance: hide personal data', ['frontend/src/components/settings/compliance-settings.tsx', 'frontend/src/pages/settings.tsx']],
  ['pa-13', 'personal/13-telegram-intro.png', 'Telling the assistant about yourself in Telegram', TELEGRAM, '/agents/:id/always-on'],
  ['pa-14', 'personal/14-memory.png', 'What the assistant remembers about Elena', AGENT],
  ['pa-15', 'personal/15-approve-move.png', 'Approving the moved meeting', APPROVALS],
  ['pa-16', 'personal/16-approve-email.png', 'Approving the email to Tom', APPROVALS],
  ['pa-17', 'personal/17-what-woke-it.png', 'What woke it lately', ALWAYS_ON],
  ['pa-18', 'personal/18-memory-after.png', 'The assistant remembers what Elena said yes to', AGENT],
]

const AGENT_ID = '{{agents.assistant}}'
const sendMessage = /api\.telegram\.org\/bot[^/]+\/sendMessage/
const botSaid = (text: RegExp, what: string): Step => received('outbox', { url: sendMessage, 'body.chat_id': String(TG_USER), 'body.text': text }, what)
const say = (text: string): Step => ({ action: 'telegramSay', with: { slug: '{{org.slug}}', channel: '{{channels.telegram}}', secret: '{{tgSecret}}', chat: TG_USER, text } })

const steps: Step[] = [
  // A used stand-in would mix an earlier run into these pictures.
  { action: 'freshUpstream' },
  // 1. A model and Google, as in the founder's associate, with the permissions to change events and send email.
  { use: 'connectOpenAI', with: { key: MODEL_KEY } },
  { use: 'importApi', with: { link: LINKS.calendar, name: 'Google Calendar', address: '{{stack.upstream}}/calendar/v3' } },
  // To move a meeting it needs calendar.events; nothing wider.
  ...googleApp(GOOGLE_APP, /\/auth\/calendar\.events$/),
  { shot: 'pa-01' },
  ...pastedToken('Google Calendar (Elena)', 'local-test-google-calendar-token'),
  ...([['Gmail', LINKS.gmail, 'gmail'], ['Google Tasks', LINKS.tasks, 'google-tasks']] as const).flatMap(([name, link, key]): Step[] => [
    { use: 'importApi', with: { link, name, address: '{{stack.upstream}}/' } },
    ...googleApp(GOOGLE_APP),
    ...pastedToken(`${name} (Elena)`, `local-test-${key}-token`),
  ]),
  { goto: '/apis' },
  { shot: 'pa-02' },

  // 2. The assistant
  { use: 'newAgent', with: { name: "Elena's assistant", personality: PERSONALITY, instructions: INSTRUCTIONS } },
  { scrollTo: textbox('Personality and style'), offset: 260, inner: textbox('Instructions') },
  { shot: 'pa-03' },
  ...ownMemory,
  near({ role: 'heading', name: 'Memory' }),
  { shot: 'pa-04' },
  { use: 'pickTools', with: { tools: TOOLS } },
  near({ role: 'heading', name: 'Tools and APIs' }),
  { shot: 'pa-05' },
  { use: 'saveAgent', with: { as: 'agents.assistant' } },
  { use: 'activate', with: { agent: AGENT_ID } },

  // 3. Telegram: the bot she talks to
  { goto: `/agents/${AGENT_ID}/channels/new` },
  { click: button(/^Telegram/) },
  { click: { role: 'button', name: 'Create one here', nth: 'last' } },
  { fill: { role: 'textbox', name: 'Name', exact: true, nth: 'last' }, value: 'Telegram bot (Elena)' },
  { fill: textbox('Bot token'), value: '7000001234:AAH-local-test-token-elena-0123456789' },
  near(textbox('Bot token')),
  { shot: 'pa-06' },
  ...publishChannel({ text: 'Registered with Telegram.' }),
  { shot: 'pa-07' },
  { remember: 'channels.telegram', fromUrl: /channels\/([0-9a-f-]{36})/ },
  // The secret token almyty gave Telegram when it registered the webhook; Telegram sends it back with every update.
  { action: 'telegramSecret', save: 'tgSecret' },

  // 4. Always on: wakes by itself, talks to her in Telegram, asks before every change
  { goto: `/agents/${AGENT_ID}/always-on` },
  { fill: textbox('Standing instructions'), value: STANDING },
  { fill: { role: 'spinbutton', name: 'Every' }, value: '30' },
  { select: combo('Unit'), option: 'minutes' },
  { click: { role: 'switch', name: 'Always on' } },
  top({ text: 'What it keeps doing', exact: true }, 140),
  { shot: 'pa-08' },
  { select: combo('Channel'), option: /Telegram/ },
  { fill: textbox('Your address there'), value: String(TG_USER) },
  { select: combo('On its own, it'), option: /Does things/ },
  top({ text: 'Talk to it yourself', exact: true }, 140),
  { shot: 'pa-09' },
  { select: combo('Post reports to'), option: /Telegram/ },
  { fill: { placeholder: '-1001234567890 or @yourchannel' }, value: String(TG_USER) },
  { select: combo('When'), option: 'After every wake' },
  top({ role: 'heading', name: 'Reports' }, 60),
  { shot: 'pa-10' },
  { click: button('Save', true) },
  { goto: `/agents/${AGENT_ID}` },
  near({ role: 'heading', name: 'Always on' }),
  { shot: 'pa-11' },

  // 5. The privacy filter: personal data hidden in records and in answers to outsiders
  { goto: '/settings' },
  { click: { role: 'tab', name: 'Advanced' } },
  { click: { role: 'link', name: 'Compliance', exact: true } },
  { if: { not: { checked: { role: 'switch', name: 'Enforce PII filter' } } }, then: [{ click: { role: 'switch', name: 'Enforce PII filter' } }] },
  top({ role: 'heading', name: 'Compliance policy' }, 140),
  { shot: 'pa-12' },
  { click: button('Save compliance policy') },

  // 6. She tells it about herself, in Telegram
  { remember: 'introFrom', value: '{{$now|iso}}' },
  say(INTRO),
  botSaid(/I will remember/, 'its answer in Telegram'),
  { action: 'telegramChat', with: { chat: TG_USER, from: '{{introFrom}}' }, save: 'chatIntro' },
  { render: 'telegram', with: { title: 'Telegram', messages: '{{chatIntro}}' }, shot: 'pa-13' },
  { goto: `/agents/${AGENT_ID}` },
  { click: { role: 'tab', name: 'Memory' } },
  { shot: 'pa-14' },

  // 7. Her flight moves: the airline's email arrives, and at its next wake it notices the clash.
  { remember: 'flightFrom', value: '{{$now|iso}}' },
  { action: 'flightMail' },
  { goto: `/agents/${AGENT_ID}` },
  { click: button('Wake now') },
  botSaid(/Shall I move/, 'the offer in Telegram'),

  // 8. She says yes; each change still waits for her OK in Approvals.
  say('Yes please, do that.'),
  { until: pendingApprovals, timeout: 180000, what: 'the calendar change waiting for approval' },
  { goto: '/approvals' },
  // The request lists what it will change (the event, its new start and end) without opening anything.
  { shot: 'pa-15' },
  ...approveOne,
  { until: pendingApprovals, timeout: 180000, what: 'the email to Tom waiting for approval' },
  { goto: '/approvals' },
  { shot: 'pa-16' },
  ...approveOne,
  botSaid(/^Done\./, 'its answer in Telegram'),
  { action: 'telegramChat', with: { chat: TG_USER, from: '{{flightFrom}}' }, save: 'chatFlight' },
  { render: 'telegram', with: { title: 'Telegram', messages: '{{chatFlight}}' }, shot: 'pa-00' },

  // 9. Afterwards: what woke it, and what it remembers now.
  { goto: `/agents/${AGENT_ID}/always-on` },
  near({ role: 'heading', name: 'What woke it lately' }),
  { shot: 'pa-17' },
  { goto: `/agents/${AGENT_ID}` },
  { click: { role: 'tab', name: 'Memory' } },
  { shot: 'pa-18' },
]

export const personal = {
  id: 'tutorial-personal', title: 'Tutorial: a personal assistant', profile: 'elena', account: ELENA, notes: NOTE,
  browser: { block: ['accounts.google.com'], providerUrl: '{{stack.upstream}}/openai/v1' },
  shots: Object.fromEntries(ROWS.map(([id, path, title, sources, route]) => [id, { path: `screenshots/tutorials/${path}`, title, sources, ...(route ? { route } : {}) }])),
  steps,
}
