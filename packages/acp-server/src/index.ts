#!/usr/bin/env node

/**
 * @almyty/acp-server — ACP agent server for almyty.
 *
 * Exposes any almyty agent via the Agent Client Protocol (ACP) over
 * ndjson stdio. Compatible with Zed, JetBrains AI, and other ACP clients.
 *
 * Usage:
 *   npx @almyty/acp-server <agent>          Start ACP server for a specific agent
 *   npx @almyty/acp-server my-agent         Agent by name or ID
 *
 * Environment:
 *   ALMYTY_URL     Base URL of the almyty backend (default: https://api.almyty.com)
 *   ALMYTY_TOKEN   API key (auto-read from ~/.almyty/credentials.json)
 */

import * as readline from 'node:readline';
import { resolveCredentials } from './auth.js';
import { AlmytyProxy } from './proxy.js';
import { AlmytyAcpAgent, type JsonRpcRequest, type JsonRpcResponse, type JsonRpcNotification } from './agent.js';

// ── Argument parsing ─────────────────────────────────────────────

const args = process.argv.slice(2);
const HELP_FLAGS = ['--help', '-h'];

if (args.some((a) => HELP_FLAGS.includes(a)) || args.length === 0) {
  const text = `
@almyty/acp-server — Expose any almyty agent via the Agent Client Protocol

Connects an almyty agent to ACP-compatible clients (Zed, JetBrains AI,
Toad, and others) over ndjson stdio. The server proxies all requests to
the almyty backend REST API.

Usage:
  npx @almyty/acp-server <agent>
  npx @almyty/acp-server my-agent
  npx @almyty/acp-server 550e8400-e29b-41d4-a716-446655440000

Authentication:
  npx @almyty/auth login              Browser-based login (one-time setup)

Environment:
  ALMYTY_URL         Base URL (default: https://api.almyty.com)
  ALMYTY_TOKEN       API key (auto-read from ~/.almyty/credentials.json)

Client configuration:

  Zed (settings.json):
    {
      "agent": {
        "profiles": {
          "almyty": {
            "provider": "agent-client-protocol",
            "binary": {
              "name": "npx",
              "args": ["-y", "@almyty/acp-server", "my-agent"]
            }
          }
        }
      }
    }

  JetBrains (AI Assistant settings):
    Binary path:  npx
    Arguments:    -y @almyty/acp-server my-agent

  Custom / stdio:
    echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' | npx @almyty/acp-server my-agent
`;
  // Write help to stdout (not stderr) so piping works
  process.stdout.write(text.trimStart());
  process.exit(args.length === 0 ? 1 : 0);
}

// Filter out any flags, take the first positional arg as the agent identifier
const agentArg = args.find((a) => !a.startsWith('-'));

if (!agentArg) {
  process.stderr.write('Error: Agent name or ID is required.\nUsage: npx @almyty/acp-server <agent>\n');
  process.exit(1);
}

// ── Main ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Resolve credentials
  const creds = resolveCredentials();
  if (!creds) {
    process.stderr.write(
      'Error: No authentication token found.\n' +
      'Set ALMYTY_TOKEN environment variable or run: npx @almyty/auth login\n',
    );
    process.exit(1);
  }

  const proxy = new AlmytyProxy(creds.url, creds.token);

  // Resolve agent: try as ID first, then search by name/slug
  let agentId = agentArg!;
  try {
    const agent = await proxy.getAgent(agentId);
    agentId = agent.id;
    process.stderr.write(`[acp] Agent resolved: ${agent.name} (${agent.id}, mode: ${agent.mode})\n`);
  } catch {
    // If direct lookup fails, try listing agents and matching by name/slug
    try {
      const agents = await proxy.listAgents();
      const match = agents.find(
        (a) =>
          a.name === agentArg ||
          a.slug === agentArg ||
          a.name.toLowerCase() === agentArg!.toLowerCase() ||
          a.slug?.toLowerCase() === agentArg!.toLowerCase(),
      );
      if (match) {
        agentId = match.id;
        process.stderr.write(`[acp] Agent resolved by name: ${match.name} (${match.id}, mode: ${match.mode})\n`);
      } else {
        process.stderr.write(
          `Error: Agent "${agentArg}" not found.\n` +
          `Available agents: ${agents.map((a) => a.name).join(', ') || '(none)'}\n`,
        );
        process.exit(1);
      }
    } catch (listErr) {
      process.stderr.write(`Error: Could not resolve agent "${agentArg}": ${listErr}\n`);
      process.exit(1);
    }
  }

  // Create the send function: write ndjson to stdout
  const send = (msg: JsonRpcResponse | JsonRpcNotification): void => {
    try {
      const line = JSON.stringify(msg);
      process.stdout.write(line + '\n');
    } catch (err) {
      process.stderr.write(`[acp] Failed to serialize message: ${err}\n`);
    }
  };

  // Create the ACP agent handler
  const agent = new AlmytyAcpAgent(proxy, agentId, send);

  // Set up ndjson readline on stdin
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  process.stderr.write(`[acp] Server ready. Listening for JSON-RPC messages on stdin.\n`);

  rl.on('line', async (line: string) => {
    // Skip empty lines
    const trimmed = line.trim();
    if (!trimmed) return;

    // Parse JSON-RPC message
    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      // Malformed JSON — send parse error if it looks like it had an id
      send({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error: invalid JSON' },
      });
      return;
    }

    // Validate basic JSON-RPC structure
    if (!msg.jsonrpc || msg.jsonrpc !== '2.0' || !msg.method) {
      if (msg.id !== undefined) {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32600, message: 'Invalid JSON-RPC 2.0 request' },
        });
      }
      return;
    }

    // Dispatch to agent handler
    try {
      await agent.handleMessage(msg);
    } catch (err) {
      process.stderr.write(`[acp] Unhandled error in message handler: ${err}\n`);
      if (msg.id !== undefined && msg.id !== null) {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32603, message: 'Internal error' },
        });
      }
    }
  });

  // Handle stdin close (client disconnected)
  rl.on('close', () => {
    process.stderr.write('[acp] Client disconnected. Shutting down.\n');
    agent.shutdown();
    process.exit(0);
  });

  // Handle process signals
  const shutdown = (): void => {
    process.stderr.write('[acp] Shutting down.\n');
    agent.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Handle uncaught errors — never crash the stdio process
  process.on('uncaughtException', (err) => {
    process.stderr.write(`[acp] Uncaught exception: ${err}\n`);
  });

  process.on('unhandledRejection', (err) => {
    process.stderr.write(`[acp] Unhandled rejection: ${err}\n`);
  });
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
