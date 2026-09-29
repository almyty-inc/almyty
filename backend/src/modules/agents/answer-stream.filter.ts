/**
 * An autonomous run's events, reduced to its answer as it is written.
 *
 * Shared by every surface that streams an autonomous answer to someone who
 * must see the answer and never the working: the hosted chat, and the
 * OpenAI- and Anthropic-compatible APIs.
 *
 * Every step of an autonomous run streams its model output as `llm.chunk`,
 * and a step that goes on to call tools streams its narration too: what it
 * is about to look up, what the last tool returned, instructions echoed
 * from the system prompt.
 *
 * A run started with `metadata.composeFinalAnswer` (agents/final-answer.ts)
 * announces every call that offers tools as working (`llm.started` with
 * `answer: false`), and nothing of it is passed on; the answer is written by
 * a call that offers none (`answer: true`), which streams token by token as
 * it arrives. Should that call fail, its `llm.response` carries the draft,
 * which then goes out whole.
 *
 * A step not announced either way is held until the provider's stream has
 * said, with certainty, what the step is (`llm.step_kind`, see
 * StreamChunk.stepKind):
 *
 *   text -> the held chunks go out, and the rest stream live
 *   tool -> the held chunks are dropped, and nothing more is sent
 *
 * A step whose provider never says (Gemini, custom endpoints, any type on
 * the non-streaming fallback) streams nothing, and its answer goes out as
 * one token when its `llm.response` lands with no tool calls. That is also
 * where anything the stream did not carry is made up. The response is the
 * last word: if it contradicts what was sent, the sink is told to `reset`.
 * With a verify panel on the final output, or a multi-model strategy that
 * checks or judges candidate answers, nothing is sent before the answer is
 * chosen, and the consumer reads the finished answer from the run instead.
 */
export interface AnswerStreamSink {
  /** A piece of the answer, in order. */
  token(content: string): void;
  /** What was sent so far is not the answer after all. */
  reset(): void;
  /** The run ended (run.completed / run.failed / run.cancelled). */
  done(reason: string): void;
}

export interface AnswerStreamOptions {
  /** withholdsCandidateAnswers(agent): send nothing until the run ends. */
  withholdCandidates?: boolean;
}

type StepStream = { kind: 'text' | 'tool' | null; held: string[]; sent: string; working?: boolean };

const RUN_ENDED = ['run.completed', 'run.failed', 'run.cancelled'];

/** A run-event handler that drives `sink` with the answer and nothing else. */
export function answerStreamFilter(
  sink: AnswerStreamSink,
  options: AnswerStreamOptions = {},
): (event: { type?: string; data?: any }) => void {
  const steps = new Map<number, StepStream>();
  const stepOf = (data: any): number | null => (typeof data?.step === 'number' ? data.step : null);
  const stateOf = (step: number): StepStream => {
    let state = steps.get(step);
    if (!state) {
      state = { kind: null, held: [], sent: '' };
      steps.set(step, state);
    }
    return state;
  };
  const send = (state: StepStream | null, content: string) => {
    sink.token(content);
    if (state) state.sent += content;
  };
  const retract = (state: StepStream | undefined) => {
    if (!state?.sent) return;
    sink.reset();
    state.sent = '';
  };

  return (event) => {
    const type = event?.type;
    const data = event?.data;
    if (type && RUN_ENDED.includes(type)) {
      sink.done(type);
      return;
    }
    if (options.withholdCandidates) return;
    const step = stepOf(data);

    if (type === 'llm.started') {
      // A fresh attempt at this step. Whatever an earlier attempt held
      // or showed is not this attempt's answer.
      if (step === null) return;
      retract(steps.get(step));
      steps.delete(step);
      // Announced: a working call is never shown, and the answer call
      // offers no tools, so it cannot turn out to be anything but text.
      if (data?.answer === false) steps.set(step, { kind: 'tool', held: [], sent: '', working: true });
      else if (data?.answer === true) steps.set(step, { kind: 'text', held: [], sent: '' });
      return;
    }

    if (type === 'llm.chunk') {
      const content = data?.content;
      if (step === null || typeof content !== 'string' || !content) return;
      const state = stateOf(step);
      if (state.kind === 'tool') return;
      if (state.kind === 'text') send(state, content);
      else state.held.push(content);
      return;
    }

    if (type === 'llm.step_kind') {
      if (step === null) return;
      const state = stateOf(step);
      if (state.kind) return; // the first verdict is the one the provider was certain of
      if (data?.kind === 'tool') {
        state.kind = 'tool';
        state.held = [];
        retract(state);
      } else if (data?.kind === 'text') {
        state.kind = 'text';
        for (const content of state.held) send(state, content);
        state.held = [];
      }
      return;
    }

    if (type === 'llm.response') {
      const state = step === null ? undefined : steps.get(step);
      if (step !== null) steps.delete(step);
      // A working step's reply is never the answer, unless the runtime says
      // it now is: the answer call failed and its draft stands in.
      if (state?.working && data?.answer !== true) return;
      const calledTools = Array.isArray(data?.toolCalls) && data.toolCalls.length > 0;
      if (calledTools) {
        retract(state);
        return;
      }
      const content = data?.content;
      if (typeof content !== 'string' || !content) return;
      const sent = state?.sent ?? '';
      if (content.startsWith(sent)) {
        const rest = content.slice(sent.length);
        if (rest) send(null, rest);
      } else {
        retract(state);
        send(null, content);
      }
    }
  };
}
