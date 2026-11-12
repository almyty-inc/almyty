import { AgentVerifierHelper } from '../agent-verifier.helper';
import { confirmsClaim, judgesRelevance, unquotedRule, wrongReturnedCount } from '../checker-guards';
import { fitResult, runEvidence } from '../checker-evidence';
import { itemsOutsideWindow } from '../window-check';
import { markUnverifiedAnswer, unverifiedLine, unverifiedReason } from '../unverified-answer';
import { AgentMemoryKeeper, factsPrompt, failedTools } from '../agent-memory.keeper';

/**
 * The answer check reports by default, and its note leads the answer. On
 * staging (rc5, 2026-11-12, live OpenAlex, GitHub and npm) 5 of 6 correct
 * answers carried a wrong "check didn't pass" note and a real error was
 * missed. Every fixture below is a checker's own words from those runs.
 */

const now = new Date('2026-11-12T10:58:44.039Z');

// The research digest agent (runs 7e4e631b, bd98321b).
const DIGEST_RULES =
  'You are a research digest writer for an R&D team. The message gives a topic and a since-date (YYYY-MM-DD). Steps: 1) Call the OpenAlex tool openalex_search_works exactly once with search = the topic, filter = from_publication_date:<since-date>,type:article, sort = publication_date:desc, per_page = 10, select = id,doi,title,publication_date,cited_by_count,authorships,primary_location. 2) Before writing, look up what you saved from earlier digests and leave out any paper (by DOI or OpenAlex id) you already reported; say how many you skipped. 3) For each remaining work write a numbered entry: exact title, publication date, first author (authorships[0].author.display_name), venue (primary_location.source.display_name, or unknown), DOI exactly as returned (or none), and one line on why it matters based only on the title. 4) Start with one line: topic, since-date, how many works the tool returned. Use only what the tool returns. Never invent papers, authors, venues, DOIs or dates. If the tool returns nothing, say so. 5) Remember the DOIs and OpenAlex ids you reported so the next digest can skip them.';
const DIGEST_FOCUS =
  'Today is 2026-11-11. Publication dates up to and including 2026-12-31 are normal in OpenAlex data and are NOT a reason to fail; never judge by your own knowledge cutoff. Only refute against the OpenAlex tool result of this run: every listed paper must be in it with the same title, publication date, DOI and first author. Flag any invented paper, author, venue, DOI or date, and any DOI written as none when the tool returned one.';

// The release watcher agent (runs 8a5070c8, 887a8bfe, dda8789a).
const WATCHER_RULES =
  'You are the release watcher for an engineering team that depends on a public GitHub repository. The user names a repository as owner/repo (for example nodejs/node) and optionally a number of days to look back (default 7). Today is the date of your run. Steps: (1) call Get a repository to confirm it exists and note its open_issues_count and default branch; (2) call List releases (per_page 10) and keep releases whose published_at falls inside the look-back window; also call Get the latest release; (3) call Search issues and pull requests (github_rest_api_search_issues_and_pull_requests) exactly once with q = "repo:<owner>/<repo> is:issue is:open", sort = updated, order = desc, per_page = 30. That query returns issues only, never pull requests. From its items pick the ones whose labels or titles indicate bugs, regressions or security (labels like confirmed-bug, bug, regression, priority/critical, P0, P1, high-priority, security). Do not use List repository issues. Output in markdown: a header with repo, window and run date; New releases (tag, name, published_at date, html_url, a 2-line summary of the release notes); Latest release (tag and date); High-priority open issues (number, title, labels, updated_at date, html_url), at most 10. Use only data returned by the tools; never invent a release, issue number or date. If a call fails (for example the GitHub rate limit), say which call failed and what that leaves out.';
const WATCHER_FOCUS =
  'Refute the answer if a listed release, tag, date or issue number is not in the tool results, if a release outside the requested look-back window is listed as new, or if a pull request (an item with a pull_request field or a /pull/ URL) is listed as an issue.';

/** The OpenAlex result of run 7e4e631b: 10 works on the page, 2,591 matching in all. */
const DOIS = [
  '10.17613/zf92n-68j61', '10.7554/elife.106826.3', '10.1088/1361-6420/aec045', '10.1117/1.jmi.13.6.064501', '10.1021/acsomega.6c05744',
  '10.1038/s41598-026-80099-8', '10.1007/s11192-026-05892-8', '10.1007/s44163-026-02726-7', '10.5281/zenodo.24113943', '10.5281/zenodo.24098743',
];
const openAlexResult = JSON.stringify({
  meta: {
    count: 2591, db_response_time_ms: 49, page: 1, per_page: 10, groups_count: null,
    x_query: { oqo: { filter_rows: [{}, {}, {}], sort_by: [{}] }, url: '/works?filter=from_publication_date:2026-10-01', order_default: false },
    cost_usd: 0.001,
  },
  results: DOIS.map((doi, i) => ({
    id: `https://openalex.org/W71675043${40 + i}`,
    doi: `https://doi.org/${doi}`,
    title: `Work ${i + 1}`,
    publication_date: '2026-11-10',
    authorships: [{ author: { display_name: `Author ${i + 1}` } }, { author: { display_name: 'Second' } }],
  })),
});
const digestEvidence = runEvidence(
  { input: { message: 'retrieval augmented generation evaluation, since 2026-10-01' } },
  { toolResults: [{ tool: 'openalex_search_works', parameters: { search: 'retrieval augmented generation evaluation', per_page: 10 }, content: openAlexResult }] },
);

const read = (failures: any[], evidence: string, standard: { rules?: string; spec?: string; focus?: string } = {}) =>
  new AgentVerifierHelper({} as any).readFailures({ verdict: 'fail', failures }, 'checker', evidence, now, standard);

describe('1a. a count of returned items the tool results do not hold (run 7e4e631b)', () => {
  const invented = {
    rule: 'The tool returned 15 works, not 10; the output incorrectly states 10 works returned.',
    evidence: "The openalex_search_works tool returned 15 works in the 'results' array, but the output claims only 10 works returned.",
    claim: 'Topic: retrieval augmented generation evaluation, since-date: 2026-10-01, number of works returned by tool: 10 (skipped 0 as none previously reported)',
  };

  it('is dropped: the result lists 10 works, and 2,591 is the total match count, not what was returned', () => {
    expect(wrongReturnedCount(invented, digestEvidence)).toBe('it says the tool returned 15, but the tool results hold 10 or 3 or 1');
    const r = read([invented], digestEvidence, { rules: DIGEST_RULES, focus: DIGEST_FOCUS });
    expect(r.failures).toEqual([]);
    expect(r.discarded[0].reason).toMatch(/says the tool returned 15, but the tool results hold 10/);
  });

  it('keeps a failure whose count is right', () => {
    const right = { rule: 'The tool returned 10 works, but the output says 12 works were returned.', evidence: 'results holds 10 items', claim: 'how many: 12' };
    expect(wrongReturnedCount(right, digestEvidence)).toBeNull();
    expect(read([right], digestEvidence, { rules: DIGEST_RULES }).failures).toHaveLength(1);
  });

  it('says nothing when the count cannot be read: a result left out or cut off', () => {
    const cut = `${digestEvidence}\n\nother_tool: [result left out: the evidence limit was reached]`;
    expect(wrongReturnedCount(invented, cut)).toBeNull();
    expect(wrongReturnedCount(invented, 'REQUEST:\nx\n\ntool:\nnot json')).toBeNull();
  });
});

describe('1b. relevance is not the checker\'s to judge unless a rule makes it so (runs bd98321b, 7e4e631b)', () => {
  const offTopic = {
    rule: "The topic is 'vision language model hallucination'; this paper is clinical and unrelated to vision language models or hallucination in AI, so including it is not relevant to the topic and violates the requirement to base relevance only on the title and topic.",
    evidence: 'The paper is about clinical features of postictal state in epilepsy, unrelated to vision language model hallucination.',
    claim: '9. Clinical features of the postictal state in adults with epilepsy: A cross‐sectional survey\n   - DOI: 10.1002/epi.70579',
  };
  const inventsRelevance = {
    rule: "The 'Why it matters' line invents relevance not supported by the title or metadata; the paper is unrelated to retrieval augmented generation evaluation.",
    evidence: 'The paper is about ultrasound tomography models, no mention of retrieval augmented generation evaluation.',
    claim: '3. Title: Diff-ANO: Towards fast high-resolution ultrasound computed tomography ...',
  };

  it('drops them when neither the instructions, the spec nor the focus make relevance a rule', () => {
    const standard = `${DIGEST_RULES}\n${DIGEST_FOCUS}`;
    expect(judgesRelevance(offTopic, standard)).toBe('unrelated');
    expect(judgesRelevance(inventsRelevance, standard)).toBe('invents relevance');
    const r = read([offTopic, inventsRelevance], digestEvidence, { rules: DIGEST_RULES, focus: DIGEST_FOCUS });
    expect(r.failures).toEqual([]);
    expect(r.discarded.map((d) => d.reason)).toEqual([
      'it judges relevance ("unrelated"), which no rule of the agent makes a requirement',
      'it judges relevance ("invents relevance"), which no rule of the agent makes a requirement',
    ]);
  });

  it('keeps them where the instructions make relevance a rule', () => {
    const rules = `${DIGEST_RULES} Only include papers relevant to the topic; leave out anything off-topic.`;
    expect(judgesRelevance(offTopic, rules)).toBeNull();
    // It rests on a rule, so it quotes it, as the checker is now asked to.
    const quoting = { ...offTopic, instruction: 'Only include papers relevant to the topic' };
    expect(read([quoting], digestEvidence, { rules }).failures).toEqual([expect.objectContaining({ kind: 'rule' })]);
    expect(read([offTopic], digestEvidence, { rules }).discarded[0].reason).toBe('it names a rule but quotes nothing from the agent instructions');
  });

  it('keeps a failure that also names a contradiction with the evidence', () => {
    const both = { rule: 'The title is wrong: the tool result gives a different title, and the paper is unrelated to the topic.', evidence: '' };
    expect(judgesRelevance(both, DIGEST_RULES)).toBeNull();
  });

  it('tells the checker in the prompt', async () => {
    const chat = jest.fn().mockResolvedValue({ message: { content: '{"verdict":"pass","failures":[],"confirmed":[]}' } });
    await new AgentVerifierHelper({ chat } as any).runPanel({ target: 'x', checkers: [{ providerId: 'p' }], evidence: 'REQUEST:\nx', rules: DIGEST_RULES }, 'org-1');
    const [system] = chat.mock.calls[0][1].messages;
    expect(system.content).toMatch(/You fail two kinds of thing only: a claim the EVIDENCE contradicts, and an item that breaks a rule/);
    expect(system.content).toMatch(/never fail an item as "off-topic", "not relevant", "unrelated" or "should be excluded" unless/);
  });
});

describe('1c. a rule failure quotes the instruction it relies on (run 887a8bfe)', () => {
  const overridesSecurity = {
    rule: "Issue 67391 has a 'feature request' label, not a bug/regression/security indicator. The 'security' label alone does not make it a high-priority bug; the instructions require labels like 'confirmed-bug', 'bug', 'regression', 'priority/critical', 'P0', 'P1', 'high-priority', or 'security'. While it has 'security', it is labeled 'feature request', which contradicts its inclusion as a high-priority issue.",
    evidence:
      'Issue 67391 labels from search results: ["feature request", "security"]. The instructions state to pick issues whose labels OR titles indicate bugs, regressions or security. However, a feature request labeled \'security\' is a feature request, not a bug or regression. The agent should have excluded it or clarified it is a security feature request, not a security bug.',
    claim: "| 67391 | Remove or date-limit emSign Root CA - G1 before Mozilla's 2026-11-16 cutoff | feature request, security |",
  };
  const standard = `${WATCHER_RULES}\n${WATCHER_FOCUS}`;

  it('drops one that names a rule and quotes nothing of it: a label name is not an instruction', () => {
    expect(unquotedRule(overridesSecurity, standard)).toBe('it names a rule but quotes nothing from the agent instructions');
    const r = read([overridesSecurity], '', { rules: WATCHER_RULES, focus: WATCHER_FOCUS });
    expect(r.failures).toEqual([]);
  });

  it('keeps one that quotes the instruction as written (run 8a5070c8)', () => {
    const quotes = {
      rule: 'Issue #67427 has no labels indicating bug, regression, or security; it is a question/discussion, not a high-priority issue matching the filter criteria',
      evidence:
        "The search results show #67427 with labels: [] (empty). The agent instructions require filtering for labels like 'confirmed-bug, bug, regression, priority/critical, P0, P1, high-priority, security'. This issue has none of these.",
    };
    expect(unquotedRule(quotes, standard)).toBeNull();
    const r = read([quotes], '', { rules: WATCHER_RULES, focus: WATCHER_FOCUS });
    expect(r.failures).toEqual([expect.objectContaining({ kind: 'rule' })]);
  });

  it('reads the instruction the checker names, and drops it when the words are not in the instructions', () => {
    const named = { rule: '#7547 is a dependency update, not a bug', evidence: 'labels: ["deps"]' };
    expect(unquotedRule({ ...named, instruction: 'pick the ones whose labels or titles indicate bugs, regressions or security' }, standard)).toBeNull();
    expect(unquotedRule({ ...named, instruction: 'only list issues labeled bug' }, standard)).toBe('the instruction it quotes is not in the agent instructions');
    expect(unquotedRule({ ...named, instruction: 'security' }, standard)).toMatch(/too short to be a rule/);
    const r = read([{ ...named, instruction: 'pick the ones whose labels or titles indicate bugs, regressions or security' }], '', { rules: WATCHER_RULES });
    expect(r.failures).toEqual([expect.objectContaining({ kind: 'rule', instruction: 'pick the ones whose labels or titles indicate bugs, regressions or security' })]);
  });

  it('leaves a failure the evidence contradicts alone, and asks for no quote without agent instructions', () => {
    const contradiction = { rule: 'The date of v5.3.0 is wrong: the tool results give 2026-10-09, the output says 2026-10-19.', evidence: 'published_at: 2026-10-09T12:50:31Z' };
    expect(unquotedRule(contradiction, standard)).toBeNull();
    expect(unquotedRule(overridesSecurity, '')).toBeNull();
  });

  it('asks the checker for the instruction in its reply', async () => {
    const chat = jest.fn().mockResolvedValue({ message: { content: '{"verdict":"pass","failures":[],"confirmed":[]}' } });
    await new AgentVerifierHelper({ chat } as any).runPanel({ target: 'x', checkers: [{ providerId: 'p' }], evidence: 'REQUEST:\nx', rules: WATCHER_RULES }, 'org-1');
    const [system] = chat.mock.calls[0][1].messages;
    expect(system.content).toMatch(/must quote, in "instruction", the words of the AGENT INSTRUCTIONS it relies on/);
    expect(chat.mock.calls[0][1].responseFormat.schema.properties.failures.items.required).toContain('instruction');
  });
});

describe('1d/e. failures whose own words agree with the claim', () => {
  it('"which qualifies it" confirms an item the answer lists (run dda8789a)', () => {
    const words =
      "Issue #7532 is listed as high-priority but does not have labels indicating bugs, regressions or security. The agent instructions require picking issues whose labels or titles indicate bugs, regressions or security. While #7532 has a 'bug' label, it should be verified it meets the criteria.\n" +
      'Issue #7532 has labels: ["bug", "4.x", "5.x"]. The \'bug\' label is present, which qualifies it as a high-priority issue per the instructions.';
    expect(confirmsClaim(words)).toBe('qualifies it');
  });

  it('but not where qualifying is why the item should have been listed (run 9b63b1d0)', () => {
    const words =
      'Issue #67391 has security label and should be included; exclusion is incorrect\n' +
      'Issue 67391 in search results has labels: [{"name":"feature request"...}, {"name":"security"...}]. The security label qualifies it for inclusion per agent instructions.';
    expect(confirmsClaim(words)).toBeNull();
  });

  it('nor where it goes on to name a real error', () => {
    expect(confirmsClaim("The 'bug' label qualifies it, but the updated_at date is wrong: the tool gives 2026-11-10.")).toBeNull();
  });

  const momentClaim = 'moment | ^2.29.4 | 2.31.0 | outdated-minor | Minor update from 2.29 to 2.31';
  const moment =
    'Version comparison error: 2.31.0 is a patch update within minor 2.29, not a minor update to 2.31\n' +
    "npm returned moment@2.31.0. Base is 2.29.4. The minor version increased from 29 to 31 (not 29 to 30), so this is outdated-minor, but the note incorrectly states 'from 2.29 to 2.31' when it should clarify the minor version jump.";

  it('"so this is X, but the note incorrectly states ... when it should clarify" agrees with a claim that says X (run c04b7a9b)', () => {
    expect(confirmsClaim(moment, momentClaim)).toBe('so this is outdated-minor');
    const r = read([{ rule: moment.split('\n')[0], evidence: moment.split('\n')[1], claim: momentClaim }], '');
    expect(r.failures).toEqual([]);
  });

  it('but not when the claim says something else, or a real error follows', () => {
    expect(confirmsClaim(moment, 'moment | ^2.29.4 | 2.31.0 | up to date |')).toBeNull();
    expect(confirmsClaim(moment)).toBeNull();
    expect(confirmsClaim('Base is 2.29.4, so this is outdated-minor, but the latest version is wrong: npm returned 2.30.1.', momentClaim)).toBeNull();
    expect(confirmsClaim('so this is wrong: npm returned 2.30.1', 'so this is wrong')).toBeNull();
  });
});

describe('2. an item listed as new from before the window (run dda8789a)', () => {
  const releases = [
    ['v5.3.0', 'v5.3.0', '2026-10-09T12:50:31Z'],
    ['v4.22.2', 'v4.22.2', '2026-05-11T18:54:02Z'],
    ['v5.2.1', 'v5.2.1', '2025-12-01T20:54:44Z'],
    ['v5.0.1', '5.0.1', '2024-10-08T19:41:00Z'],
  ].map(([tag_name, name, published_at]) => ({
    html_url: `https://github.com/expressjs/express/releases/tag/${tag_name}`,
    tag_name,
    name,
    created_at: published_at,
    published_at,
    author: { login: 'UlisesGascon', html_url: 'https://github.com/UlisesGascon' },
  }));
  const evidence = runEvidence(
    { input: { message: 'expressjs/express, look back 30 days' } },
    {
      toolResults: [
        { tool: 'github_rest_api_repos_list_releases', parameters: { owner: 'expressjs', repo: 'express', per_page: 10 }, content: JSON.stringify(releases) },
        { tool: 'github_rest_api_repos_get_latest_release', parameters: { owner: 'expressjs', repo: 'express' }, content: JSON.stringify(releases[0]) },
        {
          tool: 'github_rest_api_search_issues_and_pull_requests',
          content: JSON.stringify({ total_count: 1, items: [{ number: 7532, title: 'req.subdomains splits an IPv6 host that contains dots', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-11-11T12:53:26Z', labels: [{ name: 'bug' }] }] }),
        },
      ],
    },
  );
  const answer = [
    '# Report for expressjs/express',
    '**Look-back window:** 30 days  ',
    '**Run date:** 2026-11-12',
    '',
    '---',
    '',
    '## New releases (last 30 days)',
    '',
    '### v5.3.0',
    '- **Tag:** v5.3.0  ',
    '- **Name:** v5.3.0  ',
    '- **Published at:** 2026-10-09T12:50:31Z  ',
    '- **URL:** [Release v5.3.0](https://github.com/expressjs/express/releases/tag/v5.3.0)  ',
    '- **Summary:**  ',
    '  - Upgrades for dependencies qs, proxy-addr, body-parser fixing multiple CVEs.  ',
    '',
    '---',
    '',
    '## Latest release',
    '',
    '- **Tag:** v5.3.0  ',
    '- **Published at:** 2026-10-09T12:50:31Z  ',
    '',
    '---',
    '',
    '## High-priority open issues (max 10)',
    '',
    '1. [#7532] "req.subdomains splits an IPv6 host that contains dots"  ',
    '   - Labels: bug, 4.x, 5.x  ',
  ].join('\n');

  it('flags v5.3.0, dated 2026-10-09 by the tool results, before the window that starts 2026-10-13', () => {
    expect(itemsOutsideWindow({ request: 'expressjs/express, look back 30 days', answer, evidence, now })).toEqual([
      {
        rule: 'v5.3.0 is listed as new, but the tool results date it 2026-10-09, before the 30-day window (2026-10-13 to 2026-11-12)',
        evidence: "published_at: 2026-10-09T12:50:31Z; the request's window starts on 2026-10-13",
        checker: 'window check',
        claim: '### v5.3.0',
        code: 'outside_window',
        kind: 'deterministic',
      },
    ]);
  });

  it('says nothing for a release inside the window, the latest release, an issue, or an item the evidence has no date for', () => {
    expect(itemsOutsideWindow({ request: 'expressjs/express, look back 60 days', answer, evidence, now })).toEqual([]);
    expect(itemsOutsideWindow({ request: 'expressjs/express', answer, evidence, now })).toEqual([]);
    const unknown = answer.replace(/v5\.3\.0/g, 'v9.9.9');
    expect(itemsOutsideWindow({ request: 'expressjs/express, look back 30 days', answer: unknown, evidence, now })).toEqual([]);
    const noneNew = answer.replace('## New releases (last 30 days)', '## Releases');
    expect(itemsOutsideWindow({ request: 'expressjs/express, look back 30 days', answer: noneNew, evidence, now })).toEqual([]);
  });

  it('reads a table row and a "since" window too', () => {
    const table = '## New releases\n\n| tag | published |\n|---|---|\n| v5.2.1 | 2025-12-01 |\n| v5.3.0 | 2026-10-09 |';
    expect(itemsOutsideWindow({ request: 'expressjs/express, since 2026-10-01', answer: table, evidence, now }).map((f) => f.claim)).toEqual(['| v5.2.1 | 2025-12-01 |']);
  });

  it('fails the check even when the checker passed it, and leads the note', async () => {
    const chat = jest.fn().mockResolvedValue({ message: { content: '{"verdict":"pass","failures":[],"confirmed":["v5.3.0"]}' } });
    const panel = await new AgentVerifierHelper({ chat } as any).runPanel(
      { target: answer, checkers: [{ name: 'release-checker', providerId: 'p' }], evidence, rules: WATCHER_RULES, now },
      'org-1',
    );
    expect(panel.passed).toBe(false);
    expect(panel.checkers.map((c) => [c.checker, c.verdict])).toEqual([['release-checker', 'pass'], ['window check', 'fail']]);
    expect(unverifiedLine(panel.failures)).toBe(
      "Note: this answer's check didn't pass: v5.3.0 is listed as new, but the tool results date it 2026-10-09, before the 30-day window (2026-10-13 to 2026-11-12).",
    );
  });
});

describe('2. an empty list is never left out of the evidence (run 8a5070c8)', () => {
  const items = Array.from({ length: 30 }, (_, i) => ({
    url: `https://api.github.com/repos/nodejs/node/issues/${67400 + i}`,
    html_url: `https://github.com/nodejs/node/issues/${67400 + i}`,
    number: 67400 + i,
    title: `Issue ${i}`,
    labels: i % 2 ? [] : [{ id: i, name: 'sqlite', color: 'ededed', description: 'x'.repeat(200) }],
    body: 'b'.repeat(4000),
    milestone: '',
    user: { login: 'someone', id: i, avatar_url: 'https://avatars.githubusercontent.com/u/1' },
    updated_at: '2026-11-12T02:15:17Z',
  }));
  const raw = JSON.stringify({ total_count: 652, incomplete_results: false, items });

  it('keeps `labels: []` and `""` at every level of shortening, and does not name them as left out', () => {
    for (const allowance of [60_000, 20_000, 9_000]) {
      const { body, note } = fitResult(raw, undefined, allowance);
      const shown = JSON.parse(body);
      expect(note).toBeDefined();
      expect(note).not.toMatch(/labels \(list\)/);
      expect(note).not.toMatch(/milestone \(text\)/);
      expect(shown.items[1]).toMatchObject({ number: 67401, labels: [], milestone: '' });
    }
  });
});

describe('3. the note leads with the strongest reason, and ends once', () => {
  const ruleMisread = { rule: "Issue 67391 has a 'feature request' label; the instructions require labels like 'bug'.", evidence: '', checker: 'c', kind: 'rule' as const };
  const contradicted = { rule: 'The DOI of item 3 does not match the tool results', evidence: '10.1088/1361-6420/aec045', checker: 'c', kind: 'evidence' as const };
  const counted = { rule: 'v5.3.0 is listed as new, but the tool results date it 2026-10-09', evidence: '', checker: 'window check', code: 'outside_window', kind: 'deterministic' as const };

  it('puts what the platform counted first, then evidence contradictions, then rule failures', () => {
    expect(unverifiedReason([ruleMisread, contradicted])).toBe(contradicted.rule);
    expect(unverifiedReason([ruleMisread, contradicted, counted])).toBe(counted.rule);
    // Failures stored before `kind` existed are read from their words.
    expect(unverifiedReason([{ rule: ruleMisread.rule }, { rule: contradicted.rule }])).toBe(contradicted.rule);
    const merged = new AgentVerifierHelper({} as any).mergeVerdicts(
      [
        { checker: 'a', verdict: 'fail', failures: [ruleMisread], passedRules: [] },
        { checker: 'b', verdict: 'fail', failures: [contradicted, counted], passedRules: [] },
      ],
      'any_fail_blocks',
    );
    expect(merged.failures).toEqual([counted, contradicted, ruleMisread]);
  });

  it('does not put a full stop after a reason cut short (run dda8789a)', () => {
    const long = {
      rule: 'Issue #7532 is listed as high-priority but does not have labels indicating bugs, regressions or security. The agent instructions require picking issues whose labels or titles indicate bugs, regressions or security.',
      evidence: '',
    };
    const line = unverifiedLine([long]);
    expect(line.endsWith('l…')).toBe(true);
    expect(line).not.toMatch(/…\.$/);
    expect(markUnverifiedAnswer('answer', [long])).not.toMatch(/…\./);
    expect(unverifiedLine([{ rule: 'The date is wrong.' }])).toBe("Note: this answer's check didn't pass: The date is wrong.");
  });
});

describe('4. no memories from a run whose tool call failed (runs 6c7bd4a5, b8cc6429)', () => {
  const timeout = {
    type: 'tool_call',
    input: { tool: 'openalex_search_works', toolId: '161fe9d6-91ce-49c1-a22f-74b5c366ac76', parameters: { search: 'retrieval augmented generation evaluation' } },
    output: { error: 'Gateway timeout', reason: 'query_timeout' },
    error: 'Request failed with status code 504',
  };
  const ok = { ...timeout, output: { results: [] }, error: undefined };
  const MAIN = { key: 'main', name: 'Main', purpose: 'main', kind: 'model' } as any;
  const agent = { id: 'agent-1', name: 'Research digest', memoryConfig: { enabled: true, save: 'facts' } } as any;
  const run = (steps: any[]) =>
    ({
      id: 'run-1', organizationId: 'org-1', userId: 'u-1', endUserId: null, conversationId: null,
      input: { message: 'retrieval augmented generation evaluation, since 2026-11-01' },
      output: 'I am currently unable to retrieve articles on retrieval augmented generation evaluation since 2026-11-01 due to a server timeout error.',
      steps, totalCost: 0, metadata: { verify: { verdict: 'pass', reportOnly: true } }, workingMemory: {},
    }) as any;
  const keeper = () => {
    const memoryAccounts = { put: jest.fn(async () => ({ id: 'mem-1' })), search: jest.fn(async () => []) };
    const callModel = jest.fn(async () => ({ content: JSON.stringify({ facts: ['The assistant experienced a server timeout error retrieving articles.'] }) }));
    return { k: new AgentMemoryKeeper({ memoryAccounts, logger: { warn: jest.fn() } } as any, { callModel } as any), memoryAccounts, callModel };
  };

  it('names a tool every call of which errored; a built-in tool or a retry that worked is not one', () => {
    expect(failedTools({ steps: [timeout, { ...timeout }] } as any)).toEqual(['openalex_search_works']);
    expect(failedTools({ steps: [timeout, ok] } as any)).toEqual([]);
    expect(failedTools({ steps: [{ type: 'tool_call', input: { tool: 'recall_memory' }, error: 'x' }] } as any)).toEqual([]);
  });

  it('saves nothing from an honest error answer that passed its check, and says why', async () => {
    const { k, memoryAccounts, callModel } = keeper();
    const r = run([{ type: 'verify', output: { verdict: 'pass' } }, timeout, { ...timeout }]);
    await k.afterRun(agent, r, { main: MAIN } as any);
    expect(callModel).not.toHaveBeenCalled();
    expect(memoryAccounts.put).not.toHaveBeenCalled();
    expect(r.steps[r.steps.length - 1]).toMatchObject({ type: 'memory_save', output: { saved: 0, skipped: 'a tool call failed: openalex_search_works' } });
  });

  it('still saves when the tool answered', async () => {
    const { k, memoryAccounts } = keeper();
    await k.afterRun(agent, run([timeout, ok]), { main: MAIN } as any);
    expect(memoryAccounts.put).toHaveBeenCalled();
  });

  it('tells the facts call never to keep a tool or outage status as a fact', () => {
    expect(factsPrompt([])).toMatch(/Never keep the state of a tool, a service or a call as a fact: an error, a timeout, an outage/);
  });
});
