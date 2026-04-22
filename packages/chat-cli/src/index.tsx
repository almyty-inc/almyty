#!/usr/bin/env node

import React from 'react';
import { render, Box, Text } from 'ink';
import { AlmytyClient, resolveCredentialsOrExit, getOrgSlugFromToken } from '@almyty/client';
import type { AgentInfo } from '@almyty/client';

import { AgentSelector } from './components.js';
import { ChatApp, exitMessage } from './app.js';

export const VERSION = '0.1.5';

// ── Entry point ─────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(VERSION);
    return;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`almyty chat v${VERSION}\n\nUsage:\n  npx @almyty/chat <org>/<agent-slug>\n  npx @almyty/chat <org>/<agent-slug> --resume <conversation-id>\n\nExamples:\n  npx @almyty/chat acme/support-bot\n  npx @almyty/chat myorg/my-agent --resume 60d93c85-...\n\nCommands:\n  /help /agents /clear /quit\n\nAuth:\n  npx @almyty/auth login`);
    return;
  }

  const creds = resolveCredentialsOrExit();
  const client = new AlmytyClient(creds.url, creds.token);

  let resumeId: string | undefined;
  const ri = Math.max(argv.indexOf('--resume'), argv.indexOf('-resume'));
  if (ri !== -1) {
    resumeId = argv[ri + 1];
    if (!resumeId || resumeId.startsWith('-')) {
      console.error('--resume requires a conversation id');
      process.exit(1);
    }
  }

  const ref = argv.find(arg => !arg.startsWith('-') && arg !== resumeId);

  // Resolve org slug — from ref (org/slug) or JWT token
  const defaultOrg = getOrgSlugFromToken(creds.token);

  let orgSlug: string;
  let agentSlug: string;

  if (ref && ref.includes('/')) {
    [orgSlug, agentSlug] = ref.split('/', 2);
  } else if (ref) {
    // Bare slug — use org from JWT
    if (!defaultOrg) {
      console.error('Cannot determine org. Use org/agent-slug format or log in: npx @almyty/auth login');
      process.exit(1);
    }
    orgSlug = defaultOrg;
    agentSlug = ref;
  } else {
    // No arg — interactive picker
    if (!defaultOrg) {
      console.error('Usage: npx @almyty/chat <org>/<agent-slug>');
      process.exit(1);
    }
    orgSlug = defaultOrg;

    const agents = await client.listAgents();
    if (!agents.length) {
      console.error('No agents found. Create one at https://app.almyty.com/agents');
      process.exit(1);
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

  let agent: AgentInfo;
  try {
    agent = await gw.getInfo();
  } catch {
    console.error(`Agent not found: ${orgSlug}/${agentSlug}`);
    process.exit(1);
  }

  const { waitUntilExit } = render(
    <ChatApp client={client} initialAgent={agent} gw={gw} />,
    { exitOnCtrlC: true },
  );

  await waitUntilExit();

  if (exitMessage) {
    process.stdout.write(exitMessage);
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
