# Live demo: cross-vendor multi-agent loop on your laptop

A 5-minute walkthrough you can show a colleague. Three CLI agents (a planner, an implementer, a reviewer), three different LLM providers (or one with three different models if that's what you have installed), all editing the same codebase on the same machine in one workspace.

If you only want to verify the wiring, the stub-driven Vitest spec at `test/demo.spec.ts` does it without LLM calls. This file is for the version a person can watch.

## What you'll see

1. A runner registers your laptop with almyty in one terminal command.
2. The almyty UI shows the runner online with detected binaries.
3. A demo script copies a tiny Node app to a temp dir, then dispatches three subagents:
   - **Plan** (default: Claude Code CLI, Anthropic) — outputs a 2-step plan to add a `/health` endpoint.
   - **Implement** (default: Codex CLI, OpenAI) — modifies `index.js` and writes a passing test.
   - **Review** (default: Claude Code CLI, Anthropic) — runs `git diff` + `npm test` and outputs PASS or FAIL.
4. Each step prints to your terminal with a section header showing the CLI used. The final transcript shows the diff and the verdict.

The runner picks the CLI per step from what's installed on your machine. If you only have one of claude / codex / gemini / aider installed, all three steps go through that one CLI (with different model flags). If you have none, the script prints install commands and exits cleanly.

## Prerequisites

- **Node 20+** (for the runner and the demo script).
- **An almyty account.** If you're running this against staging or your local dev backend, log in to the corresponding URL first.
- **At least one agent CLI on PATH.** Any one of:
  ```
  npm i -g @anthropic-ai/claude-code
  npm i -g @openai/codex-cli
  npm i -g @google/gemini-cli
  pip install aider-chat
  ```
  More than one is better — that's where the cross-vendor part of the demo shines.
- **A real LLM API key for each agent CLI you installed.** The runner doesn't proxy LLM calls; the agent CLIs make them directly with whatever credentials you have configured for them (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.).

## Step 1: Authenticate

```
npx @almyty/auth login
```

Opens a browser. One-time per machine. The runner and every other almyty CLI pick this credential up automatically.

## Step 2: Start the runner

```
npm i -g @almyty/runner
almyty-runner start --name laptop --label env=demo
```

You'll see the daemon log:

```
almyty-runner v0.1.0 starting
name=laptop url=https://api.almyty.com
detected 4/15 binaries on PATH
registered as <runner-id>
runner online; press ctrl-c to exit
```

Leave this terminal open. The daemon stays alive listening for jobs.

You can also drive this step from the UI: open **Runners → Start a runner** in the almyty app. The page generates the exact command, copies on click, and waits for the heartbeat — once the daemon registers, it auto-redirects you to the runner detail.

## Step 3: Run the demo

In a second terminal:

```
git clone https://github.com/frane/almyty.git
cd almyty/examples/runner-demo
npm install
npm run demo
```

The script:
1. Detects which agent CLIs are installed locally.
2. Copies `fixtures/sample-app` to a fresh temp directory (your real fixture stays clean).
3. Picks plan / implement / review CLIs from what's available, prefering Claude Code → Codex → Claude Code if all are installed.
4. Streams the transcript to your terminal.
5. Cleans up the temp dir at the end.

Expected transcript (with claude + codex installed):

```
# fixture copied to /Users/you/almyty/examples/runner-demo/.almyty-demo-1700000000000
# almyty runner demo
# cwd: <temp-dir>
# CLIs: plan=claude implement=codex review=claude

## plan (claude)
1. Add a route handler for GET /health to index.js that returns
   { status: 'ok' } with a 200 status code.
2. Add a test in test-health.js using node:test that asserts
   GET /health returns 200.

## implement (codex)
Implemented /health endpoint and added a passing test.
# files modified: ./index.js, ./test-health.js

## review (claude)
Diff looks correct, tests would pass. Verdict: PASS

# verdict: PASS
```

That's the wedge. Three CLIs from two vendors edited the same codebase in one coherent workspace.

## What just happened, technically

- **Step 2's runner** registered with the almyty backend and opened a Streamable HTTP connection. Heartbeat every 30s.
- **Step 3's demo** is a local-only orchestrator (it doesn't dispatch through the backend; that lands in a follow-up cluster). It calls each agent CLI as a subprocess, captures stdout, and snapshots cwd mtimes before/after to report which files changed.
- The backend's runner state machine ticked the runner from `registered` to `online` on first heartbeat. If you'd created a workspace via the UI or API and pinned a job to the runner, it would have been dispatched over the Streamable HTTP envelope flow built in cluster 1; the demo skips that for now to keep the moving parts visible.

## Stop the runner

In the runner terminal: `ctrl-c` for clean shutdown (the daemon sends a `runner.draining` event and exits). Or from the UI / another terminal:

```
almyty-runner stop
```

In the UI, the runner state goes to `draining` and then `offline` after the grace window.

## Variations to try

- **Single-CLI fallback**: uninstall all but one agent CLI, re-run the demo. The transcript shows all three steps going through the same CLI; per-step model flags would differ in a real workflow.
- **No CLI installed**: uninstall all of them, re-run. The demo prints the install commands and exits with status 0.
- **Different model per step**: edit `examples/runner-demo/src/spawn-subagent.ts` to pass a `--model` flag per step. The orchestrator already threads it through — wire it from the script if you want to demo, e.g., Claude Sonnet → GPT-5 → Claude Opus.

## Troubleshooting

- **Demo prints "No agent CLI detected" but I have claude installed.**
  Make sure `claude --version` works from the same shell. `npx @anthropic-ai/claude-code --version` doesn't count; we probe binaries on PATH only.
- **Demo hangs on the implement step.**
  Some CLIs prompt for confirmation before editing files. Check the agent CLI's docs for a flag like `--yes` / `--no-confirm` / `--auto-apply` and add it to `buildArgs()` in `src/spawn-subagent.ts`.
- **Verdict came back FAIL.**
  That's a real signal — the implementer's diff didn't pass the test. Run `git diff` in the temp dir before it cleans up to inspect what happened. The temp dir path is in the transcript's first line.
