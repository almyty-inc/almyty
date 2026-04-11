#!/usr/bin/env node

/**
 * @almyty/mcp-server — Skill-first API proxy for any LLM
 *
 * Instead of dumping N tool schemas into context (N * ~200 tokens each),
 * this injects:
 *   1. Skills (compact markdown prompts) — the LLM's knowledge layer
 *   2. ONE universal executor tool — handles all API calls
 *   3. ONE search tool — finds the right skill/tool on demand
 *
 * Token comparison:
 *   Traditional MCP: 20 tools = ~4,000 tokens always in context
 *   Skill-first:     2 tools + skills on-demand = ~300 tokens base
 *
 * The LLM reads a skill to understand a workflow, then calls almyty_execute
 * with the tool name and parameters. Skills are loaded on demand via
 * MCP prompts — only when the LLM actually needs them.
 *
 * Works with every major AI coding assistant:
 *   - Claude Code (.mcp.json / .claude/skills/)
 *   - Cursor (.cursor/mcp.json)
 *   - Windsurf (~/.codeium/windsurf/mcp_config.json)
 *   - OpenAI Codex CLI (~/.codex/config.toml)
 *   - GitHub Copilot (.vscode/mcp.json)
 *   - Google Gemini CLI (~/.gemini/settings.json)
 *
 * Environment variables:
 *   ALMYTY_URL        - Base URL of the almyty backend (default: https://api.almyty.com)
 *   ALMYTY_TOKEN      - JWT Bearer token for authentication
 *   ALMYTY_GATEWAY_ID - Optional: scope to a specific gateway
 *   ALMYTY_MODE       - "skill-first" (default) | "full" (registers all tools individually)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolveCredentials } from './auth.js';
import { AlmytyProxy } from './proxy.js';

// Accept gateway as positional arg or env var:
//   npx @almyty/mcp-server acme/petstore
//   ALMYTY_GATEWAY_ID=acme/petstore npx @almyty/mcp-server
const ALMYTY_GATEWAY_ID = process.argv[2] || process.env.ALMYTY_GATEWAY_ID;
const ALMYTY_MODE = (process.env.ALMYTY_MODE || 'skill-first') as 'skill-first' | 'full';

/**
 * Sanitize a skill name into a valid MCP prompt identifier.
 * MCP prompt names should be safe identifiers — replace anything outside
 * [a-zA-Z0-9_-] (e.g. slashes from `petstore/pets`) with underscores so
 * the registration doesn't blow up on real-world skill names.
 */
function sanitizePromptName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '') || 'skill';
}

async function main() {
  // Resolve token: env var > ~/.almyty/credentials.json
  const creds = resolveCredentials();
  if (!creds) {
    console.error(
      'Error: No authentication token found.\n' +
      'Set ALMYTY_TOKEN environment variable or run: npx @almyty/auth login'
    );
    process.exit(1);
  }

  const ALMYTY_URL = creds.url;
  const proxy = new AlmytyProxy(ALMYTY_URL, creds.token, ALMYTY_GATEWAY_ID);

  // Fetch tools + skills from backend
  const [tools, skills] = await Promise.all([
    proxy.fetchTools(),
    proxy.fetchSkills(),
  ]);

  console.error(`almyty: ${tools.length} tools, ${skills.length} skills (mode: ${ALMYTY_MODE})`);

  const server = new McpServer({
    name: 'almyty',
    version: '1.0.0',
  });

  if (ALMYTY_MODE === 'skill-first') {
    // =====================================================
    // SKILL-FIRST MODE (default) — minimal token overhead
    // =====================================================
    // Register only 2 tools instead of N:
    //   1. almyty_execute — universal tool executor
    //   2. almyty_search  — find tools by query
    //
    // Skills are registered as prompts (loaded on-demand).
    // The LLM reads a skill, learns the workflow, then calls
    // almyty_execute with the right tool name + params.
    // =====================================================

    // Build a compact tool index for the search tool
    const toolIndex = tools.map(t => ({
      name: t.name,
      description: t.description || '',
    }));

    // --- Universal executor ---
    // ONE tool that can call ANY almyty tool by name.
    // ~150 tokens in context instead of N * ~200 tokens.
    server.tool(
      'almyty_execute',
      'Execute any almyty API tool by name. Read the relevant skill prompt first to understand which tool to use and what parameters are needed.',
      {
        tool_name: z.string().describe('Name of the almyty tool to execute (from skill instructions)'),
        parameters: z.record(z.unknown()).describe('Parameters for the tool (see skill for required params)'),
      },
      async (args) => {
        try {
          const result = await proxy.callTool(args.tool_name, args.parameters as Record<string, unknown>);
          return {
            content: [{
              type: 'text' as const,
              text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
            }],
          };
        } catch (error: any) {
          return {
            content: [{ type: 'text' as const, text: `Error: ${error.message}` }],
            isError: true,
          };
        }
      },
    );

    // --- Search tool ---
    // Helps the LLM find the right tool/skill without having all schemas in context.
    server.tool(
      'almyty_search',
      'Search available API tools by keyword. Returns matching tool names and descriptions. Use this to discover which tools are available before calling almyty_execute.',
      {
        query: z.string().describe('Search query (e.g., "create pet", "list users", "payment")'),
      },
      async (args) => {
        const query = args.query.toLowerCase();
        const matches = toolIndex.filter(t =>
          t.name.toLowerCase().includes(query) ||
          t.description.toLowerCase().includes(query)
        );

        if (matches.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `No tools found matching "${args.query}". Available tools: ${toolIndex.slice(0, 10).map(t => t.name).join(', ')}${toolIndex.length > 10 ? ` ... and ${toolIndex.length - 10} more` : ''}`,
            }],
          };
        }

        const resultText = matches.slice(0, 20).map(t =>
          `- **${t.name}**: ${t.description}`
        ).join('\n');

        return {
          content: [{
            type: 'text' as const,
            text: `Found ${matches.length} tools:\n${resultText}\n\nLoad the relevant skill prompt for detailed usage instructions, then call almyty_execute.`,
          }],
        };
      },
    );

  } else {
    // =====================================================
    // FULL MODE — registers every tool individually
    // Higher token overhead but works without skill prompts.
    // =====================================================
    for (const tool of tools) {
      const schema = tool.inputSchema || { type: 'object' as const, properties: {} };

      server.tool(
        tool.name,
        tool.description || `Tool: ${tool.name}`,
        schema,
        async (args: Record<string, unknown>) => {
          try {
            const result = await proxy.callTool(tool.name, args);
            return {
              content: [{
                type: 'text' as const,
                text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
              }],
            };
          } catch (error: any) {
            return {
              content: [{ type: 'text' as const, text: `Error: ${error.message}` }],
              isError: true,
            };
          }
        },
      );
    }
  }

  // =====================================================
  // SKILLS AS PROMPTS — loaded on demand, not in context
  // =====================================================
  // Each skill is ~100-250 tokens. The LLM loads only the
  // skill it needs via prompts/get, instead of having all
  // N tool schemas (~200 tokens each) always in context.
  // =====================================================

  // Track sanitized prompt names to avoid collisions when two skills
  // sanitize to the same identifier (e.g. `petstore/pets` and
  // `petstore-pets` both become `petstore_pets`).
  const usedPromptNames = new Set<string>();
  for (const skill of skills) {
    let promptName = `skill-${sanitizePromptName(skill.name)}`;
    if (usedPromptNames.has(promptName)) {
      let suffix = 2;
      while (usedPromptNames.has(`${promptName}-${suffix}`)) suffix++;
      promptName = `${promptName}-${suffix}`;
    }
    usedPromptNames.add(promptName);

    server.prompt(
      promptName,
      `How to use: ${skill.name} (${skill.toolCount} tools)`,
      async () => ({
        messages: [{
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: skill.content,
          },
        }],
      }),
    );
  }

  // Overview prompt — compact index of all available skills
  if (skills.length > 0 || tools.length > 0) {
    server.prompt(
      'almyty-overview',
      `Overview: ${tools.length} API tools available via almyty`,
      async () => {
        const lines = [
          '# almyty API Tools',
          '',
          `Connected to: ${ALMYTY_URL}`,
          ALMYTY_GATEWAY_ID ? `Gateway: ${ALMYTY_GATEWAY_ID}` : '',
          '',
          `## ${tools.length} tools available`,
          '',
          ...tools.map(t => `- \`${t.name}\`: ${t.description || 'No description'}`),
          '',
        ];

        if (skills.length > 0) {
          lines.push(
            `## ${skills.length} skills (detailed usage guides)`,
            '',
            ...skills.map(s => `- \`skill-${s.name}\`: ${s.toolCount} tools`),
            '',
          );
        }

        lines.push(
          '## How to use',
          '',
          '1. Load a skill prompt to understand the workflow',
          '2. Call `almyty_execute` with `tool_name` and `parameters`',
          '3. Or use `almyty_search` to find the right tool first',
          '',
        );

        return {
          messages: [{
            role: 'user' as const,
            content: { type: 'text' as const, text: lines.filter(Boolean).join('\n') },
          }],
        };
      },
    );
  }

  // Server info resource
  server.resource(
    'almyty-info',
    'almyty://info',
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify({
          server: ALMYTY_URL,
          gatewayId: ALMYTY_GATEWAY_ID || 'all',
          mode: ALMYTY_MODE,
          tools: tools.length,
          skills: skills.length,
        }, null, 2),
      }],
    }),
  );

  // =====================================================
  // MANAGEMENT TOOLS — control the almyty platform itself
  // =====================================================
  // These tools let LLMs manage almyty: create APIs, import
  // schemas, generate tools, set up gateways, build agents.
  // Available in both modes (skill-first and full).

  server.tool(
    'almyty_list_apis',
    'List all connected APIs in your organization.',
    {},
    async () => {
      const result = await proxy.listApis();
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'almyty_create_api',
    'Connect a new API. Provide a name, type (openapi/graphql/soap/protobuf/sdk), and base URL.',
    {
      name: z.string().describe('Human-readable API name'),
      type: z.enum(['openapi', 'graphql', 'soap', 'protobuf', 'sdk']).describe('Schema type'),
      baseUrl: z.string().optional().describe('API base URL (not needed for SDK type)'),
    },
    async (args) => {
      const result = await proxy.createApi(args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'almyty_import_schema',
    'Import an API schema and auto-generate tools. Provide the API ID and a schema URL.',
    {
      apiId: z.string().describe('ID of the API to import into'),
      schemaUrl: z.string().describe('URL of the schema (e.g. OpenAPI JSON endpoint)'),
      generateTools: z.boolean().default(true).describe('Auto-generate tools from operations'),
    },
    async (args) => {
      const result = await proxy.importSchema(args.apiId, { schemaUrl: args.schemaUrl, generateTools: args.generateTools });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'almyty_list_gateways',
    'List all gateways in your organization.',
    {},
    async () => {
      const result = await proxy.listGateways();
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'almyty_create_gateway',
    'Create a gateway to expose tools OR an agent via a protocol (MCP, A2A, UTCP, Skills). Use kind="tool" for a tool gateway or kind="agent" for an agent gateway.',
    {
      name: z.string().describe('Gateway name'),
      type: z.enum(['mcp', 'a2a', 'utcp', 'skills']).describe('Protocol type'),
      endpoint: z.string().describe('URL slug for the gateway endpoint'),
      kind: z.enum(['tool', 'agent']).default('tool').describe('What the gateway exposes: tools or a single agent'),
      agentId: z.string().optional().describe('Agent ID (required when kind is "agent")'),
    },
    async (args) => {
      const result = await proxy.createGateway({ ...args, configuration: {} });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'almyty_assign_tool',
    'Assign a tool to a tool-kind gateway.',
    {
      gatewayId: z.string().describe('Gateway ID'),
      toolId: z.string().describe('Tool ID to assign'),
    },
    async (args) => {
      const result = await proxy.assignToolToGateway(args.gatewayId, args.toolId);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'almyty_list_agents',
    'List all agents in your organization.',
    {},
    async () => {
      const result = await proxy.listAgents();
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'almyty_create_agent',
    'Create a new agent. Workflow agents use a visual DAG pipeline. Autonomous agents use instructions + tool access.',
    {
      name: z.string().describe('Agent name'),
      description: z.string().optional().describe('What the agent does'),
      mode: z.enum(['workflow', 'autonomous']).default('autonomous').describe('workflow = visual pipeline, autonomous = instruction-driven'),
      instructions: z.string().optional().describe('Instructions for autonomous agents'),
    },
    async (args) => {
      const result = await proxy.createAgent(args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'almyty_invoke_agent',
    'Invoke an agent with input. Returns the agent execution result.',
    {
      agentId: z.string().describe('Agent ID'),
      input: z.record(z.unknown()).describe('Input data for the agent'),
    },
    async (args) => {
      const result = await proxy.invokeAgent(args.agentId, args.input);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'almyty_add_provider',
    'Add an LLM provider (OpenAI, Anthropic, etc.).',
    {
      name: z.string().describe('Display name'),
      type: z.string().describe('Provider type (openai, anthropic, gemini, azure, bedrock, etc.)'),
      apiKey: z.string().describe('API key for the provider'),
    },
    async (args) => {
      const result = await proxy.addProvider({ name: args.name, type: args.type, configuration: { apiKey: args.apiKey } });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  process.stderr.write(`almyty: ${tools.length} gateway tools, ${skills.length} skills, 10 management tools (mode: ${ALMYTY_MODE})\n`);

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Handle subcommands (check before main() uses argv[2] as gateway ID)
const subcommand = process.argv[2];

if (subcommand === 'login' || subcommand === 'logout' || subcommand === 'whoami') {
  // Auth lives in @almyty/auth. Redirect rather than silently doing
  // nothing — users typing the old commands should see the new entry point.
  console.error(`Authentication moved to @almyty/auth.`);
  console.error(`  npx @almyty/auth ${subcommand}`);
  process.exit(1);
} else if (subcommand === '--help' || subcommand === '-h') {
  console.log(`
@almyty/mcp-server — Skill-first API proxy for any LLM

Turn any API into AI skills. Instead of dumping tool schemas into context
(expensive), this injects compact skills that teach the LLM workflows,
plus a single universal executor.

Token overhead comparison:
  Traditional MCP:  20 tools = ~4,000 tokens/turn (always in context)
  Skill-first:      2 tools  = ~300 tokens/turn (skills loaded on demand)

Usage:
  npx @almyty/mcp-server <org/gateway>   Start server for a specific gateway
  npx @almyty/mcp-server                 Start server (all gateways)

Examples:
  npx @almyty/mcp-server acme/petstore
  claude mcp add petstore -- npx -y @almyty/mcp-server acme/petstore

Authentication:
  npx @almyty/auth login              Browser-based login (one-time setup)

Environment:
  ALMYTY_URL         Base URL (default: https://api.almyty.com)
  ALMYTY_TOKEN       API key (auto-read from ~/.almyty/credentials.json)
  ALMYTY_GATEWAY_ID  Gateway (alternative to positional arg)
  ALMYTY_MODE        "skill-first" (default) | "full"

Modes:
  skill-first  2 tools (almyty_execute + almyty_search) + skills as prompts
               Minimal token overhead. LLM loads skills on demand.
  full         All tools registered individually (traditional MCP)
               Higher overhead but works without prompt loading.

Configuration:

  Claude Code:  claude mcp add petstore -- npx -y @almyty/mcp-server acme/petstore
  Cursor:       .cursor/mcp.json → { "mcpServers": { "petstore": { "command": "npx", "args": ["-y", "@almyty/mcp-server", "acme/petstore"] } } }
  Copilot:      .vscode/mcp.json → { "servers": { "almyty": { "command": "npx", "args": ["-y", "@almyty/mcp-server"] } } }
  Gemini:       ~/.gemini/settings.json → { "mcpServers": { "almyty": { ... } } }
`);
} else {
  main().catch((err) => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
}
