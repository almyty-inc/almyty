/**
 * Tool-call arguments in a run's log, with personal data hidden for whoever
 * reads the log out (durable runs step 4, docs/design/durable-runs.md).
 *
 * The log keeps the real arguments where a resumed step needs them: the
 * model's answer (`model_answered`, the calls it asked for) and each call as
 * it was started (`tool_started`). A step that picks up after its worker
 * died reads them from the log as they are (StepJournal), and makes the
 * calls with them. Everyone else gets them through here: the run streams
 * (`/agents/:id/runs/:runId/stream` and the API-key route), the run view
 * (the row's held calls) and anything that reads the log out later. The
 * hiding is the organization's PII filter, the same one the stored steps
 * and tool results go through (ToolExecutorService.hidePersonalData); no
 * detector of its own.
 *
 * Only the arguments are touched. Ids, states, costs and the rest of each
 * payload are left exactly as they are, so a viewer folds the log the same
 * way and nothing it keys on changes.
 */

/** Hides personal data in each value, in order; the same number back. */
export type HideValues = (values: any[]) => Promise<any[]>;

interface Slot {
  get(): any;
  set(value: any): void;
}

/** Working-memory lists whose entries carry a call's arguments as `parameters`. */
const CALL_LISTS = ['gatedToolCalls', 'wakingToolCalls', 'unknownOutcomeCalls'] as const;

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

function argumentSlot(holder: Record<string, any>, key: string, into: Slot[]): void {
  if (!isObject(holder) || holder[key] === undefined || holder[key] === null) return;
  into.push({ get: () => holder[key], set: (v) => (holder[key] = v) });
}

/** The arguments of a model's tool calls (`parameters`, or `arguments` as some providers name them). */
function toolCallSlots(calls: unknown, into: Slot[]): void {
  if (!Array.isArray(calls)) return;
  for (const call of calls) {
    if (!isObject(call)) continue;
    argumentSlot(call, 'parameters', into);
    argumentSlot(call, 'arguments', into);
    if (isObject(call.function)) argumentSlot(call.function, 'arguments', into);
  }
}

/** A stored step's call arguments (`input.parameters`). */
function stepSlots(step: unknown, into: Slot[]): void {
  if (isObject(step) && isObject(step.input)) argumentSlot(step.input, 'parameters', into);
}

/** The call lists of a working memory, as a whole value or as a change to one. */
function memorySlots(memory: unknown, into: Slot[]): void {
  if (!isObject(memory)) return;
  for (const list of CALL_LISTS) {
    const entries = memory[list];
    if (Array.isArray(entries)) for (const entry of entries) if (isObject(entry)) argumentSlot(entry, 'parameters', into);
  }
}

/** Where an event carries tool-call arguments. */
function eventSlots(event: { type: string; payload?: any }, into: Slot[]): void {
  const p = event.payload;
  if (!isObject(p)) return;
  switch (event.type) {
    case 'model_answered':
      toolCallSlots(p.response?.message?.toolCalls, into);
      toolCallSlots(p.response?.toolCalls, into);
      break;
    case 'tool_started':
    case 'tool_attempted':
      argumentSlot(p, 'parameters', into);
      break;
    case 'tool_call':
    case 'step_recorded':
    case 'step_replaced':
    case 'model_call':
      stepSlots(p.step, into);
      break;
    // A finished call carries the steps it recorded (stored as the steps
    // are), and the calls it left held or waiting, with their arguments.
    case 'tool_finished':
      for (const step of Array.isArray(p.steps) ? p.steps : []) stepSlots(step, into);
      memorySlots(p.workingMemory, into);
      for (const list of ['gated', 'waking']) {
        const entries = isObject(p.local) ? p.local[list] : null;
        if (Array.isArray(entries)) for (const entry of entries) if (isObject(entry)) argumentSlot(entry, 'parameters', into);
      }
      break;
    case 'steps_reset':
      for (const step of Array.isArray(p.steps) ? p.steps : []) stepSlots(step, into);
      break;
    case 'run_started':
      for (const step of Array.isArray(p.steps) ? p.steps : []) stepSlots(step, into);
      memorySlots(p.workingMemory, into);
      break;
    case 'memory_changed':
      memorySlots(p.set, into);
      memorySlots(p.replace, into);
      break;
    case 'approval_requested':
      argumentSlot(p, 'parameters', into);
      break;
  }
}

/** Whether any of these events carries tool-call arguments (nothing to hide otherwise). */
export function carriesArguments(events: Array<{ type: string; payload?: any }>): boolean {
  return events.some((e) => {
    const slots: Slot[] = [];
    eventSlots(e, slots);
    return slots.length > 0;
  });
}

async function hideSlots(slots: Slot[], hide: HideValues): Promise<void> {
  if (!slots.length) return;
  const values = slots.map((s) => s.get());
  let hidden: any[];
  try {
    hidden = await hide(values);
  } catch {
    hidden = [];
  }
  // A filter that fails, or hands back something else, hides everything
  // rather than nothing: the arguments are not shown at all.
  const usable = Array.isArray(hidden) && hidden.length === values.length;
  slots.forEach((s, i) => s.set(usable ? hidden[i] : '[hidden]'));
}

const copy = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

/**
 * The events as a viewer may see them: copies, with every tool-call
 * argument they carry passed through `hide`, all in one call. The events
 * handed in are not changed.
 */
export async function eventsForViewers<E extends { type: string; payload?: any }>(events: E[], hide: HideValues): Promise<E[]> {
  if (!carriesArguments(events)) return events;
  const out = events.map((e) => ({ ...e, payload: copy(e.payload) }));
  const slots: Slot[] = [];
  for (const event of out) eventSlots(event, slots);
  await hideSlots(slots, hide);
  return out;
}

/**
 * A run row as a viewer may see it: the calls held in its working memory
 * (waiting for a person, for a machine, or with their outcome lost) and
 * its steps, with their arguments passed through `hide`. A copy; the row
 * handed in is not changed.
 */
export async function runForViewers<R extends { workingMemory?: any; steps?: any }>(run: R, hide: HideValues): Promise<R> {
  const slots: Slot[] = [];
  const out: R = { ...run, workingMemory: copy(run.workingMemory), steps: copy(run.steps) };
  Object.setPrototypeOf(out, Object.getPrototypeOf(run));
  memorySlots(out.workingMemory, slots);
  for (const step of Array.isArray(out.steps) ? out.steps : []) stepSlots(step, slots);
  await hideSlots(slots, hide);
  return out;
}

/** Hides personal data in one value under an organization's filter (ToolExecutorService.hidePersonalData). */
export type HidePersonalData = <T>(data: T, options: { organizationId: string; userId: string | undefined }) => Promise<T>;

/** Reads the run a log page belongs to: its organization and who started it. */
export type RunOwnerOf = (runId: string) => Promise<{ organizationId: string; userId?: string | null } | null>;

/**
 * The view a run stream sends a page of the log through: the arguments in
 * it hidden under the run's organization's filter. A page with no
 * arguments goes out as it is, without looking the run up. A run that can
 * no longer be found has its arguments hidden altogether.
 */
export function runLogView(ownerOf: RunOwnerOf, hidePersonalData: HidePersonalData) {
  return async <E extends { type: string; payload?: any }>(runId: string, events: E[]): Promise<E[]> => {
    if (!carriesArguments(events)) return events;
    const owner = await ownerOf(runId).catch(() => null);
    return eventsForViewers(events, async (values) => {
      if (!owner?.organizationId) return values.map(() => '[hidden]');
      return hidePersonalData(values, { organizationId: owner.organizationId, userId: owner.userId ?? undefined });
    });
  };
}

export type RunLogView = ReturnType<typeof runLogView>;