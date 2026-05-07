/**
 * almyty runner demo: cross-vendor multi-agent workflow on one runner.
 *
 * The wedge: PM agent (any model) plans, dispatches subtasks to
 * specialist agents (different CLIs, different models), all editing
 * the same codebase on the same runner.
 *
 * v1.0 demo workflow:
 *   1. Plan       (default: Claude Code CLI / Anthropic)
 *   2. Implement  (default: Codex CLI / OpenAI)
 *   3. Review     (default: Claude Code CLI / Anthropic)
 *
 * Designed so the orchestration is testable end-to-end without real
 * LLM calls: every external dependency (workspace, subagent CLI) is
 * an injection point. The CLI entrypoint wires real implementations;
 * the demo.spec.ts test wires stubs. Both run the same orchestrator.
 */

import { mkdirSync, existsSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Public types ────────────────────────────────────────────────────

export interface SubagentRequest {
  /** Step name shown in the transcript header. */
  step: 'plan' | 'implement' | 'review';
  /** CLI name (claude, codex, gemini, aider) or stub identifier. */
  cli: string;
  /** Model identifier the subagent should use. Optional. */
  model?: string;
  /** Prompt content to pass to the subagent. */
  prompt: string;
  /** cwd inside which the subagent reads/edits files. */
  cwd: string;
}

export interface SubagentResult {
  /** Stdout (and stderr) captured from the subagent. */
  output: string;
  /** Files modified by this step (relative to cwd). Empty if read-only. */
  filesModified: string[];
  /**
   * Free-form structured field a step can fill in. The 'review' step
   * uses this to surface a verdict the orchestrator records.
   */
  metadata?: Record<string, unknown>;
}

export type Subagent = (req: SubagentRequest) => Promise<SubagentResult>;

export interface DemoWorkspace {
  /** Directory the subagents operate inside. */
  cwd: string;
  /**
   * Optional release callback. When the demo finishes (success or
   * fail), this runs. With a real runner this dispatches the workspace
   * release envelope; with the stub it's a no-op.
   */
  release?: () => Promise<void>;
}

export interface DemoOptions {
  workspace: DemoWorkspace;
  /**
   * Available CLIs detected from runner.info(). Keys are CLI names,
   * values are versions (or null). The orchestrator picks plan/
   * implement/review CLIs from this map.
   */
  availableClis: Record<string, string | null>;
  /** Subagent invoker. Real impl spawns CLIs; tests stub. */
  subagent: Subagent;
  /**
   * Stream of human-readable transcript lines. Defaults to
   * console.log; tests can capture into an array.
   */
  log?: (line: string) => void;
}

export interface DemoResult {
  steps: Array<{ step: SubagentRequest['step']; cli: string; output: string; filesModified: string[] }>;
  verdict: string | null;
  filesModifiedTotal: string[];
}

// ── Orchestrator ────────────────────────────────────────────────────

const PREFERRED_CLIS = {
  plan: ['claude', 'gemini', 'codex', 'aider'],
  implement: ['codex', 'aider', 'claude', 'gemini'],
  review: ['claude', 'gemini', 'codex', 'aider'],
};

/**
 * Decide which CLI to dispatch each of the three steps to. Honors the
 * spec's robustness rule: prefer the diversity in PREFERRED_CLIS, but
 * fall back to the same CLI for all three steps if only one is
 * installed (with different model flags). If none are installed, the
 * caller short-circuits with an install hint and exits 0.
 */
export function pickCliPlan(
  available: Record<string, string | null>,
): { plan: string; implement: string; review: string } | null {
  const present = Object.entries(available)
    .filter(([, v]) => v != null)
    .map(([name]) => name);

  const intersect = (preferred: string[]) =>
    preferred.find(name => present.includes(name));

  if (present.length === 0) return null;

  if (present.length === 1) {
    // Single-CLI fallback: one CLI for all three steps. Models can
    // still differ; the subagent's --model flag is set per-step by
    // the caller.
    const only = present[0];
    return { plan: only, implement: only, review: only };
  }

  return {
    plan: intersect(PREFERRED_CLIS.plan) ?? present[0],
    implement: intersect(PREFERRED_CLIS.implement) ?? present[0],
    review: intersect(PREFERRED_CLIS.review) ?? present[0],
  };
}

export async function runDemo(opts: DemoOptions): Promise<DemoResult> {
  const log = opts.log ?? ((line: string) => process.stdout.write(line + '\n'));
  const plan = pickCliPlan(opts.availableClis);
  if (!plan) {
    throw new InstallMessage(
      'No agent CLI detected. Install at least one and try again:\n' +
        '  npm i -g @anthropic-ai/claude-code\n' +
        '  npm i -g @openai/codex-cli\n' +
        '  npm i -g @google/gemini-cli\n' +
        '  pip install aider-chat',
    );
  }

  const steps: DemoResult['steps'] = [];
  const filesModifiedTotal = new Set<string>();
  let verdict: string | null = null;

  try {
    log(`# almyty runner demo`);
    log(`# cwd: ${opts.workspace.cwd}`);
    log(`# CLIs: plan=${plan.plan} implement=${plan.implement} review=${plan.review}\n`);

    // ── Step 1: plan ───────────────────────────────────────────────
    log(`## plan (${plan.plan})`);
    const planResult = await opts.subagent({
      step: 'plan',
      cli: plan.plan,
      prompt:
        `You are the planner. Output the smallest plan to add a GET /health endpoint to this app ` +
        `that returns {status:'ok'}, and one passing test for it. Output the plan only, no code.`,
      cwd: opts.workspace.cwd,
    });
    steps.push({ step: 'plan', cli: plan.plan, output: planResult.output, filesModified: planResult.filesModified });
    planResult.filesModified.forEach(f => filesModifiedTotal.add(f));
    log(planResult.output + '\n');

    // ── Step 2: implement ──────────────────────────────────────────
    log(`## implement (${plan.implement})`);
    const implResult = await opts.subagent({
      step: 'implement',
      cli: plan.implement,
      prompt:
        `You are the implementer. Apply the plan below to the files in cwd. Modify only what is ` +
        `necessary; do not commit. Plan:\n\n${planResult.output}`,
      cwd: opts.workspace.cwd,
    });
    steps.push({ step: 'implement', cli: plan.implement, output: implResult.output, filesModified: implResult.filesModified });
    implResult.filesModified.forEach(f => filesModifiedTotal.add(f));
    log(implResult.output + '\n');
    log(`# files modified: ${implResult.filesModified.join(', ') || '(none)'}\n`);

    // ── Step 3: review ─────────────────────────────────────────────
    log(`## review (${plan.review})`);
    const reviewResult = await opts.subagent({
      step: 'review',
      cli: plan.review,
      prompt:
        `You are the reviewer. Run \`git diff\` and \`npm test\`. If tests fail, suggest a one-line ` +
        `fix. Output only your verdict (PASS or FAIL with reason).`,
      cwd: opts.workspace.cwd,
    });
    steps.push({ step: 'review', cli: plan.review, output: reviewResult.output, filesModified: reviewResult.filesModified });
    reviewResult.filesModified.forEach(f => filesModifiedTotal.add(f));
    verdict = (reviewResult.metadata?.verdict as string | undefined) ?? extractVerdict(reviewResult.output);
    log(reviewResult.output + '\n');
    log(`# verdict: ${verdict ?? '(none captured)'}\n`);

    return {
      steps,
      verdict,
      filesModifiedTotal: [...filesModifiedTotal],
    };
  } finally {
    if (opts.workspace.release) {
      try {
        await opts.workspace.release();
      } catch (err: any) {
        log(`# warning: workspace release failed: ${err.message}`);
      }
    }
  }
}

export class InstallMessage extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallMessage';
  }
}

// ── Workspace fixture helpers (used by the CLI entry, not the test) ─

/** Copy fixtures/sample-app to a fresh temp dir. Keeps the fixture clean. */
export function copyFixtureToTempDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const fixture = join(here, '..', 'fixtures', 'sample-app');
  const dest = join(process.cwd(), '.almyty-demo-' + Date.now());
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
  copyTree(fixture, dest);
  return dest;
}

function copyTree(src: string, dst: string): void {
  for (const entry of readdirSync(src)) {
    const sp = join(src, entry);
    const dp = join(dst, entry);
    const st = statSync(sp);
    if (st.isDirectory()) {
      mkdirSync(dp, { recursive: true });
      copyTree(sp, dp);
    } else {
      copyFileSync(sp, dp);
    }
  }
}

function extractVerdict(text: string): string | null {
  const m = /\b(PASS|FAIL)\b[^\n]*/i.exec(text);
  return m ? m[0].trim() : null;
}
