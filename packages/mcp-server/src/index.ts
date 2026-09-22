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
 * Two rules this file lives by:
 *
 * **stdout is the protocol.** Every diagnostic goes to stderr; one stray
 * console.log on stdout corrupts the JSON-RPC stream and the host editor
 * loses the server with no useful error.
 *
 * **The transport connects before anything is fetched.** Discovery used to
 * run first, so a backend that was down or a stale token killed the process
 * during the handshake. Now the handshake always succeeds and a discovery
 * failure is reported on the tool call that needed it.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolveCredentials } from './auth.js';
import { AlmytyProxy } from './proxy.js';
import { ToolCatalog, searchResultText, uniquePromptNames, upstreamErrorText } from './catalog.js';
import { EXIT, EXIT_CODE_HELP, exitCodeFor } from './exit-codes.js';
import { buildZodShape } from './schema.js';
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
  const proxy = new AlmytyProxy(ALMYTY_URL, creds.token, ALMYTY_GATEWAY_ID);
  const catalog = new ToolCatalog(proxy, { warn: (m) => log(m) });

  const server = new McpServer({ name: 'almyty', version: VERSION });

  // ── Gateway tools ────────────────────────────────────────────────

  if (ALMYTY_MODE === 'skill-first') {
    // Two tools instead of N: ~300 tokens of context rather than N * ~200.
    // Neither depends on discovery having finished, which is what lets the
    // handshake complete before the first network call.

    server.tool(
      'almyty_execute',
      'Execute any almyty API tool by name. Read the relevant skill prompt first to understand which tool to use and what parameters are needed, or call almyty_search to find one.',
      {
        tool_name: z.string().describe('Name of the almyty tool to execute (from skill instructions or almyty_search)'),
        parameters: z.record(z.unknown()).describe('Parameters for the tool (see the skill for required params)'),
      },
      async (args) => {
        try {
          return textResult(await proxy.callTool(args.tool_name, args.parameters as Record<string, unknown>));
        } catch (error) {
          return errorResult(error);
        }
      },
    );

    server.tool(
      'almyty_search',
      'Search the available API tools by keyword. Returns matching tool names and descriptions. Use this to discover which tools exist before calling almyty_execute.',
      {
        query: z.string().describe('Search query (e.g. "create pet", "list users", "payment"). Empty lists everything.'),
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

  const management: Array<{ name: string; description: string; shape: Record<string, any>; run: (args: any) => Promise<unknown> }> = [
    {
      name: 'almyty_list_apis',
      description: 'List all connected APIs in your organization.',
      shape: {},
      run: () => proxy.listApis(),
    },
    {
      name: 'almyty_create_api',
      description: 'Connect a new API. Provide a name, type (openapi/graphql/soap/protobuf/sdk), and base URL.',
      shape: {
        name: z.string().describe('Human-readable API name'),
        type: z.enum(['openapi', 'graphql', 'soap', 'protobuf', 'sdk']).describe('Schema type'),
        baseUrl: z.string().optional().describe('API base URL (not needed for SDK type)'),
      },
      run: (args) => proxy.createApi(args),
    },
    {
      name: 'almyty_import_schema',
      description: 'Import an API schema and auto-generate tools. Provide the API ID and a schema URL.',
      shape: {
        apiId: z.string().describe('ID of the API to import into'),
        schemaUrl: z.string().describe('URL of the schema (e.g. an OpenAPI JSON endpoint)'),
        generateTools: z.boolean().default(true).describe('Auto-generate tools from operations'),
      },
      run: (args) => proxy.importSchema(args.apiId, { schemaUrl: args.schemaUrl, generateTools: args.generateTools }),
    },
    {
      name: 'almyty_list_gateways',
      description: 'List all gateways in your organization.',
      shape: {},
      run: () => proxy.listGateways(),
    },
    {
      name: 'almyty_create_gateway',
      description: 'Create a gateway that exposes tools OR an agent over a protocol (MCP, A2A, UTCP, Skills). Use kind="tool" for a tool gateway or kind="agent" for an agent gateway.',
      shape: {
        name: z.string().describe('Gateway name'),
        type: z.enum(['mcp', 'a2a', 'utcp', 'skills']).describe('Protocol type'),
        endpoint: z.string().describe('URL slug for the gateway endpoint'),
        kind: z.enum(['tool', 'agent']).default('tool').describe('What the gateway exposes: tools or a single agent'),
        agentId: z.string().optional().describe('Agent ID (required when kind is "agent")'),
      },
      run: (args) => proxy.createGateway({ ...args, configuration: {} }),
    },
    {
      name: 'almyty_assign_tool',
      description: 'Assign a tool to a tool-kind gateway.',
      shape: {
        gatewayId: z.string().describe('Gateway ID'),
        toolId: z.string().describe('Tool ID to assign'),
      },
      run: (args) => proxy.assignToolToGateway(args.gatewayId, args.toolId),
    },
    {
      name: 'almyty_list_agents',
      description: 'List all agents in your organization.',
      shape: {},
      run: () => proxy.listAgents(),
    },
    {
      name: 'almyty_create_agent',
      description: 'Create an agent. Workflow agents run a visual DAG pipeline; autonomous agents run from instructions plus tool access.',
      shape: {
        name: z.string().describe('Agent name'),
        description: z.string().optional().describe('What the agent does'),
        mode: z.enum(['workflow', 'autonomous']).default('autonomous').describe('workflow = visual pipeline, autonomous = instruction-driven'),
        instructions: z.string().optional().describe('Instructions for autonomous agents'),
      },
      run: (args) => proxy.createAgent(args),
    },
    {
      name: 'almyty_invoke_agent',
      description: 'Invoke an agent with input. Returns the agent execution result.',
      shape: {
        agentId: z.string().describe('Agent ID'),
        input: z.record(z.unknown()).describe('Input data for the agent'),
      },
      run: (args) => proxy.invokeAgent(args.agentId, args.input),
    },
    {
      name: 'almyty_list_providers',
      description: 'List the LLM providers configured in your organization, with the connection backing each one.',
      shape: {},
      run: () => proxy.listProviders(),
    },
    {
      name: 'almyty_add_provider',
      description:
        'Add an LLM provider backed by an existing connection. Connect the vendor account first with `npx @almyty/connections connect <vendor>` and pass the connection id here. ' +
        'This tool deliberately does not take an API key: a key passed as a tool argument would be written into this conversation\'s transcript and the host editor\'s logs.',
      shape: {
        name: z.string().describe('Display name for the provider'),
        type: z.string().describe('Provider type (openai, anthropic, gemini, azure, bedrock, ...)'),
        credentialId: z.string().describe('Id of an existing connection, from `npx @almyty/connections list`'),
      },
      run: (args) => proxy.addProvider({ name: args.name, type: args.type, credentialId: args.credentialId, configuration: {} }),
    },
  ];

  for (const tool of management) {
    server.tool(tool.name, tool.description, tool.shape, async (args: any) => {
      try {
        return textResult(await tool.run(args));
      } catch (error) {
        return errorResult(error);
      }
    });
  }

  // Server info, answered from whatever discovery has managed so far.
  server.resource(
    'almyty-info',
    'almyty://info',
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify({
          server: ALMYTY_URL,
          version: VERSION,
          gatewayId: ALMYTY_GATEWAY_ID || 'all',
          mode: ALMYTY_MODE,
          discovered: catalog.discovered,
          tools: catalog.tools.length,
          skills: catalog.skills.length,
          discoveryError: catalog.lastError,
        }, null, 2),
      }],
    }),
  );

  // ── Connect, then discover ───────────────────────────────────────
  // This order is the point: the client gets its handshake even when the
  // backend is unreachable, so the editor shows a server that explains the
  // problem instead of one that died.

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`ready on stdio (mode: ${ALMYTY_MODE}, ${management.length} management tools)`);

  await catalog.refresh();
  if (catalog.lastError) {
    log(`gateway discovery failed: ${catalog.lastError}`);
    log('the management tools still work; almyty_execute will report this until discovery succeeds');
  } else {
    log(`${catalog.tools.length} gateway tools, ${catalog.skills.length} skills`);
  }

  // Skills as prompts, loaded on demand rather than held in context.
  const promptNames = uniquePromptNames(catalog.skills.map((s) => s.name));
  catalog.skills.forEach((skill, i) => {
    server.prompt(
      promptNames[i],
      `How to use: ${skill.name} (${skill.toolCount} tools)`,
      async () => ({
        messages: [{ role: 'user' as const, content: { type: 'text' as const, text: skill.content } }],
      }),
    );
  });

  // A compact index of everything available, as one prompt.
  server.prompt(
    'almyty-overview',
    `Overview: ${catalog.tools.length} API tools available via almyty`,
    async () => {
      await catalog.ensureFresh();
      const lines = [
        '# almyty API tools',
        '',
        `Connected to: ${ALMYTY_URL}`,
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

  if (ALMYTY_MODE === 'full') {
    // Every gateway tool individually. The JSON Schema the gateway returns
    // is converted to the Zod shape the SDK wants; handing it the raw
    // schema left the SDK with no usable parameter types.
    for (const tool of catalog.tools) {
      server.tool(
        tool.name,
        tool.description || `Tool: ${tool.name}`,
        buildZodShape(tool.inputSchema, z as any),
        async (args: Record<string, unknown>) => {
          try {
            return textResult(await proxy.callTool(tool.name, args));
          } catch (error) {
            return errorResult(error);
          }
        },
      );
    }
  }

  // Registrations happened after the handshake, so tell the client its
  // lists changed. A client that does not care ignores it.
  // Feature-detected rather than called outright: these notifications are
  // a courtesy, and nothing here depends on one arriving or on a particular
  // SDK version carrying them.
  const lowLevel = (server as unknown as { server?: Record<string, unknown> }).server;
  const notify = (method: string) => {
    const fn = lowLevel?.[method];
    if (typeof fn !== 'function') return;
    try {
      (fn as () => void).call(lowLevel);
    } catch {
      // A client that refuses the notification changes nothing.
    }
  };
  if (ALMYTY_MODE === 'full' && catalog.tools.length > 0) notify('sendToolListChanged');
  notify('sendPromptListChanged');
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
run by hand.

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

  almyty_add_provider takes a connection id, never an API key: a key passed as
  a tool argument would land in the assistant's transcript and the editor's
  logs. Make the connection first with \`npx @almyty/connections connect <vendor>\`.

Authentication:
  npx @almyty/auth login              Browser-based login (one-time setup)

Environment:
  ALMYTY_URL         Base URL (default: https://api.almyty.com)
  ALMYTY_TOKEN       Token (otherwise read from ~/.almyty/credentials.json)
  ALMYTY_GATEWAY_ID  Gateway as "orgSlug/gatewaySlug" (alternative to the positional arg)
  ALMYTY_MODE        "skill-first" (default) | "full"

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
