# Live demo: SaaS-driven runner with auto-published capabilities

A 5-minute walkthrough you can show a colleague. Start a runner on your laptop with one command, open the almyty UI, and execute a shell command on your laptop **from the browser** — through the SaaS, dispatched over Streamable HTTP, executed locally, output streamed back into the UI.

## What you'll see

1. A runner registers your laptop with almyty in one terminal command.
2. The almyty UI shows the runner online with detected binaries on **/runners**.
3. The runner automatically publishes capabilities: `runner.<name>.runner.info` and `runner.<name>.shell.exec` appear in **/tools** within seconds, each tagged with a cyan "runner: <name>" badge.
4. Open `runner.info` → **Test Tool** → click Execute. Output (OS, CPU, memory, detected binaries) streams back from your laptop into the UI.
5. Create a workspace on the runner. Open `shell.exec` → pick the workspace → enter a command (`uname -a`, `ls -la`, whatever you want). Click Execute. Output comes back through the same envelope channel.

This is the routing path end-to-end: the SaaS dispatches a tool, the backend looks up the tool's `runnerConfig`, `RunnerCallService` pushes a `request` envelope onto the runner's Streamable HTTP session, your runner executes, and the response envelope flows back to the executor and into the UI.

## Prerequisites

- **Node 20+**.
- **An almyty account.** Use the SaaS at the URL you normally use (production, staging, or local dev — the runner config picks up the API URL from the SaaS you logged into).

That's it. No agent CLIs, no API keys, no clones. The runner ships node-pty + node and that's enough for `shell.exec`.

## Step 1: Authenticate

```
npx @almyty/auth login
```

Or, if you already have the umbrella installed:

```
almyty login
```

Opens a browser. One-time per machine. The runner picks the credential up from `~/.almyty/credentials.json` automatically.

## Step 2: Start the runner

Either of these works — the umbrella delegates `runner` to `@almyty/runner`, so they produce identical output:

```
almyty runner start --name laptop --label env=demo
# or, without installing the umbrella globally:
npx @almyty/runner start --name laptop --label env=demo
```

You'll see the daemon log:

```
almyty-runner v0.1.0 starting
name=laptop url=https://api.almyty.com
detected 4/15 binaries on PATH
registered as <runner-id>
runner online; press ctrl-c to exit
```

Leave this terminal open. The daemon stays alive listening for envelopes.

You can also drive this step from the UI: open **Runners → Start a runner**. The page generates the exact command, copies on click, and waits for the heartbeat. Once the daemon registers, it auto-redirects you to the runner detail.

## Step 3: See the capabilities appear

Open **/runners/<your-runner>** in the UI. The page now has a **Published capabilities** card listing:

- `runner.info` — global metadata (OS, arch, binaries).
- `shell.exec` — workspace-scoped shell command.

Click `runner.info` and you land on **/tools/<id>**. The detail page shows a cyan "Runner-backed tool" panel: name, method, "workspace: not required". Click **Test Tool** → **Execute Tool**. Within a second or two:

```json
{
  "ok": true,
  "result": {
    "os": "darwin",
    "arch": "arm64",
    "hostname": "your-laptop",
    "cpuCount": 10,
    "memoryMb": 16384,
    "binaries": { "node": "v22.10.0", "git": "2.45.2", ... }
  }
}
```

That's a live RPC to your laptop, dispatched through the SaaS.

## Step 4: Run a workspace-scoped command

Back on the runner detail page, scroll to **Workspaces** and create one (or use any existing active workspace). The default cwd is your home directory; pick whatever directory you want shell.exec to run in.

Open **/tools/<id>** for `runner.<name>.shell.exec`. The Test Tool tab now shows a **Workspace** picker (red asterisk — required). Pick the workspace you just created. In the parameters area:

- `command`: `ls -la`

Click Execute. The result panel:

```json
{
  "ok": true,
  "result": {
    "exitCode": 0,
    "stdout": "total 32\ndrwxr-xr-x  ...\n",
    "stderr": "",
    "durationMs": 18
  }
}
```

Try a few:
- `command: uname -a` — reports kernel info.
- `command: git -C . log --oneline -5` — last 5 commits in the workspace dir.
- `command: node -e "console.log(2+2)"` — proves it really is your machine.

Each one is a full request/response cycle: SaaS → backend → Streamable HTTP envelope → runner → executor → response envelope → backend → UI.

## What just happened, technically

- **Step 2's runner** registered with the backend over `POST /runners/register`. The backend wrote a `Runner` row, then `RunnerCapabilityPublisher` minted two `Tool` rows (one for `runner.info`, one for `shell.exec`) with `runnerConfig` pointing at the runner.
- **Step 2's runner** also opened a Streamable HTTP session on `GET /mcp/streamable` for server→client envelopes, and the backend recorded the session in `runner_sessions`.
- **Step 3's Execute Tool** click hit `POST /organizations/:org/tools/:id/execute`, which loaded the Tool, saw `runnerConfig`, and called `RunnerCallService.dispatch(runnerId, 'runner.info', {})`.
- `RunnerCallService` minted a uuid v7 correlation id, pushed a `request` envelope onto the streamable session via `transport.push`, and registered a pending entry keyed by the id.
- The runner saw the envelope on its SSE stream, dispatched `runner.info` locally (`packages/runner/src/handlers.ts`), and POSTed a `response` envelope back. The transport emitted it; `RunnerCallService` matched the id and resolved the pending promise.
- `ToolExecutorService.executeRunnerCall` wrapped the response in a `ToolExecutionResult` and the controller returned it to the UI.

## Stop the runner

In the runner terminal: `ctrl-c` for clean shutdown (the daemon sends a `runner.draining` event and exits). Or from another terminal:

```
almyty runner stop
```

In the UI, the runner state goes to `draining` and then `offline` after the grace window. The published Tool rows disappear automatically (capability publisher unregisters them on `POST /runners/:id/unregister`).

## Variations to try

- **Re-register a runner.** Stop and restart with the same `--name`. The Tool rows are upserted (delete + insert on `runnerId` in one transaction); the IDs change but the published surface stays consistent.
- **Multiple workspaces.** Create three workspaces with different `cwd`s. Each picks its own working directory; switch the workspace in the Test Tool picker to run the same command in different dirs.
- **Drive it from a custom tool.** Build any almyty agent that calls `runner.<name>.shell.exec` as a tool. The agent runtime sees it as a normal function-calling tool — there's no runner-specific code path beyond the dispatch already wired in `ToolExecutorService`.

## Troubleshooting

- **Tool list doesn't show the capabilities.** Hard-refresh `/tools`. The backend mints the rows on register; the UI's React Query cache may be holding the prior empty list. The default refetch is on focus.
- **Execute returns `runner_offline`.** Your runner's Streamable HTTP session has dropped (laptop sleep, network blip). The daemon auto-reconnects on the next heartbeat tick; retry the execute in 5 seconds.
- **Execute returns `workspace_required`.** You called `shell.exec` without picking a workspace. The picker is required — the backend refuses dispatch otherwise. Pick one or create one from the runner detail page.
- **Runner state stuck at `registered`.** No heartbeat received yet. The daemon heartbeats every 30s by default. Wait for the next interval, or run `almyty runner status` in a third terminal to confirm the daemon is alive.
