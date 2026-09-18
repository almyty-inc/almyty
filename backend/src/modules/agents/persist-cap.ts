/**
 * One cap for anything a run persists as a payload.
 *
 * Extracted from `AgentStepProcessor.boundStepsForPersist`, which had
 * the only cap in the agent layer, so that the workflow engine's node
 * results use the same number instead of inventing a second one. The
 * marker text is part of the contract: the UI shows it verbatim, so a
 * truncated payload never reads as the whole payload.
 */
export const STEP_PAYLOAD_CAP = 32 * 1024;

export function capPersistedPayload(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  let text: string | undefined;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    // Circular or otherwise unserializable — record that, not a throw
    // from inside a persistence path.
    return '[unserializable]';
  }
  if (text === undefined || text.length <= STEP_PAYLOAD_CAP) return value;
  return `${text.slice(0, STEP_PAYLOAD_CAP)}… (truncated from ${text.length} characters)`;
}
