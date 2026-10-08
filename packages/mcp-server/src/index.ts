#!/usr/bin/env node

/**
 * @almyty/mcp-server — skill-first API proxy for any MCP client
 *
 * Instead of putting N tool schemas in context (N * ~200 tokens each), this
 * registers:
 *   1. skills (compact markdown prompts) loaded on demand,
 *   2. one universal executor, `almyty_execute`,
 *   3. one search tool, `almyty_search`.
 *
 * The model reads a skill to learn a workflow, then calls almyty_execute with
 * a tool name and parameters.
 *
 * Rules this file lives by:
 *
 * **stdout is the protocol.** Every diagnostic goes to stderr; one stray
 * console.log on stdout corrupts the JSON-RPC stream and the host editor
 * loses the server with no useful error.
 *
 * **The handshake never waits for the backend.** Discovery runs in the
 * background, so a backend that is down or a stale token cannot kill the
 * process during the handshake; a discovery failure is reported on the tool
 * call that needed it.
 *
 * **Both protocol eras, from one factory.** `serveStdio` (MCP SDK 2.x) lets
 * the client's first message decide: an `initialize` (MCP 2024-11-05 ..
 * 2025-11-25, what Claude Desktop, Cursor and most editors send today) pins
 * the connection to the earlier protocol; a request carrying `_meta` pins it
 * to MCP 2026-07-28. `buildServer` registers the same tools either way.
 *
 * **No notifications before the client is ready (#875).** What discovery
 * found is registered late, and every late registration makes the SDK send
 * a list_changed notification. On the earlier protocol that is held until
 * the client has sent `notifications/initialized`, as the MCP lifecycle
 * requires. On 2026-07-28 there is no handshake and the SDK sends
 * notifications only on a `subscriptions/listen` stream the client opened.
 */

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { resolveCredentials } from './auth.js';
import { AlmytyProxy, upstreamEraFromEnv } from './proxy.js';
import { ToolCatalog, searchResultText, uniquePromptNames, upstreamErrorText } from './catalog.js';
import { EXIT, EXIT_CODE_HELP, exitCodeFor } from './exit-codes.js';
import { gatewayToolConfig, passThroughResult } from './registration.js';
import { VERSION } from './version.js';


// Accept gateway as positional arg or env var:
//   npx @almyty/mcp-server acme/petstore
//   ALMYTY_GATEWAY_ID=acme/petstore npx @almyty/mcp-server
const ALMYTY_GATEWAY_ID = process.argv[2] || process.env.ALMYTY_GATEWAY_ID;
const ALMYTY_MODE = (process.env.ALMYTY_MODE || 'skill-first') as 'skill-first' | 'full';

/** Never stdout: that is the protocol stream. */
function log(message: string): void {
  process.stderr.write(`almyty: ${message}\n`);
}

/** A tool result the model can act on, rather than a raw upstream body. */
function errorResult(err: unknown) {
  return {
    content: [{ type: 'text' as const, text: upstreamErrorText(err) }],
    isError: true as const,
  };
}

function textResult(result: unknown) {
  return {
    content: [{
      type: 'text' as const,
      text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
    }],
  };
}

interface ServerDeps {
  proxy: AlmytyProxy;
  catalog: ToolCatalog;
  /** Settles once the first discovery has run (it never rejects). */
  discovered: Promise<void>;
  url: string;
}

/** ALMYTY_DISCOVERY_WAIT_MS: how long the first client message waits for discovery (0 to 60000, default 5000). */
function discoveryWaitMs(value: string | undefined = process.env.ALMYTY_DISCOVERY_WAIT_MS): number {
  const n = value === undefined || value.trim() === '' ? NaN : Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 60_000 ? n : 5_000;
}

/** The management tools: control almyty itself. Registered in both modes; none needs discovery. */
function managementTools(proxy: AlmytyProxy): Array<{ name: string; description: string; input: z.ZodObject<any>; run: (args: any) => Promise<unknown> }> {
  return [
    {
      name: 'almyty_list_apis',
      description: 'List all connected APIs in your organization.',
      input: z.object({}),
      run: () => proxy.listApis(),
    },
    {
      name: 'almyty_create_api',
      description: 'Connect a new API. Provide a name, type (openapi/graphql/soap/protobuf/sdk), and base URL.',
      input: z.object({
        name: z.string().describe('Human-readable API name'),
        type: z.enum(['openapi', 'graphql', 'soap', 'protobuf', 'sdk']).describe('Schema type'),
        baseUrl: z.string().optional().describe('API base URL (not needed for SDK type)'),
      }),
      run: (args) => proxy.createApi(args),
    },
    {
      name: 'almyty_import_schema',
      description: 'Import an API schema and auto-generate tools. Provide the API ID and a schema URL.',
      input: z.object({
        apiId: z.string().describe('ID of the API to import into'),
        schemaUrl: z.string().describe('URL of the schema (e.g. an OpenAPI JSON endpoint)'),
        generateTools: z.boolean().default(true).describe('Auto-generate tools from operations'),
      }),
      run: (args) => proxy.importSchema(args.apiId, { schemaUrl: args.schemaUrl, generateTools: args.generateTools }),
    },
    {
      name: 'almyty_list_gateways',
      description: 'List the gateways in your organization: MCP, UTCP and Skills gateways serving tools. An agent\'s channels (web chat, messaging, A2A) are not gateways.',
      input: z.object({}),
      run: () => proxy.listGateways(),
    },
    {
      name: 'almyty_create_gateway',
      description: 'Share tools over one protocol: MCP, UTCP or Skills (one gateway each). An agent is put in front of people or other agents (web, chat apps, A2A) through an app, not here.',
      input: z.object({
        name: z.string().describe('Gateway name'),
        type: z.enum(['mcp', 'utcp', 'skills']).default('mcp').describe('The one protocol this gateway serves'),
        endpoint: z.string().describe('URL slug for the gateway endpoint'),
      }),
      run: (args) =>
        proxy.createGateway({
          ...args,
          kind: 'tool',
          configuration: args.type === 'mcp' ? { transport: 'http' } : args.type === 'utcp' ? { protocol: 'http' } : {},
        }),
    },
    {
      name: 'almyty_assign_tool',
      description: 'Assign a tool to a tool-kind gateway.',
      input: z.object({
        gatewayId: z.string().describe('Gateway ID'),
        toolId: z.string().describe('Tool ID to assign'),
      }),
      run: (args) => proxy.assignToolToGateway(args.gatewayId, args.toolId),
    },
    {
      name: 'almyty_list_agents',
      description: 'List all agents in your organization.',
      input: z.object({}),
      run: () => proxy.listAgents(),
    },
    {
      name: 'almyty_create_agent',
      description: 'Create an agent. Workflow agents run a visual DAG pipeline; autonomous agents run from instructions plus tool access.',
      input: z.object({
        name: z.string().describe('Agent name'),
        description: z.string().optional().describe('What the agent does'),
        mode: z.enum(['workflow', 'autonomous']).default('autonomous').describe('workflow = visual pipeline, autonomous = instruction-driven'),
        instructions: z.string().optional().describe('Instructions for autonomous agents'),
      }),
      run: (args) => proxy.createAgent(args),
    },
    {
      name: 'almyty_invoke_agent',
      description: 'Invoke an agent with input. Returns the agent execution result.',
      input: z.object({
        agentId: z.string().describe('Agent ID'),
        input: z.record(z.string(), z.unknown()).describe('Input data for the agent'),
      }),
      run: (args) => proxy.invokeAgent(args.agentId, args.input),
    },
    {
      name: 'almyty_list_providers',
      description: 'List the LLM providers configured in your organization, with the credential backing each one.',
      input: z.object({}),
      run: () => proxy.listProviders(),
    },
    {
      name: 'almyty_add_provider',
      description:
        'Add an LLM provider backed by an existing credential. Add the vendor key first with `npx @almyty/credentials add <vendor>` and pass the credential id here. ' +
        'This tool deliberately does not take an API key: a key passed as a tool argument would be written into this conversation\'s transcript and the host editor\'s logs.',
      input: z.object({
        name: z.string().describe('Display name for the provider'),
        type: z.string().describe('Provider type (openai, anthropic, gemini, azure, bedrock, ...)'),
        credentialId: z.string().describe('Id of an existing credential, from `npx @almyty/credentials list`'),
      }),
      run: (args) => proxy.addProvider({ name: args.name, type: args.type, credentialId: args.credentialId, configuration: {} }),
    },
  ];
}

/**
 * One MCP server instance, for one connection in one era. Everything that
 * does not depend on discovery is registered here, before the instance is
 * handed to the SDK; what discovery found is registered once the client is
 * ready (see the file comment).
 */
function buildServer(era: 'legacy' | 'modern', deps: ServerDeps, discoveredAlready: boolean): McpServer {
  const { proxy, catalog, discovered, url } = deps;
  const server = new McpServer({ name: 'almyty', version: VERSION });

  // ── Gateway tools ────────────────────────────────────────────────

  if (ALMYTY_MODE === 'skill-first') {
    // Two tools instead of N: ~300 tokens of context rather than N * ~200.
    // Neither depends on discovery having finished, which is what lets the
    // handshake complete before the first network call.

    server.registerTool(
      'almyty_execute',
      {
        description: 'Execute any almyty API tool by name. Read the relevant skill prompt first to understand which tool to use and what parameters are needed, or call almyty_search to find one.',
        inputSchema: z.object({
          tool_name: z.string().describe('Name of the almyty tool to execute (from skill instructions or almyty_search)'),
          parameters: z.record(z.string(), z.unknown()).describe('Parameters for the tool (see the skill for required params)'),
        }),
      },
      async (args) => {
        try {
          return textResult(await proxy.callTool(args.tool_name, args.parameters as Record<string, unknown>));
        } catch (error) {
          return errorResult(error);
        }
      },
    );

    server.registerTool(
      'almyty_search',
      {
        description: 'Search the available API tools by keyword. Returns matching tool names and descriptions. Use this to discover which tools exist before calling almyty_execute.',
        inputSchema: z.object({
          query: z.string().describe('Search query (e.g. "create pet", "list users", "payment"). Empty lists everything.'),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async (args) => {
        // The gateway's tool list changes while the editor is open, so the
        // index is re-asked when it has gone stale instead of being a
        // snapshot from whenever the editor last started.
        await catalog.ensureFresh();
        if (!catalog.discovered && catalog.lastError) {
          return errorResult(new Error(catalog.lastError));
        }
        return textResult(searchResultText(args.query, catalog.search(args.query), catalog.tools));
      },
    );
  }

  // ── Management tools — control almyty itself ─────────────────────
  // Registered in both modes: create APIs, import schemas, wire gateways,
  // build and invoke agents. None of them needs discovery either.

  const management = managementTools(proxy);
  for (const tool of management) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input }, async (args: any) => {
      try {
        return textResult(await tool.run(args));
      } catch (error) {
        return errorResult(error);
      }
    });
  }

  // Server info, answered from whatever discovery has managed so far.
  server.registerResource(
    'almyty-info',
    'almyty://info',
    { description: 'This server: the almyty backend, gateway, mode and what discovery found', mimeType: 'application/json' },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify({
          server: url,
          version: VERSION,
          gatewayId: ALMYTY_GATEWAY_ID || 'all',
          mode: ALMYTY_MODE,
          protocol: { client: era, upstream: proxy.upstreamEra },
          discovered: catalog.discovered,
          tools: catalog.tools.length,
          skills: catalog.skills.length,
          discoveryError: catalog.lastError,
        }, null, 2),
      }],
    }),
  );

  // A compact index of everything available, as one prompt. Registered
  // with the instance: its description gets the tool count once discovery
  // has run.
  let promptNames: string[] = [];
  const overview = server.registerPrompt(
    'almyty-overview',
    { description: 'Overview: the API tools available via almyty' },
    async () => {
      await catalog.ensureFresh();
      const lines = [
        '# almyty API tools',
        '',
        `Connected to: ${url}`,
        ALMYTY_GATEWAY_ID ? `Gateway: ${ALMYTY_GATEWAY_ID}` : 'Gateway: all',
        '',
      ];
      if (catalog.lastError && !catalog.discovered) {
        lines.push(`Discovery failed: ${upstreamErrorText(new Error(catalog.lastError))}`, '');
      }
      lines.push(`## ${catalog.tools.length} tools available`, '',
        ...catalog.tools.map((t) => `- \`${t.name}\`: ${t.description || 'No description'}`), '');
      if (catalog.skills.length > 0) {
        lines.push(`## ${catalog.skills.length} skills (detailed usage guides)`, '',
          ...catalog.skills.map((s, i) => `- \`${promptNames[i]}\`: ${s.toolCount} tools`), '');
      }
      lines.push(
        '## How to use',
        '',
        '1. Load a skill prompt to understand the workflow',
        '2. Call `almyty_execute` with `tool_name` and `parameters`',
        '3. Or use `almyty_search` to find the right tool first',
        '',
      );
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: lines.filter(Boolean).join('\n') } }] };
    },
  );

  // ── What discovery found ─────────────────────────────────────────
  const registerDiscovered = () => {
    promptNames = uniquePromptNames(catalog.skills.map((s) => s.name));
    overview.update({ description: `Overview: ${catalog.tools.length} API tools available via almyty` });
    catalog.skills.forEach((skill, i) => {
      server.registerPrompt(
        promptNames[i],
        { description: `How to use: ${skill.name} (${skill.toolCount} tools)` },
        async () => ({
          messages: [{ role: 'user' as const, content: { type: 'text' as const, text: skill.content } }],
        }),
      );
    });

    if (ALMYTY_MODE === 'full') {
      // Every gateway tool individually, as the gateway describes it:
      // its JSON Schema, title, output schema and annotations.
      for (const tool of catalog.tools) {
        let config;
        try {
          config = gatewayToolConfig(tool as any);
        } catch (error) {
          log(`skipping gateway tool ${tool.name}: its schema is not valid JSON Schema (${(error as Error).message})`);
          continue;
        }
        server.registerTool(tool.name, config as any, async (args: Record<string, unknown>) => {
          try {
            return passThroughResult(await proxy.callToolResult(tool.name, args));
          } catch (error) {
            return errorResult(error);
          }
        });
      }
    }
  };

  // Discovery that finished before the client's first message (the factory
  // waits for it a little, see main): register it now, before the instance
  // is connected. Nothing is announced, and the client's first tools/list
  // already has the gateway tools, which matters to clients that list once
  // and never again (Claude Code's `-p` mode, for one).
  if (discoveredAlready) {
    registerDiscovered();
    return server;
  }

  // Otherwise once discovery has run and the client is ready. On the
  // earlier protocol the client is ready once it has sent
  // `notifications/initialized`: the lifecycle forbids notifications before
  // that, and a discovery that failed fast used to announce its prompts
  // before the client had even sent `initialize` (#875). On 2026-07-28 there
  // is no handshake; the SDK announces late registrations only on a
  // `subscriptions/listen` stream. Every late registration makes the SDK
  // announce the change, so the client re-reads its lists.
  const clientReady = era === 'legacy'
    ? new Promise<void>((resolve) => {
        const lowLevel = server.server;
        const previous = lowLevel.oninitialized;
        lowLevel.oninitialized = () => {
          previous?.();
          resolve();
        };
      })
    : Promise.resolve();

  void Promise.all([discovered, clientReady])
    .then(registerDiscovered)
    .catch((error) => log(`could not register what discovery found: ${upstreamErrorText(error)}`));

  return server;
}

async function main() {
  // Resolve token: env var > ~/.almyty/credentials.json
  const creds = resolveCredentials();
  if (!creds) {
    log(
      'no authentication token found.\n' +
      '  Set ALMYTY_TOKEN, or run: npx @almyty/auth login',
    );
    process.exit(EXIT.AUTH);
  }

  const ALMYTY_URL = creds.url;
  const proxy = new AlmytyProxy(ALMYTY_URL, creds.token, ALMYTY_GATEWAY_ID, {
    era: upstreamEraFromEnv(),
    clientVersion: VERSION,
  });
  const catalog = new ToolCatalog(proxy, { warn: (m) => log(m) });

  // Discovery starts at once, alongside the transport. It never throws; the
  // instance a client connects to registers what it found when both are
  // ready.
  const discovered = catalog.refresh().then(() => {
    if (catalog.lastError) {
      log(`gateway discovery failed: ${catalog.lastError}`);
      log('the management tools still work; almyty_execute will report this until discovery succeeds');
    } else {
      log(`${catalog.tools.length} gateway tools, ${catalog.skills.length} skills (upstream: MCP ${proxy.upstreamEra === 'modern' ? '2026-07-28' : '2025'})`);
    }
  });

  // The client's first message calls the factory. Discovery has usually
  // finished by then; if not, it is waited for up to ALMYTY_DISCOVERY_WAIT_MS
  // so the first tools/list is complete, and past that the handshake goes
  // ahead without it (a backend that does not answer must not hold the
  // client) and what discovery finds is registered late.
  const waitMs = discoveryWaitMs();
  let settled = false;
  void discovered.then(() => { settled = true; });
  serveStdio(async (ctx) => {
    if (!settled && waitMs > 0) {
      await Promise.race([discovered, new Promise<void>((resolve) => setTimeout(resolve, waitMs).unref())]);
    }
    return buildServer(ctx.era, { proxy, catalog, discovered, url: ALMYTY_URL }, settled);
  }, {
    onerror: (error) => log(`protocol error: ${error.message}`),
  });
  log(`ready on stdio (mode: ${ALMYTY_MODE}, ${managementTools(proxy).length} management tools)`);
}

function printHelp(): void {
  console.log(`
@almyty/mcp-server v${VERSION} — skill-first API proxy for any MCP client

Turn any API into AI skills. Instead of putting tool schemas in context
(expensive), this serves compact skills that teach the model workflows, plus a
single universal executor.

  Traditional MCP:  20 tools = ~4,000 tokens/turn (always in context)
  Skill-first:      2 tools  = ~300 tokens/turn (skills loaded on demand)

Usage:
  npx @almyty/mcp-server <org/gateway>   Serve one gateway
  npx @almyty/mcp-server                 Serve every gateway the token can see
  npx @almyty/mcp-server --help          This help
  npx @almyty/mcp-server --version       Print the version

The server speaks MCP over stdio: stdout carries the protocol and every
diagnostic goes to stderr. It is meant to be launched by an MCP client, not
run by hand. It speaks MCP 2026-07-28 and the earlier versions (2024-11-05 to
2025-11-25) alike: the client's first message decides.

Modes (ALMYTY_MODE):
  skill-first  (default) almyty_execute + almyty_search, and skills as prompts.
               Minimal context. The tool index is re-read when it goes stale,
               so a tool added in almyty is found without a restart.
  full         Every gateway tool registered individually. Traditional MCP,
               higher context cost. The list is read once at startup and the
               client is notified when it arrives.

Management tools (both modes), for building on almyty from your assistant:
  almyty_list_apis        almyty_create_api       almyty_import_schema
  almyty_list_gateways    almyty_create_gateway   almyty_assign_tool
  almyty_list_agents      almyty_create_agent     almyty_invoke_agent
  almyty_list_providers   almyty_add_provider

  almyty_add_provider takes a credential id, never an API key: a key passed as
  a tool argument would land in the assistant's transcript and the editor's
  logs. Add the credential first with \`npx @almyty/credentials add <vendor>\`.

Authentication:
  npx @almyty/auth login              Browser-based login (one-time setup)

Environment:
  ALMYTY_URL         Base URL (default: https://api.almyty.com)
  ALMYTY_TOKEN       Token (otherwise read from ~/.almyty/credentials.json)
  ALMYTY_GATEWAY_ID  Gateway as "orgSlug/gatewaySlug" (alternative to the positional arg)
  ALMYTY_MODE        "skill-first" (default) | "full"
  ALMYTY_MCP_PROTOCOL  How this server talks to almyty: "auto" (default: MCP
                     2026-07-28, falling back to the earlier protocol for an
                     older almyty), "modern" or "legacy"
  ALMYTY_DISCOVERY_WAIT_MS  How long the client's first message waits for the
                     gateway's tool list, so it is complete from the start
                     (default 5000; 0 = never wait, announce the tools later)

Configuration:
  Claude Code:  claude mcp add petstore -- npx -y @almyty/mcp-server acme/petstore
  Cursor:       .cursor/mcp.json -> { "mcpServers": { "petstore": { "command": "npx", "args": ["-y", "@almyty/mcp-server", "acme/petstore"] } } }
  Copilot:      .vscode/mcp.json -> { "servers": { "almyty": { "command": "npx", "args": ["-y", "@almyty/mcp-server"] } } }
  Gemini:       ~/.gemini/settings.json -> { "mcpServers": { "almyty": { ... } } }

Exit codes (the same in every almyty CLI):
${EXIT_CODE_HELP}
`);
}

// Handle subcommands before main() reads argv[2] as a gateway id.
const subcommand = process.argv[2];

if (subcommand === 'login' || subcommand === 'logout' || subcommand === 'whoami') {
  // Auth lives in @almyty/auth. Redirect rather than silently doing nothing.
  console.error('Authentication moved to @almyty/auth.');
  console.error(`  npx @almyty/auth ${subcommand}`);
  process.exit(EXIT.USAGE);
} else if (subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
  printHelp();
} else if (subcommand === '--version' || subcommand === '-v') {
  console.log(VERSION);
} else {
  main().catch((err) => {
    log(`fatal: ${upstreamErrorText(err)}`);
    // A token the API rejected leaves with the same code as no token at
    // all, so a supervisor can tell "log in again" from "restart me".
    process.exit(exitCodeFor(err));
  });
}
