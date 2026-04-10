# @almyty/skills

Install and manage almyty skills in 30+ AI coding agents (Claude Code, Cursor, Windsurf, Copilot, Codex, and more).

## Quick start

```bash
$ npx @almyty/auth login
$ npx @almyty/skills gateways
$ npx @almyty/skills install @org/gateway
```

## Commands

| Command | Description |
|---------|-------------|
| `gateways` | List your gateways |
| `list` | List all available skills |
| `list @org/gateway` | List skills from one gateway |
| `search <query>` | Search skills by keyword |
| `install @org/gateway` | Install all skills from a gateway |
| `install @org/gateway/skill` | Install a single skill |
| `installed` | Show locally installed skills |
| `remove` | Remove all installed skills |
| `run @org/gateway/skill [--key value]` | Execute a skill |
| `daemon [--interval 60]` | Sync all skills on a schedule |
| `watch @org/gateway [--interval 60]` | Watch a specific gateway for changes |

## References

Skills are referenced as `@org/gateway` or `@org/gateway/skill`:

```bash
$ npx @almyty/skills install @acme/petstore
$ npx @almyty/skills run @acme/petstore/get-pet --id 123
```

## Configuration

Create `.almytyrc` in your project or home directory:

```json
{
  "url": "https://api.almyty.com",
  "token": "your-token"
}
```

## Environment variables

| Variable | Description |
|----------|-------------|
| `ALMYTY_TOKEN` | Auth token override |
| `ALMYTY_URL` | API URL override |
| `ALMYTY_SKILLS_DIR` | Custom directory for installed skill files |

## Authentication

Requires `npx @almyty/auth login` first. Reads credentials from `~/.almyty/credentials.json`.

## Docs

https://almyty.com/docs

## License

BSL-1.1
