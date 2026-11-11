/**
 * An answer whose check did not pass is delivered marked, on every surface.
 *
 * The marker is put on the answer once, where the run completes
 * (agent-step-processor.ts), on `run.output` and on the saved assistant
 * message. A surface delivers it unmarked only if it shows the answer before
 * the run completes, from the streamed events. These checks fail when:
 *
 *  - the completion stops marking, or marks after the answer is stored;
 *  - a verify panel on the final output stops holding streamed candidates back;
 *  - a new surface streams a run's answer without holding candidates back
 *    the way hosted chat, the widget and the compat APIs do.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

import { markUnverifiedAnswer, unverifiedLine, unverifiedReason, UNVERIFIED_ANSWER_LEAD } from '../unverified-answer';
import { withholdsCandidateAnswers } from '../final-answer';

const SRC = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'test' || name === 'node_modules') continue;
      walk(full, out);
    } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('the unverified-answer marker', () => {
  it('puts one plain line with the first failed rule above the answer', () => {
    const marked = markUnverifiedAnswer('The total is 40.', [{ rule: 'sum is wrong.', evidence: 'row 7' }]);
    expect(marked).toBe("Note: this answer's check didn't pass: sum is wrong.\n\nThe total is 40.");
    expect(marked).not.toContain('row 7');
  });

  it('says something plain when the checkers gave no rule, and marks once', () => {
    expect(unverifiedLine([])).toBe(`${UNVERIFIED_ANSWER_LEAD}: the checkers found problems that were not fixed.`);
    const once = markUnverifiedAnswer('x', []);
    expect(markUnverifiedAnswer(once, [])).toBe(once);
  });

  it('keeps the reason short', () => {
    expect(unverifiedReason([{ rule: 'a'.repeat(500) }]).length).toBeLessThanOrEqual(160);
  });
});

describe('every delivery path carries the marker', () => {
  it('the run completion marks the answer before storing and saving it', () => {
    const src = read('modules/agents/agent-step-processor.ts');
    const mark = src.indexOf('finalContent = markUnverifiedAnswer(finalContent, failedCheck)');
    const msg = src.indexOf('if (finalMsg) finalMsg.content = finalContent');
    const save = src.indexOf('if (finalMsg) await this.s.messageRepository.save(finalMsg);', mark);
    const output = src.indexOf('run.output = finalContent;', mark);
    expect(mark).toBeGreaterThan(-1);
    expect(msg).toBeGreaterThan(mark);
    expect(save).toBeGreaterThan(msg);
    expect(output).toBeGreaterThan(save);
    // One completion: a second place that completes a run would skip the marker.
    expect(src.match(/run\.status = AgentRunStatus\.COMPLETED/g)).toHaveLength(1);
  });

  it('a verify panel on the final output holds streamed candidates back', () => {
    expect(
      withholdsCandidateAnswers({ agentConfig: { verify: { enabled: true, checkers: [{ providerId: 'p' }] } } } as any),
    ).toBe(true);
  });

  it('every surface that streams a run answer holds candidates back for a verify panel', () => {
    // The runtime itself, and the shared pieces every surface goes through.
    const runtime = new Set([
      'modules/agents/agent-step-processor.ts',
      'modules/agents/llm-stream-events.ts',
      'modules/agents/stream-event.types.ts',
      'modules/agents/answer-stream.filter.ts',
    ]);
    const streamers = walk(join(SRC, 'modules'))
      .map((f) => relative(SRC, f))
      .filter((f) => !runtime.has(f))
      .filter((f) => /answerStreamFilter|'llm\.chunk'|'llm\.response'/.test(read(f)));
    // Hosted chat and the widget (visitor-reply-stream) and the compat APIs (compat-agent-invoker).
    expect(streamers.sort()).toEqual(
      ['modules/agents/compat-agent-invoker.service.ts', 'modules/gateways/channels/visitor-reply-stream.ts'].sort(),
    );
    for (const f of streamers) {
      const src = read(f);
      expect({ file: f, withholds: /withholdCandidates:\s*\w/.test(src) && src.includes('withholdsCandidateAnswers(') }).toEqual({
        file: f,
        withholds: true,
      });
    }
  });
});
