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

Usage:
  almyty-acp <agent>
  almyty-acp my-agent
  almyty-acp acme/my-agent

Authentication:
  npx @almyty/auth login

Environment:
  ALMYTY_URL    Backend URL (default: https://api.almyty.com)
  ALMYTY_TOKEN  API key (or auto-read from ~/.almyty/credentials.json)

Docs: https://docs.almyty.com/cli/acp-server
`;
  // Write help to stdout (not stderr) so piping works
  process.stdout.write(text.trimStart());
  process.exit(args.length === 0 ? 1 : 0);
}

// Filter out any flags, take the first positional arg as the agent identifier
const agentArg = args.find((a) => !a.startsWith('-'));

if (!agentArg) {
  process.stderr.write('Error: Agent name or slug is required.\nUsage: almyty-acp <agent>\n');
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

  // Resolve agent. Accepts:
  //   my-agent              slug
  //   acme/my-agent         org/slug
  //   My Agent              display name
  //   550e8400-...          UUID
  let agentId: string | undefined;
  const ref = agentArg!;
  const hasSlash = ref.includes('/');
  const orgPrefix = hasSlash ? ref.split('/')[0] : undefined;
  const agentRef = hasSlash ? ref.split('/').slice(1).join('/') : ref;

  // 1. Try UUID direct lookup
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentRef);
  if (isUUID) {
    try {
      const agent = await proxy.getAgent(agentRef);
      agentId = agent.id;
      process.stderr.write(`[acp] ${agent.name} (${agent.mode})\n`);
    } catch {
      process.stderr.write(`Error: Agent not found: ${agentRef}\n`);
      process.exit(1);
    }
  }

  // 2. List agents and match by slug, name, or slug-ified name
  if (!agentId) {
    try {
      const agents = await proxy.listAgents();
      const slugify = (s: string) => s.toLowerCase().replace(/\s+/g, '-');
      const needle = slugify(agentRef);
      const match = agents.find((a) => {
        const aSlug = a.slug || slugify(a.name);
        return aSlug === needle || a.name === agentRef || slugify(a.name) === needle || a.id === agentRef;
      });
      if (match) {
        agentId = match.id;
        process.stderr.write(`[acp] ${match.name} (${match.mode})\n`);
      } else {
        const available = agents.map((a) => a.slug || a.name.toLowerCase().replace(/\s+/g, '-')).join(', ');
        process.stderr.write(`Error: Agent "${ref}" not found.\nAvailable: ${available || '(none)'}\n`);
        process.exit(1);
      }
    } catch (err) {
      process.stderr.write(`Error: Could not resolve agent "${ref}": ${err}\n`);
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
