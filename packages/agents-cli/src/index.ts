#!/usr/bin/env node
/**
 * @almyty/agents — list, get, run, and inspect almyty agents.
 *
 *   npx @almyty/agents list
 *   npx @almyty/agents get <name|id>
 *   npx @almyty/agents run <name|id> [--input '<json>']
 *   npx @almyty/agents runs <name|id>
 *   npx @almyty/agents cancel <name|id> <runId>
 *
 * Reads credentials from ~/.almyty/credentials.json (created by
 * `npx @almyty/auth login`).
 */

import { AlmytyClient, AgentInfo, AgentRun } from './client.js';
import { resolveCredentialsOrExit } from './credentials.js';

const VERSION = '0.1.0';

function printHelp(): void {
  console.log(`
@almyty/agents v${VERSION}

Usage:
  npx @almyty/agents <command> [options]

Commands:
  list                          List all agents in your organization
  get <name|id>                 Show details for one agent
  run <name|id>                 Invoke a workflow agent or start an autonomous run
  runs <name|id>                List recent runs for an agent
  cancel <name|id> <runId>      Cancel a running autonomous run
  help                          Show this help

Run options:
  --input '<json>'              Input payload (workflow: object; autonomous: string or object)
  --max-steps <n>               Autonomous: max steps (default 50)
  --max-cost-cents <n>          Autonomous: max cost in cents (default 100)
  --max-duration-ms <ms>        Autonomous: max wall time in ms (default 3600000)
  --watch                       Autonomous: stream steps as they arrive
  --json                        Print raw JSON instead of pretty output

Environment:
  ALMYTY_TOKEN                  Token override (skips ~/.almyty/credentials.json)
  ALMYTY_URL                    API URL override

Login:
  npx @almyty/auth login        Browser-based login (writes ~/.almyty/credentials.json)
`);
}

interface ParsedArgs {
  command?: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { positional: [], flags: {} };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      result.flags.help = true;
    } else if (arg === '--version' || arg === '-v') {
      result.flags.version = true;
    } else if (arg === '--watch') {
      result.flags.watch = true;
    } else if (arg === '--json') {
      result.flags.json = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        result.flags[key] = next;
        i++;
      } else {
        result.flags[key] = true;
      }
    } else if (!result.command) {
      result.command = arg;
    } else {
      result.positional.push(arg);
    }
    i++;
  }
  return result;
}

function newClient(): AlmytyClient {
  const creds = resolveCredentialsOrExit();
  return new AlmytyClient(creds.url, creds.token);
}

function formatAgent(a: AgentInfo, prefix = ''): string {
  const mode = a.mode ? ` [${a.mode}]` : '';
  const status = a.status ? ` (${a.status})` : '';
  const desc = a.description ? `\n${prefix}    ${a.description}` : '';
  return `${prefix}${a.name}${mode}${status}${desc}`;
}

async function cmdList(args: ParsedArgs): Promise<void> {
  const client = newClient();
  const agents = await client.listAgents();
  if (args.flags.json) {
    console.log(JSON.stringify(agents, null, 2));
    return;
  }
  if (agents.length === 0) {
    console.log('No agents found. Create one at https://app.almyty.com/agents');
    return;
  }
  console.log(`\n${agents.length} agent(s):\n`);
  for (const a of agents) {
    console.log('  ' + formatAgent(a, '  ').trimStart());
    console.log('');
  }
}

async function cmdGet(args: ParsedArgs): Promise<void> {
  const ref = args.positional[0];
  if (!ref) {
    console.error('Usage: npx @almyty/agents get <name|id>');
    process.exit(1);
  }
  const client = newClient();
  const agent = await client.findAgentByNameOrId(ref);
  if (!agent) {
    console.error(`Agent not found: ${ref}`);
    process.exit(1);
  }
  if (args.flags.json) {
    console.log(JSON.stringify(agent, null, 2));
    return;
  }
  console.log('');
  console.log(`  ${agent.name}`);
  console.log(`  id:     ${agent.id}`);
  if (agent.mode) console.log(`  mode:   ${agent.mode}`);
  if (agent.status) console.log(`  status: ${agent.status}`);
  if (agent.description) console.log(`  desc:   ${agent.description}`);
  console.log('');
}

function parseInputFlag(value: string | boolean | undefined): any {
  if (value === undefined || value === true || value === false) return undefined;
  // Try JSON first; fall back to raw string.
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function formatStep(step: any): string | null {
  if (!step) return null;
  switch (step.type) {
    case 'llm_call':
      if (step.output?.content) {
        return `  ${step.output.content}`;
      }
      return `  · llm_call (${step.tokens?.input ?? 0}↓ / ${step.tokens?.output ?? 0}↑)`;
    case 'tool_call':
      return `  · tool_call → ${step.input?.tool ?? '?'}`;
    case 'sub_agent_call':
      return `  · sub_agent_call → ${step.input?.agentId ?? '?'}`;
    case 'error':
      return `  ! error: ${step.error}`;
    default:
      return null;
  }
}

async function cmdRun(args: ParsedArgs): Promise<void> {
  const ref = args.positional[0];
  if (!ref) {
    console.error('Usage: npx @almyty/agents run <name|id> [--input <json>]');
    process.exit(1);
  }
  const client = newClient();
  const agent = await client.findAgentByNameOrId(ref);
  if (!agent) {
    console.error(`Agent not found: ${ref}`);
    process.exit(1);
  }

  const rawInput = parseInputFlag(args.flags.input);

  if (agent.mode === 'autonomous') {
    const limits: any = {};
    if (args.flags['max-steps']) limits.maxSteps = Number(args.flags['max-steps']);
    if (args.flags['max-cost-cents']) limits.maxCostCents = Number(args.flags['max-cost-cents']);
    if (args.flags['max-duration-ms']) limits.maxDurationMs = Number(args.flags['max-duration-ms']);

    const runStub = await client.startAgentRun(agent.id, rawInput ?? '', limits);
    if (!args.flags.watch) {
      if (args.flags.json) {
        console.log(JSON.stringify(runStub, null, 2));
      } else {
        console.log(`Started run ${runStub.id}`);
        console.log(`Watch:  npx @almyty/agents runs ${ref}`);
        console.log(`Cancel: npx @almyty/agents cancel ${ref} ${runStub.id}`);
      }
      return;
    }

    let printed = 0;
    const final = await client.pollRun(agent.id, runStub.id, {
      onStep: (run: AgentRun) => {
        const newSteps = (run.steps ?? []).slice(printed);
        for (const step of newSteps) {
          const line = formatStep(step);
          if (line) console.log(line);
        }
        printed = run.steps?.length ?? printed;
      },
    });

    if (args.flags.json) {
      console.log(JSON.stringify(final, null, 2));
      return;
    }
    console.log('');
    console.log(`Run ${final.status}.`);
    if (final.output != null) {
      console.log('');
      console.log(typeof final.output === 'string' ? final.output : JSON.stringify(final.output, null, 2));
    }
    if (final.error) console.error(`Error: ${final.error}`);
    return;
  }

  // workflow mode
  const result = await client.invokeAgent(agent.id, rawInput ?? {});
  if (args.flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const output = result?.output ?? result;
  if (output == null) {
    console.log('(no output)');
  } else if (typeof output === 'string') {
    console.log(output);
  } else {
    console.log(JSON.stringify(output, null, 2));
  }
}

async function cmdRuns(args: ParsedArgs): Promise<void> {
  const ref = args.positional[0];
  if (!ref) {
    console.error('Usage: npx @almyty/agents runs <name|id>');
    process.exit(1);
  }
  const client = newClient();
  const agent = await client.findAgentByNameOrId(ref);
  if (!agent) {
    console.error(`Agent not found: ${ref}`);
    process.exit(1);
  }

  const { data, total } = await client.listRuns(agent.id);
  if (args.flags.json) {
    console.log(JSON.stringify({ total, data }, null, 2));
    return;
  }
  if (data.length === 0) {
    console.log('No runs yet.');
    return;
  }
  console.log(`\n${total} run(s):\n`);
  for (const run of data) {
    console.log(`  ${run.id}  ${run.status}`);
  }
}

async function cmdCancel(args: ParsedArgs): Promise<void> {
  const ref = args.positional[0];
  const runId = args.positional[1];
  if (!ref || !runId) {
    console.error('Usage: npx @almyty/agents cancel <name|id> <runId>');
    process.exit(1);
  }
  const client = newClient();
  const agent = await client.findAgentByNameOrId(ref);
  if (!agent) {
    console.error(`Agent not found: ${ref}`);
    process.exit(1);
  }
  await client.cancelRun(agent.id, runId);
  console.log(`Cancelled ${runId}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.version) {
    console.log(VERSION);
    return;
  }
  if (args.flags.help || !args.command || args.command === 'help') {
    printHelp();
    return;
  }

  switch (args.command) {
    case 'list':
      await cmdList(args);
      return;
    case 'get':
      await cmdGet(args);
      return;
    case 'run':
      await cmdRun(args);
      return;
    case 'runs':
      await cmdRuns(args);
      return;
    case 'cancel':
      await cmdCancel(args);
      return;
    default:
      console.error(`Unknown command: ${args.command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
