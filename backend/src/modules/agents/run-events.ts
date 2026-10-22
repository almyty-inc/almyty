import type { AgentRun } from '../../entities/agent-run.entity';

/**
 * The run event log, step 1 of durable runs (docs/design/durable-runs.md).
 *
 * Every commit of an autonomous step appends the events that describe what
 * it did to `agent_run_events`, in the same transaction as the run row
 * write. Nothing reads them yet: `projectRunEvents` folding them back into
 * the row's state is the check that they are complete, and the read path
 * the later steps build on.
 *
 * Two kinds of event. State events carry what the fold needs to rebuild
 * the row: `run_started`, the step events, `memory_changed`,
 * `metadata_changed` and `step_committed`. Markers (`status_changed`,
 * `approval_requested`, `approval_resolved`, `waiting_input`, `compaction`,
 * `run_completed`, `run_failed`) say what happened in the words a reader or
 * a stream wants and change nothing in the fold.
 */
export const RUN_EVENT_TYPES = [
  'run_started',
  'model_call',
  'tool_call',
  'tool_result',
  'step_recorded',
  'step_replaced',
  'steps_reset',
  'memory_changed',
  'metadata_changed',
  'compaction',
  'approval_requested',
  'approval_resolved',
  'waiting_input',
  'status_changed',
  'run_completed',
  'run_failed',
  'step_committed',
] as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

/** An event before it has a seq. */
export interface RunEventDraft {
  type: RunEventType;
  /** The step number the commit processed (the CAS's expected step). */
  step: number | null;
  payload: Record<string, any>;
}

/** An event as stored. */
export interface RunEventRecord {
  seq: number;
  type: string;
  step?: number | null;
  payload: Record<string, any>;
}

type Step = AgentRun['steps'][number];

type CommittedRun = Pick<
  AgentRun,
  'status' | 'currentStep' | 'totalCost' | 'totalTokens' | 'toolCallCount' | 'executionTime' | 'output' | 'error' | 'workingMemory' | 'metadata' | 'steps'
>;

/** The run row's state the log describes. */
export interface RunState {
  status: string;
  currentStep: number;
  totalCost: number;
  totalTokens: number;
  toolCallCount: number;
  executionTime: number;
  output: any;
  error: string | null;
  workingMemory: any;
  metadata: any;
  steps: Step[];
}

export interface RunProjection extends RunState {
  /** The seq of the last event folded. */
  headSeq: number;
}

/**
 * What the row held when a worker loaded it (or last committed it): the
 * values a commit is diffed against. `stepRefs` are the in-memory step
 * objects, which are append-only once pushed (see stepsForPersist), so a
 * new step is one past the baseline length and a replaced one is a
 * different object at the same index.
 */
export interface RunBaseline {
  headSeq: number;
  status: string;
  currentStep: number;
  output: any;
  error: string | null;
  workingMemory: any;
  metadata: any;
  stepRefs: unknown[];
}

/** Fields of a tool step that are its result, carried by `tool_result`. */
const RESULT_KEYS: readonly string[] = ['output', 'error', 'duration', 'cost', 'tokens'];
/** Step types recorded as a tool_call + tool_result pair. */
const TOOL_STEP_TYPES = new Set(['tool_call', 'sub_agent_call']);

/** The value as a json column hands it back: undefined dropped, dates as strings. */
export function asStored<T>(value: T): T {
  if (value === undefined) return null as T;
  return JSON.parse(JSON.stringify(value));
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const isPlainObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

export function baselineOf(run: Omit<CommittedRun, 'totalCost' | 'totalTokens' | 'toolCallCount' | 'executionTime'> & { headSeq?: number }): RunBaseline {
  return {
    headSeq: run.headSeq ?? 0,
    status: run.status,
    currentStep: run.currentStep ?? 0,
    output: asStored(run.output ?? null),
    error: run.error ?? null,
    workingMemory: asStored(run.workingMemory ?? null),
    metadata: asStored(run.metadata ?? null),
    stepRefs: Array.isArray(run.steps) ? [...run.steps] : [],
  };
}

/** A top-level change of a json object column: keys set and keys removed, or the whole value when either side is not an object. */
function diffObject(before: any, after: any): Record<string, any> | null {
  if (same(before, after)) return null;
  if (!isPlainObject(before) || !isPlainObject(after)) return { replace: after ?? null };
  const set: Record<string, any> = {};
  const unset: string[] = [];
  for (const [key, value] of Object.entries(after)) {
    if (!same(before[key], value)) set[key] = value;
  }
  for (const key of Object.keys(before)) if (!(key in after)) unset.push(key);
  return { ...(Object.keys(set).length ? { set } : {}), ...(unset.length ? { unset } : {}) };
}

function applyObjectChange(current: any, change: Record<string, any>): any {
  if ('replace' in change) return change.replace;
  const next = { ...(isPlainObject(current) ? current : {}) };
  for (const [key, value] of Object.entries(change.set ?? {})) next[key] = value;
  for (const key of change.unset ?? []) delete next[key];
  return next;
}

/** The approvals a run is waiting on, by id, read from its working memory. */
function approvalsWaiting(memory: any): Map<string, Record<string, any>> {
  const out = new Map<string, Record<string, any>>();
  if (!isPlainObject(memory)) return out;
  for (const call of Array.isArray(memory.gatedToolCalls) ? memory.gatedToolCalls : []) {
    if (call?.approvalId) out.set(call.approvalId, asStored({ approvalId: call.approvalId, kind: 'tool_call', tool: call.toolName, rule: call.rule, toolCallId: call.toolCallId }));
  }
  for (const set of Array.isArray(memory.pendingChangeSets) ? memory.pendingChangeSets : []) {
    if (set?.approvalId) out.set(set.approvalId, asStored({ approvalId: set.approvalId, kind: 'change_set', codeExecutionId: set.codeExecutionId, toolCallId: set.toolCallId }));
  }
  return out;
}

/** The events for one persisted step at `index`. */
function stepEvents(step: Step, index: number, nextCall: () => number, at: number): RunEventDraft[] {
  const type = (step as any)?.type;
  if (TOOL_STEP_TYPES.has(type)) {
    const call: Record<string, any> = {};
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(step as Record<string, any>)) {
      (RESULT_KEYS.includes(key) ? result : call)[key] = value;
    }
    const callIndex = nextCall();
    return [
      { type: 'tool_call', step: at, payload: { index, callIndex, step: call } },
      { type: 'tool_result', step: at, payload: { index, callIndex, result } },
    ];
  }
  if (type === 'llm_call') return [{ type: 'model_call', step: at, payload: { index, step } }];
  return [{ type: 'step_recorded', step: at, payload: { index, step } }];
}

/**
 * What a commit changes, as events, in order. `steps` is the array as the
 * row will store it (capped, personal data hidden), index-aligned with
 * `run.steps`. `notes` are markers the processor recorded during the step
 * that leave no other trace in the row (a compaction).
 */
export function commitEvents(base: RunBaseline, run: CommittedRun, steps: Step[], notes: RunEventDraft[] = []): RunEventDraft[] {
  const at = base.currentStep;
  const persisted: Step[] = asStored(Array.isArray(steps) ? steps : []);
  const memory = asStored(run.workingMemory ?? null);
  const metadata = asStored(run.metadata ?? null);
  const output = asStored(run.output ?? null);
  const error = run.error ?? null;
  const baseLength = base.stepRefs.length;
  const events: RunEventDraft[] = [];

  // The first commit of a run opens its log with what the row held before
  // it: the input-side state a fold starts from.
  if (base.headSeq === 0) {
    events.push({
      type: 'run_started',
      step: at,
      payload: {
        status: base.status,
        currentStep: base.currentStep,
        output: base.output,
        error: base.error,
        workingMemory: base.workingMemory,
        metadata: base.metadata,
        steps: persisted.slice(0, Math.min(baseLength, persisted.length)),
      },
    });
  }

  events.push(...notes.map((n) => ({ ...n, step: n.step ?? at, payload: asStored(n.payload) })));

  const before = approvalsWaiting(base.workingMemory);
  const after = approvalsWaiting(memory);
  for (const id of before.keys()) if (!after.has(id)) events.push({ type: 'approval_resolved', step: at, payload: { approvalId: id } });

  if (persisted.length < baseLength) {
    events.push({ type: 'steps_reset', step: at, payload: { steps: persisted } });
  } else {
    const live = Array.isArray(run.steps) ? run.steps : [];
    let calls = 0;
    const nextCall = () => calls++;
    for (let i = 0; i < persisted.length; i++) {
      if (i < baseLength) {
        if (live[i] !== base.stepRefs[i]) events.push({ type: 'step_replaced', step: at, payload: { index: i, step: persisted[i] } });
        continue;
      }
      events.push(...stepEvents(persisted[i], i, nextCall, at));
    }
  }

  const memoryChange = diffObject(base.workingMemory, memory);
  if (memoryChange) events.push({ type: 'memory_changed', step: at, payload: memoryChange });
  const metadataChange = diffObject(base.metadata, metadata);
  if (metadataChange) events.push({ type: 'metadata_changed', step: at, payload: metadataChange });

  let asked = 0;
  for (const [id, detail] of after) {
    if (before.has(id)) continue;
    events.push({ type: 'approval_requested', step: at, payload: detail });
    asked++;
  }
  // The request_approval tool pauses the run with no held call in working
  // memory: the request is the run itself.
  if (!asked && !after.size && run.status === 'waiting_approval' && base.status !== 'waiting_approval') {
    events.push({ type: 'approval_requested', step: at, payload: { kind: 'run' } });
  }

  if (run.status !== base.status) {
    events.push({ type: 'status_changed', step: at, payload: { from: base.status, to: run.status } });
    if (run.status === 'waiting_input') events.push({ type: 'waiting_input', step: at, payload: {} });
    if (run.status === 'completed') events.push({ type: 'run_completed', step: at, payload: {} });
    if (run.status === 'failed') events.push({ type: 'run_failed', step: at, payload: { error } });
  }

  // Always last: the row's scalars as this commit leaves them.
  events.push({
    type: 'step_committed',
    step: at,
    payload: {
      status: run.status,
      currentStep: run.currentStep,
      totalCost: run.totalCost ?? 0,
      totalTokens: run.totalTokens ?? 0,
      toolCallCount: run.toolCallCount ?? 0,
      executionTime: run.executionTime ?? 0,
      ...(same(output, base.output) ? {} : { output }),
      ...(error === base.error ? {} : { error }),
    },
  });
  return events;
}

/**
 * Fold a run's events back into the row's state. Throws on a gap or a
 * repeated seq, and on a log that does not open with run_started: either
 * means the log cannot stand in for the row.
 */
export function projectRunEvents(events: RunEventRecord[]): RunProjection {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  let state: RunProjection | null = null;
  let expected = 1;
  for (const event of ordered) {
    if (event.seq !== expected) throw new Error(`run event log is not contiguous: expected seq ${expected}, found ${event.seq}`);
    expected++;
    const p = event.payload ?? {};
    if (event.type === 'run_started') {
      if (state) throw new Error(`run_started appears twice (seq ${event.seq})`);
      state = {
        headSeq: event.seq,
        status: p.status,
        currentStep: p.currentStep ?? 0,
        totalCost: 0,
        totalTokens: 0,
        toolCallCount: 0,
        executionTime: 0,
        output: p.output ?? null,
        error: p.error ?? null,
        workingMemory: p.workingMemory ?? null,
        metadata: p.metadata ?? null,
        steps: Array.isArray(p.steps) ? [...p.steps] : [],
      };
      continue;
    }
    if (!state) throw new Error(`run event log does not open with run_started (seq ${event.seq} is ${event.type})`);
    state.headSeq = event.seq;
    switch (event.type) {
      case 'model_call':
      case 'step_recorded':
      case 'tool_call':
        if (p.index !== state.steps.length) throw new Error(`step ${p.index} out of order at seq ${event.seq}`);
        state.steps.push({ ...p.step });
        break;
      case 'tool_result':
        state.steps[p.index] = { ...state.steps[p.index], ...p.result };
        break;
      case 'step_replaced':
        state.steps[p.index] = p.step;
        break;
      case 'steps_reset':
        state.steps = [...p.steps];
        break;
      case 'memory_changed':
        state.workingMemory = applyObjectChange(state.workingMemory, p);
        break;
      case 'metadata_changed':
        state.metadata = applyObjectChange(state.metadata, p);
        break;
      case 'step_committed':
        state.status = p.status;
        state.currentStep = p.currentStep;
        state.totalCost = p.totalCost;
        state.totalTokens = p.totalTokens;
        state.toolCallCount = p.toolCallCount;
        state.executionTime = p.executionTime;
        if ('output' in p) state.output = p.output;
        if ('error' in p) state.error = p.error;
        break;
      default:
        // A marker: nothing to fold.
        break;
    }
  }
  if (!state) throw new Error('run event log is empty');
  return state;
}

/** The row's state in the shape the projection returns, for comparing the two. */
export function storedRunState(row: CommittedRun): RunState {
  return asStored({
    status: row.status,
    currentStep: row.currentStep,
    totalCost: row.totalCost ?? 0,
    totalTokens: row.totalTokens ?? 0,
    toolCallCount: row.toolCallCount ?? 0,
    executionTime: row.executionTime ?? 0,
    output: row.output ?? null,
    error: row.error ?? null,
    workingMemory: row.workingMemory ?? null,
    metadata: row.metadata ?? null,
    steps: row.steps ?? [],
  });
}
