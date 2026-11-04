// The Northwind AI organization the reference screenshots show: three model
// vendors, two company APIs and Petstore, gateways, agents of every kind,
// channels, approval rules, a runner and hosted machines, and some history.
// Seeded through the public API as Ava Chen; a few things the product only
// writes itself (a stub machine's state, a script run waiting for approval)
// go straight into the database, in the shapes the runtime writes them.
// Every step finds what is already there by name first, so it reruns.
import type { Step } from '../../engine/schema.ts'
import { demoPassword } from '../../engine/password.ts'

export const AVA = { email: 'ava.chen@northwind.ai', password: demoPassword(), firstName: 'Ava', lastName: 'Chen', organizationName: 'Northwind AI' }

const role = (key: string, name: string, purpose: string, provider: string, model: string, extra: object = {}) =>
  ({ key, name, purpose, kind: 'model', providerId: `{{providers.${provider}.id}}`, model, ...extra })

// The same model vendor three times over, so each connects as its own provider.
const providers: Step[] = [
  ['OpenAI', 'openai'], ['OpenRouter', 'openrouter'], ['Mistral', 'mistral'],
].map(([name, type]): Step => ({
  ensure: { list: '/llm-providers', at: 'providers', where: { name } },
  create: { method: 'POST', url: '/llm-providers/connect', body: { name, type, configuration: { apiKey: `sk-demo-${type}-0000000000`, apiUrl: `{{stack.fake}}/${type}/v1` } } },
  pick: 'provider', save: `providers.${type}`,
}))

// A company API, imported from the fake's description, tools and all.
const importSpec = (key: string, name: string): Step[] => [
  { if: { not: { http: { url: '/apis' }, where: { name } } }, then: [
    { http: { url: `{{stack.fake}}/${key}/openapi.json` }, save: `spec.${key}` },
    { http: { method: 'POST', url: '/apis/import', body: { content: `{{spec.${key}|json}}`, type: 'openapi', name, generateTools: true } }, save: `import.${key}` },
    { until: { http: { url: `/apis/{{import.${key}.api.id}}/import-status/{{import.${key}.jobId}}` }, where: { status: 'completed' } }, timeout: 60000, what: `the ${name} import` },
  ] },
  { ensure: { list: '/apis', at: 'apis', where: { name } }, save: `apis.${key}` },
]

const activate = (agent: string): Step => ({
  if: { not: { http: { url: `/agents/{{${agent}.id}}` }, where: { status: 'active' } } },
  then: [{ http: { method: 'POST', url: `/agents/{{${agent}.id}}/activate` } }],
})

const digestPipeline = (systemPrompt: string) => ({
  nodes: [
    { id: 'input_1', type: 'input', label: 'Start', position: { x: 60, y: 220 }, config: {}, data: { schema: { type: 'object', properties: { days: { type: 'number' } } } } },
    { id: 'tool_csat', type: 'tool_call', label: 'CSAT summary', position: { x: 340, y: 220 }, config: {}, data: { toolId: '{{tools|where:name~csat|first|get:id}}', parameters: { days: '{{!input.days}}' } } },
    { id: 'llm_digest', type: 'llm_call', label: 'Write digest', position: { x: 620, y: 220 }, config: {}, data: { providerId: '{{providers.openai.id}}', model: 'gpt-4o-mini', systemPrompt, userPromptTemplate: 'CSAT data: {{!nodes.tool_csat.output}}\nWrite the digest.' } },
    { id: 'verify_1', type: 'verify', label: 'Check the numbers', position: { x: 900, y: 220 }, config: {}, data: { checkers: [{ name: 'Numbers', providerId: '{{providers.openrouter.id}}', model: 'anthropic/claude-sonnet-4.5' }], policy: 'all_pass' } },
    { id: 'output_1', type: 'output', label: 'Digest', position: { x: 1180, y: 220 }, config: {}, data: { mapping: '{{!nodes.llm_digest.output}}' } },
  ],
  edges: [
    { id: 'e1', source: 'input_1', target: 'tool_csat' },
    { id: 'e2', source: 'tool_csat', target: 'llm_digest' },
    { id: 'e3', source: 'llm_digest', target: 'verify_1' },
    { id: 'e4', source: 'verify_1', target: 'output_1' },
  ],
})

const KEEPER_CODE = [
  '// Archive the first three pets marked sold',
  "const sold = await petstore.findPetsByStatus({ status: 'sold' })",
  'const named = sold.filter((p) => p.name).slice(0, 3)',
  'log(`Found ${sold.length} sold pets`)',
  'const results = []',
  'for (const pet of named) {',
  "  const res = await petstore.updatePet({ ...pet, status: 'archived' })",
  '  results.push({ id: pet.id, name: pet.name, status: res.status })',
  '}',
  'return results',
].join('\n')

const REFUND_CODE = [
  '// Refund the damaged order, as the customer asked.',
  "const refund = await orders.createRefund({ orderId: 'NW-38801', amount: 820 })",
  "log('Refund staged for review.')",
  'return refund',
].join('\n')

// A hosted machine as the stub adapter would never leave it: enrolled and in a state.
const machine = (n: number, env: string, state: string, status: string, replicas: number, idle: string, readOnly = false): Step => {
  const workspace = `0000000${n}-0000-4000-8000-0000000000a${n}`
  const runner = `0000000${n}-0000-4000-8000-00000000000${n}`
  const hosted = `0000000${n}-0000-4000-8000-0000000000b${n}`
  return {
    if: { sql: `SELECT count(*) FROM workspaces WHERE id = '${workspace}'`, is: '0' }, then: [{ sql: `BEGIN;
      INSERT INTO runners (id, name, "ownerUserId", "organizationId", visibility, kind, state, labels, "hostedRunnerId")
        VALUES ('${runner}', 'env-${n}-${workspace.slice(0, 8)}', '{{me.id}}', '{{org.id}}', 'private', 'hosted', 'registered', '{}', '${hosted}');
      INSERT INTO workspaces (id, "runnerId", "ownerUserId", "organizationId", cwd, isolation, status, kind, "environmentId", "lastActiveAt", "createdAt", "readOnly")
        VALUES ('${workspace}', '${runner}', '{{me.id}}', '{{org.id}}', '/workspace', 'host', '${status}', 'persistent', '{{environments.${env}.id}}', now() - interval '${idle}', now() - interval '6 days', ${readOnly});
      INSERT INTO hosted_runners (id, "organizationId", "environmentId", "environmentVersion", "workspaceId", "runnerId", "providerType", desired, state, "lastActiveAt")
        VALUES ('${hosted}', '{{org.id}}', '{{environments.${env}.id}}', 1, '${workspace}', '${runner}', 'stub', '{"replicas":${replicas},"resourceClass":"small"}', '${state}', now() - interval '${idle}');
      COMMIT;` }],
  }
}

const QUESTIONS: [string, string][] = [
  ['support', 'Where is order NW-10428? The customer says it is late.'],
  ['support', 'Triage ticket T-5521 and draft a reply.'],
  ['support', 'Brightway Logistics wants a refund of $820 on NW-44120, it arrived defective.'],
  ['research', 'How do our CSAT scores compare with last quarter?'],
]

export const seed = {
  id: 'northwind-seed',
  title: 'Seed the Northwind AI organization',
  profile: 'northwind',
  account: AVA,
  headless: true,
  shots: {},
  steps: [
    ...providers,
    ...importSpec('orders', 'Northwind Orders'),
    ...importSpec('helpdesk', 'Northwind Helpdesk'),
    // Petstore is read from its public address, as a customer would; offline it is left out.
    { if: { not: { http: { url: '/apis' }, where: { name: 'Petstore' } } }, then: [
      { http: { method: 'POST', url: '/apis/import', body: { url: 'https://petstore3.swagger.io/api/v3/openapi.json', type: 'openapi', name: 'Petstore', generateTools: true } }, save: 'import.petstore' },
      { until: { http: { url: '/apis/{{import.petstore.api.id}}/import-status/{{import.petstore.jobId}}' }, where: { status: /^(completed|failed)$/ } }, timeout: 60000, what: 'the Petstore import' },
    ] },
    { http: { url: '/organizations/{{org.id}}/tools?limit=100' }, save: 'toolList' },
    { remember: 'tools', value: '{{toolList|rows:tools}}' },

    ...[
      { name: 'Northwind Support Tools', type: 'mcp', endpoint: '/support-tools', configuration: { transport: 'http' }, tools: '^northwind_', description: "Orders and helpdesk tools for the support team's AI clients." },
      { name: 'Orders for partners', type: 'utcp', endpoint: '/orders-utcp', configuration: { protocol: 'http' }, tools: '^northwind_orders_(get_order\\|track_shipment\\|list_orders)', description: 'Read-only order lookup for logistics partners.' },
      { name: 'Northwind skills', type: 'skills', endpoint: '/northwind-skills', configuration: { format: 'skill-md' }, tools: '^northwind_helpdesk_', description: 'Helpdesk skills for coding agents, installed with @almyty/skills.' },
      { name: 'Petstore', type: 'mcp', endpoint: '/petstore', configuration: { transport: 'http' }, tools: '^petstore_' },
    ].map(({ tools, ...g }): Step => ({
      if: { value: `{{tools|where:name~${tools}|len}}`, is: /^[1-9]/ }, then: [{
        ensure: { list: '/gateways', at: 'gateways', where: { name: g.name } },
        create: { method: 'POST', url: '/gateways', body: { ...g, toolIds: `{{tools|where:name~${tools}|map:id}}`, kind: 'tool', visibility: 'org' } },
        save: `gateways.${g.endpoint.slice(1)}`,
      }],
    })),

    { ensure: { list: '/credentials', at: 'credentials', where: { name: 'Northwind Slack app' } },
      create: { method: 'POST', url: '/credentials/connect/channel-slack-app', body: { method: 'api_key', name: 'Northwind Slack app', input: { client_id: '4312876501.7719203348121', client_secret: 'demo0client0secret0000000', signing_secret: 'demo0signing0secret000000' } } },
      pick: 'connection', save: 'credentials.slack' },
    { ensure: { list: '/credentials', at: 'credentials', where: { name: 'Helpdesk API token' } },
      create: { method: 'POST', url: '/credentials', body: { name: 'Helpdesk API token', type: 'api_key', config: { apiKey: 'hd_demo_000000000000000000' } } } },
    // Not a Stripe key: a placeholder, assembled so no key-shaped literal sits in the source.
    { ensure: { list: '/credentials', at: 'credentials', where: { name: 'Stripe restricted key' } },
      create: { method: 'POST', url: '/credentials', body: { name: 'Stripe restricted key', type: 'api_key', config: { apiKey: ['rk', 'test', 'placeholder'].join('_') + '0'.repeat(16) } } } },

    { ensure: { list: '/agents?limit=100', at: 'agents', where: { name: 'Market Research Analyst' } },
      create: { method: 'POST', url: '/agents', body: {
        name: 'Market Research Analyst', mode: 'autonomous', visibility: 'org',
        description: 'Answers market and competitor questions; three models from three vendors argue it out.',
        instructions: 'Research the question, cite what you used, and give a short recommendation.',
        personality: 'Concise, neutral, numbers first.',
        models: { strategy: 'panel', roles: [
          role('main', 'Main', 'main', 'openai', 'gpt-4.1'),
          role('panelist_1', 'Panelist 1', 'panelist', 'openrouter', 'anthropic/claude-sonnet-4.5'),
          role('panelist_2', 'Panelist 2', 'panelist', 'openrouter', 'google/gemini-2.5-pro'),
          role('judge', 'Judge', 'judge', 'mistral', 'mistral-large-latest'),
        ] },
        memoryConfig: { enabled: true, whose: 'agent', save: 'facts', retentionDays: 180 },
      } }, save: 'agents.research' },
    activate('agents.research'),
    { ensure: { list: '/agents?limit=100', at: 'agents', where: { name: 'Customer Support Orchestrator' } },
      create: { method: 'POST', url: '/agents', body: {
        name: 'Customer Support Orchestrator', mode: 'autonomous', visibility: 'org',
        description: 'Answers Northwind customers on web chat and Slack: order status, shipping delays, refunds.',
        instructions: "You are Northwind's support agent. Look orders up before answering, never promise a date the carrier has not given, and ask a person to approve any refund over $500.",
        personality: 'Warm, brief, specific. One apology at most.',
        models: { strategy: 'cascade', roles: [
          role('main', 'Main', 'main', 'openai', 'gpt-4o'),
          role('drafter', 'Drafter', 'drafter', 'mistral', 'mistral-small-latest'),
          role('checker', 'Checker', 'checker', 'openrouter', 'anthropic/claude-sonnet-4.5', { instructions: 'Refute any claim about an order that the tool results do not support.' }),
        ] },
        memoryConfig: { enabled: true, whose: 'person', save: 'facts', retentionDays: 365, neverSave: 'Card numbers, passwords, home addresses' },
        agentConfig: {
          apiIds: ['{{apis.orders.id}}', '{{apis.helpdesk.id}}'], canCallAgents: true, callableAgentIds: ['{{agents.research.id}}'],
          verify: { enabled: true, policy: 'all_pass', maxReviseLoops: 2, triggers: ['on_final_output'], checkers: [
            { name: 'Accuracy', providerId: '{{providers.openrouter.id}}', model: 'anthropic/claude-sonnet-4.5', instructions: 'Check every order fact against the tool results.' },
            { name: 'Policy', providerId: '{{providers.openai.id}}', model: 'gpt-4o-mini', instructions: 'Refunds over $500 must go to approval.' },
          ] },
          constraints: { enabled: true, autoLearn: true },
        },
      } }, save: 'agents.support' },
    activate('agents.support'),

    { ensure: { list: '/agents?limit=100', at: 'agents', where: { name: 'Nightly CSAT Digest' } },
      create: { method: 'POST', url: '/agents', body: {
        name: 'Nightly CSAT Digest', mode: 'workflow', visibility: 'org',
        description: 'Every night: pull the CSAT numbers, write a digest, flag a drop.',
        pipeline: digestPipeline('You write a short daily support digest.'),
        webhookUrl: 'https://hooks.northwind.example/support/digest',
      } }, save: 'agents.digest' },
    activate('agents.digest'),
    // A time of day in a time zone, the result to the agent's webhook: what the Schedule card shows.
    { http: { method: 'POST', url: '/agents/{{agents.digest.id}}/schedule', body: { kind: 'days', days: [1, 2, 3, 4, 5], time: '08:00', timezone: 'Europe/Berlin', input: { days: 1 }, deliverTo: { kind: 'webhook' } } } },

    ...[
      'Never quote a delivery date the carrier has not confirmed.',
      'Refunds over $500 need a person to approve them first.',
      'Look the order up before answering anything about it.',
    ].map((rule): Step => ({
      ensure: { list: '/agents/{{agents.support.id}}/constraints', at: 'constraints', where: { rule } },
      create: { method: 'POST', url: '/agents/{{agents.support.id}}/constraints', body: { rule } },
    })),

    { if: { sql: "SELECT count(*) >= 4 FROM memories WHERE scope_id LIKE '{{org.id}}%'", is: 'f' }, then: [
      ...[
        { content: 'Brightway Logistics is an enterprise account: route their tickets to Tier 2.', tier: 'long', tags: ['accounts'] },
        { content: 'EU shipments through Leipzig are often held at customs for 1 to 3 days.', tier: 'long', tags: ['shipping'] },
        { content: 'Harbor & Pine Outfitters prefers email over chat for order updates.', tier: 'long', tags: ['customers'] },
        { content: 'Delayed-shipment policy: offer free expedited shipping on the next order.', tier: 'shared', tags: ['policy'] },
        { content: 'Refunds over $500 go to a support lead for approval before they are issued.', tier: 'shared', tags: ['policy', 'refunds'] },
        { content: 'Brightway Logistics has a dedicated account manager, Priya Nair; copy her on escalations.', tier: 'shared', tags: ['accounts'] },
        { content: 'The Leipzig hub is closed on German public holidays; add a day to EU estimates around them.', tier: 'shared', tags: ['shipping'] },
      ].map((m): Step => ({ http: { method: 'POST', url: '/memory/canonical', body: {
        mode: 'memory', content: m.content, content_format: 'text', tier: m.tier, tags: m.tags,
        scope: m.tier === 'shared' ? { scope_type: 'workspace', scope_id: '{{org.id}}' } : { scope_type: 'agent', scope_id: '{{org.id}}:agent:{{agents.support.id}}' },
      } } })),
    ] },

    { http: { method: 'PATCH', url: '/agents/{{agents.support.id}}/public-settings', body: {
      branding: { appName: 'Northwind Help', primaryColor: '#7C3AED', theme: 'auto', greeting: 'Hi! I can check orders, shipping and refunds.', suggestedPrompts: ['Where is my order?', 'I need a refund', 'Change my delivery address'] },
      visitorRules: { authMode: 'public_link', limits: { costCapCents: 50, perUserRateLimit: 20, perIpRateLimit: 60, dailySpendCapCents: 500, monthlySpendCapCents: 5000 }, privacy: { retentionDays: 30, visitorCanDelete: true, visitorCanExport: true } },
    } } },
    ...[
      { type: 'web', name: 'Help center chat', slug: 'northwind-help', publish: true },
      { type: 'widget', name: 'Website widget', publish: true, configuration: { allowedOrigins: ['https://northwind.example'] } },
      { type: 'slack', name: 'Slack', credentialId: '{{credentials.slack.id}}', publish: true },
      { type: 'a2a', name: 'Other agents (A2A)', publish: true },
      { type: 'microsoft_teams', name: 'Microsoft Teams', publish: false },
      { type: 'tui', name: 'Terminal app', publish: false },
    ].flatMap(({ publish, ...c }): Step[] => [
      { ensure: { list: '/agents/{{agents.support.id}}/channels', at: 'channels', where: { type: c.type } },
        create: { method: 'POST', url: '/agents/{{agents.support.id}}/channels', body: c }, save: `channels.${c.type}` },
      ...(publish ? [{
        if: { not: { http: { url: '/agents/{{agents.support.id}}/channels' }, where: { type: c.type, status: 'published' } } },
        then: [{ http: { method: 'POST', url: `/agents/{{agents.support.id}}/channels/{{channels.${c.type}.id}}/publish`, body: {} } }],
      } as Step] : []),
    ]),

    { ensure: { list: '/approval-policies', at: 'policies', where: { name: 'Refunds over $500' } },
      create: { method: 'POST', url: '/approval-policies', body: {
        name: 'Refunds over $500', description: 'A support lead signs off on large refunds before the agent issues them.',
        match: [{ attr: 'payload.amount', op: 'gt', value: 500 }],
        steps: [{ name: 'Support lead', approverRole: 'admin', minApprovals: 1 }], priority: 10, enabled: true,
      } } },
    // The free amount rule: a refund call over 500 waits for a person, whatever the agent was told.
    { ensure: { list: '/approval-rules', at: 'rules', where: { name: 'Refunds over 500' } },
      create: { method: 'POST', url: '/approval-rules', body: { name: 'Refunds over 500', enabled: true, trigger: { kind: 'tool_amount', toolId: '{{tools|where:name=northwind_orders_create_refund|first|get:id}}', argument: 'amount', op: 'gt', amount: 500 } } } },
    { ensure: { list: '/runners', at: 'runners', where: { name: 'ci-mac-studio' } },
      create: { method: 'POST', url: '/runners', body: { name: 'ci-mac-studio', labels: { os: 'mac', arch: 'arm64', gpu: 'yes' }, visibility: 'org' } } },

    // Hosted environments (stack.sh runs the stub adapter, which starts nothing, with its reconcile sweep off).
    ...[
      { name: 'web-app', repo: { url: 'https://github.com/northwind-ai/web-app', ref: 'main' }, image: { base: 'standard-browser' }, setupScript: 'npm ci', egress: { allowHosts: ['github.com', 'registry.npmjs.org'] }, idleTimeoutMinutes: 30 },
      { name: 'data-jobs', repo: { url: 'https://github.com/northwind-ai/data-jobs', ref: 'main' }, image: { base: 'standard' }, setupScript: 'pip install -r requirements.txt', egress: { allowHosts: ['github.com', 'pypi.org', 'files.pythonhosted.org'] } },
    ].map((e): Step => ({ ensure: { list: '/environments', at: 'environments', where: { name: e.name } }, create: { method: 'POST', url: '/environments', body: e }, save: `environments.${e.name}` })),
    // readOnly: a workspace kept from a member who left, beside the receiver's own (the handover's case).
    machine(1, 'web-app', 'ready', 'active', 1, '4 minutes'),
    machine(2, 'data-jobs', 'suspended', 'suspended', 0, '3 days'),
    machine(3, 'data-jobs', 'suspended', 'suspended', 0, '4 days', true),
    // Minutes this month, so the usage shows: closed intervals of the two machines.
    { if: { sql: `SELECT count(*) FROM runner_usage_intervals WHERE "organizationId" = '{{org.id}}'`, is: '0' }, then: [{ sql: `INSERT INTO runner_usage_intervals ("organizationId", "hostedRunnerId", "environmentId", "workspaceId", "resourceClass", "startedAt", "endedAt")
      VALUES ('{{org.id}}', '00000001-0000-4000-8000-0000000000b1', '{{environments.web-app.id}}', '00000001-0000-4000-8000-0000000000a1', 'small', now() - interval '3 hours', now() - interval '1 hour'),
             ('{{org.id}}', '00000002-0000-4000-8000-0000000000b2', '{{environments.data-jobs.id}}', '00000002-0000-4000-8000-0000000000a2', 'small', now() - interval '1 day 40 minutes', now() - interval '1 day')` }] },
    // An agent set to run on web-app, with runs for its Recent runs.
    { if: { not: { http: { url: '/agents?limit=100' }, where: { name: 'Repo helper' } } }, then: [
      { http: { method: 'POST', url: '/agents', body: {
        name: 'Repo helper', description: 'Runs the web app tests and reports what broke.', mode: 'autonomous',
        instructions: 'Run the web app tests on the hosted machine and report what broke.',
        modelConfig: { providerId: '{{providers.openai.id}}', model: 'gpt-4o-mini' }, agentConfig: { environmentId: '{{environments.web-app.id}}' },
      } }, save: 'agents.helper' },
      ...['completed', 'completed', 'failed'].map((status): Step => ({ sql: `INSERT INTO agent_runs (id, "agentId", "organizationId", "userId", mode, status, input, "createdAt", "updatedAt")
        VALUES (gen_random_uuid(), '{{agents.helper.id}}', '{{org.id}}', '{{me.id}}', 'autonomous', '${status}', '{}', now() - interval '${status === 'failed' ? 5 : 30} minutes', now())` })),
    ] },

    // Code mode: a workflow with a Code step, and a script one autonomous run
    // wrote that waits in Approvals with its change set. No model here writes
    // scripts, so the run, its script trace and the approval are written in the
    // shapes the runtime writes them (agent-step-processor runCode,
    // code-mode.service), and the run says so.
    { ensure: { list: '/agents?limit=100', at: 'agents', where: { name: 'Pet store keeper' } },
      create: { method: 'POST', url: '/agents', body: {
        name: 'Pet store keeper', mode: 'workflow', visibility: 'org', description: 'Archives the pets the store has sold.',
        pipeline: {
          nodes: [
            { id: 'input_1', type: 'input', label: 'Start', position: { x: 60, y: 220 }, config: {}, data: {} },
            { id: 'code_1', type: 'code', label: 'Archive the sold pets', position: { x: 380, y: 220 }, config: {}, data: { label: 'Archive the sold pets', code: KEEPER_CODE } },
            { id: 'output_1', type: 'output', label: 'Archived', position: { x: 700, y: 220 }, config: {}, data: { mapping: '{{!nodes.code_1.output}}' } },
          ],
          edges: [{ id: 'e1', source: 'input_1', target: 'code_1' }, { id: 'e2', source: 'code_1', target: 'output_1' }],
        },
      } }, save: 'agents.keeper' },
    activate('agents.keeper'),
    { if: { sql: `SELECT count(*) FROM code_executions WHERE "agentId" = '{{agents.support.id}}'`, is: '0' }, then: [
      { remember: 'cm', value: { run: '{{$uuid}}', exec: '{{$uuid}}', approval: '{{$uuid}}', at: '{{$now|add:-20m|iso}}', refund: '{{tools|where:name=northwind_orders_create_refund|first}}' } },
      { remember: 'cm.changeSet', value: [{
        id: 1, toolId: '{{cm.refund.id}}', toolName: '{{cm.refund.name}}', codeName: 'orders.createRefund', title: 'Refund an order',
        arguments: { orderId: 'NW-38801', amount: 820 }, paramsHash: 'demo-seed', sideEffect: 'write', reason: 'policy', rule: 'Refunds over 500',
      }] },
      { remember: 'cm.payload', value: { kind: 'change_set', tool: 'run_code', codeExecutionId: '{{cm.exec}}', changeSet: '{{cm.changeSet}}' } },
      { remember: 'cm.input', value: { message: 'Brightway wants $820 back on NW-38801, it arrived damaged. Refund it.' } },
      { remember: 'cm.code', value: REFUND_CODE },
      { remember: 'cm.steps', value: [
        { type: 'llm_call', role: { key: 'main', name: 'Main', purpose: 'main', kind: 'model' }, input: { messageCount: 2, toolCount: 6 }, output: { toolCalls: [{ name: 'run_code', hasResult: true }], model: 'gpt-4o' }, cost: 0.0021, tokens: { input: 1650, output: 96 }, duration: 640, timestamp: '{{cm.at}}' },
        { type: 'tool_call', input: { tool: 'run_code', parameters: { code: REFUND_CODE } }, output: { codeExecutionId: '{{cm.exec}}', status: 'waiting_approval', calls: { made: 1, ran: 0, failed: 0, staged: 1, refused: 0 }, cpuMs: 7, staged: 1, approvalId: '{{cm.approval}}' }, cost: 0, duration: 35, timestamp: '{{cm.at}}' },
      ] },
      { sql: `INSERT INTO agent_runs (id, "agentId", "organizationId", "userId", mode, status, steps, "currentStep", "maxSteps", input, metadata, "totalCost", "totalTokens", "executionTime", "toolCallCount", "createdAt", "updatedAt")
        VALUES ('{{cm.run}}', '{{agents.support.id}}', '{{org.id}}', '{{me.id}}', 'autonomous', 'waiting_approval', {{cm.steps|sqljson}}, 2, 25,
          {{cm.input|sqljson}}, '{"demoFixture":"written by scripts/demo-seed (walks/northwind/seed.ts), not a model run"}',
          0.0021, 1746, 675, 1, '{{cm.at}}', '{{cm.at}}')` },
      { sql: `INSERT INTO approval_requests (id, "organizationId", visibility, "runId", "agentId", "toolCallId", reason, payload, status, "expiresAt", "createdAt", "updatedAt")
        VALUES ('{{cm.approval}}', '{{org.id}}', 'org', '{{cm.run}}', '{{agents.support.id}}', 'call_demo_run_code',
          'A script wants to make 1 change. Approve to make all of them, or reject to make none.',
          {{cm.payload|sqljson}}::jsonb, 'pending', now() + interval '1 day', '{{cm.at}}', '{{cm.at}}')` },
      { sql: `INSERT INTO code_executions (id, "organizationId", "runId", "agentId", "userId", code, logs, result, status, "changeSet", "approvalRequestId", "callCount", "cpuMs", "durationMs", "createdAt", "updatedAt")
        VALUES ('{{cm.exec}}', '{{org.id}}', '{{cm.run}}', '{{agents.support.id}}', '{{me.id}}', {{cm.code|sql}}, 'Refund staged for review.', '{"staged":true}'::jsonb,
          'waiting_approval', {{cm.changeSet|sqljson}}::jsonb, '{{cm.approval}}', 1, 7, 35, '{{cm.at}}', '{{cm.at}}')` },
    ] },

    // Traffic and history, so the metrics, Analytics and the run views have something to show.
    { if: { value: '{{gateways.support-tools.initialApiKey|default:}}' }, then: [
      { action: 'mcpTraffic', with: { url: '{{stack.api}}/{{org.slug}}/support-tools', key: '{{gateways.support-tools.initialApiKey}}' } },
    ] },
    { if: { not: { http: { url: '/agents/{{agents.support.id}}/runs' }, where: { mode: 'autonomous', status: /^(completed|failed)$/ } } }, then: QUESTIONS.flatMap(([agent, message], i): Step[] => [
      { http: { method: 'POST', url: `/agents/{{agents.${agent}.id}}/runs`, body: { input: { message } } }, save: `runs.r${i}` },
      { until: { http: { url: `/agents/{{agents.${agent}.id}}/runs` }, where: { id: `{{runs.r${i}.id}}`, status: /^(completed|failed|waiting_approval|cancelled)$/ } }, timeout: 120000, what: `run ${i + 1} to finish` },
    ]) },
    { if: { not: { http: { url: '/promoted-skills' } } }, then: [
      { until: { http: { url: '/agents/{{agents.support.id}}/runs' }, where: { status: 'completed', input: { contains: 'NW-10428' } } }, save: 'promote', timeout: 60000, what: 'the NW-10428 run' },
      { http: { method: 'POST', url: '/promoted-skills', body: { runId: '{{promote|first|get:id}}', name: 'check-delayed-order', description: 'Look a delayed order up, track the shipment and draft the apology with the delayed-shipment offer.' } } },
    ] },
    { if: { sql: `SELECT count(*) FROM agent_executions WHERE "agentId" = '{{agents.digest.id}}'`, is: '0' }, then: [
      { http: { method: 'POST', url: '/agents/{{agents.digest.id}}/invoke', body: { input: { days: 1 } } } },
    ] },
    // Two pipeline saves, so Pipeline versions has snapshots to roll back to.
    { if: { not: { http: { url: '/agents/{{agents.digest.id}}/versions' }, min: 2 } }, then: [
      { http: { method: 'PATCH', url: '/agents/{{agents.digest.id}}', body: { pipeline: digestPipeline('You write a short daily support digest for the support leads.') } } },
      { http: { method: 'PATCH', url: '/agents/{{agents.digest.id}}', body: { pipeline: digestPipeline('You write a short daily support digest for the support leads. Lead with anything that got worse.') } } },
    ] },
  ] satisfies Step[],
  vars: {},
}
