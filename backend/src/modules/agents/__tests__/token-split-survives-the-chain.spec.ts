import { readFileSync } from 'fs';
import { join } from 'path';
import {
  usageSplitState,
  USAGE_SPLIT_MEASURED,
  USAGE_SPLIT_UNAVAILABLE,
} from '../agent-openai-stream.helper';

/**
 * The prompt/completion split was fabricated (60/40 of the total), then
 * honestly reported as 0/0 once that was caught. Neither was a measurement.
 * The provider returns the split on every LLMResponse -- the node executor
 * threw it away at `tokens: response.usage?.totalTokens` and the engine had
 * one accumulator -- so the fix was to stop discarding it, not to keep
 * apologising for the zeros.
 *
 * These are source-reading assertions on purpose. The chain is
 * provider -> node result -> engine accumulator -> execution row -> response,
 * and it has already been broken twice at the first link by code that
 * compiled and whose tests stayed green.
 */
const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

describe('the token split survives the whole chain', () => {
  it('the node executor keeps the provider split instead of only the total', () => {
    const src = read('agent-node-executor.ts');
    expect(src).toContain('inputTokens: response.usage?.inputTokens');
    expect(src).toContain('outputTokens: response.usage?.outputTokens');
  });

  it('NodeExecutionResult can carry the split', () => {
    const src = read('agent-node-executor.ts');
    expect(src).toMatch(/inputTokens\?: number;/);
    expect(src).toMatch(/outputTokens\?: number;/);
  });

  it('the engine accumulates the split alongside the total', () => {
    const src = read('agent-execution.engine.ts');
    expect(src).toContain('totalInputTokens += result.inputTokens || 0;');
    expect(src).toContain('totalOutputTokens += result.outputTokens || 0;');
  });

  it('every place the engine writes totalTokens also writes the split', () => {
    const src = read('agent-execution.engine.ts');
    const totals = (src.match(/execution\.totalTokens = totalTokens;/g) || []).length;
    const inputs = (src.match(/execution\.inputTokens = totalInputTokens;/g) || []).length;
    const outputs = (src.match(/execution\.outputTokens = totalOutputTokens;/g) || []).length;
    expect(totals).toBeGreaterThan(0);
    // A path that persists the total without the split leaves a run whose
    // split reads 0 for no reason a caller can distinguish from a tool-only
    // pipeline. There are several such paths (success, failure, cancel).
    expect(inputs).toBe(totals);
    expect(outputs).toBe(totals);
  });

  it('the execution row has somewhere to put it', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', '..', 'entities', 'agent-execution.entity.ts'),
      'utf8',
    );
    expect(src).toMatch(/inputTokens: number;/);
    expect(src).toMatch(/outputTokens: number;/);
  });

  it('the migration adds both columns', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', '..', 'migrations', '1750806000000-AgentExecutionTokenSplit.ts'),
      'utf8',
    );
    expect(src).toContain('"inputTokens"');
    expect(src).toContain('"outputTokens"');
    expect(src).toContain('agent_executions');
  });

  it('the OpenAI route reports the recorded split, not zeros and not a ratio', () => {
    const src = read('agent-openai-stream.helper.ts');
    expect(src).toContain('prompt_tokens: execution?.inputTokens || 0');
    expect(src).toContain('completion_tokens: execution?.outputTokens || 0');
    // The fabricated split that started this.
    expect(src).not.toMatch(/0\.6|0\.4|\*\s*0\.6/);
  });

  it('the Anthropic route reports input_tokens rather than hardcoding it away', () => {
    const src = read('agent-anthropic-compat.controller.ts');
    expect(src).toContain('inputTokens: execution.inputTokens ?? 0');
    expect(src).toContain('outputTokens: execution.outputTokens ?? 0');
  });
});

describe('the usage-split header tells the truth about which case it is', () => {
  it('says measured when the run recorded a split', () => {
    expect(usageSplitState({ totalTokens: 100, inputTokens: 70, outputTokens: 30 })).toBe(
      USAGE_SPLIT_MEASURED,
    );
  });

  it('says measured when only one half is non-zero', () => {
    expect(usageSplitState({ totalTokens: 70, inputTokens: 70, outputTokens: 0 })).toBe(
      USAGE_SPLIT_MEASURED,
    );
  });

  it('says unavailable for a run with tokens but no split — a tool-only pipeline', () => {
    expect(usageSplitState({ totalTokens: 100, inputTokens: 0, outputTokens: 0 })).toBe(
      USAGE_SPLIT_UNAVAILABLE,
    );
  });

  it('says unavailable rather than throwing when there is no execution at all', () => {
    expect(usageSplitState(undefined)).toBe(USAGE_SPLIT_UNAVAILABLE);
  });
});
