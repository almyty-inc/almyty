# Driving coding agents with the runner

The runner is a generic process surface, but it also ships first-class knowledge
of the coding-agent CLIs — the same platforms [maco](../../../maco) drives. That
turns "spawn any binary" into "spawn a named coding agent, unattended, and watch
its status," which is the substrate for multi-vendor orchestration.

## Supported platforms

Detected at startup and reported in `runner.info` → `runtime.codingAgents`.
Per-platform levers (auth env, isolated config home, auto-approve flag, resume
mechanism) come from each CLI's docs; see
[`maco/docs/briefs/cli-feature-matrix.md`](../../../maco/docs/briefs/cli-feature-matrix.md).

| Platform | binary | provider family | API key env | config-home env | auto-approve |
|---|---|---|---|---|---|
| Claude Code | `claude` | anthropic | `ANTHROPIC_API_KEY` | `CLAUDE_CONFIG_DIR` | `--dangerously-skip-permissions` |
| Codex | `codex` | openai | `OPENAI_API_KEY` | `CODEX_HOME` | `--dangerously-bypass-approvals-and-sandbox` |
| Gemini CLI | `gemini` | google | `GEMINI_API_KEY` | _(HOME)_ | `--yolo` |
| Cursor Agent | `cursor-agent` | cursor | `CURSOR_API_KEY` | _(HOME)_ | `--force` |
| OpenCode | `opencode` | _(byo)_ | `ANTHROPIC/OPENAI_API_KEY` | _(HOME)_ | _(config)_ |
| Crush | `crush` | _(byo)_ | `*_API_KEY` | _(HOME)_ | `--yolo` |
| GitHub Copilot CLI | `copilot` | github | `COPILOT_GITHUB_TOKEN` | `COPILOT_HOME` | `--yolo` |
| Grok CLI | `grok` | xai | `XAI_API_KEY` | _(HOME)_ | `--always-approve` |
| Hermes | `hermes` | nous | `*_API_KEY` | `HERMES_HOME` | `--yolo` |
| Mistral Vibe | `vibe` | mistral | `MISTRAL_API_KEY` | `VIBE_HOME` | `--yolo` |
| OpenClaw | `openclaw` | _(byo)_ | `OPENAI/ANTHROPIC_API_KEY` | `OPENCLAW_CONFIG_PATH` | `exec-policy preset yolo` |
| Aider | `aider` | _(byo)_ | `ANTHROPIC/OPENAI_API_KEY` | _(HOME)_ | `--yes-always` |

## The agent.* RPC surface

Three methods on top of the generic `process.*` surface:

- **`agent.list`** → the catalog above (what this runner *can* drive + the
  levers per CLI). What's actually installed is in `runner.info`.
- **`agent.spawn`** `{ platform, apiKey?, apiKeyEnvVar?, configDir?, autoApprove?,
  model?, resumeSessionId?, extraArgs?, cwd? }` → launches the CLI as an
  unattended member. Builds the spawn spec (headless auth + isolated config home
  + auto-approve + resume) and runs it through the **same execution policy** as
  `process.spawn` — a coding agent gets no privilege the generic surface
  wouldn't. Returns `{ processId, platform, binary, args }`.
- **`agent.status`** `{ processId, platform? }` → non-destructively classifies
  the pane: `busy | idle | awaiting_input | awaiting_auth | error | exited`.
  Resolves the platform from the process's binary, strips VT escapes from the
  latest repaint frame, and runs the per-CLI status table. Does **not** drain
  the agent's own `process.read` buffer.

Drive a member with the existing surface: `process.write` to type into it,
`process.read` to pull output, `process.wait_for_idle` to await a turn, and
`agent.status` to know whether it's working, done, or stuck on a prompt.

## Example: a single member

```jsonc
// 1. launch Claude Code in an isolated config home, unattended
→ agent.spawn { workspaceId, platform: "claude",
                apiKey: "<ANTHROPIC_API_KEY>",
                configDir: "/run/almyty/ws/claude",
                cwd: "/repo" }
← { processId: "proc_…", platform: "claude", binary: "claude",
    args: ["--dangerously-skip-permissions"] }

// 2. give it a task
→ process.write { processId, data: "Add a /health endpoint and a test.\r" }

// 3. poll status until it's back at the prompt
→ agent.status { processId }      ← { status: "busy" }
→ agent.status { processId }      ← { status: "idle" }   // turn complete

// 4. read what it produced
→ process.read { processId }      ← { data: "…diff + test…" }
```

## Example: multi-vendor orchestration (the manager pattern)

One orchestrating agent fans a task across **three vendors in parallel**, each in
its own isolated config home, then compares results — the maco "team" pattern,
expressed over the runner's RPC surface. Each member authenticates from its own
provider key, so this is genuinely multi-vendor: Anthropic + OpenAI + Google
working the same problem at once.

```jsonc
// fan out — three coding CLIs, three providers, three isolated homes
for (const m of [
  { platform: "claude", key: ANTHROPIC_API_KEY, home: "/run/almyty/ws/claude" },
  { platform: "codex",  key: OPENAI_API_KEY,    home: "/run/almyty/ws/codex"  },
  { platform: "gemini", key: GEMINI_API_KEY,    home: "/run/almyty/ws/gemini" },
]) {
  → agent.spawn { workspaceId, platform: m.platform, apiKey: m.key,
                  configDir: m.home, cwd: "/repo" }
  → process.write { processId, data: TASK + "\r" }
}

// watch loop — poll agent.status across all members; act on transitions
//   busy            → keep waiting
//   idle            → turn done; process.read the result, give the next step
//   awaiting_input  → answer its prompt with process.write
//   awaiting_auth   → a key/ToS gate — inject the key or surface to the human
//   error / exited  → reap and (optionally) respawn that member
```

The two-tier status is what makes the watch loop possible without a human
babysitting each pane: `awaiting_input` and `awaiting_auth` are distinct from
`busy`, so the orchestrator knows the difference between "still thinking" and
"stuck waiting on me."

### What's real vs. what the orchestration is

The platform catalog, spawn-spec wiring, and status classifier are real and
tested (`test/coding-agents.spec.ts`, `test/agent-handlers.spec.ts`). The
*orchestration policy* — fan-out, the watch loop, task routing — lives in the
calling agent's prompt/logic, not baked into the runner. The runner gives you
the primitives (spawn the right CLI correctly, know its live status); the agent
composes them. Single-runner-per-account still applies in v1.0, so the fan-out
above runs on one machine.
