# @almyty/connections

Connect a third-party account to almyty once, from your terminal; agents,
models, deployments, memory backends, MCP servers, channels and registries
then use the connection. Inference vendors, deployment clouds, buckets, chat
platforms — all of them are connectors in the same catalog.

```sh
npx @almyty/auth login
npx @almyty/connections connectors --kind inference
npx @almyty/connections connect openrouter --open
npx @almyty/connections list
```

## What a connection is

A connection is a credential row with a connector key, an account label and a
health status. The secret is stored encrypted in almyty's credential store and
is **never returned**, not even masked. Every module that needs it holds a
reference, resolved on each use, so a rotation is live on the next call and
every resolve is audited.

```
b91c…  openrouter  org   ava@northwind   valid
3d70…  huggingface user  frane           failed
    401 invalid credentials
```

## Commands

Every read command takes `--json` and writes undecorated JSON to stdout.

### Read

| Command | What it does |
|---|---|
| `connectors [--kind k]` | The catalog: what can be connected, and how. `--kind` is one of `inference`, `deployment`, `memory`, `mcp`, `tool_source`, `channel`, `cloud`, `registry` |
| `list` | Connected accounts with health |
| `get <id>` | One connection: connector, account label, health and when it was checked, scopes, owner — and what to do when the health is not `valid` |
| `grants <id>` | Who may use this connection |

### Connect

| Command | What it does |
|---|---|
| `connect <key> [--method m] [--owner org\|user] [--name n] [--headless] [--open]` | Start a connection |
| `complete <key> --state s --code c` | Finish a headless sign-in by pasting the code |
| `validate <id>` | Re-check against the provider; refreshes health and the account label |
| `rotate <id> [--headless] [--open]` | Replace the secret in place, so everything pointing at the connection keeps working |
| `disconnect <id>` | Revoke at the provider where the connector declares a revoke endpoint, then delete |

Each connector offers one or more methods, best first, and `connect` picks the
best unless `--method` names another. `connectors` lists them.

**Sign-in** (OpenRouter and Slack today) is the best path: nothing to paste.

```sh
npx @almyty/connections connect openrouter --open
```

On a machine with no browser, ask for the headless flow and the provider shows
a code:

```sh
npx @almyty/connections connect openrouter --headless
# -> Open this URL to continue: https://…
#    The provider will show you a code. Paste it with:
#      almyty connections complete openrouter --state st-… --code <code>
```

The instructions you get are the ones that will work: a browser flow finishes
on the callback and says so, rather than pointing you at a `complete` command
whose state the redirect has already consumed.

**A pasted key** prompts for each field, secrets not echoed, with a link to
the page where the key is created:

```sh
npx @almyty/connections connect huggingface --owner user
# Get a key at: https://huggingface.co/settings/tokens
# Access token: ······
```

The key is checked against the provider before it is saved. If the provider
says no, the connection is kept with a `failed` health and the provider's
answer, so you fix the key at the provider and `validate` or `rotate` rather
than starting over.

**Rotate** replaces the secret without touching anything that points at the
connection. For a pasted key it prompts for the new value; for a sign-in
connector it returns a fresh authorize URL and completing it swaps the key on
the same connection.

### Share

An organization connection is usable by the organization; a grant widens or
narrows that to a principal.

| Command | What it does |
|---|---|
| `grant <id> --principal user\|team\|role\|agent\|workspace --to <principalId> [--permission use\|manage] [--expires <iso8601>]` | Let a principal use (or manage) a connection |
| `revoke <id> <grantId>` | Withdraw one grant |

## Org or personal

`--owner org` (the default) makes the connection the organization's: this is
what agents and deployments use, and it needs `connections:manage` (admin or
owner). `--owner user` makes it yours. Free and personal organizations allow
personal connections by default; paid organizations start with them off until
an admin turns them on.

## Secrets never travel on argv

`ps` shows every process's arguments to every user on the machine, shell
history keeps them, and most CI runners echo them. So this tool does not take
a secret as a flag value.

In order of preference:

1. **A sign-in flow** where the connector has one. Nothing is typed at all.
2. **The prompt**, which is the default: secret fields are read without echo.
3. **`--input-file <path>`** — the form fields as a JSON object in a file.
4. **`--input-stdin`** — the same object on stdin.

```sh
npx @almyty/connections connect telegram --input-file bot.json
pass show telegram/bot | jq -Rn '{bot_token: input}' \
  | npx @almyty/connections connect telegram --input-stdin
```

`--input '<json>'` still works for the fields a connector does **not** mark
secret (a region, a bucket, a phone number) and is refused the moment it
carries one that is, naming the field and the safe alternatives. The refusal
never repeats the value.

Unattended runs are handled rather than hung: without a terminal to prompt on,
`connect` and `rotate` say so and name `--input-file` and `--input-stdin`
instead of reading end-of-file and submitting an empty form. `--input-stdin`
with a terminal on stdin is refused for the same reason.

## Health, and what to do about it

`validate` exits non-zero unless the health comes back `valid`, so it works in
a check. Each status has a different next step, and `get` and `validate` print
it:

| Health | What it means |
|---|---|
| `valid` | The provider accepted the credential |
| `failed` | The provider rejected it. Fix it at the provider, then `rotate` |
| `expired` | It has expired. `rotate` |
| `revoked` | It was revoked at the provider. `rotate` |
| `quota` | The credential is fine; the account is out of quota or rate limited. Rotating would not help |
| `unknown` | Never checked. Run `validate` |

## Chat channels

Every chat channel is a connector like any other, so a Slack, Discord or
Telegram token is connected here instead of pasted into a gateway form:

```sh
npx @almyty/connections connectors --kind channel
npx @almyty/connections connect channel-slack --open
npx @almyty/connections connect channel-telegram
```

The connector key is `channel-<gateway type>` with underscores dasherized
(`channel-whatsapp-cloud`), and the form fields are spelled the way the
channel adapter reads them, so a gateway can adopt a connection you already
made. `docs/connections.md` has the table of what each channel needs, where
to get it, and how it is validated.

## Environment

| Variable | Meaning |
|---|---|
| `ALMYTY_TOKEN` | Token override; skips `~/.almyty/credentials.json` |
| `ALMYTY_URL` | API URL override |
| `NO_COLOR` | Honoured: this tool never colours its output |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | unexpected error |
| 2 | usage error (bad flags, missing argument, unknown command, a secret on argv) |
| 3 | not authenticated — run `npx @almyty/auth login` |
| 4 | not found |
| 5 | the operation ran and failed (a `validate` whose health is not `valid`) |

The same table in every `@almyty/*` CLI.

## About almyty

almyty is the platform for AI agents, agnostic by design: any LLM, any API
turned into tools, served over MCP, A2A, UTCP and Agent Skills.

- Website: https://almyty.com
- Design notes: `docs/connections.md` in the almyty repository
- Source: https://github.com/almyty-inc/almyty

Run `npx @almyty/connections --help` for the full surface.

Apache-2.0 © Almyty Inc.
