# almyty runner demo

Cross-vendor multi-agent workflow on a single runner: a planner, an implementer, and a reviewer, each running through a different CLI agent (potentially using different models), all editing the same codebase.

## Show this to a person

The walkthrough lives at [DEMO.md](DEMO.md). It covers prerequisites, the three commands a real user runs (auth, start runner, run demo), what to watch for in the transcript, the variations (single-CLI fallback, no-CLI install hint, different model per step), and troubleshooting.

The version below is the dev quick-start; for the actual show-and-tell, read DEMO.md.

## Run

```
npm install
npm run demo
```

The demo:

1. Detects which agent CLIs are installed locally (claude, codex, gemini, aider).
2. Copies `fixtures/sample-app` to a fresh temp dir.
3. Runs three subagent calls in order: plan, implement, review.
4. Prints the transcript with section headers showing model and CLI per step.
5. Cleans up the temp dir.

If no agent CLI is installed, prints install commands and exits 0.
If only one is installed, runs all three steps through it.

## Test

```
npm test
```

Runs the orchestrator end-to-end against a stub subagent. Verifies the workspace lifecycle, that all three steps fire in order with the right CLI, that the implementation step actually modifies files in cwd, and that the verdict is captured. No LLM calls; the test exercises the orchestrator's contract.

## What this demo proves

The wedge: an almyty workflow can orchestrate any CLI coding agent with any model, on the user's machine, in one coherent workspace. Anthropic's subagents only call Anthropic models; OpenAI's only call OpenAI's. With a runner, you can have a Claude planner hand work to a Codex implementer hand work back to a Claude reviewer. Or any other combination, in any sequence, scoped to one workspace on one machine.
