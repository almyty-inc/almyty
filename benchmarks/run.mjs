#!/usr/bin/env node
// The benchmark: import each pinned API description into a running almyty
// backend (benchmarks/stack.sh up), time it, then count the tokens a model
// reads through each way almyty exposes the generated tools. See README.md.
//
//   node run.mjs [--api URL] [--runs N] [--only id,id] [--pg CONTAINER]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Almyty, targetTool } from './lib/almyty.mjs';
import { anthropicAvailable, anthropicModel, anthropicToolTokens } from './lib/anthropic-count.mjs';
import { StdioMcpClient } from './lib/mcp-stdio.mjs';
import { renderTables, stats } from './lib/report.mjs';
import { loadSpec } from './lib/specs.mjs';
import { TOKENIZER, accumulate, callText, countTokens, countTools } from './lib/tokens.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const { values: opts } = parseArgs({
  options: {
    api: { type: 'string', default: process.env.BENCH_API_URL || 'http://localhost:4310' },
    runs: { type: 'string', default: '5' },
    only: { type: 'string' },
    pg: { type: 'string', default: process.env.PG_NAME || 'almyty-bench-pg' },
    out: { type: 'string', default: join(HERE, 'results') },
  },
});
const RUNS = Number(opts.runs);
const MCP_SERVER = join(ROOT, 'packages/mcp-server/dist/index.js');
const log = (m) => process.stderr.write(`${m}\n`);

const textOf = (result) => (result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
// What came back from the task's call: isError as the server set it, and the
// head of the text (the proxy reports an upstream failure as a plain result,
// so its text is the only way to tell).
const outcome = (result) => ({ isError: Boolean(result?.isError), head: textOf(result).replace(/\s+/g, ' ').slice(0, 160) });

function machine() {
  const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8' }).trim(); } catch { return null; } };
  return {
    cpu: os.cpus()[0]?.model ?? 'unknown',
    cores: os.cpus().length,
    memoryGiB: Math.round(os.totalmem() / 2 ** 30),
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    node: process.version,
    docker: sh('docker', ['version', '--format', '{{.Server.Version}}']),
    commit: sh('git', ['-C', ROOT, 'rev-parse', 'HEAD']),
    // 1/5/15-minute load average when the run started: other work on the
    // machine slows the import timings.
    loadAverage: os.loadavg().map((n) => Number(n.toFixed(2))),
  };
}

async function measureTokens(almyty, account, spec, tools) {
  const task = spec.task;
  const target = targetTool(tools, task.target);
  if (!target) throw new Error(`${spec.id}: no generated tool for ${task.target.method} ${task.target.endpoint}`);
  const ids = tools.map((t) => t.id);
  await almyty.createGateway({ name: `${spec.id} tools`, endpoint: `/${spec.id}`, toolIds: ids });
  await almyty.createGateway({ name: `${spec.id} code`, endpoint: `/${spec.id}-code`, toolIds: ids, exposure: 'code' });
  const toolsPath = `${account.orgSlug}/${spec.id}`;
  const codePath = `${account.orgSlug}/${spec.id}-code`;

  // (a) The plain MCP gateway: every tool's definition, every page of tools/list.
  const fullList = await almyty.listAllTools(toolsPath);
  const fullInitial = countTools(fullList);
  const fullCall = await almyty.mcp(toolsPath, 'tools/call', { name: target.name, arguments: task.arguments });
  const full = accumulate(fullInitial, [{ call: countTokens(callText(target.name, task.arguments)) }]);

  // (b3) The code-mode gateway: search_tools (each listed query in turn,
  // until the target shows up), get_tool, run_code.
  const metaList = await almyty.listAllTools(codePath);
  const codeInitial = countTools(metaList);
  const codeSearches = [];
  for (const query of task.queries) {
    const args = { query };
    const searched = await almyty.mcp(codePath, 'tools/call', { name: 'search_tools', arguments: args });
    const text = textOf(searched);
    const names = (searched.structuredContent?.tools ?? JSON.parse(text).tools ?? []).map((t) => t.name);
    codeSearches.push({ query, rank: names.indexOf(target.name) + 1 || null, call: countTokens(callText('search_tools', args)), result: countTokens(text) });
    if (names.includes(target.name)) break;
  }
  const getArgs = { name: target.name };
  const got = await almyty.mcp(codePath, 'tools/call', { name: 'get_tool', arguments: getArgs });
  const getText = textOf(got);
  const detail = JSON.parse(getText);
  const ns = detail.code?.namespace;
  const fn = detail.code?.function;
  if (!ns || !fn) throw new Error(`${spec.id}: get_tool gave no code.namespace/function`);
  const runArgs = { code: `return await ${ns}.${fn}(${JSON.stringify(task.arguments)})` };
  const ran = await almyty.mcp(codePath, 'tools/call', { name: 'run_code', arguments: runArgs });
  const code = accumulate(codeInitial, [
    ...codeSearches.map(({ call, result }) => ({ call, result })),
    { call: countTokens(callText('get_tool', getArgs)), result: countTokens(getText) },
    { call: countTokens(callText('run_code', runArgs)) },
  ]);

  // (b1, b2) @almyty/mcp-server in its default skill-first mode, as an editor
  // runs it: almyty_search with each listed keyword until the target shows
  // up, then almyty_execute.
  const client = new StdioMcpClient('node', [MCP_SERVER, toolsPath], {
    ALMYTY_URL: almyty.baseUrl, ALMYTY_TOKEN: almyty.token, ALMYTY_MODE: 'skill-first',
  });
  let proxy;
  try {
    await client.initialize();
    const proxyTools = (await client.request('tools/list')).tools;
    const gatewayOnly = proxyTools.filter((t) => t.name === 'almyty_execute' || t.name === 'almyty_search');
    const prompts = (await client.request('prompts/list')).prompts;
    const proxySearches = [];
    for (const query of task.keywords) {
      const args = { query };
      const text = textOf(await client.request('tools/call', { name: 'almyty_search', arguments: args }));
      const hit = text.includes(`**${target.name}**`);
      proxySearches.push({ query, found: hit, call: countTokens(callText('almyty_search', args)), result: countTokens(text) });
      if (hit) break;
    }
    const skillPrompt = prompts.find((p) => p.name.startsWith('skill-'));
    const skillText = skillPrompt
      ? (await client.request('prompts/get', { name: skillPrompt.name })).messages.map((m) => m.content?.text ?? '').join('\n')
      : '';
    const execArgs = { tool_name: target.name, parameters: task.arguments };
    const executed = await client.request('tools/call', { name: 'almyty_execute', arguments: execArgs }, 120_000);
    const initialAll = countTools(proxyTools);
    const searchSteps = proxySearches.map(({ call, result }) => ({ call, result }));
    const execStep = { call: countTokens(callText('almyty_execute', execArgs)) };
    proxy = {
      initialAll,
      initialGatewayOnly: countTools(gatewayOnly),
      toolNames: proxyTools.map((t) => t.name),
      prompts: prompts.map((p) => p.name),
      skillPromptTokens: countTokens(skillText),
      searches: proxySearches,
      callOutcome: outcome(executed),
      noSkill: accumulate(initialAll, [...searchSteps, execStep]),
      // A prompt is put in context by the person (MCP prompts are user-chosen),
      // so it is a result with no model call before it.
      withSkill: accumulate(initialAll, [...searchSteps, { call: 0, result: countTokens(skillText) }, execStep]),
      anthropic: await anthropicToolTokens(proxyTools).catch((e) => `error: ${e.message}`),
    };
  } finally {
    await client.close();
  }

  return {
    targetTool: target.name,
    tokens: {
      full: {
        initial: fullInitial,
        tools: fullList.length,
        perToolMean: Math.round(fullInitial / Math.max(fullList.length, 1)),
        rawListBytes: JSON.stringify(fullList).length,
        anthropic: await anthropicToolTokens(fullList).catch((e) => `error: ${e.message}`),
      },
      code: {
        initial: codeInitial,
        toolNames: metaList.map((t) => t.name),
        anthropic: await anthropicToolTokens(metaList).catch((e) => `error: ${e.message}`),
      },
      proxy: { initialAll: proxy.initialAll, initialGatewayOnly: proxy.initialGatewayOnly, toolNames: proxy.toolNames, anthropic: proxy.anthropic },
    },
    task: {
      what: task.what,
      full: { ...full, callOutcome: outcome(fullCall) },
      code: {
        ...code,
        searches: codeSearches,
        searchFoundTarget: codeSearches.some((s) => s.rank),
        getToolResultTokens: countTokens(getText),
        script: runArgs.code,
        callOutcome: outcome(ran),
      },
      proxyNoSkill: { ...proxy.noSkill, searches: proxy.searches, searchFoundTarget: proxy.searches.some((s) => s.found), callOutcome: proxy.callOutcome },
      proxyWithSkill: { ...proxy.withSkill, skillPromptTokens: proxy.skillPromptTokens, prompts: proxy.prompts },
    },
  };
}

async function main() {
  if (!existsSync(MCP_SERVER)) {
    throw new Error(`${MCP_SERVER} is missing: build it first (cd packages/mcp-server && npm ci && npm run build)`);
  }
  const manifest = JSON.parse(readFileSync(join(HERE, 'specs.json'), 'utf8'));
  const only = opts.only ? new Set(opts.only.split(',')) : null;
  const specs = manifest.specs.filter((s) => !only || only.has(s.id));
  const almyty = new Almyty(opts.api, { pgContainer: opts.pg });
  const results = {
    generatedAt: new Date().toISOString(),
    machine: machine(),
    method: {
      tokenizer: TOKENIZER,
      anthropic: anthropicAvailable() ? `count_tokens, model ${anthropicModel()}` : 'not run: no ANTHROPIC_API_KEY in the environment',
      toolText: 'compact JSON of [{name, description, input_schema}] per tool list',
      runs: RUNS,
    },
    specs: [],
  };

  for (const spec of specs) {
    log(`${spec.id}: loading the pinned description`);
    const loaded = await loadSpec(spec, join(HERE, '.cache'));
    // One account per description (sign-up is rate limited to 10 an hour).
    // Each run imports into an empty organization: the previous run's API is
    // deleted, and its tools with it, so no run regenerates over another.
    const account = await almyty.freshAccount(spec.id);
    const timings = [];
    let last;
    for (let run = 1; run <= RUNS; run++) {
      const imported = await almyty.importAndGenerate({ name: spec.apiName, fileName: spec.fileName, content: loaded.content, baseUrl: spec.baseUrl });
      const tools = await almyty.toolsOfApi(imported.apiId);
      log(`${spec.id}: run ${run}: ${(imported.ms / 1000).toFixed(2)} s, ${tools.length} tools`);
      timings.push({ ms: Math.round(imported.ms), tools: tools.length });
      if (run < RUNS) await almyty.deleteApi(imported.apiId);
      else last = { tools };
    }
    log(`${spec.id}: counting tokens`);
    const first = last;
    const measured = await measureTokens(almyty, account, spec, last.tools);
    results.specs.push({
      id: spec.id,
      label: spec.label,
      source: { url: spec.url, sha256: spec.sha256, subset: spec.subset ?? null },
      imported: { sha256: loaded.sha256 },
      bytes: loaded.bytes,
      operations: loaded.operations,
      toolCount: first.tools.length,
      import: { runs: timings, stats: stats(timings.map((t) => t.ms)) },
      ...measured,
    });
  }

  mkdirSync(opts.out, { recursive: true });
  writeFileSync(join(opts.out, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(join(opts.out, 'tables.md'), `${renderTables(results)}\n`);
  process.stdout.write(`${renderTables(results)}\n`);
}

main().catch((err) => {
  log(err.stack || String(err));
  process.exit(1);
});
