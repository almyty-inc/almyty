#!/usr/bin/env node
// The tool-mode benchmark (docs/design/code-mode.md, "Benchmark"): the same
// fixed tasks, run by real autonomous agents through a running almyty API,
// in each tool mode, on each model, several times. Every number comes from
// the run itself: tokens from the provider's usage on each model call, turns
// and tool calls from the run's steps, cost from the run, latency from the
// clock. Success is a deterministic check on the end state (tasks.mjs).
//
//   node scripts/tool-mode-benchmark/run.mjs --self-check
//   node scripts/tool-mode-benchmark/run.mjs \
//     --api http://localhost:4000 --email you@example.com --password ... \
//     --models ollama=qwen3.8:27b,openai=gpt-5-mini --modes direct,discover,code --reps 5
//
// --models takes provider=model pairs; `provider` is an LLM provider id or a
// provider type (the organization's first provider of that type). The
// organization's egress allowlist gets 127.0.0.1 so the generated tools can
// reach the mock APIs this script serves.
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { ROUTES, API_TITLES, openApiDocument, startMockServer, seedState } from './mock-apis.mjs'
import { TASKS } from './tasks.mjs'
import { summarize, markdownReport } from './report.mjs'

const { values: opt } = parseArgs({
  options: {
    api: { type: 'string', default: process.env.BENCH_API ?? 'http://localhost:4000' },
    email: { type: 'string', default: process.env.BENCH_EMAIL },
    password: { type: 'string', default: process.env.BENCH_PASSWORD },
    models: { type: 'string', default: process.env.BENCH_MODELS ?? '' },
    modes: { type: 'string', default: 'direct,discover' },
    reps: { type: 'string', default: '5' },
    tasks: { type: 'string', default: '' },
    'max-steps': { type: 'string', default: '15' },
    'run-timeout-s': { type: 'string', default: '600' },
    'mock-port': { type: 'string', default: '0' },
    out: { type: 'string', default: `tool-mode-benchmark-${new Date().toISOString().replace(/[:.]/g, '-')}` },
    'self-check': { type: 'boolean', default: false },
  },
})

const META = new Set(['search_tools', 'get_tool', 'call_tool'])
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'budget_exceeded', 'waiting_input', 'waiting_approval', 'sleeping', 'paused'])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.error(...a)
const tasks = opt.tasks ? TASKS.filter((t) => opt.tasks.split(',').includes(t.id)) : TASKS

// ── Self-check: every check passes on the reference and fails on doing nothing ──
if (opt['self-check']) {
  let bad = 0
  for (const t of tasks) {
    const seed = seedState()
    const state = seedState()
    const answer = t.reference(state)
    const calls = t.kind === 'impossible' ? [] : [{ operationId: 'reference', method: t.kind.includes('write') ? 'put' : 'get' }]
    const pass = t.check({ state, seed, output: answer, calls })
    const idle = t.check({ state: seedState(), seed, output: 'Done.', calls: [] })
    const ok = pass.ok && !idle.ok
    if (!ok) bad++
    log(`${ok ? 'ok  ' : 'FAIL'} ${t.id}: reference ${pass.ok ? 'passes' : 'FAILS'}, doing nothing ${idle.ok ? 'PASSES' : 'fails'}`)
  }
  const ops = ROUTES.length
  const unique = new Set(ROUTES.map((r) => `${r.api}.${r.operationId}`)).size
  log(`${ops} operations over ${Object.keys(API_TITLES).length} APIs (${unique} unique)`)
  if (ops < 50 || unique !== ops) bad++
  process.exit(bad ? 1 : 0)
}

if (!opt.email || !opt.password) throw new Error('--email and --password (or BENCH_EMAIL, BENCH_PASSWORD) are required')
if (!opt.models) throw new Error('--models provider=model[,provider=model...] is required')

let token = ''
async function call(method, path, body, ok = [200, 201, 204]) {
  for (let attempt = 0; ; attempt++) {
    const headers = token ? { authorization: `Bearer ${token}` } : {}
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await fetch(`${opt.api}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await res.text()
    if (res.status === 429 && attempt < 20) { await sleep(5000); continue }
    let json
    try { json = text ? JSON.parse(text) : null } catch { json = text }
    if (!ok.includes(res.status)) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 400)}`)
    return json && typeof json === 'object' && 'data' in json && 'success' in json ? json.data : json
  }
}
const list = (x, key) => (Array.isArray(x) ? x : x?.[key] ?? x?.items ?? x?.data ?? [])

const mock = await startMockServer(Number(opt['mock-port']))
log(`mock APIs on ${mock.baseUrl}`)
token = (await call('POST', '/auth/token', { email: opt.email, password: opt.password })).accessToken
const me = await call('GET', '/auth/me').catch(() => null)
const orgs = list(await call('GET', '/organizations'), 'organizations')
const org = orgs.find((o) => o.id === me?.currentOrganizationId) ?? orgs[0]
const orgId = org.id

// The generated tools call 127.0.0.1: allow it for this organization.
const settings = (await call('GET', `/organizations/${orgId}`)).settings ?? {}
const allow = new Set([...(settings.egressAllowlist ?? []), '127.0.0.1'])
await call('PATCH', `/organizations/${orgId}`, { settings: { egressAllowlist: [...allow] } })

// Fresh imports of the three APIs (their server URL is this run's mock port).
const apiIds = []
const existing = list(await call('GET', '/apis?limit=100'), 'apis')
for (const [key, title] of Object.entries(API_TITLES)) {
  const name = `Bench ${title}`
  for (const a of existing.filter((x) => x.name === name)) await call('DELETE', `/apis/${a.id}`)
  const r = await call('POST', '/apis/import', { content: JSON.stringify(openApiDocument(key, mock.baseUrl)), type: 'openapi', name, generateTools: true })
  for (let i = 0; i < 120; i++) {
    const s = await call('GET', `/apis/${r.api.id}/import-status/${r.jobId}`)
    if (s?.status === 'completed') break
    if (s?.status === 'failed') throw new Error(`${name} import failed: ${s.error}`)
    await sleep(1000)
  }
  const tools = list(await call('GET', `/organizations/${orgId}/tools?limit=100&apiId=${r.api.id}`), 'tools').filter((t) => t.apiId === r.api.id)
  for (const t of tools) if (t.status !== 'active') await call('POST', `/organizations/${orgId}/tools/${t.id}/activate`)
  log(`${name}: ${tools.length} tools`)
  apiIds.push(r.api.id)
}

// The models: provider=model, provider by id or by type.
const providers = list(await call('GET', '/llm-providers'), 'providers')
const models = opt.models.split(',').map((pair) => {
  const i = pair.indexOf('=')
  const ref = pair.slice(0, i)
  const model = pair.slice(i + 1)
  const provider = providers.find((p) => p.id === ref) ?? providers.find((p) => p.type === ref)
  if (!provider) throw new Error(`no LLM provider ${ref} in this organization`)
  return { label: `${provider.type}/${model}`, providerId: provider.id, model }
})
const modes = opt.modes.split(',')

// One agent per model and mode, the same in everything but the tool mode.
const INSTRUCTIONS =
  'You work with three business systems: a pet store, a coffee shop and a helpdesk. Use the tools to answer from real data ' +
  'and to make the changes asked for, exactly those and no others. If no tool can do what is asked, say so plainly and change nothing. ' +
  'Finish with a short answer.'
const agents = {}
for (const m of models) {
  for (const mode of modes) {
    const name = `bench ${mode} ${m.label}`
    const have = list(await call('GET', '/agents?limit=100'), 'agents').find((a) => a.name === name)
    const body = {
      name,
      mode: 'autonomous',
      instructions: INSTRUCTIONS,
      modelConfig: { providerId: m.providerId, model: m.model, temperature: 0 },
      // In code mode a script's changes run without a person, as direct calls
      // do in the other modes, so every mode is measured on the same job.
      agentConfig: { apiIds, toolMode: mode, ...(mode === 'code' ? { codeMode: { writes: { write: 'allow', destructive: 'allow' } } } : {}) },
    }
    const agent = have ? await call('PATCH', `/agents/${have.id}`, body) : await call('POST', '/agents', body)
    if (agent.status !== 'active') await call('POST', `/agents/${agent.id}/activate`).catch(() => undefined)
    agents[`${m.label}|${mode}`] = agent.id
  }
}

mkdirSync(opt.out, { recursive: true })
const rowsFile = join(opt.out, 'runs.jsonl')
const rows = []
const reps = Number(opt.reps)
const total = reps * tasks.length * models.length * modes.length
let n = 0
// Interleaved (rep, task, model, mode), so drift in a provider's speed lands on every mode alike.
for (let rep = 1; rep <= reps; rep++) {
  for (const task of tasks) {
    for (const m of models) {
      for (const mode of modes) {
        n++
        mock.reset()
        const seed = seedState()
        const agentId = agents[`${m.label}|${mode}`]
        const t0 = Date.now()
        let run
        let error = null
        try {
          const started = await call('POST', `/agents/${agentId}/runs`, { input: task.prompt, maxSteps: Number(opt['max-steps']) })
          const runId = started.id ?? started.runId
          const deadline = t0 + Number(opt['run-timeout-s']) * 1000
          do {
            await sleep(1000)
            run = await call('GET', `/agents/${agentId}/runs/${runId}`)
            run = run.run ?? run
          } while (!TERMINAL.has(run.status) && Date.now() < deadline)
          if (!TERMINAL.has(run.status)) {
            await call('POST', `/agents/${agentId}/runs/${runId}/cancel`).catch(() => undefined)
            error = 'timed out in the benchmark'
          }
        } catch (e) {
          error = e.message
        }
        const latencyMs = Date.now() - t0
        const steps = run?.steps ?? []
        const llm = steps.filter((s) => s.type === 'llm_call')
        const toolSteps = steps.filter((s) => s.type === 'tool_call')
        const output = typeof run?.output === 'string' ? run.output : JSON.stringify(run?.output ?? '')
        const verdict = error || run?.status !== 'completed'
          ? { ok: false, why: error ?? `run ended ${run?.status}` }
          : task.check({ state: mock.state, seed, output, calls: mock.calls })
        const row = {
          rep, task: task.id, kind: task.kind, model: m.label, mode,
          ok: verdict.ok, why: verdict.why, status: run?.status ?? 'error',
          inputTokens: llm.reduce((s, x) => s + (x.tokens?.input ?? 0), 0),
          outputTokens: llm.reduce((s, x) => s + (x.tokens?.output ?? 0), 0),
          turns: llm.length,
          toolCalls: toolSteps.filter((s) => !META.has(s.input?.tool) && s.input?.tool !== 'run_code').length,
          // Scripts the model ran (code mode); the calls inside them are in apiCalls.
          scripts: toolSteps.filter((s) => s.input?.tool === 'run_code').length,
          metaCalls: toolSteps.filter((s) => META.has(s.input?.tool)).length,
          apiCalls: mock.calls.length,
          costUsd: Number(run?.totalCost ?? 0),
          latencyMs,
          toolMode: run?.workingMemory?.toolMode?.mode ?? null,
          output: output.slice(0, 500),
          error: run?.error ?? error,
          // What reached the APIs, for reading a failure afterwards.
          calls: mock.calls.map((c) => [c.operationId, c.args, c.status]),
        }
        rows.push(row)
        appendFileSync(rowsFile, JSON.stringify(row) + '\n')
        log(`[${n}/${total}] ${m.label} ${mode} ${task.id} #${rep}: ${row.ok ? 'pass' : 'FAIL'} (${row.why}) in=${row.inputTokens} out=${row.outputTokens} turns=${row.turns} tools=${row.toolCalls}+${row.metaCalls} ${Math.round(latencyMs / 1000)}s`)
      }
    }
  }
}

await mock.close()
const summary = summarize(rows)
const meta = {
  date: new Date().toISOString(),
  api: opt.api,
  models: models.map((m) => m.label),
  modes,
  reps,
  tasks: tasks.map((t) => `${t.id} (${t.kind})`),
  tools: ROUTES.length,
}
writeFileSync(join(opt.out, 'summary.json'), JSON.stringify({ meta, summary }, null, 2))
writeFileSync(join(opt.out, 'report.md'), markdownReport(meta, summary))
log(`wrote ${opt.out}/runs.jsonl, summary.json, report.md`)
