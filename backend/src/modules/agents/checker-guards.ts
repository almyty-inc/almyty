/**
 * What the verdict findings of a check share: reading the tool results'
 * JSON out of the evidence text, and ordering findings strongest first.
 *
 * This file used to hold pattern guards that dropped a checker's failure
 * by its wording: "qualifies it", "which is correct", "not relevant", a
 * rule it did not quote. Each was right for the run it came from and
 * wrong for the next phrasing. A checker failure now counts only when the
 * code verifies the tool data it cites (checker-findings.ts); everything
 * else a checker says is a note, so no guard has to read its mind.
 */

/** Index of the bracket that closes the one at `open`, reading strings; -1 when it never closes. */
function closingAt(text: string, open: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The JSON values in an evidence text: each tool result is written on the
 * line after the line that names its tool (checker-evidence.ts
 * runEvidence). A result cut off mid-way does not parse and is not
 * returned.
 */
export function evidenceJson(evidence: string): unknown[] {
  const out: unknown[] = [];
  let i = 0;
  while (i < (evidence ?? '').length) {
    const c = evidence[i];
    if (c === '{' || c === '[') {
      const end = closingAt(evidence, i);
      if (end !== -1) {
        try {
          out.push(JSON.parse(evidence.slice(i, end + 1)));
          i = end + 1;
          continue;
        } catch {
          // Not JSON from here: go on at the next line.
        }
      }
    }
    const nl = evidence.indexOf('\n', i);
    if (nl === -1) break;
    i = nl + 1;
  }
  return out;
}

/**
 * What a failure rests on, strongest first: a check the platform made
 * itself, tool data a checker cited and the code confirmed. `rule` is a
 * failure that rested on the agent's instructions, as older runs stored
 * it; no final-answer check makes one now.
 */
export type FailureKind = 'deterministic' | 'evidence' | 'rule';

const KIND_RANK: Record<FailureKind, number> = { deterministic: 0, evidence: 1, rule: 2 };

/** What a failure rests on: its `kind` when set, a platform code, else the evidence. */
export function failureKind(f: { kind?: unknown; code?: unknown } | null | undefined): FailureKind {
  if (f?.kind === 'deterministic' || f?.kind === 'evidence' || f?.kind === 'rule') return f.kind;
  if (typeof f?.code === 'string' && f.code && f.code !== 'verification_unavailable') return 'deterministic';
  return 'evidence';
}

/** Failures with the strongest first: platform findings, then contradictions with the evidence, then rule failures. Stable. */
export function strongestFirst<T>(failures: T[]): T[] {
  return failures
    .map((f, i) => ({ f, i, rank: KIND_RANK[failureKind(f as any)] }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.f);
}