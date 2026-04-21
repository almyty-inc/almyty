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

async function resolveAgent(ref: string, send: (msg: any) => void): Promise<AlmytyAcpAgent> {
  const creds = resolveCredentials();
  if (!creds) throw new Error('No auth token. Run: npx @almyty/auth login');

  const proxy = new AlmytyProxy(creds.url, creds.token);
  const agentRef = ref.includes('/') ? ref.split('/').slice(1).join('/') : ref;

  // UUID
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentRef)) {
    const a = await proxy.getAgent(agentRef);
    process.stderr.write(`[acp] ${a.name} (${a.mode})\n`);
    return new AlmytyAcpAgent(proxy, a.id, send);
  }

  // Name/slug lookup
  const agents = await proxy.listAgents();
  const slugify = (s: string) => s.toLowerCase().replace(/\s+/g, '-');
  const needle = slugify(agentRef);
  const match = agents.find((a) => {
    const aSlug = a.slug || slugify(a.name);
    return aSlug === needle || a.name === agentRef || slugify(a.name) === needle;
  });
  if (match) {
    process.stderr.write(`[acp] ${match.name} (${match.mode})\n`);
    return new AlmytyAcpAgent(proxy, match.id, send);
  }

  const available = agents.map((a) => a.slug || slugify(a.name)).join(', ');
  throw new Error(`Agent "${ref}" not found. Available: ${available || '(none)'}`);
}

async function main(): Promise<void> {
  // Send function: write ndjson to stdout
  const send = (msg: JsonRpcResponse | JsonRpcNotification): void => {
    try {
      process.stdout.write(JSON.stringify(msg) + '\n');
    } catch (err) {
      process.stderr.write(`[acp] Failed to serialize: ${err}\n`);
    }
  };

  // Start listening on stdin IMMEDIATELY — Zed expects the process
  // to be ready for JSON-RPC as soon as it spawns. Agent resolution
  // and auth happen lazily on first `initialize` message.
  let agent: AlmytyAcpAgent | null = null;

  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on('line', async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }

    if (!msg.jsonrpc || msg.jsonrpc !== '2.0' || !msg.method) {
      if (msg.id !== undefined) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'Invalid request' } });
      }
      return;
    }

    // Lazy init: resolve credentials + agent on first message
    if (!agent) {
      try {
        agent = await resolveAgent(agentArg!, send);
      } catch (err: any) {
        send({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: err.message } });
        return;
      }
    }

    try {
      await agent.handleMessage(msg);
    } catch (err) {
      process.stderr.write(`[acp] Error: ${err}\n`);
      if (msg.id !== undefined && msg.id !== null) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Internal error' } });
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
