/**
 * The brief an `extract_context` step produces.
 *
 * The step reads N prior rollout transcripts plus the task, makes one
 * call on a role slot, and puts a small structured brief into run context.
 * It is its own step with its own cost precisely so that compression is
 * visible: the saving in explore-extract-patch comes from the expensive
 * role reading a brief instead of every transcript, and if the extraction
 * were folded into another step nobody could see what it cost.
 *
 * See docs/design/layers.md, L5.
 */
export interface ExtractedContext {
  relevantFiles: string[];
  symbols: string[];
  callers: string[];
  tests: string[];
  notes: string;
}

export class ExtractedContextInvalid extends Error {
  readonly code = 'EXTRACTED_CONTEXT_INVALID';
  constructor(
    readonly problems: string[],
    readonly raw: string,
  ) {
    super(`The extraction did not return a usable brief: ${problems.join('; ')}`);
    this.name = 'ExtractedContextInvalid';
  }
}

const STRING_ARRAYS = ['relevantFiles', 'symbols', 'callers', 'tests'] as const;

/**
 * Validate a model's answer into a brief.
 *
 * Strict about shape and forgiving about surroundings: models wrap JSON in
 * prose and fences, and rejecting that would make the step flaky for a
 * reason that has nothing to do with the work. What it will NOT do is
 * invent a field: a missing array is an error, not an empty list, because
 * silently returning an empty brief would look like "nothing relevant was
 * found" and send the expensive role in blind.
 */
export function parseExtractedContext(raw: string): ExtractedContext {
  const problems: string[] = [];
  const text = (raw ?? '').trim();
  if (!text) throw new ExtractedContextInvalid(['the model returned nothing'], raw);

  const json = extractJsonObject(text);
  if (!json) throw new ExtractedContextInvalid(['no JSON object in the answer'], raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new ExtractedContextInvalid([`the JSON did not parse: ${(err as Error).message}`], raw);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ExtractedContextInvalid(['the answer was not a JSON object'], raw);
  }

  const obj = parsed as Record<string, unknown>;
  const out: Partial<ExtractedContext> = {};
  for (const key of STRING_ARRAYS) {
    const value = obj[key];
    if (value === undefined) {
      problems.push(`${key} is missing`);
      continue;
    }
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
      problems.push(`${key} must be an array of strings`);
      continue;
    }
    out[key] = value as string[];
  }
  if (obj.notes === undefined) problems.push('notes is missing');
  else if (typeof obj.notes !== 'string') problems.push('notes must be a string');
  else out.notes = obj.notes;

  if (problems.length) throw new ExtractedContextInvalid(problems, raw);
  return out as ExtractedContext;
}

/** The first balanced `{...}` in the text, so a fenced or prefaced answer still works. */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** The instruction the step sends. Kept here so the shape and the ask cannot drift apart. */
export const EXTRACT_CONTEXT_INSTRUCTION = [
  'You are compressing what several exploration attempts learned into one brief.',
  'Answer with a single JSON object and nothing else, with exactly these keys:',
  '  relevantFiles: string[]  paths that matter for the task',
  '  symbols:       string[]  functions, types or classes that matter',
  '  callers:       string[]  what calls those symbols',
  '  tests:         string[]  tests that cover this area',
  '  notes:         string    anything else the next step needs, in prose',
  'Include a key even when it is empty. Do not guess paths you did not see.',
].join('\n');
