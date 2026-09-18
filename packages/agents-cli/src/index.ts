#!/usr/bin/env node
/**
 * @almyty/agents — list, inspect, and run almyty agents.
 *
 *   npx @almyty/agents list
 *   npx @almyty/agents get <name|id>
 *   npx @almyty/agents run <name|id> --input '<json>' --watch
 *   npx @almyty/agents runs <name|id>
 *   npx @almyty/agents inspect <name|id> <runId>
 *   npx @almyty/agents trace <name|id> <executionId>
 *
 * Reads credentials from ~/.almyty/credentials.json (created by
 * `npx @almyty/auth login`).
 */

import {
  AlmytyClient,
  type AgentInfo,
  type AgentRun,
  type RunLimits,
  resolveCredentials,
} from '@almyty/client';

import { parseArgs, flagNumber, flagString, type ParsedArgs } from './args.js';
import { EXIT } from './exit-codes.js';
import { VERSION } from './version.js';
import {
  formatAgentDetail,
  formatAgentLine,
  formatExecutionSummary,
  formatNodeResults,
  formatRunDetail,
  formatRunSummary,
  formatStep,
  formatTrace,
  notActiveMessage,
  runSucceeded,
  type AgentSummary,
} from './format.js';

/** Flags that are switches, so they never swallow the next token. */
const BOOLEAN_FLAGS = ['watch', 'steps'] as const;

function printHelp(): void {
  console.log(`@almyty/agents v${VERSION}

Usage:
  npx @almyty/agents <command> [options]

Commands:
  list                          List the agents in your organization
  get <name|id>                 One agent: mode, status, pipeline shape, tools
  run <name|id>                 Invoke a workflow agent, or start an autonomous run
  runs <name|id>                Recent autonomous runs, newest first
  inspect <name|id> <runId>     One autonomous run in full: steps, models, cost, error
  executions <name|id>          Recent workflow executions, newest first
  trace <name|id> <execId>      Where a workflow execution's calls went, hop by hop
  cancel <name|id> <runId>      Cancel an in-flight autonomous run
  help                          Show this help

Run options:
  --input '<json>'              Input payload (workflow: object; autonomous: string or object)
  --resume <conversation-id>    Autonomous: continue a previous conversation
  --max-steps <n>               Autonomous: step ceiling
  --max-cost-cents <n>          Autonomous: cost ceiling, in cents
  --max-duration-ms <ms>        Autonomous: wall-clock ceiling
  --watch                       Autonomous: stream steps until the run ends
  --timeout <s>                 Autonomous --watch: give up waiting after this long (default 300)

List options (list, runs, executions):
  --limit <n>                   Rows per page (runs, executions; default 20)
  --page <n>                    Page number (runs, executions; default 1)

Inspect options:
  --steps                       run: also print per-node detail for a workflow run

Global options:
  --json                        Machine-readable output, no decoration
  --help, -h                    Show this help
  --version, -v                 Print the version

Environment:
  ALMYTY_TOKEN                  Token override (skips ~/.almyty/credentials.json)
  ALMYTY_URL                    API URL override
  NO_COLOR                      Honoured; these commands emit no ANSI colour anyway

Exit codes:
  0  success
  1  unexpected error
  2  usage error (bad flags, unknown command)
  3  not authenticated — run \`npx @almyty/auth login\`
  4  no such agent, run, or execution
  5  the run finished in a non-success state

Notes:
  A workflow agent's history is under \`executions\` and \`trace\`; an
  autonomous agent's is under \`runs\` and \`inspect\`. \`get\` tells you
  which mode an agent is in.

Login:
  npx @almyty/auth login        Browser-based login (writes ~/.almyty/credentials.json)
`);
}

function emitJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function fail(message: string, code: number): never {
  console.error(message);
  process.exit(code);
}

/**
 * The credential, or a clear instruction. Every command in every almyty
 * CLI answers a missing credential the same way and with the same exit
 * code, so a script can branch on 3 instead of matching stderr.
 */
function newClient(args?: ParsedArgs): AlmytyClient {
  const creds = resolveCredentials();
  if (!creds?.token) {
    if (args?.flags.json) {
      // A --json consumer gets a parseable answer on stdout too, not
      // only an exit code and prose on stderr.
      emitJson({
        error: 'NOT_AUTHENTICATED',
        message: 'Run `npx @almyty/auth login`, or set ALMYTY_TOKEN.',
      });
    }
    console.error('Not authenticated. Run one of:');
    console.error('  npx @almyty/auth login');
    console.error('  export ALMYTY_TOKEN=<your-token>');
    process.exit(EXIT.AUTH);
  }
  return new AlmytyClient(creds.url, creds.token);
}

function requireArg(value: string | undefined, usage: string): string {
  if (!value) fail(`Usage: npx @almyty/agents ${usage}`, EXIT.USAGE);
  return value;
}

async function findAgentOrExit(client: AlmytyClient, ref: string): Promise<AgentInfo> {
  const agent = await client.findAgentByNameOrId(ref);
  if (!agent) {
    console.error(`Agent not found: ${ref}`);
    console.error('Run `npx @almyty/agents list` to see what exists.');
    process.exit(EXIT.NOT_FOUND);
  }
  return agent;
}

/** `?page=&limit=` from the shared list flags. */
function pageQuery(args: ParsedArgs): { page: number; limit: number } {
  return {
    page: flagNumber(args.flags, 'page') ?? 1,
    limit: flagNumber(args.flags, 'limit') ?? 20,
  };
}

async function cmdList(args: ParsedArgs): Promise<void> {
  const client = newClient(args);
  const agents = await client.listAgents();
  if (args.flags.json) {
    emitJson(agents);
    return;
  }
  if (agents.length === 0) {
    console.log('No agents found. Create one at https://app.almyty.com/agents');
    return;
  }
  console.log('');
  console.log(`${agents.length} agent(s):`);
  console.log('');
  for (const agent of agents) {
    console.log(formatAgentLine(agent as AgentSummary));
    console.log('');
  }
}

async function cmdGet(args: ParsedArgs): Promise<void> {
  const ref = requireArg(args.positional[0], 'get <name|id>');
  const client = newClient(args);
  const found = await findAgentOrExit(client, ref);
  // The list endpoint drops tools and the pipeline; fetch the full row
  // so `get` can answer what the agent is actually wired to.
  const agent = await client.getAgent(found.id).catch(() => found);
  if (args.flags.json) {
    emitJson(agent);
    return;
  }
  console.log('');
  console.log(formatAgentDetail(agent as AgentSummary));
  console.log('');
}

function parseInputFlag(value: string | boolean | undefined): any {
  if (typeof value !== 'string') return undefined;
  // Try JSON first; fall back to the raw string (an autonomous agent's
  // input is usually a plain sentence).
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function cmdRun(args: ParsedArgs): Promise<void> {
  const ref = requireArg(args.positional[0], "run <name|id> [--input '<json>']");
  const client = newClient(args);
  const agent = await findAgentOrExit(client, ref);

  // A DRAFT agent answers 400 with a JSON body. The status is already
  // here, so say what to do about it instead of printing the body.
  if (agent.status && agent.status.toLowerCase() !== 'active') {
    if (args.flags.json) {
      emitJson({
        error: 'AGENT_NOT_ACTIVE',
        agentId: agent.id,
        agentName: agent.name,
        status: agent.status,
        message: 'Agent must be active to run',
      });
      process.exit(EXIT.FAILED);
    }
    fail(notActiveMessage(agent as AgentSummary), EXIT.FAILED);
  }

  const rawInput = parseInputFlag(args.flags.input);

  if (agent.mode === 'autonomous') {
    const limits: RunLimits & { conversationId?: string } = {};
    const maxSteps = flagNumber(args.flags, 'max-steps');
    const maxCostCents = flagNumber(args.flags, 'max-cost-cents');
    const maxDurationMs = flagNumber(args.flags, 'max-duration-ms');
    if (maxSteps !== undefined) limits.maxSteps = maxSteps;
    if (maxCostCents !== undefined) limits.maxCostCents = maxCostCents;
    if (maxDurationMs !== undefined) limits.maxDurationMs = maxDurationMs;
    const resume = flagString(args.flags, 'resume');
    if (resume) limits.conversationId = resume;

    const runStub = await client.startRun(agent.id, rawInput ?? '', limits);
    if (!args.flags.watch) {
      if (args.flags.json) {
        emitJson(runStub);
      } else {
        console.log(`Started run ${runStub.id}`);
        console.log(`Watch:   npx @almyty/agents inspect ${ref} ${runStub.id}`);
        console.log(`Cancel:  npx @almyty/agents cancel ${ref} ${runStub.id}`);
      }
      return;
    }

    let printed = 0;
    const timeoutSeconds = flagNumber(args.flags, 'timeout') ?? 300;
    const final = await client.pollRun(agent.id, runStub.id, {
      timeoutMs: timeoutSeconds * 1000,
      onStep: (run: AgentRun) => {
        if (args.flags.json) return;
        const steps = (run.steps ?? []) as any[];
        for (let i = printed; i < steps.length; i++) {
          const line = formatStep(steps[i], i);
          if (line) console.log(line);
        }
        printed = steps.length;
      },
    });

    // A failed run is a failed command.
    //
    // pollRun returns on ANY terminal status, and this printed
    // "Run failed." and exited 0 -- so `almyty agents run deploy-check
    // --watch && ./ship.sh` shipped on a failed check.
    if (!runSucceeded(final.status)) process.exitCode = EXIT.FAILED;

    if (args.flags.json) {
      emitJson(final);
      return;
    }
    console.log('');
    console.log(formatRunSummary(final as any));
    if (final.output != null) {
      console.log('');
      console.log(
        typeof final.output === 'string'
          ? final.output
          : JSON.stringify(final.output, null, 2),
      );
    }
    if (final.error) {
      console.error('');
      console.error(`Error: ${final.error}`);
      console.error(`Detail: npx @almyty/agents inspect ${ref} ${final.id}`);
    }
    return;
  }

  // workflow mode
  const result = await client.invokeAgent(agent.id, rawInput ?? {});
  // Same rule: the endpoint answers 200 with status 'failed'.
  if (result?.status && !runSucceeded(result.status)) process.exitCode = EXIT.FAILED;
  if (args.flags.json) {
    emitJson(result);
    return;
  }

  const output = result?.output ?? null;
  if (output == null) console.log('(no output)');
  else if (typeof output === 'string') console.log(output);
  else console.log(JSON.stringify(output, null, 2));

  // Attribution and cost, always — a routed workflow answers from
  // whichever model the policy picked, and that has to be visible.
  if (result?.status) {
    console.log('');
    console.log(formatExecutionSummary(result));
  }
  if (args.flags.steps || (result?.status && !runSucceeded(result.status))) {
    const lines = formatNodeResults(result?.nodeResults);
    if (lines.length) {
      console.log('');
      console.log('Nodes:');
      for (const line of lines) console.log(line);
    }
  }
  if (result?.error) {
    console.error('');
    console.error(`Error: ${result.error}`);
    if (result.id) {
      console.error(`Detail: npx @almyty/agents trace ${ref} ${result.id}`);
    }
  }
}

async function cmdRuns(args: ParsedArgs): Promise<void> {
  const ref = requireArg(args.positional[0], 'runs <name|id>');
  const client = newClient(args);
  const agent = await findAgentOrExit(client, ref);
  const { page, limit } = pageQuery(args);

  const { data, total } = await client.listRuns(agent.id, page, limit);
  if (args.flags.json) {
    emitJson({ total, page, limit, data });
    return;
  }
  if (data.length === 0) {
    console.log(
      agent.mode === 'workflow'
        ? `No autonomous runs — ${agent.name} is a workflow agent. Try: npx @almyty/agents executions ${ref}`
        : 'No runs yet.',
    );
    return;
  }
  console.log('');
  console.log(`${total} run(s), showing page ${page}:`);
  console.log('');
  for (const run of data as any[]) {
    const bits = [run.id, (run.status ?? '?').padEnd(10)];
    if (run.createdAt) bits.push(run.createdAt);
    console.log(`  ${bits.join('  ')}`);
    console.log(`      ${formatRunSummary(run)}`);
  }
  console.log('');
  console.log(`Detail: npx @almyty/agents inspect ${ref} <runId>`);
}

async function cmdInspect(args: ParsedArgs): Promise<void> {
  const ref = requireArg(args.positional[0], 'inspect <name|id> <runId>');
  const runId = requireArg(args.positional[1], 'inspect <name|id> <runId>');
  const client = newClient(args);
  const agent = await findAgentOrExit(client, ref);

  let run: AgentRun;
  try {
    run = await client.getRun(agent.id, runId);
  } catch (err: any) {
    fail(
      `Run not found on ${agent.name}: ${runId}\n${err.message}`,
      EXIT.NOT_FOUND,
    );
  }
  if (args.flags.json) {
    emitJson(run);
  } else {
    console.log('');
    console.log(formatRunDetail(run as any));
    console.log('');
  }
  if (!runSucceeded(run.status)) process.exitCode = EXIT.FAILED;
}

async function cmdExecutions(args: ParsedArgs): Promise<void> {
  const ref = requireArg(args.positional[0], 'executions <name|id>');
  const client = newClient(args);
  const agent = await findAgentOrExit(client, ref);
  const { page, limit } = pageQuery(args);

  const body: any = await client.request(
    `/agents/${encodeURIComponent(agent.id)}/executions?page=${page}&limit=${limit}`,
  );
  const data: any[] = body?.data ?? [];
  const total: number = body?.pagination?.total ?? data.length;

  if (args.flags.json) {
    emitJson({ total, page, limit, data });
    return;
  }
  if (data.length === 0) {
    console.log(
      agent.mode === 'autonomous'
        ? `No workflow executions — ${agent.name} is an autonomous agent. Try: npx @almyty/agents runs ${ref}`
        : 'No executions yet.',
    );
    return;
  }
  console.log('');
  console.log(`${total} execution(s), showing page ${page}:`);
  console.log('');
  for (const execution of data) {
    const bits = [execution.id, (execution.status ?? '?').padEnd(10)];
    if (execution.createdAt) bits.push(execution.createdAt);
    console.log(`  ${bits.join('  ')}`);
    console.log(`      ${formatExecutionSummary(execution)}`);
  }
  console.log('');
  console.log(`Detail: npx @almyty/agents trace ${ref} <executionId>`);
}

async function cmdTrace(args: ParsedArgs): Promise<void> {
  const ref = requireArg(args.positional[0], 'trace <name|id> <executionId>');
  const executionId = requireArg(args.positional[1], 'trace <name|id> <executionId>');
  const client = newClient(args);
  const agent = await findAgentOrExit(client, ref);

  let body: any;
  try {
    body = await client.request(
      `/agents/${encodeURIComponent(agent.id)}/executions/${encodeURIComponent(executionId)}/trace`,
    );
  } catch (err: any) {
    fail(
      `No trace for execution ${executionId} on ${agent.name}.\n${err.message}`,
      EXIT.NOT_FOUND,
    );
  }
  const trace = body?.data ?? body;
  if (args.flags.json) {
    emitJson(trace);
    return;
  }
  console.log('');
  console.log(formatTrace(trace));
  console.log('');
}

async function cmdCancel(args: ParsedArgs): Promise<void> {
  const ref = requireArg(args.positional[0], 'cancel <name|id> <runId>');
  const runId = requireArg(args.positional[1], 'cancel <name|id> <runId>');
  const client = newClient(args);
  const agent = await findAgentOrExit(client, ref);
  await client.cancelRun(agent.id, runId);
  if (args.flags.json) emitJson({ cancelled: true, agentId: agent.id, runId });
  else console.log(`Cancelled ${runId}`);
}

const COMMANDS: Record<string, (args: ParsedArgs) => Promise<void>> = {
  list: cmdList,
  get: cmdGet,
  run: cmdRun,
  runs: cmdRuns,
  inspect: cmdInspect,
  executions: cmdExecutions,
  trace: cmdTrace,
  cancel: cmdCancel,
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), BOOLEAN_FLAGS);
  if (args.flags.version) {
    console.log(VERSION);
    return;
  }
  if (args.flags.help || !args.command || args.command === 'help') {
    printHelp();
    return;
  }

  const handler = COMMANDS[args.command];
  if (!handler) {
    console.error(`Unknown command: ${args.command}`);
    console.error(`Commands: ${Object.keys(COMMANDS).join(', ')}. Run --help for detail.`);
    process.exit(EXIT.USAGE);
  }
  await handler(args);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  // An auth failure from anywhere in the client gets the auth code, so
  // `|| almyty login` works whichever call discovered the dead token.
  const authFailure = /Authentication failed|401/.test(err.message ?? '');
  process.exit(authFailure ? EXIT.AUTH : EXIT.ERROR);
});
