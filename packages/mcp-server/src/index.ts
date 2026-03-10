#!/usr/bin/env node

/**
 * @apifai/mcp-server — MCP skill & tool injector for apifai
 *
 * Fetches tools AND skills from an apifai backend and injects them into
 * any LLM that supports MCP. Skills are procedural knowledge (markdown +
 * YAML frontmatter) that teach the LLM HOW to use tools — not just schemas.
 *
 * Tools → registered as MCP tools (callable)
 * Skills → registered as MCP prompts (injectable knowledge)
 *
 * Works with every major AI coding assistant:
 *   - Claude Code (.mcp.json)
 *   - Cursor (.cursor/mcp.json)
 *   - Windsurf (~/.codeium/windsurf/mcp_config.json)
 *   - OpenAI Codex CLI (~/.codex/config.toml)
 *   - GitHub Copilot (.vscode/mcp.json)
 *   - Google Gemini CLI (~/.gemini/settings.json)
 *
 * Usage:
 *   APIFAI_URL=http://localhost:4000 APIFAI_TOKEN=xxx npx @apifai/mcp-server
 *
 * Environment variables:
 *   APIFAI_URL        - Base URL of the apifai backend (default: http://localhost:4000)
 *   APIFAI_TOKEN      - JWT Bearer token for authentication
 *   APIFAI_GATEWAY_ID - Optional: scope tools/skills to a specific gateway
 *   APIFAI_MODE       - "tools" | "skills" | "both" (default: "both")
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadCredentials } from './auth.js';
import { ApifaiProxy } from './proxy.js';

const APIFAI_URL = process.env.APIFAI_URL || 'http://localhost:4000';
const APIFAI_GATEWAY_ID = process.env.APIFAI_GATEWAY_ID;
const APIFAI_MODE = (process.env.APIFAI_MODE || 'both') as 'tools' | 'skills' | 'both';

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

  // Create MCP server
  const server = new McpServer({
    name: 'apifai',
    version: '1.0.0',
  });

  // --- Register Tools ---
  if (APIFAI_MODE === 'tools' || APIFAI_MODE === 'both') {
    const tools = await proxy.fetchTools();

    if (tools.length === 0) {
      console.error('Warning: No tools found on the apifai server.');
    } else {
      console.error(`Loaded ${tools.length} tools from apifai`);
    }

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
              content: [
                {
                  type: 'text' as const,
                  text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
                },
              ],
            };
          } catch (error: any) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Error: ${error.message}`,
                },
              ],
              isError: true,
            };
          }
        },
      );
    }
  }

  // --- Register Skills as Prompts ---
  // Skills are procedural knowledge — they go into MCP prompts so the LLM
  // can "get" them and learn how to use the tools properly.
  if (APIFAI_MODE === 'skills' || APIFAI_MODE === 'both') {
    const skills = await proxy.fetchSkills();

    if (skills.length > 0) {
      console.error(`Loaded ${skills.length} skills from apifai`);
    }

    for (const skill of skills) {
      server.prompt(
        `skill-${skill.name}`,
        `Skill: ${skill.name} (${skill.toolCount} tools)`,
        async () => ({
          messages: [
            {
              role: 'user' as const,
              content: {
                type: 'text' as const,
                text: skill.content,
              },
            },
          ],
        }),
      );
    }

    // Register a meta-prompt that lists all available skills
    if (skills.length > 0) {
      server.prompt(
        'apifai-skills-overview',
        'Overview of all available apifai skills and tools',
        async () => ({
          messages: [
            {
              role: 'user' as const,
              content: {
                type: 'text' as const,
                text: [
                  '# apifai Skills Overview',
                  '',
                  `This server provides ${skills.length} skills with procedural knowledge for API tool usage.`,
                  '',
                  '## Available Skills',
                  '',
                  ...skills.map(s => `- **${s.name}** (${s.toolCount} tools)`),
                  '',
                  'Use `prompts/get` with skill name to load full procedural instructions.',
                ].join('\n'),
              },
            },
          ],
        }),
      );
    }
  }

  // --- Register Resources ---
  // Server info resource
  server.resource(
    'apifai-info',
    'apifai://info',
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify({
            server: APIFAI_URL,
            gatewayId: APIFAI_GATEWAY_ID || 'all',
            mode: APIFAI_MODE,
          }, null, 2),
        },
      ],
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
@apifai/mcp-server — MCP skill & tool injector for apifai

Injects tools AND skills (procedural knowledge) from any API into your
LLM via the Model Context Protocol.

Usage:
  npx @apifai/mcp-server              Start MCP server (stdio transport)
  npx @apifai/mcp-server login        Interactive login to apifai
  npx @apifai/mcp-server logout       Clear stored credentials

Environment:
  APIFAI_URL         Base URL (default: http://localhost:4000)
  APIFAI_TOKEN       JWT Bearer token
  APIFAI_GATEWAY_ID  Scope to specific gateway
  APIFAI_MODE        "tools" | "skills" | "both" (default: "both")

What gets injected:
  Tools  → MCP tools (callable by the LLM)
  Skills → MCP prompts (procedural knowledge on HOW to use the tools)

Configuration examples:

  Claude Code:
    claude mcp add apifai -- npx -y @apifai/mcp-server

  Cursor (.cursor/mcp.json):
    {
      "mcpServers": {
        "apifai": {
          "command": "npx",
          "args": ["-y", "@apifai/mcp-server"],
          "env": { "APIFAI_URL": "http://localhost:4000", "APIFAI_TOKEN": "..." }
        }
      }
    }

  Codex CLI (~/.codex/config.toml):
    [mcp_servers.apifai]
    command = "npx"
    args = ["-y", "@apifai/mcp-server"]

  GitHub Copilot (.vscode/mcp.json):
    {
      "servers": {
        "apifai": { "command": "npx", "args": ["-y", "@apifai/mcp-server"] }
      }
    }

  Gemini CLI (~/.gemini/settings.json):
    {
      "mcpServers": {
        "apifai": { "command": "npx", "args": ["-y", "@apifai/mcp-server"] }
      }
    }
`);
} else {
  main().catch((err) => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
}
