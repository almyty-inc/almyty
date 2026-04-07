# @almyty/agents

List, run, and inspect [almyty](https://almyty.com) agents from the command line.

```bash
# Browser-based login (one-time setup)
npx @almyty/auth login

# List your agents
npx @almyty/agents list

# Run a workflow agent
npx @almyty/agents run my-summarizer --input '{"text": "..."}'

# Start an autonomous run and stream steps
npx @almyty/agents run my-researcher --input "look up the latest..." --watch

# Inspect recent runs
npx @almyty/agents runs my-researcher

# Cancel a runaway run
npx @almyty/agents cancel my-researcher <runId>
```

## Commands

| Command | Description |
|---|---|
| `list` | List agents in your organization |
| `get <ref>` | Show details for one agent |
| `run <ref>` | Invoke a workflow agent or start an autonomous run |
| `runs <ref>` | List recent runs for an agent |
| `cancel <ref> <runId>` | Cancel an in-flight autonomous run |

`<ref>` is either an agent name (case-insensitive, with hyphens) or a UUID.

## Run options

| Flag | Mode | Description |
|---|---|---|
| `--input '<json>'` | both | Workflow: object payload. Autonomous: string or object. |
| `--watch` | autonomous | Stream steps as they arrive instead of returning the run id. |
| `--max-steps <n>` | autonomous | Hard cap on reasoning steps. |
| `--max-cost-cents <n>` | autonomous | Hard cap on spending (in cents). |
| `--max-duration-ms <n>` | autonomous | Hard cap on wall-clock time. |
| `--json` | both | Print raw JSON instead of pretty output. |

## Authentication

Reads credentials from `~/.almyty/credentials.json` (created by
`npx @almyty/auth login`). Override with `ALMYTY_TOKEN` and `ALMYTY_URL`
environment variables for CI.

## License

BSL-1.1
