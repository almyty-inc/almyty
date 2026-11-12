import { asJson, shortenForStore } from './checker-evidence';

/**
 * One cap for anything a run persists as a payload.
 *
 * Extracted from `AgentStepProcessor.boundStepsForPersist`, which had
 * the only cap in the agent layer, so that the workflow engine's node
 * results use the same number instead of inventing a second one. The
 * marker text is part of the contract: the UI shows it verbatim, so a
 * truncated payload never reads as the whole payload.
 *
 * A JSON payload is shortened item by item, not cut: the run is reloaded
 * from storage between steps, and a checker that read a tool result cut
 * at 32 KB (invalid JSON, no note) called every item past the cut
 * "invented" (run 0db5d8dd). Stored, a large JSON result keeps every item
 * with its identifying fields, stays valid JSON, and says what was left
 * out (`{"_shortened": "[result shortened: ...]", "result": ...}`,
 * checker-evidence.ts). Text that is not JSON is cut and says so.
 *
 * Capping is idempotent: a capped payload fits, so capping it again (a
 * resumed step replays capped steps from the run log, which the commit
 * caps again) leaves it as it is, and the log and the row agree.
 */
export const STEP_PAYLOAD_CAP = 32 * 1024;

/** Room the cut-text marker takes, so cut text with its marker still fits the cap. */
const MARKER_ROOM = 100;

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
  const parsed = asJson(typeof value === 'string' ? undefined : value, text);
  const shortened = parsed !== undefined ? shortenForStore(parsed, text, STEP_PAYLOAD_CAP) : null;
  if (shortened) return typeof value === 'string' ? JSON.stringify(shortened) : shortened;
  return withTruncationMarker(text.slice(0, STEP_PAYLOAD_CAP - MARKER_ROOM), text.length);
}

/**
 * Text that was cut, with the marker every capped payload carries
 * (`… (truncated from N characters; only the first K are kept)`), so the
 * UI and a model read a truncation the same way wherever it happened.
 * checker-evidence.ts reads it back (cutTextOf).
 */
export function withTruncationMarker(kept: string, totalCharacters: number): string {
  return `${kept}… (truncated from ${totalCharacters} characters; only the first ${kept.length} are kept)`;
}