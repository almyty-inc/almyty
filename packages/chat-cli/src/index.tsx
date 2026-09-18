#!/usr/bin/env node

import React from 'react';
import { render, Box, Text } from 'ink';
import { AlmytyClient, resolveCredentials, getOrgSlugFromToken } from '@almyty/client';
import type { AgentInfo, RunLimits } from '@almyty/client';

import { AgentSelector } from './components.js';
import { ChatApp, exitMessage } from './app.js';
import { helpText, isNonInteractive, parseArgs, resolveRef, splitRef, useColor, type ChatArgs } from './args.js';
import { explainError, DEFAULT_APP_URL, type ErrorContext } from './errors.js';
import { EXIT, exitCodeForError } from './exit-codes.js';
import { readStdin, runHeadless } from './headless.js';
import { VERSION } from './version.js';

export { VERSION };

function limitsFrom(args: ChatArgs): RunLimits | undefined {
  if (args.maxSteps === undefined && args.maxCostCents === undefined) return undefined;
  return {
    ...(args.maxSteps !== undefined ? { maxSteps: args.maxSteps } : {}),
    ...(args.maxCostCents !== undefined ? { maxCostCents: args.maxCostCents } : {}),
  };
}

// ── Entry point ─────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.error) {
    console.error(args.error);
    process.exit(EXIT.USAGE);
  }
  if (args.version) {
    console.log(VERSION);
    return;
  }
  if (args.help) {
    console.log(helpText(VERSION));
    return;
  }

  const creds = resolveCredentials();
  if (!creds) {
    // Said once, in full, rather than as a 401 three calls later.
    console.error('Not authenticated. Run one of:');
    console.error('  npx @almyty/auth login');
    console.error('  export ALMYTY_TOKEN=<your-token>');
    process.exit(EXIT.AUTH);
  }
  const client = new AlmytyClient(creds.url, creds.token);
  const appUrl = process.env.ALMYTY_APP_URL || creds.frontendUrl || DEFAULT_APP_URL;
  const headless = isNonInteractive(args, {
    stdinTty: process.stdin.isTTY === true,
    stdoutTty: process.stdout.isTTY === true,
  });

  const ref = resolveRef(args);
  const defaultOrg = getOrgSlugFromToken(creds.token);

  let orgSlug: string;
  let agentSlug: string;

  if (ref) {
    const parts = splitRef(ref);
    if (parts.orgSlug) {
      orgSlug = parts.orgSlug;
      agentSlug = parts.agentSlug;
    } else {
      if (!defaultOrg) {
        console.error('Cannot tell which organization to use. Pass <org>/<agent-slug>, or log in again: npx @almyty/auth login');
        process.exit(EXIT.USAGE);
      }
      orgSlug = defaultOrg;
      agentSlug = parts.agentSlug;
    }
  } else if (headless) {
    // There is nobody to answer a picker on a pipe.
    console.error('No agent given. Pass <org>/<agent-slug>, or set ALMYTY_AGENT.');
    process.exit(EXIT.USAGE);
  } else {
    if (!defaultOrg) {
      console.error('Usage: almyty chat <org>/<agent-slug>');
      process.exit(EXIT.USAGE);
    }
    orgSlug = defaultOrg;

    let agents: AgentInfo[];
    try {
      agents = await client.listAgents();
    } catch (err) {
      console.error(explainError(err, { apiUrl: creds.url, appUrl }));
      process.exit(exitCodeForError(err));
    }
    if (!agents.length) {
      console.error(`No agents in this organization yet. Create one at ${appUrl}/agents`);
      process.exit(EXIT.NOT_FOUND);
    }
    if (agents.length === 1) {
      agentSlug = agents[0].slug || agents[0].name.toLowerCase().replace(/\s+/g, '-');
    } else {
      const picked = await new Promise<AgentInfo | null>((resolve) => {
        const { unmount } = render(
          <Box flexDirection="column">
            <Box paddingTop={1} paddingLeft={2}>
              <Text color="#22d3ee">⚡</Text>
              <Text color="#8b5cf6" bold> almyty chat</Text>
            </Box>
            <AgentSelector agents={agents} onSelect={(a) => { unmount(); resolve(a); }} />
          </Box>,
          { exitOnCtrlC: true },
        );
      });
      if (!picked) process.exit(0);
      agentSlug = picked.slug || picked.name.toLowerCase().replace(/\s+/g, '-');
    }
  }

  const gw = client.gateway(orgSlug, agentSlug);
  const errorContext: ErrorContext = { agentRef: `${orgSlug}/${agentSlug}`, apiUrl: creds.url, appUrl };

  let agent: AgentInfo;
  try {
    agent = await gw.getInfo();
  } catch (err) {
    // "Agent not found" used to be printed for a bad login, a wrong
    // org, a draft agent and an unreachable API alike.
    console.error(explainError(err, { ...errorContext, what: 'info' }));
    process.exit(exitCodeForError(err));
  }

  if (headless) {
    const message = args.message ?? (await readStdin(process.stdin as unknown as AsyncIterable<Buffer>));
    if (!message) {
      console.error('Nothing to ask. Pass --message "<question>", or pipe it in.');
      process.exit(EXIT.USAGE);
    }

    // Ctrl-C on a pipe cancels the run rather than orphaning it.
    const ac = new AbortController();
    const onSigint = () => ac.abort();
    process.on('SIGINT', onSigint);

    const code = await runHeadless({
      message,
      agent,
      target: gw,
      json: args.json,
      stream: args.stream && !args.json,
      conversationId: args.resume,
      limits: limitsFrom(args),
      signal: ac.signal,
      errorContext,
      io: {
        out: (text) => process.stdout.write(text),
        err: (text) => process.stderr.write(text),
      },
    });
    process.off('SIGINT', onSigint);
    process.exit(code);
  }

  // Colour is decided once, here, so NO_COLOR reaches ink's own
  // detection rather than being re-derived per component.
  if (!useColor(args, process.env, process.stdout.isTTY === true)) {
    process.env.FORCE_COLOR = '0';
  }

  const { waitUntilExit } = render(
    <ChatApp
      client={client}
      initialAgent={agent}
      gw={gw}
      resumeConversationId={args.resume}
      errorContext={errorContext}
    />,
    // Ctrl-C is handled inside the app: the first press cancels the
    // run server-side, and only then does a second one exit.
    { exitOnCtrlC: false },
  );

  await waitUntilExit();

  if (exitMessage) {
    process.stdout.write(exitMessage);
  }
}

main().catch(err => {
  console.error(explainError(err));
  process.exit(exitCodeForError(err));
});
