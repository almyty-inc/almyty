// The reference screenshots of the seeded Northwind AI organization: one
// page each, opened at its address, sometimes scrolled to a section or with
// one thing done on it first. Sizes are the published image in device pixels.
import type { Step } from '../../engine/schema.ts'
import { AVA } from './seed.ts'

interface Page {
  id: string
  title: string
  sources: string[]
  route: string
  /** The published size in device pixels. */
  size: [number, number]
  /** What is done on the page before the screenshot. */
  then?: Step[]
}

const AGENTS = ['frontend/src/pages/agent-detail.tsx', 'frontend/src/components/agents']
const BUILDER = ['frontend/src/pages/agent-builder.tsx', 'frontend/src/components/agents']
const CHANNEL = ['frontend/src/pages/agent-channel.tsx', 'frontend/src/components/channels']
const GATEWAY = ['frontend/src/pages/gateway-detail.tsx', 'frontend/src/components/gateways']
const ANALYTICS = ['frontend/src/pages/analytics.tsx', 'frontend/src/components/analytics']
const SETTINGS = ['frontend/src/pages/settings.tsx', 'frontend/src/components/settings']
const RUNNERS = ['frontend/src/pages/runners.tsx', 'frontend/src/pages/runners-shared.ts', 'frontend/src/components/runners']
const CHAT = ['frontend/src/pages/hosted-chat.tsx', 'frontend/src/lib/hosted-chat.ts']

const heading = (name: string): Step[] => [{ scrollTo: { role: 'heading', name }, offset: 24 }]
const section = (text: string): Step[] => [{ scrollTo: { text, exact: true }, offset: 32 }]
// A visitor asks one question and waits for the answer.
const converse: Step[] = [
  { fill: { role: 'textbox', name: 'Message' }, value: 'Where is order NW-10428? It was due last week.' },
  { click: { role: 'button', name: 'Send' } },
  { waitFor: { text: /held at customs|DHL Express/, nth: 'last' }, timeout: 30000 },
]

// The ids the routes need, found by name the way a reader finds them.
const lookups: Step[] = [
  { http: { url: '/agents?limit=100' }, save: 'list.agents' },
  { http: { url: '/gateways' }, save: 'list.gateways' },
  { http: { url: '/apis' }, save: 'list.apis' },
  { http: { url: '/runners' }, save: 'list.runners' },
  { http: { url: '/environments' }, save: 'list.environments' },
  { http: { url: '/organizations/{{org.id}}/tools?limit=100' }, save: 'list.tools' },
  { remember: 'id', value: {
    support: '{{list.agents|rows:agents|where:name=Customer Support Orchestrator|first|get:id}}',
    research: '{{list.agents|rows:agents|where:name=Market Research Analyst|first|get:id}}',
    digest: '{{list.agents|rows:agents|where:name=Nightly CSAT Digest|first|get:id}}',
    keeper: '{{list.agents|rows:agents|where:name=Pet store keeper|first|get:id}}',
    gwSupport: '{{list.gateways|rows:gateways|where:name=Northwind Support Tools|first|get:id}}',
    gwPetstore: '{{list.gateways|rows:gateways|where:name=Petstore|first|get:id}}',
    apiPetstore: '{{list.apis|rows:apis|where:name=Petstore|first|get:id}}',
    runner: '{{list.runners|rows:runners|first|get:id}}',
    envWebApp: '{{list.environments|rows:environments|where:name=web-app|first|get:id}}',
    tool: '{{list.tools|rows:tools|where:name=northwind_orders_track_shipment|first|get:id}}',
  } },
  { http: { url: '/agents/{{id.support}}/channels' }, save: 'list.channels' },
  { remember: 'channel', value: {
    web: '{{list.channels|rows:channels|where:type=web|first}}',
    slack: '{{list.channels|rows:channels|where:type=slack|first|get:id}}',
    tui: '{{list.channels|rows:channels|where:type=tui|first|get:id}}',
    teams: '{{list.channels|rows:channels|where:type=microsoft_teams|first|get:id}}',
    widget: '{{list.channels|rows:channels|where:type=widget|first|get:id}}',
  } },
]

const SIGNED_IN: Page[] = [
  { id: 'agents-list', title: 'Agents list', sources: ['frontend/src/pages/agents.tsx', 'frontend/src/components/agents'], route: '/agents', size: [2880, 2000] },
  { id: 'agent-detail-overview', title: 'Autonomous agent overview', sources: AGENTS, route: '/agents/{{id.support}}', size: [2880, 1500] },
  { id: 'support-agent-overview', title: 'Support agent overview', sources: AGENTS, route: '/agents/{{id.support}}', size: [2880, 1500] },
  { id: 'agent-constraints', title: 'Agent constraints', sources: AGENTS, route: '/agents/{{id.support}}?tab=constraints', size: [2880, 1900] },
  { id: 'support-agent-constraints', title: 'Support agent constraints', sources: AGENTS, route: '/agents/{{id.support}}?tab=constraints', size: [2880, 1900] },
  { id: 'support-agent-runs', title: 'Support agent runs', sources: AGENTS, route: '/agents/{{id.support}}?tab=runs', size: [2880, 2400] },
  { id: 'agent-skill-viewer', title: 'Agent skills', sources: AGENTS, route: '/agents/{{id.support}}?tab=skills', size: [2560, 1600] },
  { id: 'agent-builder-autonomous', title: 'Autonomous agent: work mode', sources: BUILDER, route: '/agents/{{id.support}}/edit', size: [2560, 1600], then: heading('Work mode') },
  { id: 'agent-work-mode-panel', title: 'Panel work mode', sources: BUILDER, route: '/agents/{{id.research}}/edit', size: [2560, 1600], then: heading('Work mode') },
  { id: 'agent-builder-node-palette', title: 'Steps palette', sources: BUILDER, route: '/agents/{{id.digest}}/edit', size: [2880, 1800] },
  { id: 'schedule-config', title: 'Schedule card', sources: AGENTS, route: '/agents/{{id.digest}}', size: [2880, 1800], then: heading('Schedule') },
  { id: 'webhook-config', title: 'Webhook card', sources: AGENTS, route: '/agents/{{id.digest}}', size: [2880, 1800], then: heading('Webhook') },
  { id: 'versioning', title: 'Pipeline versions', sources: AGENTS, route: '/agents/{{id.digest}}', size: [2880, 1800], then: heading('Pipeline versions') },
  { id: 'versioning-history', title: 'Change history', sources: AGENTS, route: '/agents/{{id.support}}', size: [2880, 927], then: heading('Change history') },
  { id: 'agent-channels', title: "An agent's Channels tab", sources: [...AGENTS, 'frontend/src/components/channels'], route: '/agents/{{id.support}}?tab=channels', size: [2880, 1800] },
  { id: 'channel-branding-rules', title: 'Branding and visitor rules', sources: ['frontend/src/pages/agent-public-settings.tsx', 'frontend/src/components/channels'], route: '/agents/{{id.support}}/channels/settings', size: [2880, 1800] },
  { id: 'channel-web-published', title: 'Published web chat channel', sources: CHANNEL, route: '/agents/{{id.support}}/channels/{{channel.web.id}}', size: [2880, 2200] },
  { id: 'channel-slack-keys', title: 'Slack channel keys', sources: CHANNEL, route: '/agents/{{id.support}}/channels/{{channel.slack}}', size: [2880, 1800] },
  { id: 'channel-slack-live', title: 'Published Slack channel', sources: CHANNEL, route: '/agents/{{id.support}}/channels/{{channel.slack}}', size: [2880, 1800], then: section('Install link') },
  { id: 'channel-terminal-build', title: 'Terminal app channel', sources: CHANNEL, route: '/agents/{{id.support}}/channels/{{channel.tui}}', size: [2880, 1800] },
  { id: 'interfaces-channel-config', title: 'Add channel', sources: ['frontend/src/pages/agent-channel-new.tsx', 'frontend/src/components/channels'], route: '/agents/{{id.support}}/channels/new', size: [2560, 1600] },
  { id: 'interfaces-channel-setup', title: 'Microsoft Teams channel', sources: CHANNEL, route: '/agents/{{id.support}}/channels/{{channel.teams}}', size: [2560, 1600] },
  { id: 'widget-builder', title: 'Website widget channel', sources: [...CHANNEL, 'frontend/src/components/gateways/widget-builder.tsx'], route: '/agents/{{id.support}}/channels/{{channel.widget}}', size: [2560, 1600], then: section('Preview') },
  { id: 'apis-list', title: 'APIs list', sources: ['frontend/src/pages/apis.tsx', 'frontend/src/components/apis'], route: '/apis', size: [2880, 1700] },
  { id: 'quickstart-api-imported', title: 'Imported API', sources: ['frontend/src/pages/api-detail.tsx', 'frontend/src/components/apis'], route: '/apis/{{id.apiPetstore}}', size: [2880, 1800] },
  { id: 'tools-list', title: 'Tools list', sources: ['frontend/src/pages/tools.tsx', 'frontend/src/components/tools'], route: '/tools', size: [2880, 1500] },
  { id: 'tool-detail', title: 'Tool test', sources: ['frontend/src/pages/tool-detail.tsx', 'frontend/src/components/tools'], route: '/tools/{{id.tool}}?tab=test', size: [2880, 1800], then: [
    { fill: { placeholder: 'Enter orderId' }, value: 'NW-10428' },
    { click: { role: 'button', name: 'Execute Tool' } },
    { waitFor: { text: /Leipzig|DHL/ }, timeout: 20000 },
  ] },
  { id: 'gateway-detail', title: 'Gateway detail', sources: GATEWAY, route: '/gateways/{{id.gwSupport}}', size: [2560, 1600] },
  { id: 'gateway-detail-tools', title: 'Gateway tool scoping', sources: GATEWAY, route: '/gateways/{{id.gwSupport}}?tab=tools', size: [2560, 1600], then: section('Tool scoping') },
  { id: 'gateway-petstore-config', title: 'Petstore gateway', sources: GATEWAY, route: '/gateways/{{id.gwPetstore}}', size: [2560, 1600] },
  { id: 'quickstart-gateway-mcp', title: 'Petstore MCP gateway', sources: GATEWAY, route: '/gateways/{{id.gwPetstore}}', size: [2880, 1800] },
  { id: 'gateway-petstore-integration', title: 'Gateway integrations', sources: GATEWAY, route: '/gateways/{{id.gwPetstore}}?tab=integrations', size: [2560, 1600], then: section('MCP endpoint') },
  { id: 'quickstart-mcp-endpoints', title: 'MCP endpoints', sources: GATEWAY, route: '/gateways/{{id.gwPetstore}}?tab=integrations', size: [2880, 1800], then: section('MCP endpoint') },
  { id: 'quickstart-claude-config', title: 'Client setup', sources: GATEWAY, route: '/gateways/{{id.gwPetstore}}?tab=integrations', size: [2880, 1800], then: section('Quick setup') },
  { id: 'credentials-vault', title: 'Credentials', sources: ['frontend/src/pages/credentials.tsx', 'frontend/src/pages/credential-pages.tsx', 'frontend/src/components/credentials'], route: '/credentials', size: [2880, 1800] },
  { id: 'models', title: 'Model catalog', sources: ['frontend/src/pages/models.tsx', 'frontend/src/components/models'], route: '/models', size: [2880, 1800] },
  { id: 'memory', title: 'Memory', sources: ['frontend/src/pages/memories.tsx', 'frontend/src/components/memory'], route: '/memories', size: [2880, 1800] },
  { id: 'memory-write', title: 'Add memory', sources: ['frontend/src/pages/memory-new.tsx', 'frontend/src/components/memory'], route: '/memories/new', size: [2880, 1800] },
  { id: 'approvals-pending', title: 'Pending approvals', sources: ['frontend/src/pages/approvals.tsx', 'frontend/src/components/entitlement-gate.tsx'], route: '/approvals', size: [2560, 1600] },
  { id: 'approval-refund-820', title: 'Refund approval', sources: ['frontend/src/pages/approvals.tsx', 'frontend/src/components/entitlement-gate.tsx'], route: '/approvals', size: [2560, 1600], then: [{ scrollTo: { text: /Refund of \$820/ }, block: 'nearest' }] },
  { id: 'runners-list', title: 'Runners', sources: RUNNERS, route: '/runners', size: [2880, 1800] },
  { id: 'runner-detail', title: 'Runner detail', sources: ['frontend/src/pages/runner-detail.tsx', 'frontend/src/pages/runners-shared.ts', 'frontend/src/components/runners'], route: '/runners/{{id.runner}}', size: [2880, 1800] },
  { id: 'runners-hosted', title: 'Hosted environments', sources: RUNNERS, route: '/runners?tab=hosted', size: [2880, 1500] },
  { id: 'environment-new', title: 'New environment', sources: ['frontend/src/pages/environment-new.tsx', 'frontend/src/components/runners', 'frontend/src/components/plan-indicator.tsx'], route: '/runners/hosted/new', size: [2880, 2600] },
  { id: 'environment-detail', title: 'Hosted environment', sources: ['frontend/src/pages/environment-detail.tsx', 'frontend/src/pages/environment-new.tsx', 'frontend/src/components/runners'], route: '/runners/hosted/{{id.envWebApp}}', size: [2880, 1800] },
  { id: 'analytics-overview', title: 'Analytics overview', sources: ANALYTICS, route: '/analytics', size: [2880, 1800] },
  { id: 'analytics-agents', title: 'Analytics: agents', sources: ANALYTICS, route: '/analytics/agents', size: [2880, 1800] },
  { id: 'analytics-tools', title: 'Analytics: tools', sources: ANALYTICS, route: '/analytics/tools', size: [2880, 1800] },
  { id: 'analytics-gateways', title: 'Analytics: gateways', sources: ANALYTICS, route: '/analytics/gateways', size: [2880, 1800] },
  { id: 'analytics-audit', title: 'Audit trail', sources: ANALYTICS, route: '/analytics/audit', size: [2880, 1800] },
  { id: 'analytics-chargeback-locked', title: 'Chargeback (Enterprise, locked)', sources: ANALYTICS, route: '/analytics/chargeback', size: [2880, 1440] },
  { id: 'settings-teams', title: 'Members and teams', sources: ['frontend/src/pages/settings.tsx', 'frontend/src/components/MembersAndTeamsTab.tsx', 'frontend/src/components/settings'], route: '/settings/members', size: [2880, 1800] },
  { id: 'settings-rbac-enabled', title: 'Roles', sources: SETTINGS, route: '/settings/rbac', size: [2880, 1800] },
  { id: 'settings-rbac-new-role', title: 'New role', sources: SETTINGS, route: '/settings/rbac', size: [2880, 2400], then: [{ click: { role: 'button', name: /new role|add role|custom role/i } }] },
  { id: 'settings-rbac-new-policy', title: 'New access rule', sources: SETTINGS, route: '/settings/rbac', size: [2880, 2400], then: [{ click: { role: 'button', name: /new rule|new policy|add policy|access rule/i } }] },
  { id: 'settings-sso-enabled', title: 'Single sign-on', sources: SETTINGS, route: '/settings/sso', size: [2880, 2400] },
  { id: 'settings-approval-policies-enabled', title: 'Approval policies', sources: ['frontend/src/pages/settings.tsx', 'frontend/src/pages/approval-policy.tsx', 'frontend/src/components/settings'], route: '/settings/approvals', size: [2880, 1800] },
  { id: 'settings-approval-policy-new', title: 'New approval policy', sources: ['frontend/src/pages/approval-policy.tsx', 'frontend/src/components/settings'], route: '/settings/approvals/policies/new', size: [2880, 2400] },
  { id: 'settings-compliance-enabled', title: 'Compliance', sources: SETTINGS, route: '/settings/compliance', size: [2880, 2400] },
  { id: 'settings-audit-streams-enabled', title: 'Audit streaming', sources: SETTINGS, route: '/settings/audit-streams', size: [2880, 2400] },
  { id: 'settings-encryption-locked', title: 'Encryption (Enterprise, locked)', sources: SETTINGS, route: '/settings/encryption', size: [2880, 1440] },
  // Code mode and tool details. The script run and its change set are fixtures the seed writes.
  { id: 'agent-tool-mode', title: 'How the model sees its tools', sources: ['frontend/src/components/agents/builder/capabilities-section.tsx', 'frontend/src/pages/agent-builder.tsx'], route: '/agents/{{id.support}}/edit', size: [2880, 1800], then: heading('How the model sees its tools') },
  { id: 'builder-code-step', title: 'A Code step in the builder', sources: BUILDER, route: '/agents/{{id.keeper}}/edit', size: [2880, 1800], then: [{ click: { testid: 'rf__node-code_1' } }] },
  { id: 'run-script-step', title: 'A script step in a run', sources: ['frontend/src/components/agents/detail/code-step.tsx', 'frontend/src/components/agents/detail/runs-tab.tsx', 'frontend/src/components/approvals'], route: '/agents/{{id.support}}?tab=runs', size: [2880, 1944], then: [
    { click: { role: 'button', name: /Brightway wants \$820 back/ } },
    { click: { role: 'button', name: /Show script/ } },
    { scrollTo: { text: 'Steps', exact: true }, offset: 200 },
  ] },
  { id: 'approvals-change-set', title: "A script's changes in Approvals", sources: ['frontend/src/pages/approvals.tsx', 'frontend/src/components/approvals'], route: '/approvals', size: [2880, 1944], then: [{ scrollTo: { text: /A script wants to make 1 change/ }, offset: 90 }] },
  { id: 'gateway-exposure', title: "How apps see a gateway's tools", sources: [...GATEWAY, 'frontend/src/components/agents/builder/capabilities-section.tsx'], route: '/gateways/{{id.gwPetstore}}', size: [2800, 1750], then: heading('How apps see the tools') },
  { id: 'tool-side-effect', title: 'What a tool does to your data', sources: ['frontend/src/pages/tool-detail.tsx', 'frontend/src/components/tools'], route: '/tools/{{id.tool}}?tab=details', size: [2880, 1800], then: section('What it does to your data') },
  { id: 'visitor-data-request', title: 'Visitor data request', sources: ['frontend/src/pages/agent-visitor-data.tsx', 'frontend/src/components/channels/visitor-data-request.tsx'], route: '/agents/{{id.support}}/channels/visitor-data', size: [2800, 1750] },
]

// Shown at one CSS pixel per device pixel.
const SIGNED_IN_1X: Page[] = [
  { id: 'agent-builder', title: 'Workflow builder', sources: BUILDER, route: '/agents/{{id.digest}}/edit', size: [1440, 900] },
  { id: 'credentials-connect-provider', title: 'Connect a provider', sources: ['frontend/src/pages/models-connect.tsx', 'frontend/src/components/models'], route: '/models/providers/new', size: [1440, 900] },
]

const VISITOR: Page[] = [
  { id: 'hosted-chat', title: 'Hosted web chat', sources: CHAT, route: '/?__slug={{channel.web.slug|default:northwind-help}}', size: [2880, 2200], then: converse },
  { id: 'hosted-chat-privacy', title: 'Hosted chat: visitor data', sources: CHAT, route: '/?__slug={{channel.web.slug|default:northwind-help}}', size: [2880, 2000], then: [
    ...converse,
    { click: { role: 'button', name: 'Privacy and visitor data' } },
  ] },
]

const VISITOR_1X: Page[] = [
  { id: 'auth-register', title: 'Create account', sources: ['frontend/src/pages/auth'], route: '/auth/register', size: [1440, 989] },
]

const NOTE = 'Local seeded Northwind AI demo stack (scripts/demo-seed), fake model vendors and company APIs; not staging or production data.'

function walk(id: string, title: string, pages: Page[], scale: 1 | 2, anonymous = false, needsIds = true) {
  return {
    id, title, profile: 'northwind', account: AVA, after: ['northwind-seed'], notes: NOTE,
    browser: { scale, ...(anonymous ? { anonymous } : {}) },
    shots: Object.fromEntries(pages.map((p) => [p.id, { path: `screenshots/${p.id}.png`, title: p.title, sources: p.sources }])),
    steps: [
      ...(needsIds ? lookups : []),
      ...pages.flatMap((p): Step[] => [
        // Each page in a fresh context, as a reader opening it: nothing carried over from the page before.
        { restart: true },
        { viewport: { width: Math.round(p.size[0] / scale), height: Math.round(p.size[1] / scale) } },
        { goto: p.route },
        ...(p.then ?? []),
        { shot: p.id },
      ]),
    ],
  }
}

export const pages = [
  walk('northwind-pages', 'The Northwind AI organization, page by page', SIGNED_IN, 2),
  walk('northwind-pages-1x', 'The builder and Connect a provider, at 1x', SIGNED_IN_1X, 1),
  walk('northwind-visitor', 'What a visitor sees: the hosted web chat', VISITOR, 2, true),
  walk('northwind-signup', 'Create an account', VISITOR_1X, 1, true, false),
]
