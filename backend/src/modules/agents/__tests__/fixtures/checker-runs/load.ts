/**
 * Real runs from staging (rounds rc5 and rc6, 2026-11-11 and 2026-11-12):
 * the request, the agent's instructions, the answer as the agent wrote it
 * (without the check's note line), every tool result as the run stored
 * it, and the stored verify step. The ground truth for each is in the
 * spec that uses it, checked by hand against the live APIs.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { runEvidence } from '../../../checker-evidence';

export interface RunFixture {
  run: string;
  request: string;
  instructions: string;
  now: string;
  answer: string;
  tools: Array<{ tool: string; parameters?: unknown; output: unknown; error?: unknown }>;
  stored: {
    verdict: string;
    failures: Array<{ rule: string; evidence?: string; claim?: string; checker?: string; kind?: string; code?: string; instruction?: string }>;
    checkers: Array<{ checker: string; verdict: string; note?: string }>;
  };
}

/** A run by its file name: `rc6-RD1-db52dcca`. */
export function loadRun(name: string): RunFixture {
  return JSON.parse(readFileSync(join(__dirname, `${name}.json`), 'utf8')) as RunFixture;
}

/** What the run's checker was given: the request and the stored tool results (runEvidence). */
export function evidenceOf(fx: RunFixture): string {
  return runEvidence({
    input: { message: fx.request },
    steps: fx.tools.map((t) => ({ type: 'tool_call', input: { tool: t.tool, parameters: t.parameters }, output: t.output, ...(t.error ? { error: t.error } : {}) })),
  });
}

/** A live OpenAlex works search (results whole), for the shortener. */
export function liveWorks(): { results: Array<Record<string, any>> } {
  return JSON.parse(readFileSync(join(__dirname, 'openalex-works-live.json'), 'utf8'));
}

export const RC6 = [
  'rc6-RD1-db52dcca',
  'rc6-RD2-6432deb3',
  'rc6-RD3-e3acd95d',
  'rc6-RD4-c76c1335',
  'rc6-RW1-22301018',
  'rc6-RW2-49ed3013',
  'rc6-RW3-e342b57f',
  'rc6-DC1-20f31553',
  'rc6-DC2-bf05f68a',
  'rc6-DC3-3e0e5b2f',
] as const;
