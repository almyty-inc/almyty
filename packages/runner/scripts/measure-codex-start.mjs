#!/usr/bin/env node
// Cold start against warm start of a Codex session, through the runner's own
// agent.spawn handler (the built dist/, so run `npm run build` first).
//
//   node scripts/measure-codex-start.mjs [runs=10] [cwd=/tmp/codex-start]
//
// Each round starts a new session (cold: `codex ... exec`) and then resumes
// it (warm: agent.spawn with resumeSessionId, `codex exec resume <id>`), with
// the same one-word prompt, so the two alternate under the same load. For
// each it records, from the moment the handler is called: the session open
// (Codex's `thread.started` event), the answer (its first agent message) and
// the exit. Codex uses the login already on the machine; nothing is passed
// in. Prints one JSON line per run and a summary with median and p90.
import { mkdirSync } from 'node:fs';
import { dispatchHandler } from '../dist/handlers.js';
import { ProcessManager, createDefaultAdapterFactory } from '../dist/process-manager.js';

const RUNS = Number(process.argv[2]) || 10;
const CWD = process.argv[3] || '/tmp/codex-start';
const PROMPT = 'Reply with the single word ready.';
const FLAGS = ['--json', '--skip-git-repo-check'];
const LIMIT_MS = 10 * 60_000;

mkdirSync(CWD, { recursive: true });
const processes = new ProcessManager(createDefaultAdapterFactory(), 4);
const ctx = {
  processes,
  runnerName: 'measure',
  labels: {},
  maxConcurrent: 4,
  config: { defaultIsolation: 'host', maxConcurrent: 4, allowedCwdRoots: [], denyPatterns: [], networkBlocked: false, installBlocked: true },
};

async function once(kind, resumeSessionId) {
  const ws = `measure-${kind}`;
  const params = {
    platform: 'codex',
    cwd: CWD,
    ...(resumeSessionId ? { resumeSessionId, extraArgs: [...FLAGS, PROMPT] } : { extraArgs: ['exec', ...FLAGS, PROMPT] }),
  };
  const t0 = performance.now();
  const res = await dispatchHandler(ctx, { method: 'agent.spawn', params, workspaceId: ws });
  if (!res.ok) throw new Error(`agent.spawn failed: ${JSON.stringify(res)}`);
  const { processId, args } = res.result;
  const out = { kind, args: args.filter((a) => a !== PROMPT), threadId: null, openMs: null, answerMs: null, exitMs: null, exitCode: null, answer: null };
  let buf = '';
  await new Promise((resolve) => {
    const timer = setTimeout(() => { processes.signal?.(ws, processId, 'SIGKILL'); resolve(); }, LIMIT_MS);
    const done = processes.observe(ws, processId, {
      onData: (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          const j = line.indexOf('{"type"');
          if (j < 0) continue;
          let ev;
          try { ev = JSON.parse(line.slice(j)); } catch { continue; }
          const at = Math.round(performance.now() - t0);
          if (ev.type === 'thread.started' && out.openMs === null) { out.openMs = at; out.threadId = ev.thread_id; }
          if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && out.answerMs === null) { out.answerMs = at; out.answer = String(ev.item.text).slice(0, 40); }
        }
      },
      onExit: (info) => {
        out.exitMs = Math.round(performance.now() - t0);
        out.exitCode = info.exitCode;
        clearTimeout(timer);
        done();
        resolve();
      },
    });
  });
  return out;
}

const pct = (xs, p) => {
  const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

const results = { cold: [], warm: [] };
for (let r = 1; r <= RUNS; r++) {
  const cold = await once('cold');
  console.log(JSON.stringify({ round: r, ...cold }));
  results.cold.push(cold);
  const warm = cold.threadId ? await once('warm', cold.threadId) : { kind: 'warm', error: 'no session to resume' };
  if (warm.threadId && warm.threadId !== cold.threadId) warm.error = `resumed ${warm.threadId}, not ${cold.threadId}`;
  console.log(JSON.stringify({ round: r, ...warm }));
  results.warm.push(warm);
}

const summary = {};
for (const kind of ['cold', 'warm']) {
  const runs = results[kind];
  summary[kind] = { runs: runs.length, ok: runs.filter((x) => x.exitCode === 0 && x.answer && !x.error).length };
  for (const m of ['openMs', 'answerMs', 'exitMs']) {
    const xs = runs.map((x) => x[m]);
    summary[kind][m] = { median: pct(xs, 50), p90: pct(xs, 90) };
  }
}
console.log(JSON.stringify({ summary }));
process.exit(0);
