/**
 * Every model call a run makes is told today's date and the organization's
 * time zone: workflow llm_call, merge-judge, extract_context and decision
 * steps, verify-step checkers, the autonomous loop and its answer call, the
 * autonomous team's roles (workers, judges, checkers, summarisers), the
 * memory keeper, collaboration participants, the orchestrator, the
 * compactor and run_code's extract(). Sub-agents are runs of their own and
 * go through the same calls.
 *
 * Without the date, checkers took their training cutoff for today and
 * rejected real 2026 papers as "from the future". The date is added by the
 * model call itself for a request with `currentTime: true`
 * (LlmChatHelper, common/utils/current-time.ts), so this guard walks every
 * source file of the agents module, finds every model call, and fails on
 * one that does not ask for it.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const AGENTS_DIR = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

/** The text between the parentheses of the call that opens at `open`. */
function argumentsAt(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error('unbalanced call');
}

/** Every `.chat(` / `.chatStream(` call in a file, with its arguments. */
function modelCalls(src: string): Array<{ line: number; args: string }> {
  const out: Array<{ line: number; args: string }> = [];
  const call = /\.(chat|chatStream)\(/g;
  for (let m = call.exec(src); m; m = call.exec(src)) {
    const open = m.index + m[0].length - 1;
    out.push({ line: src.slice(0, m.index).split('\n').length, args: argumentsAt(src, open) });
  }
  return out;
}

/**
 * Model calls in the agents module that are not a run's: a pass-through of
 * a caller's own request to a model, which carries the caller's prompt as
 * it was sent.
 */
const NOT_A_RUN = new Set(['model-pass-through.service.ts']);

describe("every model call of a run is told today's date", () => {
  const files = sourceFiles(AGENTS_DIR);
  const calls = files.flatMap((file) =>
    modelCalls(readFileSync(file, 'utf8')).map((c) => ({ ...c, file: relative(AGENTS_DIR, file) })),
  );

  it('finds the model-calling paths it guards', () => {
    const where = new Set(calls.map((c) => c.file));
    for (const file of [
      'agent-node-executor.ts', // llm_call, merge judge, extract_context, decision
      'agent-verifier.helper.ts', // verify-step and final-answer checkers
      'agent-step-processor.ts', // the autonomous loop, its answer call, run_code extract()
      'autonomous-strategy.runner.ts', // the team's roles: workers, judges, checkers, summarisers
      'agent-collaboration.helper.ts',
      'agent-context-compactor.helper.ts',
      'strategies/orchestrator.service.ts',
    ]) {
      expect(where).toContain(file);
    }
  });

  it.each(
    sourceFiles(AGENTS_DIR).flatMap((file) =>
      modelCalls(readFileSync(file, 'utf8')).map((c) => [`${relative(AGENTS_DIR, file)}:${c.line}`, c.args] as const),
    ),
  )('%s asks for the date', (_where, args) => {
    expect(args).toMatch(/currentTime:\s*true/);
  });

  it('nothing in the module calls a model past LlmProvidersService, but the pass-through', () => {
    const direct = files
      .filter((file) => /callLlmProviderHttp(Stream)?\(|dispatchProviderCall\(|callLlmProvider\(/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(AGENTS_DIR, file));
    expect(direct.filter((f) => !NOT_A_RUN.has(f))).toEqual([]);
  });

  it('the memory keeper calls through the strategy runner, which asks for it', () => {
    const keeper = readFileSync(join(AGENTS_DIR, 'agent-memory.keeper.ts'), 'utf8');
    expect(keeper).toMatch(/this\.runner\.callModel\(/);
    expect(keeper).not.toMatch(/llmProvidersService/);
  });

  it('the model call adds it for a request that asks (LlmChatHelper)', () => {
    const helper = readFileSync(join(AGENTS_DIR, '..', 'llm-providers', 'llm-chat.helper.ts'), 'utf8');
    for (const method of ['async chat(', 'async chatStream(']) {
      const body = helper.slice(helper.indexOf(method), helper.indexOf('try {', helper.indexOf(method)));
      expect(body).toMatch(/request = await this\.datedRequest\(request, organizationId\)/);
    }
  });
});
