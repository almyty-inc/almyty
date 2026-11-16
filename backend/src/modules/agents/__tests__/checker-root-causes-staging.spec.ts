/**
 * Why the answer check passed only 7 of 36 "Release Watcher" runs and 18
 * of 58 "Research Digest" runs on staging (Northwind AI, 2026-11-11 to
 * 2026-11-16). Every failed run was replayed through the check and read
 * against its tool results. Of 66 failed runs, 53 answers were wrong and
 * 13 were false flags: 11 of those the check had already stopped making,
 * 2 it still made (fixed here). Every fixture is a real run.
 *
 * False flags, fixed in the check:
 *  1. "No other issues matching the required labels" read as "no other issues" (3110d113).
 *  2. "Labels: ppc, flaky-test (flaky-test)" read as a made-up label; an issue under
 *     "Other notable open issues ... (not included in high-priority ...)" read as listed as a bug (b60bacad).
 *  3. A title that says what "should not" happen names a problem (#63826, 85f89397).
 *  4. "Daniel Armstrong" for "D. M. Armstrong" is the same first author (f1e315e1).
 *  5. "I found 4 new papers" is what the answer kept, not what the tool returned (ed292817).
 *
 * Wrong answers, fixed where the agent goes wrong:
 *  6. Every express run listed v5.3.0 (2026-10-09) as new in a 30-day window: the model is
 *     now given the window as dates (66499415).
 *  7. The research digest re-listed what it reported before, and called papers it never
 *     reported "already reported", with the list in its prompt: each tool result now marks
 *     the items its earlier answers listed (21bfea69, d90db80e).
 *  8. The release watcher listed feature requests and questions as bugs in 10 runs: each
 *     search result now marks the issues the agent's own rule cannot let in (1d76944d).
 *
 * Not fixed here: release summaries that name what the notes do not (6 runs) and labels
 * an issue does not have (3 runs) stay wrong answers, and the check still fails them.
 * And it still catches every other wrong answer (1d76944d).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { codeFindings } from '../agent-verifier.helper';
import { AgentStepProcessor } from '../agent-step-processor';
import { AgentRuntimeBuilders, requestWindowNote } from '../agent-runtime-builders';
import {
  ALREADY_REPORTED_FIELD,
  NOT_A_PROBLEM_FIELD,
  earlierReportedItems,
  issueQualifies,
  issueRuleOf,
  markAlreadyReported,
  markOutsideIssueRule,
  samePerson,
  speaksOfEarlierReports,
  toolItems,
} from '../answer-checks';
import { earlierAnswers, evidenceOf, loadRun, wholeToolResults } from './fixtures/checker-runs/load';

function findingsOf(name: string, opts: { answer?: string } = {}) {
  const fx = loadRun(name);
  const answer = opts.answer ?? fx.answer;
  const earlier = speaksOfEarlierReports(answer, fx.instructions) ? earlierAnswers(fx) : undefined;
  return codeFindings({
    request: fx.request,
    answer,
    evidence: evidenceOf(fx),
    now: new Date(fx.now),
    whole: wholeToolResults(fx),
    instructions: fx.instructions,
    ...(earlier ? { earlier } : {}),
  });
}

describe('1. a "no other issues matching ..." claim is held to what it names', () => {
  const name = 'staging-RW-3110d113';
  const fx = loadRun(name);
  const claim = 'No other issues matching the required labels (confirmed-bug, bug, regression, priority/critical, P0, P1, high-priority, security) were found';

  // The check failed it for leaving out 29 issues, feature requests (#67354, #67352) among them.
  it('3110d113: lists #67391 (security), says no other issue has a required label; none has: no finding', () => {
    expect(fx.answer).toContain(claim);
    expect(findingsOf(name)).toEqual([]);
  });

  it('a claim of no other issues at all is still held to every issue the tool returned', () => {
    const all = fx.answer.replace(claim, 'No other issues were found');
    expect(findingsOf(name, { answer: all }).filter((f) => f.code === 'left_out').length).toBeGreaterThan(20);
  });

  it('an issue with a required label that the answer leaves out is still found', () => {
    const entry = /1\. \[#67391[^\n]*\n[^\n]*\n[^\n]*\n/;
    expect(fx.answer).toMatch(entry);
    const other = fx.answer.replace(entry, '1. [#67429 fs.cpSync() terminates the process](https://github.com/nodejs/node/issues/67429)\n');
    expect(findingsOf(name, { answer: other }).filter((f) => f.code === 'left_out').map((f) => f.item)).toEqual(['#67391']);
  });
});

describe('2. a note after a label, and a heading that sets issues apart', () => {
  const name = 'staging-RW-b60bacad';
  const fx = loadRun(name);

  // The check failed it on "#67374: the answer gives the label flaky-test (flaky-test), but the
  // tool results give ppc, flaky-test" and on #67352, a feature request listed under that heading.
  it('b60bacad: no finding', () => {
    expect(findingsOf(name)).toEqual([]);
  });

  it('a label the tool does not give is still found, note or not', () => {
    const extra = fx.answer.replace('Labels: ppc, flaky-test (flaky-test)', 'Labels: ppc, flaky-test (flaky-test), aix');
    expect(findingsOf(name, { answer: extra }).map((f) => f.rule)).toEqual(['#67374: the answer gives the label aix, but the tool results give ppc, flaky-test']);
  });

  it('the same feature request under the high-priority heading is still found', () => {
    const heading = '## Other notable open issues with feature request labels (not included in high-priority bug/regression/security list):';
    expect(fx.answer).toContain(heading);
    const listed = fx.answer.replace(heading, '## More high-priority open issues:');
    expect(findingsOf(name, { answer: listed }).map((f) => f.item)).toContain('#67352');
  });
});

describe('3. a title that says what should not happen names a problem', () => {
  it('85f89397: #63826 "sqlite integer parameters should not be bound as doubles" (label question) meets "labels or titles"', () => {
    expect(findingsOf('staging-RW-85f89397')).toEqual([]);
    const it63826 = toolItems(evidenceOf(loadRun('staging-RW-85f89397'))).items.find((x) => x.numbers.includes('#63826'))!;
    expect(issueQualifies(it63826, null).qualifies).toBe(true);
  });

  it('a question whose title names no problem is still not a bug: #67427 "should `Database` close its connection ...?"', () => {
    const it67427 = toolItems(evidenceOf(loadRun('rc7-RW1-15fca65f'))).items.find((x) => x.numbers.includes('#67427'))!;
    expect(issueQualifies(it67427, null).qualifies).toBe(false);
  });

  it('rc9 RW1 8ca1dcf2 still fails, on undici alone', () => {
    expect(findingsOf('rc9-RW1-8ca1dcf2').map((f) => f.rule)).toEqual([
      "v22.23.5: the answer's summary names undici, but the release notes in the tool results never mention it",
    ]);
  });
});

describe('4. a first author written out where the tool gives initials', () => {
  it.each([
    ['Daniel Armstrong', 'D. M. Armstrong', true],
    ['D. Armstrong', 'Daniel M. Armstrong', true],
    ['Li Yongxin', 'Li Yongxin', true],
    ['Lucas Armstrong', 'D. M. Armstrong', false],
    ['Daniel Armstrong', 'Daniel Armstrang', false],
    ['Armstrong', 'D. M. Armstrong', false],
  ])('%p and %p: %p', (a, b, same) => {
    expect(samePerson(a, b)).toBe(same);
  });

  it('f1e315e1: no first-author finding for SynthStrategy; a different first author is still found', () => {
    const name = 'staging-RD-f1e315e1';
    expect(findingsOf(name).filter((f) => f.field === 'first author')).toEqual([]);
    const other = loadRun(name).answer.replace('First Author: Daniel Armstrong', 'First Author: Lucas Armstrong');
    expect(findingsOf(name, { answer: other }).filter((f) => f.field === 'first author').map((f) => f.rule)).toEqual([
      '"SynthStrategy: Extracting and Formalizing Latent Strategic…": the answer gives the first author as Lucas Armstrong, but the tool results give D. M. Armstrong',
    ]);
  });
});

describe('5. what the tool returned, against what the answer kept', () => {
  it('ed292817: "10 works returned by the tool" is the count, "I found 4 new papers" is not', () => {
    const rules = findingsOf('staging-RD-ed292817').map((f) => f.rule);
    expect(rules).not.toContain('The answer says the tool returned 4 papers, but the tool returned 10');
    expect(rules).toContain('The answer says it skipped 4 of the 10 works the tool returned, so it should list 6, but it lists 4');
    expect(rules.some((r) => /^The answer lists 4 items as new, but this agent's earlier answers already reported them/.test(r))).toBe(true);
  });

  it('"N works returned by the tool" is read, and a wrong one found', () => {
    const fx = loadRun('staging-RD-ed292817');
    const wrong = fx.answer.replace('10 works returned by the tool', '8 works returned by the tool');
    expect(findingsOf('staging-RD-ed292817', { answer: wrong }).map((f) => f.rule)).toContain('The answer says the tool returned 8 works, but the tool returned 10');
  });
});

describe('6. the model is given the window the request names, as dates', () => {
  const fx = loadRun('staging-RW-66499415');

  it('66499415: "look back 30 days" on 2026-11-13 runs from 2026-10-14; v5.3.0 (2026-10-09) is before it', () => {
    const note = requestWindowNote({ message: fx.request }, new Date(fx.now))!;
    expect(note).toContain('The 30-day window runs from 2026-10-14 to 2026-11-13');
    expect(note).toMatch(/list nothing dated before the window as new/);
    // The check holds the answer to the same window.
    expect(findingsOf('staging-RW-66499415').filter((f) => f.code === 'outside_window').map((f) => f.item)).toContain('v5.3.0');
  });

  it('no window, no note', () => {
    expect(requestWindowNote({ message: 'nodejs/node' }, new Date(fx.now))).toBeNull();
    expect(requestWindowNote(undefined, new Date(fx.now))).toBeNull();
  });

  it('is in the system prompt, after the instructions', async () => {
    const builders = new AgentRuntimeBuilders({ find: jest.fn(async () => []) } as any, { listActiveRules: jest.fn(async () => []) } as any);
    const agent: any = { id: 'a', instructions: fx.instructions, agentConfig: {}, memoryConfig: {} };
    const run: any = { id: 'r', input: { message: fx.request }, workingMemory: {} };
    const system: string = (await builders.buildMessages(agent, run, [], ''))[0].content;
    const at = system.indexOf('[REQUEST WINDOW]');
    expect(at).toBeGreaterThan(system.indexOf('[INSTRUCTIONS]'));
    expect(system.slice(at)).toMatch(/The 30-day window runs from \d{4}-\d{2}-\d{2}/);
  });
});

describe('7. the items an agent already reported are marked on the tool result its model reads', () => {
  /** The search result whole, as the model read it, and what the run was told it had reported. */
  const setup = (name: string) => {
    const fx = loadRun(name);
    const search = wholeToolResults(fx).find((t) => t.tool === 'openalex_search_works')!;
    const items = earlierReportedItems(earlierAnswers(fx));
    return { fx, search, items, marked: markAlreadyReported(search.content, items) };
  };
  const markedIds = (content: string) =>
    (JSON.parse(content).results as Array<Record<string, any>>).filter((w) => w[ALREADY_REPORTED_FIELD] === true).map((w) => String(w.id).split('/').pop());

  it('21bfea69: all 10 works it listed "as new" are marked, with a note that says to skip 10', () => {
    const { marked } = setup('staging-RD-21bfea69');
    expect(marked.marked).toBe(10);
    expect(marked.items).toBe(10);
    expect(JSON.parse(marked.content)._note).toMatch(/^10 of the 10 items in this result were already reported .* say you skipped 10\.$/);
    const relisted = findingsOf('staging-RD-21bfea69').find((f) => f.code === 'previously_reported')!;
    expect(relisted.rule).toMatch(/^The answer lists 10 items as new/);
  });

  it('d90db80e: the one it re-listed is marked; the four it called "already reported" are not', () => {
    const { marked } = setup('staging-RD-d90db80e');
    const ids = markedIds(marked.content);
    expect(ids).toContain('W7167504345');
    const found = findingsOf('staging-RD-d90db80e');
    const never = found.find((f) => f.code === 'skipped_not_reported')!.item.split(', ');
    expect(never).toHaveLength(4);
    for (const id of never) expect(ids).not.toContain(id);
  });

  it('an answer that leaves out exactly the marked items, and says so, passes the check', () => {
    for (const name of ['staging-RD-21bfea69', 'staging-RD-d90db80e']) {
      const { fx, marked } = setup(name);
      const works = JSON.parse(marked.content).results as Array<Record<string, any>>;
      const kept = works.filter((w) => w[ALREADY_REPORTED_FIELD] !== true);
      const answer =
        `Topic: ${fx.request}, ${works.length} works returned by the tool; I skipped ${works.length - kept.length} already reported.\n\n` +
        kept
          .map((w, i) =>
            [
              `${i + 1}. ${w.title}`,
              `   - Publication date: ${w.publication_date}`,
              `   - First author: ${w.authorships?.[0]?.author?.display_name ?? 'unknown'}`,
              `   - DOI: ${w.doi ?? 'none'}`,
            ].join('\n'),
          )
          .join('\n\n');
      expect([name, findingsOf(name, { answer })]).toEqual([name, []]);
    }
  });

  it('a result that is not JSON, a single item, or one with nothing reported, is given back as it was', () => {
    const { items, search } = setup('staging-RD-d90db80e');
    expect(markAlreadyReported('plain text', items).content).toBe('plain text');
    const one = JSON.stringify({ id: 'https://openalex.org/W7167504345', title: 'x' });
    expect(markAlreadyReported(one, items).content).toBe(one);
    expect(markAlreadyReported(search.content, []).content).toBe(search.content);
  });

  it('the step processor keeps the items at the start of the run and marks every tool result its model reads', async () => {
    const fx = loadRun('staging-RD-d90db80e');
    const find = jest.fn().mockResolvedValue(earlierAnswers(fx).map((output, i) => ({ id: `r${i}`, output, createdAt: new Date() })));
    const self = Object.assign(Object.create(AgentStepProcessor.prototype), { s: { runRepository: { find }, logger: { warn: jest.fn() } } });
    const run: any = { id: 'rd', agentId: 'agent-1', organizationId: 'org-1', createdAt: new Date(fx.now), workingMemory: {} };
    await self.alreadyReportedFor(run);
    expect(run.workingMemory.alreadyReportedList).toEqual(earlierReportedItems(earlierAnswers(fx)));
    const search = wholeToolResults(fx).find((t) => t.tool === 'openalex_search_works')!;
    expect(markedIds(self.toolResultForModel(run, search.content))).toContain('W7167504345');
    expect(self.toolResultForModel({ workingMemory: {} } as any, search.content)).toBe(search.content);

    const src = readFileSync(join(__dirname, '..', 'agent-step-processor.ts'), 'utf8');
    // Every path that saves a successful tool result for the model goes through it.
    expect(src.match(/this\.toolResultForModel\(run, typeof (?:toolResult|result)\.data === 'string'/g)).toHaveLength(3);
  });
});

describe("8. the issues an agent's own rule cannot let in are marked on the result its model reads", () => {
  const fx = loadRun('staging-RW-1d76944d');
  const search = wholeToolResults(fx).find((t) => t.tool === 'github_rest_api_search_issues_and_pull_requests')!;
  const rule = issueRuleOf(fx.instructions)!;
  const markedNumbers = (content: string) =>
    (JSON.parse(content).items as Array<Record<string, any>>).filter((i) => typeof i[NOT_A_PROBLEM_FIELD] === 'string').map((i) => i.number);

  it('1d76944d: #63096 and #67482 (feature requests the answer listed as bugs) are marked; #67484 (no labels) and #60267 (security) are not', () => {
    const marked = markOutsideIssueRule(search.content, rule);
    const numbers = markedNumbers(marked.content);
    expect(numbers).toEqual(expect.arrayContaining([63096, 67482]));
    expect(numbers).not.toContain(67484);
    expect(numbers).not.toContain(60267);
    // Exactly the issues the check would fail if they were listed as bugs.
    const index = toolItems(search.content);
    const failing = index.items.filter((it) => it.numbers.length && issueQualifies(it, rule).qualifies === false).map((it) => Number(it.numbers[0].slice(1)));
    expect(numbers.sort()).toEqual(failing.sort());
    expect(JSON.parse(marked.content)._note).toMatch(/do not list them as one\.$/);
  });

  it('no rule, nothing marked; a release list has no issues to mark', () => {
    expect(markOutsideIssueRule(search.content, null).content).toBe(search.content);
    const releases = wholeToolResults(fx).find((t) => t.tool === 'github_rest_api_repos_list_releases')!;
    expect(markOutsideIssueRule(releases.content, rule).marked).toBe(0);
  });

  it('the step processor keeps the rule at the start of the run and marks with it, beside the already-reported marks', () => {
    const self = Object.create(AgentStepProcessor.prototype);
    const run: any = { workingMemory: { issueRuleLabels: [...rule.labels] } };
    expect(markedNumbers(self.toolResultForModel(run, search.content))).toEqual(expect.arrayContaining([63096, 67482]));
    const src = readFileSync(join(__dirname, '..', 'agent-step-processor.ts'), 'utf8');
    expect(src).toMatch(/const rule = issueRuleOf\(agent\.instructions \?\? ''\);\s*if \(rule\) run\.workingMemory = \{ \.\.\.\(run\.workingMemory \?\? \{\}\), issueRuleLabels: \[\.\.\.rule\.labels\] \};/);
  });

  it('both marks on one result keep both notes', () => {
    const items = [{ ids: [], dois: [], numbers: ['#60267'], title: '' }];
    const both = markOutsideIssueRule(markAlreadyReported(search.content, items).content, rule).content;
    const note: string = JSON.parse(both)._note;
    expect(note).toMatch(/already reported/);
    expect(note).toMatch(/do not list them as one/);
    expect(Object.keys(JSON.parse(both))[0]).toBe('_note');
  });
});

describe('the check still fails what is wrong', () => {
  it('1d76944d: two feature requests listed as bugs, and a label #67484 does not have', () => {
    expect(findingsOf('staging-RW-1d76944d').map((f) => f.rule)).toEqual([
      '#63096: the answer lists it as a bug, regression or security issue, but the tool results mark it as feature request, and neither its labels nor its title name a problem',
      '#67482: the answer lists it as a bug, regression or security issue, but the tool results mark it as feature request, and neither its labels nor its title name a problem',
      '#67484: the answer gives the label v8 engine, but the tool results give none',
    ]);
  });
});
