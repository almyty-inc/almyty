#!/usr/bin/env node
/**
 * almyty runner end-to-end demo.
 *
 * Drives the real product flow against a live SaaS:
 *   1. Resolve credentials from ~/.almyty/credentials.json (or ALMYTY_TOKEN env).
 *   2. Spawn `almyty runner start --name almyty-demo-<random>` as a child process.
 *   3. Poll the API until the runner row reports state=online.
 *   4. Poll the API until the capability tools (runner.info, shell.exec) appear.
 *   5. Execute runner.info via POST /organizations/:org/tools/:id/execute.
 *      Print the response payload — that's a live RPC to your laptop.
 *   6. Create a workspace on the runner (cwd = process.cwd()).
 *   7. Execute shell.exec with `command: uname -a` + the workspace id.
 *      Print the response.
 *   8. Clean up: delete the workspace, kill the runner subprocess.
 *
 * Every step exercises the routing path: tool dispatch → ToolExecutorService
 * → RunnerCallService → Streamable HTTP envelope → runner → response back.
 *
 * Run:
 *   npx @almyty/auth login          # one-time
 *   npm run demo                     # in this directory
 *
 * If you want to skip the runner-spawn step (e.g. you already have one
 * running), set ALMYTY_DEMO_RUNNER_NAME=<existing-runner-name> and the
 * demo will reuse it instead of starting a new one.
 */
import { spawn, ChildProcess } from 'node:child_process';
import { resolveCredentialsOrExit } from '@almyty/client';

interface Runner {
  id: string;
  name: string;
  state: string;
}
interface Tool {
  id: string;
  name: string;
  runnerConfig: { runnerId: string; runnerName: string; method: string; requiresWorkspace: boolean } | null;
}
interface Workspace {
  id: string;
  cwd: string;
  status: string;
  runnerId: string;
}
interface OrgMembership {
  organization: { id: string; name: string; slug: string };
}

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 60_000;

class Api {
  constructor(private readonly baseUrl: string, private readonly token: string) {}
  async req(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${method} ${path} failed: ${res.status} ${text.slice(0, 200)}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }
  get(path: string) { return this.req('GET', path); }
  post(path: string, body: unknown) { return this.req('POST', path, body); }
  del(path: string) { return this.req('DELETE', path); }
}

function log(step: string, msg: string): void {
  process.stdout.write(`\x1b[36m[${step}]\x1b[0m ${msg}\n`);
}
function logResult(label: string, payload: unknown): void {
  process.stdout.write(`\x1b[32m  ${label}:\x1b[0m\n`);
  const s = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  for (const line of s.split('\n')) process.stdout.write(`    ${line}\n`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pollUntil<T>(
  label: string,
  fn: () => Promise<T | null>,
  timeoutMs = POLL_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result !== null) return result;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

async function getDefaultOrgId(api: Api): Promise<string> {
  const profile = await api.get('/auth/profile');
  const memberships = profile?.data?.organizationMemberships as OrgMembership[] | undefined;
  if (!memberships?.length) throw new Error('no organization memberships on the current account');
  return memberships[0].organization.id;
}

async function findRunner(api: Api, name: string): Promise<Runner | null> {
  const list = await api.get('/runners');
  const data = (list?.data ?? list) as Runner[];
  return data.find((r) => r.name === name) ?? null;
}

async function findCapabilities(api: Api, orgId: string, runnerId: string): Promise<Tool[]> {
  const list = await api.get(`/organizations/${orgId}/tools?limit=200`);
  const data = (list?.data ?? list) as Tool[];
  return data.filter((t) => t.runnerConfig?.runnerId === runnerId);
}

function spawnRunner(name: string): ChildProcess {
  // Use the umbrella so the demo doesn't have to know which package
  // ships the runner binary. `npx` resolves it from npm or local
  // workspace; `--yes` suppresses the install prompt.
  const child = spawn('npx', ['--yes', '@almyty/runner', 'start', '--name', name], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  child.stdout?.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) process.stdout.write(`\x1b[90m  runner | ${line}\x1b[0m\n`);
    }
  });
  child.stderr?.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) process.stderr.write(`\x1b[90m  runner | ${line}\x1b[0m\n`);
    }
  });
  return child;
}

async function killRunner(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* */ }
      resolve();
    }, 5_000);
    child.once('exit', () => { clearTimeout(t); resolve(); });
  });
}

async function main(): Promise<void> {
  const creds = resolveCredentialsOrExit();
  const api = new Api(creds.url, creds.token);

  log('1/7', `Resolving organization id from ${creds.url} as ${creds.email ?? 'unknown'}`);
  const orgId = await getDefaultOrgId(api);
  log('1/7', `Using organization ${orgId}`);

  const runnerName = process.env.ALMYTY_DEMO_RUNNER_NAME
    ?? `almyty-demo-${Math.random().toString(36).slice(2, 8)}`;
  const reuseExisting = !!process.env.ALMYTY_DEMO_RUNNER_NAME;

  let child: ChildProcess | null = null;
  let runner: Runner;
  let workspace: Workspace | null = null;

  try {
    if (reuseExisting) {
      log('2/7', `Reusing existing runner '${runnerName}' (ALMYTY_DEMO_RUNNER_NAME set)`);
    } else {
      log('2/7', `Starting a runner named '${runnerName}' via 'npx --yes @almyty/runner start'`);
      child = spawnRunner(runnerName);
      child.on('exit', (code, sig) => {
        if (code !== 0 && code !== null) {
          process.stderr.write(`\x1b[31m  runner exited with code=${code} signal=${sig}\x1b[0m\n`);
        }
      });
    }

    log('3/7', `Polling /runners until '${runnerName}' reports state=online`);
    runner = await pollUntil<Runner>('runner online', async () => {
      const r = await findRunner(api, runnerName);
      if (!r) return null;
      return r.state === 'online' || r.state === 'busy' ? r : null;
    });
    log('3/7', `Runner ${runner.name} (${runner.id}) is ${runner.state}`);

    log('4/7', `Polling /tools until capabilities are published`);
    const tools = await pollUntil<Tool[]>('capabilities published', async () => {
      const list = await findCapabilities(api, orgId, runner.id);
      return list.length >= 2 ? list : null;
    });
    const info = tools.find((t) => t.runnerConfig?.method === 'runner.info')!;
    const shell = tools.find((t) => t.runnerConfig?.method === 'shell.exec')!;
    log('4/7', `Found ${tools.length} capabilities — runner.info=${info.id.slice(0, 8)}, shell.exec=${shell.id.slice(0, 8)}`);

    log('5/7', `Executing runner.info (live RPC to your laptop)`);
    const infoResult = await api.post(`/organizations/${orgId}/tools/${info.id}/execute`, { parameters: {} });
    logResult('runner.info →', (infoResult?.data ?? infoResult)?.data ?? infoResult);

    log('6/7', `Creating a workspace at cwd=${process.cwd()}`);
    const wsRes = await api.post('/workspaces', { cwd: process.cwd(), ttlMs: 10 * 60 * 1000 });
    workspace = (wsRes?.data ?? wsRes) as Workspace;
    log('6/7', `Workspace ${workspace.id} created, status=${workspace.status}`);

    const command = process.env.ALMYTY_DEMO_COMMAND ?? 'uname -a && echo "almyty:$(date -u +%FT%TZ)"';
    log('7/7', `Executing shell.exec with command='${command}'`);
    const shellResult = await api.post(`/organizations/${orgId}/tools/${shell.id}/execute`, {
      parameters: { command, workspaceId: workspace.id },
    });
    logResult('shell.exec →', (shellResult?.data ?? shellResult)?.data ?? shellResult);

    log('done', `End-to-end routing path verified. SaaS dispatched two tools through your runner.`);
  } finally {
    if (workspace) {
      try {
        await api.del(`/workspaces/${workspace.id}`);
        log('cleanup', `Released workspace ${workspace.id}`);
      } catch (e: any) {
        process.stderr.write(`  cleanup: failed to release workspace: ${e.message}\n`);
      }
    }
    if (child) {
      log('cleanup', `Sending SIGTERM to runner subprocess`);
      await killRunner(child);
    }
  }
}

main().catch((err) => {
  process.stderr.write(`\x1b[31m✗ demo failed:\x1b[0m ${err.message ?? err}\n`);
  process.exit(1);
});
