#!/usr/bin/env node
/**
 * @almyty/chat — interactive REPL with almyty agents.
 *
 *   npx @almyty/chat                       # pick from a menu
 *   npx @almyty/chat <agent>               # start chatting with that agent
 *   npx @almyty/chat <agent> --resume <id> # resume a conversation
 *
 * Reads credentials from ~/.almyty/credentials.json (created by
 * `npx @almyty/auth login`).
 *
 * Slash commands inside the REPL:
 *
 *   /switch <agent>   switch to a different agent
 *   /agents           list agents in your organization
 *   /clear            clear the screen
 *   /help             show command list
 *   /quit, /exit      leave the REPL
 */

import { createInterface, Interface as ReadlineInterface } from 'readline';
import { AlmytyClient, AgentInfo, AgentRun, resolveCredentialsOrExit } from '@almyty/client';

const VERSION = '0.1.0';

interface ChatState {
  client: AlmytyClient;
  agent: AgentInfo;
  // For autonomous agents: a run that's parked in waiting_input state.
  pendingRunId: string | null;
  // Conversation ID for multi-turn history across runs.
  conversationId: string | null;
}

function printHelp(): void {
  console.log(`
@almyty/chat v${VERSION}

Usage:
  npx @almyty/chat                       Pick an agent from a menu
  npx @almyty/chat <name|id>             Start chatting with that agent
  npx @almyty/chat <name|id> --resume <conversation-id>
                                         Resume an existing conversation

Inside the REPL:
  /switch <agent>   switch to a different agent
  /agents           list agents in your organization
  /clear            clear the screen
  /help             show command list
  /quit, /exit      leave the REPL

Login:
  npx @almyty/auth login                 Browser-based login
`);
}

function printAgentBanner(agent: AgentInfo): void {
  console.log('');
  console.log(`  💬 ${agent.name}${agent.mode ? ` [${agent.mode}]` : ''}`);
  if (agent.description) console.log(`     ${agent.description}`);
  console.log('');
  console.log('  Type your message, or /help for commands. /quit to exit.');
  console.log('');
}

function formatStep(step: any): string | null {
  if (!step) return null;
  switch (step.type) {
    case 'llm_call':
      if (step.output?.content) return `  ${step.output.content}`;
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

async function pickAgent(client: AlmytyClient): Promise<AgentInfo | null> {
  const agents = await client.listAgents();
  if (agents.length === 0) {
    console.error('No agents in your organization. Create one at https://app.almyty.com/agents');
    return null;
  }
  if (agents.length === 1) {
    return agents[0];
  }

  console.log('');
  console.log('  Pick an agent:');
  agents.forEach((a, i) => {
    const mode = a.mode ? ` [${a.mode}]` : '';
    console.log(`    ${i + 1}. ${a.name}${mode}`);
  });
  console.log('');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question('  Enter number: ', (input) => {
      rl.close();
      resolve(input.trim());
    });
  });

  const idx = parseInt(answer, 10) - 1;
  if (Number.isNaN(idx) || idx < 0 || idx >= agents.length) {
    console.error('Invalid selection.');
    return null;
  }
  return agents[idx];
}

async function handleSlashCommand(
  command: string,
  state: ChatState,
): Promise<{ exit?: boolean }> {
  const [cmd, ...rest] = command.slice(1).trim().split(/\s+/);
  switch (cmd) {
    case 'quit':
    case 'exit':
      return { exit: true };

    case 'help':
      console.log('');
      console.log('  /switch <agent>   switch to a different agent');
      console.log('  /agents           list agents in your organization');
      console.log('  /clear            clear the screen');
      console.log('  /quit, /exit      leave the REPL');
      console.log('  /help             this help');
      console.log('');
      return {};

    case 'clear':
      process.stdout.write('\x1b[2J\x1b[H');
      printAgentBanner(state.agent);
      return {};

    case 'agents': {
      const agents = await state.client.listAgents();
      if (agents.length === 0) {
        console.log('  (no agents in this organization)');
        return {};
      }
      console.log('');
      for (const a of agents) {
        const marker = a.id === state.agent.id ? '→' : ' ';
        const mode = a.mode ? ` [${a.mode}]` : '';
        console.log(`  ${marker} ${a.name}${mode}${a.description ? ' — ' + a.description : ''}`);
      }
      console.log('');
      return {};
    }

    case 'switch': {
      const target = rest.join(' ').trim();
      if (!target) {
        console.log('  Usage: /switch <agent name or id>');
        return {};
      }
      const next = await state.client.findAgentByNameOrId(target);
      if (!next) {
        console.log(`  Agent "${target}" not found.`);
        return {};
      }
      state.agent = next;
      state.pendingRunId = null;
      state.conversationId = null;
      printAgentBanner(state.agent);
      return {};
    }

    default:
      console.log(`  Unknown command: /${cmd}. Type /help for available commands.`);
      return {};
  }
}

async function handleAutonomousTurn(state: ChatState, message: string): Promise<void> {
  let runId: string;
  if (state.pendingRunId) {
    await state.client.sendRunInput(state.agent.id, state.pendingRunId, message);
    runId = state.pendingRunId;
    state.pendingRunId = null;
  } else {
    const run = await state.client.startRun(state.agent.id, message, {
      conversationId: state.conversationId ?? undefined,
    });
    runId = run.id;
    if (run.conversationId) {
      state.conversationId = run.conversationId;
    }
  }

  let printed = 0;
  const final = await state.client.pollRun(state.agent.id, runId, {
    onStep: (run: AgentRun) => {
      const newSteps = (run.steps ?? []).slice(printed);
      for (const step of newSteps) {
        const line = formatStep(step);
        if (line) console.log(line);
      }
      printed = run.steps?.length ?? printed;
    },
  });

  if (final.status === 'waiting_input') {
    state.pendingRunId = runId;
    console.log('');
    console.log('  (agent is waiting for your input — answer below)');
    console.log('');
    return;
  }
  if (final.status === 'completed') {
    if (final.output != null) {
      console.log('');
      console.log(typeof final.output === 'string' ? `  ${final.output}` : JSON.stringify(final.output, null, 2));
    }
    return;
  }
  console.log('');
  console.log(`  Run ${final.status}${final.error ? `: ${final.error}` : ''}`);
}

async function handleWorkflowTurn(state: ChatState, message: string): Promise<void> {
  const result = await state.client.invokeAgent(state.agent.id, { message });
  const output = result?.output ?? result?.data?.output ?? result;
  if (output == null) {
    console.log('  (no output)');
    return;
  }
  console.log('');
  if (typeof output === 'string') {
    console.log(`  ${output}`);
  } else {
    console.log(JSON.stringify(output, null, 2).split('\n').map((l) => '  ' + l).join('\n'));
  }
}

async function handleUserTurn(state: ChatState, message: string): Promise<void> {
  if (state.agent.mode === 'autonomous') {
    return handleAutonomousTurn(state, message);
  }
  return handleWorkflowTurn(state, message);
}

async function startChat(client: AlmytyClient, agent: AgentInfo, resumeConversationId?: string): Promise<void> {
  const state: ChatState = { client, agent, pendingRunId: null, conversationId: resumeConversationId ?? null };
  if (resumeConversationId) {
    console.log(`  Resuming conversation ${resumeConversationId}`);
  }
  printAgentBanner(state.agent);

  const rl: ReadlineInterface = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  rl.prompt();

  rl.on('line', async (raw) => {
    const line = raw.trim();
    if (!line) {
      rl.prompt();
      return;
    }

    if (line.startsWith('/')) {
      try {
        const { exit } = await handleSlashCommand(line, state);
        if (exit) {
          rl.close();
          return;
        }
      } catch (err: any) {
        console.error(`  Error: ${err.message}`);
      }
      rl.prompt();
      return;
    }

    try {
      await handleUserTurn(state, line);
    } catch (err: any) {
      console.error(`  Error: ${err.message}`);
    }
    console.log('');
    rl.prompt();
  });

  rl.on('close', () => {
    console.log('');
    console.log('Chat ended.');
    process.exit(0);
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(VERSION);
    return;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return;
  }

  const creds = resolveCredentialsOrExit();
  const client = new AlmytyClient(creds.url, creds.token);

  // Parse --resume <conversation-id>
  let resumeConversationId: string | undefined;
  const resumeIdx = argv.indexOf('--resume');
  if (resumeIdx !== -1) {
    const nextArg = argv[resumeIdx + 1];
    if (!nextArg || nextArg.startsWith('-')) {
      console.error('Usage: --resume <conversation-id>');
      process.exit(1);
    }
    resumeConversationId = nextArg;
  }

  let agent: AgentInfo | null = null;
  const ref = argv.find((a) => !a.startsWith('-') && a !== resumeConversationId);
  if (ref) {
    agent = await client.findAgentByNameOrId(ref);
    if (!agent) {
      console.error(`Agent not found: ${ref}`);
      process.exit(1);
    }
  } else {
    agent = await pickAgent(client);
    if (!agent) process.exit(1);
  }

  await startChat(client, agent, resumeConversationId);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
