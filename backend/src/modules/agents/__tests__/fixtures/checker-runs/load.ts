/**
 * Real runs from staging (rounds rc5, rc6 and rc7, 2026-11-11 to
 * 2026-11-13): the request, the agent's instructions, the answer as the
 * agent wrote it (without the check's note line), every tool result as the
 * run stored it, and the stored verify step. The ground truth for each is
 * in the spec that uses it, checked by hand against the live APIs.
 *
 * Two more files hold what the stored steps do not:
 *  - release-bodies-live.json: the release notes of every release the
 *    release-watcher runs listed, whole, from the GitHub API at 12:51 UTC
 *    on 2026-11-13. A stored step keeps the first 500 characters of each;
 *    the checker read the run's conversation, which holds them whole. Each
 *    stored start was checked to be the start of the whole text.
 *  - research-digest-answers.json: every answer the research-digest agent
 *    gave up to RD4 of rc7, with when its run started (the agent's run
 *    history on staging, read for the RD2 report).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { runEvidence, type RunToolResult } from '../../../checker-evidence';

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

export const RC5 = [
  'rc5-RD1-c62aa29a',
  'rc5-RD2-d4ad7da4',
  'rc5-RD3-7e4e631b',
  'rc5-RD4-bd98321b',
  'rc5-RW1-8a5070c8',
  'rc5-RW2-887a8bfe',
  'rc5-RW3-dda8789a',
  'rc5-DC1-2ee71e77',
  'rc5-DC2-6e00f1e9',
  'rc5-DC3-c04b7a9b',
] as const;

export const RC7 = [
  'rc7-RD1-0f136ed8',
  'rc7-RD2-af3c05c0',
  'rc7-RD3-07a3f5c7',
  'rc7-RD4-fcf9e484',
  'rc7-RW1-15fca65f',
  'rc7-RW2-947d8e43',
  'rc7-RW3-ab0c73df',
  'rc7-DC1-81411770',
  'rc7-DC2-e9cec629',
  'rc7-DC3-6f04ad1d',
] as const;

export const RC8 = [
  'rc8-RD1-d99aa38d',
  'rc8-RD2-bc75f6f1',
  'rc8-RD3-e31b4553',
  'rc8-RD4-d13c5d50',
  'rc8-RW1-64f3b08a',
  'rc8-RW2-d3757bc9',
  'rc8-RW3-6d6a8e80',
  'rc8-DC1-22a3aee0',
  'rc8-DC2-986e43dd',
  'rc8-DC3-988ea008',
] as const;

export const RC9 = [
  'rc9-RD1-b79da115',
  'rc9-RD2-b37987d4',
  'rc9-RD3-fc270572',
  'rc9-RD4-37f14fe1',
  'rc9-RW1-8ca1dcf2',
  'rc9-RW2-96f7b54a',
  'rc9-RW3-941cb583',
  'rc9-DC1-9f8a4886',
  'rc9-DC2-0a487018',
  'rc9-DC3-93f80a2e',
] as const;

/**
 * The run's tool results as its conversation held them, for the code
 * checks (toolResultsFromMessages): each release's notes whole
 * (release-bodies-live.json), everything else as stored. A body whose
 * stored start is not the start of the whole text is left as stored.
 */
export function wholeToolResults(fx: RunFixture): RunToolResult[] {
  const bodies: Record<string, Record<string, string>> = JSON.parse(readFileSync(join(__dirname, 'release-bodies-live.json'), 'utf8'));
  const restore = (rel: any, repo: Record<string, string>) => {
    if (!rel || typeof rel !== 'object' || typeof rel.tag_name !== 'string' || typeof rel.body !== 'string') return rel;
    const whole = repo[rel.tag_name];
    const kept = rel.body.endsWith('…') ? rel.body.slice(0, -1) : rel.body;
    return typeof whole === 'string' && whole.startsWith(kept) ? { ...rel, body: whole } : rel;
  };
  return fx.tools.map((t) => {
    const p = t.parameters as { owner?: string; repo?: string } | undefined;
    const repo = p?.owner && p?.repo ? bodies[`${p.owner}/${p.repo}`] : undefined;
    const out = t.output as Record<string, any> | null;
    let value: unknown = out && typeof out === 'object' && '_shortened' in out && 'result' in out ? out.result : out;
    if (repo && /release/.test(t.tool)) value = Array.isArray(value) ? value.map((r) => restore(r, repo)) : restore(value, repo);
    return { tool: t.tool, ...(t.parameters ? { parameters: t.parameters } : {}), content: typeof value === 'string' ? value : JSON.stringify(value), ...(t.error ? { error: true } : {}) };
  });
}

/**
 * What the research-digest agent answered before this run, newest first:
 * the answers of its runs started before this one, at most `max` of them
 * (the step processor reads the last EARLIER_ANSWERS_MAX completed runs).
 */
export function earlierAnswers(fx: RunFixture, max = 50): string[] {
  const rows: Array<{ run: string; createdAt: string; output: string }> = JSON.parse(readFileSync(join(__dirname, 'research-digest-answers.json'), 'utf8'));
  return rows
    .filter((r) => r.createdAt < fx.now && !fx.run.endsWith(r.run))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, max)
    .map((r) => r.output);
}
