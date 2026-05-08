# almyty runner demo

A live, end-to-end script that drives the routing path: spawn a runner CLI, wait for the SaaS to publish its capabilities as Tool rows, execute those tools through the SaaS, watch the response come back.

## The watchable version

[DEMO.md](DEMO.md) is the show-and-tell walkthrough. It explains what to click in the UI, what to watch for, and how the routing path threads SaaS → runner → SaaS on every dispatch.

## The script

`src/demo.ts` does the same thing without the browser. Useful for regression testing, CI smoke checks, or just verifying the path on a fresh machine in 30 seconds:

```
npx @almyty/auth login        # one-time per machine
npm install
npm run demo
```

The script:

1. Resolves your credentials from `~/.almyty/credentials.json`.
2. Spawns `npx --yes @almyty/runner start --name almyty-demo-<rand>` as a child process.
3. Polls `GET /runners` until the runner reports `state=online`.
4. Polls `GET /organizations/:org/tools` until the capabilities (`runner.info` + `shell.exec`) appear.
5. Executes `runner.info` against the SaaS — that's a live RPC to your laptop.
6. Creates a workspace at `cwd=$PWD`.
7. Executes `shell.exec` with `command: uname -a && echo "almyty:$(date)"` against that workspace.
8. Releases the workspace and SIGTERMs the runner subprocess.

Every step exercises the routing path end-to-end. There is no local subprocess orchestration here — the demo proves that **the SaaS can dispatch tools onto your laptop through the runner**.

## Variations

- **Reuse a running runner.** If you already have a runner up via `almyty runner start`, set `ALMYTY_DEMO_RUNNER_NAME=<your-runner-name>` and the demo skips the spawn step.
- **Different command.** Set `ALMYTY_DEMO_COMMAND='your shell command here'` to override the default `uname -a` invocation.
- **Different backend.** The demo follows whatever URL is in your stored credentials. Set `ALMYTY_URL` + `ALMYTY_TOKEN` env vars to override (for staging or local dev).

## What this proves

The wedge: any tool minted on a runner is a normal Tool row in the catalog. MCP gateways list it; the agent builder can use it; OpenAI-compat routes function calls into it; the UI executes it. The runner is just *another* execution backend behind the same `Tool.execute` contract — same as HTTP, GraphQL, SDK, custom code. The difference is the executor dispatches over a Streamable HTTP envelope to a process running on your machine instead of opening an outbound HTTP connection.
