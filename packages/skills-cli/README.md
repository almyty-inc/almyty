# @almyty/skills

Install and manage AI skills from [almyty](https://almyty.com) in 30+ coding agents.

## Quick Start

```bash
# Install skills from a gateway
npx @almyty/skills install @your-org/your-gateway

# Keep skills synced (daemon mode)
npx @almyty/skills daemon

# Run a skill directly
npx @almyty/skills run @your-org/your-gateway/tool-name --param value
```

## What It Does

almyty turns any API into AI-ready tools. This CLI installs those tools as **SKILL.md files** into your project, where they're automatically picked up by supported agents.

## Supported Agents

| Category | Agents |
|----------|--------|
| **IDE** | Claude Code, Cursor, Windsurf, VS Code Copilot, JetBrains |
| **AI Assistants** | Claude Desktop, ChatGPT, Gemini |
| **Dev Tools** | Aider, Continue, Cody, GitHub Copilot CLI |
| **Frameworks** | LangChain, LlamaIndex, CrewAI, AutoGPT |

## Commands

```
npx @almyty/skills login              Authenticate with almyty
npx @almyty/skills logout             Remove stored credentials
npx @almyty/skills daemon             Start skill daemon (syncs all skills)
npx @almyty/skills install <ref>      Install skills from a gateway
npx @almyty/skills list [ref]         List available skills
npx @almyty/skills search <query>     Search for skills
npx @almyty/skills run <ref>          Execute a skill
npx @almyty/skills installed          Show locally installed skills
npx @almyty/skills remove             Remove all installed skills
npx @almyty/skills gateways           List your gateways
```

## References

Skills are referenced as `@org/gateway` or `@org/gateway/skill`:

```bash
npx @almyty/skills install @acme/petstore        # All skills from a gateway
npx @almyty/skills run @acme/petstore/get-pet     # Run a specific skill
```

## Configuration

Create `.almytyrc` in your project or home directory:

```json
{
  "url": "https://api.almyty.com",
  "token": "your-token"
}
```

Or use environment variables: `ALMYTY_URL`, `ALMYTY_TOKEN`.

## License

BSL-1.1
