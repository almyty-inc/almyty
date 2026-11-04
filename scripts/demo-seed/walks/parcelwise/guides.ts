// Five example guides in docs-site/content/examples, walked through the UI
// step by step as their text says: docs-deflection-bot,
// lead-enrichment-routing, meeting-notes-to-crm, agent-that-remembers and
// connect-google-sharepoint.
//
// They work as Sofia Marques, head of sales at Parcelwise (made up), in an
// organization of her own; each guide builds on the ones before it (the
// model connected in the first, the Slack bot and the HubSpot key reused).
// What differs from a real account, because the stand-in
// (fakes/services/parcelwise.ts) is on localhost: the API addresses are set
// to the stand-in under Advanced, the model key is sent with the stand-in's
// address, Google's sign-in page is never opened (a token is pasted
// instead), and Slack messages are shown as the stand-in received them,
// rendered as a page. The API descriptions are the real public ones, read
// from their links as a user would.
import type { Step } from '../../engine/schema.ts'
import { demoPassword } from '../../engine/password.ts'

export const SOFIA = { email: 'sofia.marques@parcelwise.example', password: demoPassword(), firstName: 'Sofia', lastName: 'Marques', organizationName: 'Parcelwise' }

const NOTE = 'Example guide step, walked through the UI on the local demo stack (scripts/demo-seed, walks/parcelwise): real public API descriptions, a local stand-in for Intercom, HubSpot, Google Drive and Slack, and a scripted stand-in model; fictional people and companies. Not staging or production data.'
const RENDERED_NOTE = `${NOTE} The page renders the message exactly as almyty handed it to Slack; Slack itself was not used.`
const BROWSER = { providerUrl: '{{stack.upstream}}/openai/v1', block: ['accounts.google.com', 'app.hubspot.com', 'app.intercom.com'] }

// The shared UI (components/ui, components/layout, index.css) is never a source: check-screenshots rejects it as too broad.
const AGENT = ['frontend/src/pages/agent-detail.tsx', 'frontend/src/components/agents']
const BUILDER = ['frontend/src/pages/agent-builder.tsx', 'frontend/src/components/agents']
const NEW_API = ['frontend/src/pages/api-new.tsx']
const SETUP = ['frontend/src/pages/api-setup.tsx', 'frontend/src/components/apis/api-key-form.tsx']
const CHANNEL = ['frontend/src/pages/agent-channel.tsx', 'frontend/src/components/channels']
const SCHEDULE = ['frontend/src/pages/agent-schedule.tsx']
const MODELS = ['frontend/src/pages/models-connect.tsx', 'frontend/src/components/llm-providers']
const SLACK_RENDER = ['backend/src/modules/gateways/channels/adapters/slack.adapter.ts', 'backend/src/modules/gateways/channels/adapters/channel-markdown.ts']

const shot = (file: string, title: string, sources: string[], extra: { route?: string; notes?: string } = {}) => ({ path: `screenshots/examples/${file}`, title, sources, ...extra })

function walk(id: string, title: string, after: string[], shots: Record<string, ReturnType<typeof shot>>, steps: Step[]) {
  return { id, title, profile: 'parcelwise', account: SOFIA, after, notes: NOTE, browser: BROWSER, shots, steps }
}

const TOOLS_HEADING: Step = { scrollTo: { text: 'Tools and APIs' }, block: 'nearest' }
const agentSteps = (as: string): Step[] => [
  { use: 'saveAgent', with: { as: `agents.${as}` } },
  { use: 'activate', with: { agent: `{{agents.${as}}}` } },
]
const STATE = '{{stack.upstream}}/_admin/state'
// Where the stand-in's outbox stands now, so a later wait looks only at what came after.
const outboxMark = (name: string): Step => ({ http: { url: STATE }, save: name })
const slackPost = (mark: string, text: RegExp, what: string, timeout: number, save: string): Step => ({
  until: { http: { url: `${STATE}?since={{${mark}.outbox|len}}` }, at: 'outbox', where: { url: { contains: 'chat.postMessage' }, 'body.text': text } },
  timeout, every: 3000, what, save,
})

// ---------- 1. answer from the help center (docs-deflection-bot) ----------
const DOCS_INSTRUCTIONS = `You answer questions from Parcelwise colleagues about the product, using only the Parcelwise help center in Intercom.

For every question:
1. Search the help center for it.
2. If an article answers it, answer in a few lines and end with "Source:" and a link to the article. Copy plan limits and carrier names exactly as the article says them.
3. If no article answers it, do not guess. Open a ticket of the type "Docs gap" for the docs team, with the question as its title and docs@parcelwise.example as the contact, and say that you did.

Never invent a feature, a limit or a price that is not in an article.`

const ACCESS = { role: 'button', name: /^Let this agent use/, within: { testid: 'agent-access-card' } } as const

const docs = walk('docs-deflection-bot', 'Docs assistant: answers from the help center, in Slack', [], {
  'docs-00': shot('docs-deflection-bot/00-slack-thread.png', 'Docs assistant answering in a Slack thread', SLACK_RENDER, { route: '/agents/:id/channels/:id', notes: RENDERED_NOTE }),
  'docs-01': shot('docs-deflection-bot/01-connect-model.png', 'Connect a provider: OpenAI', MODELS),
  'docs-02': shot('docs-deflection-bot/02-intercom-link.png', 'Intercom API description link', NEW_API),
  'docs-03': shot('docs-deflection-bot/03-intercom-token.png', 'Intercom access token', SETUP),
  'docs-04': shot('docs-deflection-bot/04-agent.png', 'Docs assistant: model and instructions', BUILDER),
  'docs-05': shot('docs-deflection-bot/05-tools.png', 'Docs assistant: Intercom tools', BUILDER),
  'docs-06': shot('docs-deflection-bot/06-try-answer.png', 'Docs assistant: an answer with its source', AGENT),
  'docs-07': shot('docs-deflection-bot/07-try-ticket.png', 'Docs assistant: a docs gap ticket', AGENT),
  'docs-08': shot('docs-deflection-bot/08-slack-keys.png', 'Slack channel: bot token and signing secret', CHANNEL),
  'docs-09': shot('docs-deflection-bot/09-slack-live.png', 'Slack channel, live', CHANNEL),
  'docs-10': shot('docs-deflection-bot/10-access.png', 'Access: let the agent use Intercom for everyone who asks', [...AGENT, 'frontend/src/components/agents/builder/capabilities-section.tsx']),
}, [
  { use: 'connectOpenAI', with: { name: 'OpenAI', key: 'sk-proj-0000000000000000000000000000000000000000', shot: 'docs-01' } },
  { use: 'importApi', with: { link: 'https://raw.githubusercontent.com/intercom/Intercom-OpenAPI/main/descriptions/2.11/api.intercom.io.yaml', name: 'Intercom', address: '{{stack.upstream}}/intercom', linkShot: 'docs-02' } },
  { click: { role: 'button', name: 'Create one here' } },
  { fill: { role: 'textbox', name: 'Name', exact: true, nth: 'last' }, value: 'Intercom (Parcelwise help center)' },
  { fill: { role: 'textbox', name: /token|Key/i, nth: 'last' }, value: 'dG9rOmxvY2FsLWRlbW8tMDAwMDAwMDAwMDAwMDAwMDAwMDA=' },
  { shot: 'docs-03' },
  { use: 'saveSignIn' },

  { use: 'newAgent', with: { name: 'Docs assistant', personality: 'Short and plain. Answers first, then how. No filler and no exclamation marks.', instructions: DOCS_INSTRUCTIONS } },
  { scrollTop: true },
  { shot: 'docs-04' },
  { use: 'pickTools', with: { tools: ['intercom_search_articles', 'intercom_list_ticket_types', 'intercom_create_ticket'] } },
  TOOLS_HEADING,
  { shot: 'docs-05' },
  ...agentSteps('docs'),
  { use: 'parcelwiseAsk', with: { agent: '{{agents.docs}}', message: 'Can customers print DHL return labels in bulk?', answer: /Source/, shot: 'docs-06' } },
  { use: 'parcelwiseAsk', with: { agent: '{{agents.docs}}', message: 'Is there a rate limit on the Parcelwise REST API?', answer: /ticket|could not find/i, shot: 'docs-07' } },

  { use: 'parcelwiseSlack', with: { agent: '{{agents.docs}}', create: true, keysShot: 'docs-08', liveShot: 'docs-09', as: 'channels.docs' } },
  // Who writes on a channel is not the owner: the agent may use only what it was given.
  { goto: '/agents/{{agents.docs}}' },
  { waitFor: ACCESS },
  { scrollTo: { testid: 'agent-access-card' }, offset: 140 },
  { shot: 'docs-10' },
  { repeat: [{ click: ACCESS }], while: { visible: ACCESS }, max: 6 },

  outboxMark('slack.before'),
  { action: 'parcelwiseSlackMention', with: { slug: '{{org.slug}}', gateway: '{{channels.docs}}', text: '<@U0BOT> can customers print DHL return labels in bulk? A prospect asked on a call.' } },
  slackPost('slack.before', /Source/, 'the Slack answer', 150000, 'slack.answer'),
  { render: 'parcelwiseSlackThread', shot: 'docs-00', with: {
    height: 300, channel: '# ask-product', asker: 'Tom Becker', askerColor: '#7c3aed', mention: '@Docs assistant',
    question: 'can customers print DHL return labels in bulk? A prospect asked on a call.',
    bot: 'Docs assistant', botColor: '#0891b2', answer: '{{slack.answer|first|get:body.text}}',
    note: 'The reply exactly as almyty posted it to Slack, shown the way Slack formats it (local demo; Slack itself was not used).',
  } },
])

// ---------- 2. score and route new leads (lead-enrichment-routing) ----------
const HS = 'https://raw.githubusercontent.com/HubSpot/HubSpot-public-api-spec-collection/main/PublicApiSpecs/CRM/'
const LEADS_INSTRUCTIONS = `You score new leads in HubSpot for Parcelwise, shipping software for online shops, and route the good ones.

Find contacts whose lifecycle stage is "lead" and that have no fit score yet. For each one, read their company and score the fit from 0 to 100:
- 30 points if the company is an online shop (industry Retail, Consumer Goods, Sporting Goods, Apparel & Fashion or Food & Beverages).
- 25 points for 50 to 500 employees, 15 points for 20 to 49.
- 20 points if their message mentions order volume, shipping, returns, labels or a carrier.
- 15 points if their job title is Founder, Head of, Director or VP.

Save on the contact: fit_score (the number), fit_reason (one line with the reasons) and the lead status: "Open" for 70 or more, "Unqualified" below 70.
For 70 or more, also set the contact owner: companies in Europe go to the owner in the team "Sales EMEA", everyone else to the team "Sales Americas".

Then report the hot leads first (name, title, company, city, size, score, owner, and what they wrote), then the others in one line each. Never email a lead.`
const RESET: Step = { http: { method: 'POST', url: '{{stack.upstream}}/_admin/reset' } }
const PICK_HUBSPOT: Step = { use: 'pickSignIn', with: { name: /HubSpot private app/ } }
const hubspot = (path: string, name: string, linkShot?: string): Step => ({ use: 'importApi', with: { link: HS + path, name, address: '{{stack.upstream}}/hubspot', ...(linkShot ? { linkShot } : {}) } })

const leads = walk('lead-enrichment-routing', 'Lead scorer: new HubSpot leads scored and routed, hot ones to Slack', ['docs-deflection-bot'], {
  'leads-00': shot('lead-enrichment-routing/00-slack-hot-leads.png', 'Hot leads posted to Slack', SLACK_RENDER, { route: '/agents/:id/schedule', notes: RENDERED_NOTE }),
  'leads-01': shot('lead-enrichment-routing/01-hubspot-link.png', 'HubSpot Contacts description link', NEW_API),
  'leads-02': shot('lead-enrichment-routing/02-hubspot-token.png', 'HubSpot private app token', SETUP),
  'leads-03': shot('lead-enrichment-routing/03-apis.png', 'HubSpot Contacts, Companies and Owners connected', ['frontend/src/pages/apis.tsx']),
  'leads-04': shot('lead-enrichment-routing/04-agent.png', 'Lead scorer: instructions with the scoring rules', BUILDER),
  'leads-05': shot('lead-enrichment-routing/05-tools.png', 'Lead scorer: HubSpot tools', BUILDER),
  'leads-06': shot('lead-enrichment-routing/06-try.png', 'Lead scorer: a test run', AGENT),
  'leads-07': shot('lead-enrichment-routing/07-run-steps.png', 'Lead scorer: what the run did in HubSpot', AGENT),
  'leads-08': shot('lead-enrichment-routing/08-slack-live.png', 'Slack channel for the lead scorer, live', CHANNEL),
  'leads-09': shot('lead-enrichment-routing/09-schedule.png', 'Schedule: every hour, posted to #sales-leads', SCHEDULE),
  'leads-10': shot('lead-enrichment-routing/10-schedule-card.png', 'The schedule on the agent page', AGENT),
}, [
  RESET,
  hubspot('Contacts/Rollouts/424/v3/contacts.json', 'HubSpot Contacts', 'leads-01'),
  { click: { role: 'button', name: 'Create one here' } },
  { if: { visible: { role: 'button', name: 'Paste an access token instead' } }, then: [{ click: { role: 'button', name: 'Paste an access token instead' } }] },
  { fill: { role: 'textbox', name: 'Name', exact: true, nth: 'last' }, value: 'HubSpot private app' },
  { fill: { role: 'textbox', name: /Access token|Key|token/, nth: 'last' }, value: 'local-demo-hubspot-token-0000000000000000000' },
  { shot: 'leads-02' },
  { use: 'saveSignIn' },
  hubspot('Companies/Rollouts/424/v3/companies.json', 'HubSpot Companies'),
  PICK_HUBSPOT,
  hubspot('Crm%20Owners/Rollouts/146888/v3/crmOwners.json', 'HubSpot Owners'),
  PICK_HUBSPOT,
  { goto: '/apis' },
  { shot: 'leads-03' },

  { use: 'newAgent', with: { name: 'Lead scorer', instructions: LEADS_INSTRUCTIONS } },
  { scrollTop: true },
  { shot: 'leads-04' },
  { use: 'pickTools', with: { tools: [
    'hubspot_contacts_post_crm_v3_objects_contacts_search_do_search',
    'hubspot_contacts_patch_crm_v3_objects_contacts_contact_id_update',
    'hubspot_companies_get_crm_v3_objects_companies_company_id_937ca5',
    'hubspot_owners_get_crm_v3_owners_crm_v3_owners',
  ] } },
  TOOLS_HEADING,
  { shot: 'leads-05' },
  ...agentSteps('leads'),
  { use: 'parcelwiseAsk', with: { agent: '{{agents.leads}}', message: 'Score the new leads.', answer: /hot lead/, shot: 'leads-06' } },
  { use: 'parcelwiseRunSteps', with: { agent: '{{agents.leads}}', shot: 'leads-07' } },

  { use: 'parcelwiseSlack', with: { agent: '{{agents.leads}}', create: false, liveShot: 'leads-08', as: 'channels.leads' } },
  // The test run scored them; the stand-in forgets the scores so the scheduled run finds them again.
  RESET,
  { use: 'parcelwiseSchedule', with: { agent: '{{agents.leads}}', every: 1, unit: 'hours', shot: 'leads-09' } },
  { scrollTo: { role: 'heading', name: 'Schedule' }, block: 'nearest' },
  { shot: 'leads-10' },
  outboxMark('slack.before'),
  { use: 'parcelwiseSchedule', with: { agent: '{{agents.leads}}', every: 1, unit: 'minutes' } },
  slackPost('slack.before', /hot lead/, 'the hot leads in Slack', 240000, 'slack.post'),
  { use: 'parcelwiseSchedule', with: { agent: '{{agents.leads}}', every: 1, unit: 'hours' } },
  { render: 'parcelwiseSlackPost', shot: 'leads-00', with: {
    height: 300, channel: '# sales-leads', bot: 'Lead scorer', botColor: '#0891b2', post: '{{slack.post|first|get:body.text}}',
    note: 'The message exactly as almyty posted it to Slack, shown the way Slack formats it (local demo; Slack itself was not used).',
  } },
])

// ---------- 3. call notes to HubSpot (meeting-notes-to-crm) ----------
const NOTES_INSTRUCTIONS = `You turn a sales rep's call notes into HubSpot updates for Parcelwise.

When a rep pastes call notes:
1. Find the deal for the company named in the notes.
2. Update the deal: move the stage to "Presentation scheduled" when a demo was agreed, set the close date when the notes give a decision date, and write the next step in one line.
3. Add the notes to the deal as a note, as short bullet points.
4. Create a task for the deal owner for the first thing that was promised, due the next working day at 09:00.
5. Reply with what you changed (old and new values) and a short follow-up email the rep can send. Never send email yourself.

Only write what the notes say. Never invent a date, an amount or a promise.`
const CALL_NOTES = 'Call with Lena Fischer (Kaffeewerk), 22 Oct. They ship about 1,200 orders a week, mostly DHL, and around 8% come back. Return labels are made by hand today, which is the main pain. Shopify store, 2 warehouse staff. Budget is approved for Q1, decision by end of November. They want a demo for Jonas, their warehouse lead, on Thursday 30 Oct. Asked for pricing for 8 seats on the Business plan, with DHL return labels.'

const notes = walk('meeting-notes-to-crm', 'Call notes assistant: notes into HubSpot updates and an email draft', ['lead-enrichment-routing'], {
  'notes-00': shot('meeting-notes-to-crm/00-result.png', 'Call notes turned into HubSpot updates and an email draft', AGENT),
  'notes-01': shot('meeting-notes-to-crm/01-notes-link.png', 'HubSpot Notes description link', NEW_API),
  'notes-02': shot('meeting-notes-to-crm/02-pick-key.png', 'HubSpot Notes: pick the saved key', SETUP),
  'notes-03': shot('meeting-notes-to-crm/03-apis.png', 'HubSpot Deals, Notes and Tasks connected', ['frontend/src/pages/apis.tsx']),
  'notes-04': shot('meeting-notes-to-crm/04-agent.png', 'Call notes assistant: instructions', BUILDER),
  'notes-05': shot('meeting-notes-to-crm/05-tools.png', 'Call notes assistant: HubSpot tools', BUILDER),
  'notes-06': shot('meeting-notes-to-crm/06-run-steps.png', 'Call notes assistant: what the run changed', AGENT),
}, [
  hubspot('Deals/Rollouts/424/v3/deals.json', 'HubSpot Deals'),
  PICK_HUBSPOT,
  hubspot('Notes/Rollouts/424/v3/notes.json', 'HubSpot Notes', 'notes-01'),
  PICK_HUBSPOT,
  { scrollTop: true },
  { shot: 'notes-02' },
  hubspot('Tasks/Rollouts/424/v3/tasks.json', 'HubSpot Tasks'),
  PICK_HUBSPOT,
  { goto: '/apis' },
  { shot: 'notes-03' },
  { use: 'newAgent', with: { name: 'Call notes to HubSpot', personality: 'Brief and factual. Writes emails the way a busy account executive does: short, friendly, one clear next step.', instructions: NOTES_INSTRUCTIONS } },
  { scrollTop: true },
  { shot: 'notes-04' },
  { use: 'pickTools', with: { tools: [
    'hubspot_deals_post_crm_v3_objects_0_3_search_do_search',
    'hubspot_deals_patch_crm_v3_objects_0_3_deal_id_update',
    'hubspot_notes_post_crm_v3_objects_notes_create',
    'hubspot_tasks_post_crm_v3_objects_tasks_create',
  ] } },
  TOOLS_HEADING,
  { shot: 'notes-05' },
  ...agentSteps('notes'),
  { use: 'parcelwiseAsk', with: { agent: '{{agents.notes}}', message: CALL_NOTES, answer: /Updated in HubSpot/, shot: 'notes-00' } },
  { use: 'parcelwiseRunSteps', with: { agent: '{{agents.notes}}', shot: 'notes-06' } },
])

// ---------- 4. an assistant that remembers (agent-that-remembers) ----------
const MEMORY_INSTRUCTIONS = `You are the account notes assistant for Parcelwise account managers.

When someone gives you notes about a customer, remember each lasting fact on its own: who decides, how they like to be contacted, their budget cycle, and what they are waiting for. Say back what you will remember.

When someone asks you to draft something for a customer, first look up what you remember about that customer and use it. Say which remembered facts you used. If you remember nothing about them, say so and ask.`

const memory = walk('agent-that-remembers', 'Account notes: an assistant that remembers', ['meeting-notes-to-crm'], {
  'memory-00': shot('agent-that-remembers/00-second-run.png', 'A later run using what it remembered', AGENT),
  'memory-01': shot('agent-that-remembers/01-instructions.png', 'Account notes: instructions', BUILDER),
  'memory-02': shot('agent-that-remembers/02-memory-settings.png', 'Account notes: memory settings', BUILDER),
  'memory-03': shot('agent-that-remembers/03-first-run.png', 'Account notes: first run stores facts', AGENT),
  'memory-04': shot('agent-that-remembers/04-memory-tab.png', 'What the agent remembers', AGENT),
  'memory-05': shot('agent-that-remembers/05-org-memory.png', 'Memory in the sidebar: everything the organization keeps', ['frontend/src/pages/memories.tsx']),
}, [
  { use: 'newAgent', with: { name: 'Account notes', personality: 'Brief and practical.', instructions: MEMORY_INSTRUCTIONS } },
  { scrollTop: true },
  { shot: 'memory-01' },
  { click: { role: 'switch', name: 'Remember between conversations' } },
  { select: { role: 'combobox', name: 'Whose memory' }, option: /Shared by all agents/ },
  { select: { role: 'combobox', name: 'What it saves' }, option: /Facts it learns/ },
  { scrollTo: { role: 'heading', name: 'Memory' }, block: 'nearest' },
  { shot: 'memory-02' },
  ...agentSteps('memory'),
  { use: 'parcelwiseAsk', with: { agent: '{{agents.memory}}', message: "Notes from today's check-in with Kestrel Coffee Co.: their financial year starts in July, so next year's budget is decided in May. Priya Raman (Operations Director) signs off on renewals; she prefers short emails with no attachments. They want the DPD integration before peak season.", answer: /remember/, shot: 'memory-03' } },
  { click: { role: 'tab', name: 'Memory' } },
  { waitFor: { text: /their financial year starts in July/ }, timeout: 20000 },
  { shot: 'memory-04' },
  { use: 'parcelwiseAsk', with: { agent: '{{agents.memory}}', message: 'Draft the renewal email for Kestrel Coffee Co.', answer: /Subject/, shot: 'memory-00' } },
  { goto: '/memories' },
  { shot: 'memory-05' },
])

// ---------- 5. Google Drive (connect-google-sharepoint) ----------
const DRIVE_INSTRUCTIONS = `You answer Parcelwise sales questions from the documents in the team's Google Drive: pricing, discounts, security, proposals and onboarding.

For every question:
1. Search the "Sales" shared drive for the documents that cover it: search the full text (q: fullText contains 'word'), newest first, with corpora "drive", driveId "0APwSalesShared", and includeItemsFromAllDrives and supportsAllDrives set to true.
2. Read the one or two most relevant documents as plain text.
3. Answer in a few lines, quoting the rule or number the document gives, and end with "Sources:" and a link to each document you used.

If no document covers the question, say so. Never guess a price, a discount or a security claim. You only read: never create, change or share files.`
const SCOPES = { testid: 'api-oauth-scopes' } as const

const drive = walk('connect-google-sharepoint', 'Sales documents: answers from Google Drive', ['agent-that-remembers'], {
  'drive-00': shot('connect-google-sharepoint/00-answer.png', 'An answer from Google Drive documents, with sources', AGENT),
  'drive-01': shot('connect-google-sharepoint/01-drive-link.png', 'Google Drive description link', NEW_API),
  'drive-02': shot('connect-google-sharepoint/02-drive-setup.png', 'Finish connecting Google Drive', SETUP),
  'drive-03': shot('connect-google-sharepoint/03-google-sign-in.png', 'Google sign-in: client ID, secret and permissions', SETUP),
  'drive-04': shot('connect-google-sharepoint/04-signed-in.png', 'Google Drive signed in', SETUP),
  'drive-05': shot('connect-google-sharepoint/05-test-tool.png', 'Testing the Drive search tool', ['frontend/src/pages/tool-detail.tsx']),
  'drive-06': shot('connect-google-sharepoint/06-agent.png', 'Sales documents assistant: instructions', BUILDER),
  'drive-07': shot('connect-google-sharepoint/07-tools.png', 'Sales documents assistant: Drive tools', BUILDER),
}, [
  { use: 'importApi', with: { link: 'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest', name: 'Google Drive', address: '{{stack.upstream}}/drive/v3', linkShot: 'drive-01' } },
  { shot: 'drive-02' },
  { click: { role: 'button', name: 'Create one here' } },
  { fill: { label: 'Client ID' }, value: '123456789012-pw0drive1sales.apps.googleusercontent.com' },
  { fill: { label: 'Client secret' }, value: 'GOCSPX-local-test-secret' },
  { waitFor: { testid: 'api-oauth-redirect' }, timeout: 10000 },
  // For an assistant that only reads: drive.readonly and nothing else.
  { setChecks: { role: 'checkbox', within: SCOPES }, on: /drive\.readonly$/ },
  { action: 'parcelwiseScrollInsideToTop', with: { within: SCOPES } },
  { scrollTo: { testid: 'api-oauth-redirect' }, offset: 120 },
  { shot: 'drive-03' },
  { use: 'pasteToken', with: { name: 'Google account (Sofia)', token: 'local-test-google-token' } },
  { use: 'saveSignIn' },
  { scrollTop: true },
  { shot: 'drive-04' },

  { goto: '/tools' },
  { fill: { placeholder: 'Search tools...' }, value: 'drive_files_list' },
  { settle: true },
  // The list shows the tool's display name; its machine name is the title.
  { click: { title: 'google_drive_drive_files_list', exact: true } },
  { click: { role: 'tab', name: 'Test tool' } },
  { fill: { placeholder: 'Enter q', exact: true }, value: "fullText contains 'discount'" },
  { click: { role: 'button', name: 'Execute Tool' } },
  { waitFor: { text: 'Response Data:' }, timeout: 20000 },
  { scrollTo: { text: 'Response Data:' }, block: 'nearest' },
  { shot: 'drive-05' },

  { use: 'newAgent', with: { name: 'Sales documents', personality: 'Direct and exact. Gives the answer first, then the rule it comes from.', instructions: DRIVE_INSTRUCTIONS } },
  { scrollTop: true },
  { shot: 'drive-06' },
  { use: 'pickTools', with: { tools: ['google_drive_drive_files_list', 'google_drive_drive_files_export'] } },
  TOOLS_HEADING,
  { shot: 'drive-07' },
  ...agentSteps('drive'),
  { use: 'parcelwiseAsk', with: { agent: '{{agents.drive}}', message: 'Can I give Kaffeewerk 15% off an annual Business plan with 8 seats?', answer: /Sources/, shot: 'drive-00' } },
])

export const guides = [docs, leads, notes, memory, drive]
