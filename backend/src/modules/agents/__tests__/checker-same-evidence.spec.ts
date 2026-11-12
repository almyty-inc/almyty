import { readFileSync } from 'fs';
import { join } from 'path';

import { AgentStepProcessor } from '../agent-step-processor';
import { AgentVerifierHelper, CHECKER_MAX_TOKENS, CHECKER_ROOMY_MAX_TOKENS, checkerOutputLimit } from '../agent-verifier.helper';
import { AutonomousStrategyRunner } from '../autonomous-strategy.runner';
import { FIELDS_LEFT_OUT, fitResult, leftOutFieldsOf, runEvidence, toolResultsFromMessages } from '../checker-evidence';
import { aboutLeftOutField } from '../checker-guards';
import { falseDateArithmetic, windowNote } from '../date-arithmetic';
import { capPersistedPayload } from '../persist-cap';
import { PriceFeedService } from '../../model-catalog/pricing/price-feed.service';
import { LlmProviderType } from '../../../entities/llm-provider.entity';

/**
 * Real runs on staging (2026-11-12), checked against OpenAlex, GitHub and
 * npm with curl: Research Digest and Release Watcher still got false
 * "check didn't pass" verdicts that deleted correct data. Each describe
 * below is one root cause.
 */

/** Ten OpenAlex works the way the API returns them: long abstracts, authorships with nested authors, a venue under primary_location.source. */
function openAlexWorks(n = 10) {
  return {
    meta: { count: n, per_page: n },
    results: Array.from({ length: n }, (_, i) => ({
      id: `https://openalex.org/W90000${i}`,
      doi: `https://doi.org/10.5555/rag.${i}`,
      title: `Evaluating retrieval augmented generation, part ${i + 1}`,
      publication_date: `2026-11-0${(i % 9) + 1}`,
      cited_by_count: i,
      abstract: `Abstract ${i}. ${'We study retrieval. '.repeat(150)}END-OF-ABSTRACT-${i}`,
      authorships: Array.from({ length: 4 }, (_, a) => ({
        author_position: a === 0 ? 'first' : 'middle',
        author: { id: `https://openalex.org/A${i}${a}`, display_name: `Author ${i}-${a}`, orcid: null },
        institutions: [{ id: 'https://openalex.org/I1', display_name: 'Some University', type: 'education', lineage: ['https://openalex.org/I1'] }],
        raw_affiliation_strings: ['Department of Computer Science, Some University, '.repeat(6)],
        raw_author_name: `Author ${i}-${a}`,
      })),
      primary_location: {
        is_oa: true,
        landing_page_url: `https://example.org/${i}`,
        source: { id: `https://openalex.org/S${i}`, display_name: `Journal ${i}`, issn_l: '1234-5678', host_organization_name: 'Big Publisher', is_core: true },
        license: 'cc-by',
      },
    })),
  };
}

/** A processor with only what prepareCheck reads: the model cards and the run's conversation. */
function processorWith(opts: { card?: Record<string, any> | null; messages?: any[] } = {}) {
  const findOne = jest.fn().mockResolvedValue(opts.card ?? null);
  const find = jest.fn().mockResolvedValue(opts.messages ?? []);
  const self = Object.assign(Object.create(AgentStepProcessor.prototype), {
    s: {
      toolRepository: { manager: { getRepository: () => ({ findOne }) } },
      messageRepository: { find },
      logger: { warn: jest.fn() },
    },
  });
  return { self, findOne, find };
}

describe('1. the checker reads what the writer read (run 5f990f9e)', () => {
  const works = openAlexWorks();
  const raw = JSON.stringify(works);
  const call = { id: 'call-1', name: 'openalex_search_works', parameters: { search: 'retrieval augmented generation evaluation' } };
  const messages = [
    { role: 'user', content: 'retrieval augmented generation evaluation, since 2026-11-01' },
    { role: 'assistant', toolCalls: [call], content: '' },
    { role: 'tool', toolCallId: 'call-1', content: raw },
  ];
  // The run row: the same call, its result capped for storage.
  const run = {
    id: 'run-1',
    organizationId: 'org-1',
    conversationId: 'conv-1',
    input: { message: 'retrieval augmented generation evaluation, since 2026-11-01' },
    steps: [{ type: 'tool_call', input: { tool: call.name, parameters: call.parameters }, output: capPersistedPayload(raw) }],
  };

  it('the stored step is a shortened copy: what the writer read is not all in it', () => {
    const fromSteps = runEvidence(run);
    expect(fromSteps).toContain('[result shortened');
    expect(fromSteps).not.toContain('END-OF-ABSTRACT-3');
  });

  it('pairs each tool call with its result, in the order the calls were made', () => {
    const results = toolResultsFromMessages([
      { role: 'assistant', toolCalls: [{ id: 'a', name: 'first', parameters: { x: 1 } }, { id: 'b', name: 'second', parameters: {} }] },
      { role: 'tool', toolCallId: 'b', content: 'B' },
      { role: 'tool', toolCallId: 'a', content: 'A' },
      { role: 'assistant', toolCalls: [{ id: 'c', name: 'third', parameters: {} }] },
      { role: 'tool', toolCallId: 'c', content: 'boom', error: 'HTTP 503' },
      // An approval's decision replaces its placeholder: the last one is what the writer read.
      { role: 'tool', toolCallId: 'a', content: 'A, approved' },
    ]);
    expect(results.map((r) => [r.tool, r.content, !!r.error])).toEqual([
      ['first', 'A, approved', false],
      ['second', 'B', false],
      ['third', 'boom', true],
    ]);
    expect(results[0].parameters).toEqual({ x: 1 });
  });

  it('builds the evidence from the whole results in the conversation, not the stored copy', async () => {
    const { self, find } = processorWith({ messages });
    const { evidence } = await self.prepareCheck(run, null, [{ providerId: 'p', model: 'm' }], 'answer');
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ where: { conversationId: 'conv-1', runId: 'run-1' } }));
    // Every author and venue the writer had, and the rest of the result whole.
    expect(evidence).toContain(`openalex_search_works ${JSON.stringify(call.parameters)}:\n${raw}`);
    expect(evidence).not.toContain('[result shortened');
    for (let i = 0; i < 10; i++) {
      expect(evidence).toContain(`"display_name":"Author ${i}-0"`);
      expect(evidence).toContain(`"display_name":"Journal ${i}"`);
      expect(evidence).toContain(`END-OF-ABSTRACT-${i}`);
    }
  });

  it('reads the same on a step resumed on another worker: only the database is read', async () => {
    // A fresh processor with nothing in memory from the step that ran the tool.
    const resumed = processorWith({ messages });
    const { evidence } = await resumed.self.prepareCheck({ ...run, steps: [] }, null, [{ providerId: 'p', model: 'm' }], 'answer');
    expect(evidence).toContain('END-OF-ABSTRACT-9');
  });

  it('falls back to the stored steps for a run with no conversation', async () => {
    const { self, find } = processorWith({ messages });
    const { evidence } = await self.prepareCheck({ ...run, conversationId: null }, null, [{ providerId: 'p', model: 'm' }], 'answer');
    expect(find).not.toHaveBeenCalled();
    expect(evidence).toContain('[result shortened');
  });

  it('shortens only past the budget, and then keeps the short identifying leaves of nested objects', () => {
    // Small enough that long texts and lists must go, large enough for every item.
    const { body, note } = fitResult(raw, works, 15_000);
    expect(note).toMatch(/^\[result shortened: every item is shown;/);
    const shown = JSON.parse(body);
    expect(shown.results).toHaveLength(10);
    shown.results.forEach((w: any, i: number) => {
      // authorships[0].author.display_name and primary_location.source.display_name: what the digest names.
      expect(w.authorships[0].author.display_name).toBe(`Author ${i}-0`);
      expect(w.primary_location.source.display_name).toBe(`Journal ${i}`);
      expect(w.abstract).toBeUndefined();
    });
    // Long text and lists went first.
    expect(note).toContain('results[].{abstract (text)');
    expect(note).toContain('raw_affiliation_strings (list)');
    expect(note).not.toMatch(/authorships\[\]\.\{?[^;]*\bauthor \(object\)/);
  });
});

describe('2. the shortening note names every field left out, by path', () => {
  it('names all of them, not the first 12, grouped under their list item, and says what each held', () => {
    const items = Array.from({ length: 30 }, (_, i) => {
      const item: Record<string, unknown> = { id: `item-${i}` };
      for (let f = 0; f < 20; f++) item[`field_${f}`] = `${'long text '.repeat(40)}${f}`;
      item.meta_list = Array.from({ length: 50 }, (_, k) => k);
      return item;
    });
    const raw = JSON.stringify({ results: items });
    const { note } = fitResult(raw, { results: items }, 4_000);
    for (let f = 0; f < 20; f++) expect(note).toContain(`field_${f} (text)`);
    expect(note).toContain('meta_list (list)');
    // Once, under the list item: not once per item.
    expect(note!.match(/field_7 \(text\)/g)).toHaveLength(1);
    expect(note).toMatch(/fields left out: results\[\]\.\{field_0 \(text\), field_1 \(text\)/);
    expect(note).not.toContain('long fields');
  });

  it('a nested field is named by its full path, and an object left out whole is called an object', () => {
    const lists = { results: [{ id: 'x', author: { name_list: Array.from({ length: 200 }, (_, k) => `n${k}`) } }] };
    expect(fitResult(JSON.stringify(lists), lists, 200).note).toContain('results[].author.name_list (list)');
    const blob = { results: [{ id: 'x', blob: { notes: 'long text '.repeat(100) } }] };
    expect(fitResult(JSON.stringify(blob), blob, 100).note).toContain('results[].blob (object)');
  });

  it('reads the note back to every path it names', () => {
    const evidence =
      'openalex_search_works {"search":"x"}: [result shortened: every item is shown; ' +
      `${FIELDS_LEFT_OUT}meta.notice (text), results[].{abstract (text), primary_location.source (object)}, results[].authorships[].author (object); 4 long texts cut; 1,000 chars omitted]\n{}`;
    expect(leftOutFieldsOf(evidence).sort()).toEqual(
      ['meta.notice', 'results[].abstract', 'results[].authorships[].author', 'results[].primary_location.source'].sort(),
    );
  });

  it('the stored copy says the same (persist-cap.ts shortens with fitResult)', () => {
    const works = openAlexWorks(40);
    const stored = capPersistedPayload(JSON.stringify(works)) as string;
    const note = JSON.parse(stored)._shortened as string;
    expect(note).toContain('fields left out: ');
    expect(note).toContain('results[].{abstract (text)');
    expect(note).not.toContain('long fields left out');
  });
});

describe('3. a failure about a field the evidence left out does not count', () => {
  const evidence =
    'REQUEST:\nrag\n\nopenalex_search_works: [result shortened: every item is shown; ' +
    `${FIELDS_LEFT_OUT}results[].{abstract (text), primary_location (object)}, results[].authorships[].author (object); 9,000 chars omitted]\n` +
    '{"results":[{"id":"https://openalex.org/W1","title":"A study"}]}';

  it('finds the path a failure is about', () => {
    const leftOut = leftOutFieldsOf(evidence);
    // Run 5f990f9e, verbatim.
    expect(aboutLeftOutField({ rule: 'First author name does not match the evidence; evidence does not provide first author name for this work', evidence: '' }, leftOut)).toBe(
      'results[].authorships[].author',
    );
    expect(aboutLeftOutField({ rule: 'evidence includes primary_location for this work; output omits venue', evidence: '' }, leftOut)).toBe('results[].primary_location');
    // A contradiction is not an absence, and a field that was not left out is not covered.
    expect(aboutLeftOutField({ rule: 'author is Jane Doe in evidence, output says John', evidence: '' }, leftOut)).toBeNull();
    expect(aboutLeftOutField({ rule: 'output omits the DOI', evidence: '' }, leftOut)).toBeNull();
  });

  it('readFailures drops it and says why on the step; a real failure stays', () => {
    const helper = new AgentVerifierHelper({} as any);
    const read = helper.readFailures(
      {
        verdict: 'fail',
        failures: [
          { claim: 'First Author: Li Yongxin', rule: 'First author name does not match the evidence; evidence does not provide first author name for this work', evidence: 'The evidence does not list any author names.' },
          { claim: 'Venue: eLife', rule: 'Venue is not provided in the evidence; evidence includes primary_location without a name', evidence: '' },
          { claim: 'DOI: none', rule: 'The DOI is wrong', evidence: 'evidence has DOI 10.1/x' },
        ],
      },
      'Source check',
      evidence,
    );
    expect(read.failures.map((f) => f.claim)).toEqual(['DOI: none']);
    expect(read.discarded.map((d) => d.reason)).toEqual([
      'it is about results[].authorships[].author, which the evidence left out',
      'it is about results[].primary_location, which the evidence left out',
    ]);
  });

  it('tells the checker in its instructions', async () => {
    const chat = jest.fn().mockResolvedValue({ message: { content: '{"verdict":"pass","failures":[],"confirmed":[]}' } });
    await new AgentVerifierHelper({ chat } as any).runPanel({ target: 'x', checkers: [{ providerId: 'p' }], evidence }, 'org-1');
    const system = chat.mock.calls[0][1].messages[0].content as string;
    expect(system).toMatch(/A field the note names under "fields left out" is not in what you see: never fail a claim about that field/);
  });
});

describe('4. day arithmetic is counted, not taken from the checker', () => {
  const now = new Date('2026-11-12T01:53:21.740Z');

  it('drops "within 30 days" for a date 34 days back (run 942d21f9, both rounds)', () => {
    expect(falseDateArithmetic('Release v5.3.0 published 2026-10-09T12:50:31Z is within 30 days of 2026-11-12 (33 days ago, not 34)', now)).toBe(
      '2026-10-09 is 34 days from 2026-11-12, so it is not within 30 days',
    );
    expect(
      falseDateArithmetic('Release v5.3.0 was published at 2026-10-09T12:50:31Z, which is within 30 days of 2026-11-12 (34 days back). The look-back window is 30 days, so this release should be listed as new.', now),
    ).toMatch(/not within 30 days/);
  });

  it('drops "within the 7-day window" for a date 14 days back, with no reference date stated (run 85f89397)', () => {
    expect(falseDateArithmetic('A release published 2026-10-29 is within the 7-day look-back window (current time 2026-11-12).', now)).toMatch(/2026-10-29 is 14 days from 2026-11-12/);
  });

  it('drops "outside the 7-day window" for a date 2 days back (run b60bacad)', () => {
    expect(falseDateArithmetic('Issue #67085 was updated on 2026-11-10, which is outside the 7-day look-back window (2026-11-05 to 2026-11-12).', now)).toMatch(/so it is within 7 days/);
  });

  it('drops a day count that is off by more than a day', () => {
    expect(falseDateArithmetic('v5.3.0 was published 2026-10-09, which is 25 days before the current date (2026-11-12).', now)).toBe('2026-10-09 is 34 days before 2026-11-12, not 25');
    expect(falseDateArithmetic('Updated 2026-10-05, 30 days before 2026-11-12.', now)).toMatch(/38 days before 2026-11-12, not 30/);
  });

  it('keeps correct arithmetic: the first round of run 942d21f9 was right', () => {
    expect(
      falseDateArithmetic(
        'Release date is outside the 30-day look-back window. Current time is 2026-11-12; 30 days back is 2026-10-13. v5.3.0 was published 2026-10-09, which is 34 days before the current date.\nCurrent time: 2026-11-12T01:52:47.266Z. v5.3.0 published_at: 2026-10-09T12:50:31Z. Difference: 34 days.',
        now,
      ),
    ).toBeNull();
    expect(falseDateArithmetic('Issue #6711 was last updated 2026-10-05, which is 38 days before the current date.', now)).toBeNull();
    expect(falseDateArithmetic('2026-10-09 is outside the 30-day window; 2026-11-11 is within the 7-day window; created 15 days ago on 2026-10-28.', now)).toBeNull();
    // A time of day moves a count by one.
    expect(falseDateArithmetic('published 2026-10-09T12:50:31Z, 33 days ago', now)).toBeNull();
  });

  it('does not judge a statement the failure quotes from the answer', () => {
    expect(falseDateArithmetic('The OUTPUT says 2026-10-09 is within 30 days of 2026-11-12, but it is not.', now)).toBeNull();
  });

  it('readFailures drops the false one and notes why', () => {
    const read = new AgentVerifierHelper({} as any).readFailures(
      {
        verdict: 'fail',
        failures: [
          { claim: 'No releases found in the last 30 days.', rule: 'Release v5.3.0 published 2026-10-09T12:50:31Z is within 30 days of 2026-11-12 (33 days ago, not 34)', evidence: '' },
          { claim: '### v5.3.0 (2026-10-09)', rule: 'Release date is outside the 30-day look-back window. v5.3.0 was published 2026-10-09, which is 34 days before the current date.', evidence: '' },
        ],
      },
      'release-checker',
      '',
      now,
    );
    expect(read.failures.map((f) => f.claim)).toEqual(['### v5.3.0 (2026-10-09)']);
    expect(read.discarded[0].reason).toBe('its day arithmetic is wrong: 2026-10-09 is 34 days from 2026-11-12, so it is not within 30 days');
  });

  it('gives the checker the window as dates when the request names one', async () => {
    expect(windowNote(['nodejs/node, look back 7 days'], now)).toBe(
      'Today is 2026-11-12 (UTC). The 7-day window runs from 2026-11-05 to 2026-11-12: a date on or after 2026-11-05 is inside it, an earlier date is outside it.',
    );
    expect(windowNote(['expressjs/express, look back 30 days'], now)).toMatch(/runs from 2026-10-13 to 2026-11-12/);
    expect(windowNote(['retrieval augmented generation evaluation, since 2026-11-01'], now)).toMatch(/The window starts on 2026-11-01/);
    expect(windowNote(['{"dependencies":{"lodash":"^4.17.21"}}'], now)).toBeNull();

    const chat = jest.fn().mockResolvedValue({ message: { content: '{"verdict":"pass","failures":[],"confirmed":[]}' } });
    await new AgentVerifierHelper({ chat } as any).runPanel(
      { target: 'x', checkers: [{ providerId: 'p' }], evidence: 'REQUEST:\nexpressjs/express, look back 30 days\n\ntool:\n{}', now },
      'org-1',
    );
    const [system, user] = chat.mock.calls[0][1].messages;
    expect(user.content).toContain('DATES:\nToday is 2026-11-12 (UTC). The 30-day window runs from 2026-10-13 to 2026-11-12');
    expect(system.content).toMatch(/Work out every difference between dates by counting the days from the dates themselves; never estimate it/);
  });
});

describe("5. the checker judges by the agent's own rules (run b60bacad)", () => {
  const instructions =
    'From its items pick the ones whose labels or titles indicate bugs, regressions or security (labels like confirmed-bug, bug, regression).';

  it("puts the agent's instructions in front of the checker as the standard, and forbids stricter rules", async () => {
    const chat = jest.fn().mockResolvedValue({ message: { content: '{"verdict":"pass","failures":[],"confirmed":[]}' } });
    await new AgentVerifierHelper({ chat } as any).runPanel({ target: 'x', checkers: [{ providerId: 'p' }], evidence: 'REQUEST:\nnodejs/node', rules: instructions }, 'org-1');
    const [system, user] = chat.mock.calls[0][1].messages;
    expect(user.content).toContain(`AGENT INSTRUCTIONS (the standard to judge by):\n${instructions}`);
    expect(system.content).toMatch(/Judge against the agent's stated rules, never stricter rules of your own/);
    expect(system.content).toMatch(/an item that meets any one of them meets the rule/);
  });

  it('prepareCheck hands over the agent instructions; every check passes them on', async () => {
    const { self } = processorWith();
    const prepared = await self.prepareCheck({ id: 'r', organizationId: 'o', steps: [] }, { instructions }, [{ providerId: 'p', model: 'm' }], 'answer');
    expect(prepared.rules).toBe(instructions);

    const src = readFileSync(join(__dirname, '..', 'agent-step-processor.ts'), 'utf8');
    const verify = src.slice(src.indexOf('private async runAutonomousVerify'), src.indexOf('async prepareCheck'));
    expect(verify).toMatch(/rules: check\.rules/);
    expect(src.match(/await this\.prepareCheck\(run, agent, \[checkerOf\(team\.checker!\)\]/g)).toHaveLength(2);
  });

  it('the strategy checker gets the rules and the sized checker', async () => {
    const runPanel = jest.fn().mockResolvedValue({ cost: 0, tokens: 0, passed: true, verdict: 'pass', failures: [], checkers: [] });
    const runner = new AutonomousStrategyRunner({} as any, { runPanel } as any);
    const run: any = { organizationId: 'o', totalCost: 0, totalTokens: 0, metadata: {} };
    await runner.check(run, { name: 'checker', providerId: 'p', model: 'm' } as any, 'answer', undefined, {
      evidence: 'REQUEST:\nx',
      rules: instructions,
      checkers: [{ name: 'checker', providerId: 'p', model: 'm', maxTokens: 8_192 }],
    });
    expect(runPanel.mock.calls[0][0]).toEqual(expect.objectContaining({ rules: instructions, evidence: 'REQUEST:\nx', checkers: [expect.objectContaining({ maxTokens: 8_192 })] }));
  });
});

describe('6. the checker reply has room (run 560ef789)', () => {
  it('asks for 8,192 tokens where the model card allows it, its own most where less, 4,096 when unknown', () => {
    expect(checkerOutputLimit(64_000)).toBe(CHECKER_ROOMY_MAX_TOKENS);
    expect(CHECKER_ROOMY_MAX_TOKENS).toBe(8_192);
    expect(checkerOutputLimit(4_096)).toBe(4_096);
    expect(checkerOutputLimit(null)).toBe(CHECKER_MAX_TOKENS);
    expect(checkerOutputLimit(undefined)).toBe(4_096);
  });

  it("prepareCheck reads the card's most output, and keeps a checker's own setting", async () => {
    const roomy = processorWith({ card: { id: 'm', contextLength: 200_000, maxOutputTokens: 64_000 } });
    const [sized] = (await roomy.self.prepareCheck({ id: 'r', organizationId: 'o', steps: [] }, null, [{ providerId: 'p', model: 'claude-haiku-4-5' }], 'a')).checkers;
    expect(sized.maxTokens).toBe(8_192);
    expect(roomy.findOne).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({ maxOutputTokens: true }) }));

    const unknown = processorWith({ card: null });
    expect((await unknown.self.prepareCheck({ id: 'r', organizationId: 'o', steps: [] }, null, [{ providerId: 'p', model: 'x' }], 'a')).checkers[0].maxTokens).toBe(4_096);

    const own = processorWith({ card: { id: 'm', maxOutputTokens: 64_000 } });
    expect((await own.self.prepareCheck({ id: 'r', organizationId: 'o', steps: [] }, null, [{ providerId: 'p', model: 'x', maxTokens: 2_000 }], 'a')).checkers[0].maxTokens).toBe(2_000);
  });

  it('the call asks for that budget', async () => {
    const chat = jest.fn().mockResolvedValue({ message: { content: '{"verdict":"pass","failures":[],"confirmed":[]}' } });
    await new AgentVerifierHelper({ chat } as any).runPanel({ target: 'x', checkers: [{ providerId: 'p', maxTokens: 8_192 }] }, 'org-1');
    expect(chat.mock.calls[0][1].maxTokens).toBe(8_192);
  });

  it('asks for confirmations as ids, not sentences', async () => {
    const chat = jest.fn().mockResolvedValue({ message: { content: '{"verdict":"pass","failures":[],"confirmed":[]}' } });
    await new AgentVerifierHelper({ chat } as any).runPanel({ target: 'x', checkers: [{ providerId: 'p' }], evidence: 'REQUEST:\nx' }, 'org-1');
    const system = chat.mock.calls[0][1].messages[0].content as string;
    expect(system).toContain('"confirmed":["<the id, number, name or version of an item you found right>"]');
    expect(system).toMatch(/Each "confirmed" entry is only the item's id, number, name or version \("#67421", "lodash"\), never a sentence/);
  });

  it('the price feed fills the card: LiteLLM max_output_tokens, OpenRouter top_provider.max_completion_tokens', () => {
    const feed = Object.create(PriceFeedService.prototype) as PriceFeedService;
    const litellm = feed.normaliseLiteLlm({
      'claude-haiku-4-5-20251001': { litellm_provider: 'anthropic', input_cost_per_token: 0.000001, output_cost_per_token: 0.000005, max_input_tokens: 200_000, max_output_tokens: 64_000 },
    });
    expect(litellm.map.get(`${LlmProviderType.ANTHROPIC}:claude-haiku-4-5-20251001`)?.maxOutputTokens ?? Array.from(litellm.map.values())[0].maxOutputTokens).toBe(64_000);
    const openrouter = feed.normaliseOpenRouter([
      { id: 'openai/gpt-4.1-mini', pricing: { prompt: '0.0000004', completion: '0.0000016' }, context_length: 1_047_576, top_provider: { max_completion_tokens: 32_768 } },
    ]);
    expect(Array.from(openrouter.map.values())[0].maxOutputTokens).toBe(32_768);
  });

  it('a card whose most output changed is saved', () => {
    const feed = Object.create(PriceFeedService.prototype) as any;
    const fetchedAt = new Date('2026-11-12T00:00:00Z');
    const row = { pricingSource: 'feed:litellm', pricing: { inPerMTok: 1, outPerMTok: 5, currency: 'USD' }, pricingFetchedAt: fetchedAt, contextLength: 200_000, maxOutputTokens: null, capabilities: {}, metadata: null };
    const next = { pricingSource: 'feed:litellm', pricing: { inPerMTok: 1, outPerMTok: 5, currency: 'USD' }, pricingFetchedAt: fetchedAt, metadata: null };
    expect(feed.cardChanged(row, next)).toBe(false);
    expect(feed.cardChanged(row, { ...next, maxOutputTokens: 64_000 })).toBe(true);
  });
});
