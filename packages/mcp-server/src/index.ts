#!/usr/bin/env node

/**
 * @apifai/mcp-server — Skill-first API proxy for any LLM
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
 * The LLM reads a skill to understand a workflow, then calls apifai_execute
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
 *   APIFAI_URL        - Base URL of the apifai backend (default: http://localhost:4000)
 *   APIFAI_TOKEN      - JWT Bearer token for authentication
 *   APIFAI_GATEWAY_ID - Optional: scope to a specific gateway
 *   APIFAI_MODE       - "skill-first" (default) | "full" (registers all tools individually)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadCredentials } from './auth.js';
import { ApifaiProxy } from './proxy.js';

const APIFAI_URL = process.env.APIFAI_URL || 'http://localhost:4000';
const APIFAI_GATEWAY_ID = process.env.APIFAI_GATEWAY_ID;
const APIFAI_MODE = (process.env.APIFAI_MODE || 'skill-first') as 'skill-first' | 'full';

async function main() {
  // Resolve token: env var > stored credentials
  let token = process.env.APIFAI_TOKEN;
  if (!token) {
    const creds = loadCredentials();
    token = creds?.token;
  }

  if (!token) {
    console.error(
      'Error: No authentication token found.\n' +
      'Set APIFAI_TOKEN environment variable or run: npx @apifai/mcp-server login'
    );
    process.exit(1);
  }

  const proxy = new ApifaiProxy(APIFAI_URL, token, APIFAI_GATEWAY_ID);

  // Fetch tools + skills from backend
  const [tools, skills] = await Promise.all([
    proxy.fetchTools(),
    proxy.fetchSkills(),
  ]);

  console.error(`apifai: ${tools.length} tools, ${skills.length} skills (mode: ${APIFAI_MODE})`);

  const server = new McpServer({
    name: 'apifai',
    version: '1.0.0',
  });

  if (APIFAI_MODE === 'skill-first') {
    // =====================================================
    // SKILL-FIRST MODE (default) — minimal token overhead
    // =====================================================
    // Register only 2 tools instead of N:
    //   1. apifai_execute — universal tool executor
    //   2. apifai_search  — find tools by query
    //
    // Skills are registered as prompts (loaded on-demand).
    // The LLM reads a skill, learns the workflow, then calls
    // apifai_execute with the right tool name + params.
    // =====================================================

    // Build a compact tool index for the search tool
    const toolIndex = tools.map(t => ({
      name: t.name,
      description: t.description || '',
    }));

    // --- Universal executor ---
    // ONE tool that can call ANY apifai tool by name.
    // ~150 tokens in context instead of N * ~200 tokens.
    server.tool(
      'apifai_execute',
      'Execute any apifai API tool by name. Read the relevant skill prompt first to understand which tool to use and what parameters are needed.',
      {
        tool_name: z.string().describe('Name of the apifai tool to execute (from skill instructions)'),
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
      'apifai_search',
      'Search available API tools by keyword. Returns matching tool names and descriptions. Use this to discover which tools are available before calling apifai_execute.',
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
            text: `Found ${matches.length} tools:\n${resultText}\n\nLoad the relevant skill prompt for detailed usage instructions, then call apifai_execute.`,
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

  for (const skill of skills) {
    server.prompt(
      `skill-${skill.name}`,
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
      'apifai-overview',
      `Overview: ${tools.length} API tools available via apifai`,
      async () => {
        const lines = [
          '# apifai API Tools',
          '',
          `Connected to: ${APIFAI_URL}`,
          APIFAI_GATEWAY_ID ? `Gateway: ${APIFAI_GATEWAY_ID}` : '',
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
          '2. Call `apifai_execute` with `tool_name` and `parameters`',
          '3. Or use `apifai_search` to find the right tool first',
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
    'apifai-info',
    'apifai://info',
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify({
          server: APIFAI_URL,
          gatewayId: APIFAI_GATEWAY_ID || 'all',
          mode: APIFAI_MODE,
          tools: tools.length,
          skills: skills.length,
        }, null, 2),
      }],
    }),
  );

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Handle subcommands
const subcommand = process.argv[2];

if (subcommand === 'login') {
  const { login } = await import('./auth.js');
  await login(APIFAI_URL);
} else if (subcommand === 'logout') {
  const { logout } = await import('./auth.js');
  logout();
  console.log('Logged out successfully.');
} else if (subcommand === '--help' || subcommand === '-h') {
  console.log(`
@apifai/mcp-server — Skill-first API proxy for any LLM

Turn any API into AI skills. Instead of dumping tool schemas into context
(expensive), this injects compact skills that teach the LLM workflows,
plus a single universal executor.

Token overhead comparison:
  Traditional MCP:  20 tools = ~4,000 tokens/turn (always in context)
  Skill-first:      2 tools  = ~300 tokens/turn (skills loaded on demand)

Usage:
  npx @apifai/mcp-server              Start server (skill-first mode)
  npx @apifai/mcp-server login        Interactive login
  npx @apifai/mcp-server logout       Clear credentials

Environment:
  APIFAI_URL         Base URL (default: http://localhost:4000)
  APIFAI_TOKEN       JWT Bearer token
  APIFAI_GATEWAY_ID  Scope to specific gateway
  APIFAI_MODE        "skill-first" (default) | "full" (all tools individually)

Modes:
  skill-first  2 tools (apifai_execute + apifai_search) + skills as prompts
               Minimal token overhead. LLM loads skills on demand.
  full         All tools registered individually (traditional MCP)
               Higher overhead but works without prompt loading.

Configuration:

  Claude Code:  claude mcp add apifai -- npx -y @apifai/mcp-server
  Cursor:       .cursor/mcp.json → { "mcpServers": { "apifai": { "command": "npx", "args": ["-y", "@apifai/mcp-server"] } } }
  Codex:        ~/.codex/config.toml → [mcp_servers.apifai] command="npx" args=["-y","@apifai/mcp-server"]
  Copilot:      .vscode/mcp.json → { "servers": { "apifai": { "command": "npx", "args": ["-y", "@apifai/mcp-server"] } } }
  Gemini:       ~/.gemini/settings.json → { "mcpServers": { "apifai": { ... } } }
`);
} else {
  main().catch((err) => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
}
