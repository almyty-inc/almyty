import { Injectable } from '@nestjs/common';

import { LlmProvidersService } from '../llm-providers/llm-providers.service';
import type { ChatResponse } from '../llm-providers/llm-providers.service';
import type { ExecutionPrincipal } from '../../common/authorization/execution-access.service';
import type { RoutingPolicy } from '../model-catalog/routing/model-router';
import { SHORTENED_MARK } from './checker-evidence';
import { falseVersionOrder } from './version-order';
import { falseDateArithmetic, windowNote } from './date-arithmetic';
import { strongestFirst, type FailureKind } from './checker-guards';
import { itemsOutsideWindow } from './window-check';
import { answerCodeFindings, CODE_CHECKER, type WholeToolResult } from './answer-checks';
import { verifiedRule, verifyCheckerFinding } from './checker-findings';

/** Verdict-merge policy for a verify node's checker panel. */
export type VerifyPolicy = 'all_pass' | 'majority' | 'any_fail_blocks';

/**
 * A verdict finding: something wrong with the answer that the platform
 * found itself (`deterministic`), or that a checker cited from the tool
 * data and the code confirmed (`evidence`). Only these decide the verdict
 * of a final-answer check.
 */
export interface VerifyFailure {
  rule: string;
  evidence: string;
  checker: string;
  /** The claim in the answer the failure is about, when the checker named it. */
  claim?: string;
  /** A machine code for a failure the platform raised itself (verification_unavailable, outside_window, item_field, ...). `rule` is the words a person reads. */
  code?: string;
  /** What the failure rests on: a check the platform made itself, or tool data a checker cited and the code confirmed. */
  kind?: FailureKind;
  /** The item the failure is about ("dotenv", "#67427", a title) and its field ("status", "publication date"). */
  item?: string;
  field?: string;
}

/**
 * Anything else a checker said: a rule or selection judgement, style,
 * relevance, a contradiction it could not cite from the tool data. Shown
 * on the run's verify step under "Checker notes"; never on the answer,
 * never in a visitor channel, never deciding the verdict.
 */
export interface CheckerNote {
  checker: string;
  text: string;
  /** The claim in the answer it is about, when the checker named one. */
  claim?: string;
  /** For a failure the code could not verify, why it is a note. */
  why?: string;
}

/**
 * A single refute-only checker. Vendor is chosen per-checker via providerId,
 * or by the catalog from a routing policy.
 */
export interface CheckerConfig {
  name?: string;
  providerId?: string;
  model?: string;
  routing?: RoutingPolicy;
  instructions?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface CheckerResult {
  checker: string;
  verdict: 'pass' | 'fail' | 'error';
  /** Its verdict findings: with evidence, only those the code verified. */
  failures: VerifyFailure[];
  /** Everything else it said: never deciding the verdict. */
  notes?: CheckerNote[];
  passedRules: string[];
  /** Why the checker gave no verdict, in words a person can act on. */
  error?: string;
  /** What else happened reading the verdict: a cut-off reply read in part, items not counted. */
  note?: string;
  cost?: number;
  tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** The model that gave the verdict, and the router's attribution when it was routed. */
  model?: string;
  providerId?: string;
  routing?: ChatResponse['routing'];
}

export interface VerifyPanelResult {
  verdict: 'pass' | 'fail';
  passed: boolean;
  /** No checker gave a verdict: the answer was not checked, nothing was found wrong with it. */
  unavailable?: boolean;
  policy: VerifyPolicy;
  /** The verdict findings, strongest first. */
  failures: VerifyFailure[];
  /** The checkers' notes: shown on the run, never on the answer, never deciding the verdict. */
  notes?: CheckerNote[];
  passedRules: string[];
  checkers: Array<{
    checker: string;
    verdict: 'pass' | 'fail' | 'error';
    error?: string;
    note?: string;
    model?: string;
    providerId?: string;
    routing?: ChatResponse['routing'];
  }>;
  cost: number;
  tokens: number;
  /** What the checkers read (the evidence is most of it) and wrote, summed. */
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * `text.replace(/\s*```$/i, '')`: a closing code fence and the space
 * before it. The regex retried from every character of a run of spaces
 * that did not end in a fence, which on a checker reply (an LLM chose
 * it) of 100 KB of spaces took seven seconds.
 */
export function stripClosingFence(text: string): string {
  if (!text.endsWith('```')) return text;
  let end = text.length - 3;
  while (end > 0 && /\s/.test(text[end - 1])) end--;
  return text.slice(0, end);
}

/**
 * Output budget of a checker call when its config sets none and its
 * model's most output is not known. Not the provider's default:
 * Anthropic's is 1,024 tokens, which cut a dozen-item verdict off
 * mid-JSON (run b9803830).
 */
export const CHECKER_MAX_TOKENS = 4_096;
/**
 * Output budget of a checker call whose model card says it may write at
 * least this much. 4,096 cut a verdict on eight packages off (run 560ef789).
 */
export const CHECKER_ROOMY_MAX_TOKENS = 8_192;

/**
 * A checker's output budget from its model card's most output tokens:
 * 8,192 where the model allows it, the model's own most where that is
 * less, and 4,096 when the card does not say.
 */
export function checkerOutputLimit(maxOutputTokens?: number | null): number {
  if (typeof maxOutputTokens !== 'number' || !(maxOutputTokens > 0)) return CHECKER_MAX_TOKENS;
  return Math.min(CHECKER_ROOMY_MAX_TOKENS, Math.floor(maxOutputTokens));
}

/** What a person reads when no checker could give a verdict. Code: verification_unavailable. */
export const UNAVAILABLE_RULE = 'the checker could not give a verdict';

/** Item statuses that mean "this claim is wrong". Any other status is not a failure. */
const FAILED_STATUSES = new Set(['fail', 'failed', 'failure', 'wrong', 'incorrect', 'violation', 'contradicted', 'unsupported', 'error']);

/**
 * The checker's reply, as a JSON schema for providers that take one
 * (structured output, structured-output.ts): contradictions it can cite
 * from the tool data in "failures", everything else it would question in
 * "notes", what it found right in "confirmed". Checkers asked for one list
 * put confirmations and opinions in it, and each failed a correct answer.
 */
export const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'failures', 'notes', 'confirmed'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    failures: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'evidence', 'rule'],
        properties: {
          // The wrong claim, copied exactly from the answer.
          claim: { type: 'string' },
          // The tool data that shows it is wrong, copied exactly.
          evidence: { type: 'string' },
          rule: { type: 'string' },
        },
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
    confirmed: { type: 'array', items: { type: 'string' } },
  },
} as const;

const VERDICT_FORMAT = { name: 'checker_verdict', schema: VERDICT_SCHEMA as unknown as Record<string, any> };

/** Whether a provider error says it would not take the reply schema: then ask again without it. */
function refusedFormat(err: any): boolean {
  const status = err?.response?.status ?? err?.status;
  const text = String(err?.response?.data?.error?.message ?? err?.message ?? '');
  return status === 400 || /response_format|json_schema|responseSchema|structured output/i.test(text);
}

type ParsedVerdict = { verdict?: string; failures?: any[]; notes?: any[]; passed_rules?: any[]; confirmed?: any[] };

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function asVerdict(value: unknown): ParsedVerdict | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as ParsedVerdict) : null;
}

/** Whether a provider's finish reason says the reply hit its output limit. */
function isCutOff(finishReason: unknown): boolean {
  return typeof finishReason === 'string' && ['length', 'max_tokens', 'max_output_tokens', 'MAX_TOKENS'].includes(finishReason);
}

function oneLine(text: string, max: number): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * A verdict object cut off mid-way (the reply hit its output limit), read
 * up to the last value that closed inside it, with the open brackets
 * closed. `{"verdict":"fail","failures":[{"rule":"a"},{"rule":"b","evid`
 * reads as a fail with failure "a". Only a reply that states its verdict
 * is read this way; a pass is accepted only when its "failures" list
 * closed, so a cut-off list of failures is never read as a clean pass.
 * One pass over the text; no regex.
 */
export function salvageTruncatedJson(text: string): ParsedVerdict | null {
  if (!text.startsWith('{')) return null;
  const stack: string[] = [];
  const cuts: Array<{ at: number; closers: string }> = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') {
      if (stack.pop() !== c) return null;
      if (stack.length === 0) break;
      cuts.push({ at: i + 1, closers: [...stack].reverse().join('') });
    }
  }
  for (let k = cuts.length - 1; k >= 0 && k >= cuts.length - 8; k--) {
    const parsed = asVerdict(tryJson(text.slice(0, cuts[k].at) + cuts[k].closers));
    if (!parsed || (parsed.verdict !== 'pass' && parsed.verdict !== 'fail')) continue;
    if (parsed.verdict === 'pass' && !failuresClosed(text, cuts[k].at)) continue;
    return parsed;
  }
  return null;
}

/** Whether the "failures" list closed before `at` (it is read up to there). */
function failuresClosed(text: string, at: number): boolean {
  const key = text.indexOf('"failures"');
  if (key === -1 || key > at) return false;
  const open = text.indexOf('[', key);
  if (open === -1 || open > at) return false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < at; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) return true;
    }
  }
  return false;
}

export { runEvidence, evidenceBudget, SHORTENED_MARK } from './checker-evidence';

/** The request at the head of the evidence (runEvidence writes it first), or ''. */
function requestOf(evidence: string): string {
  if (!evidence.startsWith('REQUEST:\n')) return '';
  const end = evidence.indexOf('\n\n');
  return evidence.slice('REQUEST:\n'.length, end === -1 ? undefined : end);
}

/**
 * The checks the platform makes itself on an answer, before any checker
 * model is asked: the request's window (window-check.ts) and the item,
 * count, completeness and skip checks (answer-checks.ts). Each finding
 * names the item and the field, and decides the verdict on its own.
 */
export function codeFindings(input: { request: string; answer: string; evidence: string; now: Date; earlier?: string[]; whole?: WholeToolResult[] }): VerifyFailure[] {
  const found: VerifyFailure[] = [...itemsOutsideWindow(input), ...answerCodeFindings(input)];
  const seen = new Set<string>();
  return found.filter((f) => (seen.has(f.rule) ? false : (seen.add(f.rule), true)));
}

/**
 * The checker notes of a panel, for the verify step it is recorded on
 * (`{ notes }`, or nothing when there are none). Only the run view reads
 * them: the answer's note and every visitor channel read the verdict
 * findings alone.
 */
export function checkerNotesOf(panel: Pick<VerifyPanelResult, 'notes'>): { notes?: CheckerNote[] } {
  return panel.notes?.length ? { notes: panel.notes } : {};
}

/** What the reply looks like and what goes where, said once for both prompts. */
const REPLY_FORMAT =
  `\n\nReply with ONLY a JSON object, no prose, no code fences:\n` +
  `{"verdict":"pass"|"fail","failures":[{"claim":"<the wrong claim, copied from the OUTPUT>","evidence":"<the text that shows it is wrong>","rule":"<what is wrong, naming the item and the field>"}],"notes":["<anything else you would question, one sentence>"],"confirmed":["<the id, number, name or version of an item you found right>"]}\n` +
  `"failures" holds only claims that are wrong. A claim you checked and found right goes in "confirmed", never in "failures". ` +
  `Each "confirmed" entry is only the item's id, number, name or version ("#67421", "lodash"), never a sentence. ` +
  `Keep each failure and note short. "verdict" is "fail" when "failures" lists anything, else "pass".`;

/**
 * The checker's instructions for a final answer checked against the
 * run's tool results. Only a contradiction it can cite from the tool data
 * is a failure, and the platform verifies each (checker-findings.ts);
 * every other judgement is a note that never changes the verdict.
 */
function evidencePrompt(rules: string, focus?: string): string {
  return (
    `You are a verifier. Your ONLY job is to find what is WRONG with the OUTPUT, judged against the EVIDENCE: what the agent was asked and what its tools returned in this run. ` +
    `Do not praise, summarize, or restate.` +
    `\n\nYour reply has two lists, and only the first decides the verdict.` +
    `\n\n"failures": a claim in the OUTPUT that the tool results contradict: a value the OUTPUT gives for an item (a date, version, number, id, DOI, title, name, venue, author or label) ` +
    `where the tool results give that same item a different value. For each failure:\n` +
    `- "claim": the words of the OUTPUT that give the wrong value, copied exactly, character for character (one line, at most 200 characters);\n` +
    `- "evidence": the text of the tool results that gives the right value, copied exactly, character for character, with its field name (for example "publication_date":"2026-11-09");\n` +
    `- "rule": what is wrong, in plain words that name the item and the field.\n` +
    `The platform checks every failure: one whose claim is not in the OUTPUT, whose evidence is not in the tool results, or whose two values do not differ, is not counted.` +
    `\n\n"notes": everything else you would question, one short sentence each: whether an item meets the agent's rules, which items were picked or left out, ` +
    `relevance, wording, style. Notes are shown to the agent's owner and never change the verdict.` +
    (rules
      ? `\n\nThe AGENT INSTRUCTIONS are the rules the agent was given. Read them as written, never stricter: where they allow alternatives ("labels or titles"), ` +
        `an item that meets any one of them meets the rule. What you find about them goes in "notes".`
      : '') +
    `\n\nNever use your own knowledge of versions, dates, prices or other facts to overrule the EVIDENCE; it is newer than you. ` +
    `Compare version numbers part by part as integers: 4.18.1 is newer than 4.17.21, because 18 > 17. ` +
    `Work out every difference between dates by counting the days from the dates themselves; never estimate it. ` +
    `Count the items a tool returned from the list of items in its result, never from a total the result reports about the whole collection. ` +
    `A tool result marked "${SHORTENED_MARK} ...]" or "[result left out ...]" is incomplete: a value missing from what you see is not a contradiction.` +
    (focus ? `\n\nFocus: ${focus}` : '') +
    REPLY_FORMAT
  );
}

/** The checker's instructions where there are no tool results to check against: a workflow's verify step, a mid-run review. */
function specPrompt(rules: string, focus?: string): string {
  const standard = rules ? 'the AGENT INSTRUCTIONS or the SPEC' : 'the SPEC';
  return (
    `You are a verifier. Your ONLY job is to find what is WRONG with the OUTPUT ` +
    `relative to the SPEC. Do not praise, summarize, or restate. Hunt for ` +
    `violations, missing requirements, unsupported claims, and contradictions.` +
    (rules
      ? `\n\nThe AGENT INSTRUCTIONS are the rules the agent was given, and the standard you judge the OUTPUT by. ` +
        `Judge against them as written, never stricter rules of your own: where they allow alternatives ` +
        `("labels or titles"), an item that meets any one of them meets the rule.`
      : '') +
    `\n\nFail a claim that is wrong, or an item that breaks a rule ${standard} states. Anything else you would question goes in "notes".` +
    (focus ? `\n\nFocus: ${focus}` : '') +
    REPLY_FORMAT
  );
}

/**
 * Each checker's verdict, for the verify step it is recorded on: why one
 * gave none ("the checker's reply was cut off at its output limit ...")
 * and what else happened reading it. The run view shows these.
 */
export function checkerVerdicts(
  panel: Pick<VerifyPanelResult, 'checkers'>,
): Array<{ checker: string; verdict: 'pass' | 'fail' | 'error'; error?: string; note?: string }> {
  return (panel.checkers ?? []).map((c) => ({
    checker: c.checker,
    verdict: c.verdict,
    ...(c.error ? { error: c.error } : {}),
    ...(c.note ? { note: c.note } : {}),
  }));
}

/**
 * Shared verifier: a refute-only checker panel that judges an OUTPUT against a
 * SPEC. Each checker runs in its own bounded context with its own provider/model
 * (multi-vendor = checkers pointed at different-vendor provider entities), in
 * parallel, and the verdicts are merged under a policy.
 *
 * Extracted from the pipeline `verify` node so both the DAG node executor and
 * the autonomous step processor share one implementation of the checker logic,
 * the tolerant JSON parse, and the verdict merge.
 */
@Injectable()
export class AgentVerifierHelper {
  constructor(private readonly llmProvidersService: LlmProvidersService) {}

  /**
   * Run the full checker panel against already-resolved target/spec text and
   * merge the verdicts. Never throws on a checker error — a failed or
   * unparseable checker becomes verdict 'error' and the policy layer decides
   * whether that blocks. Returns the merged verdict plus aggregate cost/tokens.
   */
  async runPanel(
    opts: {
      target: any;
      spec?: string;
      checkers: CheckerConfig[];
      policy?: VerifyPolicy;
      /** What the answer must agree with: the request and the tool results (see runEvidence). */
      evidence?: string;
      /**
       * The agent's own instructions: the standard the answer is held to.
       * A checker that applied stricter rules of its own failed issues the
       * agent's rules let in ("labels or titles", run b60bacad).
       */
      rules?: string;
      /** Today, for the day arithmetic the checker's failures state. Defaults to the time of the call. */
      now?: Date;
      /**
       * What this agent's earlier completed runs answered, newest first and
       * bounded (AgentStepProcessor.prepareCheck). An answer that says it
       * skipped items as already reported is checked against them.
       */
      earlier?: string[];
      /**
       * The run's tool results read whole (toolResultsFromMessages), when
       * the caller has them. The code checks read release notes from them:
       * the evidence cuts long texts to fit the checker's budget.
       */
      toolResults?: WholeToolResult[];
    },
    organizationId: string,
    /** Who the checker calls act as: the run's principal (see LlmChatHelper.chat). */
    userId?: string | ExecutionPrincipal,
    signal?: AbortSignal,
  ): Promise<VerifyPanelResult> {
    const policy: VerifyPolicy = opts.policy || 'any_fail_blocks';
    const targetText =
      typeof opts.target === 'string'
        ? opts.target
        : JSON.stringify(opts.target, null, 2);
    const spec = opts.spec || '';
    const checkers = Array.isArray(opts.checkers) ? opts.checkers : [];
    const evidence = opts.evidence?.trim() || '';
    const extra = { rules: opts.rules?.trim() || '', now: opts.now ?? new Date() };

    const fromModels = await Promise.all(
      checkers.map((checker, i) =>
        this.runChecker(checker, i, targetText, spec, organizationId, userId, signal, evidence, extra),
      ),
    );
    // What is counted and compared, not judged: an item listed as new whose
    // date is before the request's window, an item field that contradicts
    // the tool's value for that item, counts that do not add up, items left
    // out of a list said to be complete. These stand beside the checkers
    // as a check of their own, so a checker that passed over them (run
    // dda8789a) does not pass the answer.
    const found = checkers.length && evidence ? codeFindings({ request: requestOf(evidence), answer: targetText, evidence, now: extra.now, earlier: opts.earlier, whole: opts.toolResults }) : [];
    const checkerResults: CheckerResult[] = found.length
      ? [...fromModels, { checker: CODE_CHECKER, verdict: 'fail', failures: found, passedRules: [] }]
      : fromModels;

    const merged = this.mergeVerdicts(checkerResults, policy);

    return {
      verdict: merged.verdict,
      passed: merged.verdict === 'pass',
      ...(merged.unavailable ? { unavailable: true } : {}),
      policy,
      failures: merged.failures,
      notes: merged.notes,
      passedRules: merged.passedRules,
      checkers: checkerResults.map((r) => ({
        checker: r.checker,
        verdict: r.verdict,
        ...(r.error ? { error: r.error } : {}),
        ...(r.note ? { note: r.note } : {}),
        ...(r.model ? { model: r.model } : {}),
        ...(r.providerId ? { providerId: r.providerId } : {}),
        ...(r.routing ? { routing: r.routing } : {}),
      })),
      cost: checkerResults.reduce((s, r) => s + (r.cost || 0), 0),
      tokens: checkerResults.reduce((s, r) => s + (r.tokens || 0), 0),
      inputTokens: checkerResults.reduce((s, r) => s + (r.inputTokens || 0), 0),
      outputTokens: checkerResults.reduce((s, r) => s + (r.outputTokens || 0), 0),
    };
  }

  /**
   * Render a checker panel's failures into a critique message the agent can
   * act on. Used by the autonomous revise loop as synthetic user feedback.
   * The reviser changes only what a failure names: revisions that rewrote
   * the whole answer deleted correct, tool-backed items the checker had
   * merely not seen.
   */
  formatFailuresForRevision(
    failures: VerifyFailure[],
    attempt: number,
    maxAttempts: number,
  ): string {
    const lines = failures.length
      ? failures
          .map(
            (f, i) =>
              `${i + 1}. ${f.claim ? `"${f.claim}": ` : ''}${f.rule}${f.evidence ? ` — evidence: ${f.evidence}` : ''}` +
              (f.checker ? ` (${f.checker})` : ''),
          )
          .join('\n')
      : 'The checker could not confirm the answer is correct, and named nothing wrong with it.';
    return (
      `A checker reviewed your answer and named these problems ` +
      `(revision ${attempt} of ${maxAttempts}):\n\n${lines}\n\n` +
      `Fix each problem above and produce a corrected final answer. ` +
      `Change only what a problem above names. Keep every other fact, item, number and date that your tool results support exactly as it is: ` +
      `do not drop or change an item the checker did not name. ` +
      `If your tool results show that a named problem is not a problem, keep the claim and say which tool result supports it.`
    );
  }

  /**
   * Run a single refute-only checker. Returns a structured verdict; never
   * throws — an LLM error or unparseable reply becomes verdict 'error' so the
   * policy layer decides whether that blocks.
   */
  private async runChecker(
    checker: CheckerConfig,
    index: number,
    targetText: string,
    spec: string,
    organizationId: string,
    userId: string | ExecutionPrincipal | undefined,
    signal?: AbortSignal,
    evidence = '',
    extra: { rules?: string; now?: Date } = {},
  ): Promise<CheckerResult> {
    const name = checker?.name || `checker_${index + 1}`;
    if (!checker?.providerId && !checker?.routing) {
      return {
        checker: name,
        verdict: 'error',
        failures: [],
        passedRules: [],
        error: 'the checker has no model set',
      };
    }

    const rules = extra.rules ?? '';
    const now = extra.now ?? new Date();
    // The window the request names, as dates: checkers estimated day
    // counts ("34 days ago ... within 30 days") and failed correct answers.
    const dates = windowNote([requestOf(evidence), spec, rules], now);
    const maxTokens = checker.maxTokens && checker.maxTokens > 0 ? checker.maxTokens : CHECKER_MAX_TOKENS;
    const systemPrompt = evidence ? evidencePrompt(rules, checker.instructions) : specPrompt(rules, checker.instructions);

    const userPrompt =
      (rules ? `AGENT INSTRUCTIONS (the standard to judge by):\n${rules}\n\n` : '') +
      `SPEC (rules to enforce):\n${spec || '(no explicit spec — judge for correctness, completeness, and internal consistency)'}\n\n` +
      (dates ? `DATES:\n${dates}\n\n` : '') +
      (evidence ? `EVIDENCE (ground truth for this run):\n${evidence}\n\n` : '') +
      `OUTPUT (to check):\n${targetText}`;

    try {
      const request = {
        messages: [
          { role: 'system' as any, content: systemPrompt },
          { role: 'user' as any, content: userPrompt },
        ],
        // A routed checker lets the catalog pick its model per call.
        model: checker.routing ? undefined : checker.model,
        ...(checker.routing ? { routing: checker.routing } : {}),
        temperature: checker.temperature ?? 0,
        // Never the provider's default: Anthropic's is 1,024 tokens, and a
        // verdict listing a dozen items was cut off mid-JSON, read as no
        // verdict, and the answer was sent back for paid revisions.
        maxTokens,
        signal,
      };
      // The verdict in its schema where the provider takes one
      // (structured-output.ts). A model that refuses the schema is asked
      // again without it; the prompt says the same format. Without the
      // date a checker took its training cutoff for today and failed real
      // papers dated last week as "from the future".
      let response: ChatResponse;
      try {
        response = await this.llmProvidersService.chat(checker.providerId ?? null, { ...request, responseFormat: VERDICT_FORMAT, currentTime: true }, organizationId, userId);
      } catch (err) {
        if (signal?.aborted || !refusedFormat(err)) throw err;
        response = await this.llmProvidersService.chat(checker.providerId ?? null, { ...request, currentTime: true }, organizationId, userId);
      }

      const raw = response?.message?.content || '';
      const parsed = this.parseCheckerJson(raw);
      const cost = response?.cost || 0;
      const tokens = response?.usage?.totalTokens || 0;
      // What the checker read (the evidence is most of it) and wrote: the run view shows both on the verify step.
      const usage = { inputTokens: response?.usage?.inputTokens || 0, outputTokens: response?.usage?.outputTokens || 0 };
      // Which model gave this verdict: what the provider said it ran, the
      // router's pick for a routed checker, else the checker's own model.
      // A check is a step like any other, and says who answered it.
      const answeredModel = response?.model || response?.routing?.vendorModelId || checker.model;
      const answeredProvider = response?.routing?.providerId ?? checker.providerId;
      const answered = {
        ...(answeredModel ? { model: answeredModel } : {}),
        ...(answeredProvider ? { providerId: answeredProvider } : {}),
        ...(response?.routing ? { routing: response.routing } : {}),
      };

      if (!parsed) {
        // Said on the step, in words a person can act on: the run view
        // shows it next to the check that could not give a verdict.
        const cutOff = isCutOff(response?.message?.finishReason);
        return {
          checker: name,
          verdict: 'error',
          failures: [],
          passedRules: [],
          error:
            (cutOff
              ? `the checker's reply was cut off at its output limit (${maxTokens} tokens) before it gave a verdict`
              : raw.trim()
                ? `the checker's reply could not be read as a verdict`
                : 'the checker gave an empty reply') + (raw.trim() ? `: "${oneLine(raw, 200)}"` : ''),
          cost,
          tokens,
          ...usage,
          ...answered,
        };
      }

      const read = this.readFailures(parsed, name, evidence, now, targetText);
      // With evidence the verdict is the verified findings alone: a fail
      // that names none the code could verify is a pass with checker notes.
      // Without evidence a 'fail' that names no failure still blocks:
      // synthesize one so the failure list is never silently empty on a
      // fail. A fail whose every listed item turned out not to be a failure
      // is a pass: nothing was refuted.
      const failures = read.failures;
      let verdict: 'pass' | 'fail' = failures.length ? 'fail' : evidence ? 'pass' : parsed.verdict === 'pass' ? 'pass' : 'fail';
      if (verdict === 'fail' && failures.length === 0) {
        if (read.listed > 0) {
          verdict = 'pass';
        } else {
          failures.push({
            rule: 'the checker failed the answer without saying why',
            evidence: oneLine(raw, 280),
            checker: name,
          });
        }
      }
      const passedRules = [
        ...(Array.isArray(parsed.passed_rules) ? parsed.passed_rules.map((r: any) => String(r)) : []),
        ...(Array.isArray(parsed.confirmed) ? parsed.confirmed.map((r: any) => String(r)) : []),
      ];
      // A reply read in part was cut off only when the provider says it hit
      // its output limit, or it wrote as many tokens as it was allowed. A
      // reply of 703 tokens under a limit of 8,192 was malformed, not cut
      // off (run 81411770).
      const cutOff = isCutOff(response?.message?.finishReason) || (usage.outputTokens > 0 && usage.outputTokens >= maxTokens);
      const readNotes = [
        ...(parsed.truncated
          ? [
              cutOff
                ? `the checker's reply was cut off at its output limit (${maxTokens} tokens); it was read up to its last complete item`
                : `the checker's reply was not well-formed JSON; it was read up to its last complete item`,
            ]
          : []),
        ...read.discarded.map((d) => `not counted: "${oneLine(d.rule, 120)}" (${d.reason})`),
      ];

      return {
        checker: name,
        verdict,
        failures,
        notes: read.notes,
        passedRules,
        cost,
        tokens,
        ...usage,
        ...(readNotes.length ? { note: readNotes.join('; ') } : {}),
        ...answered,
      };
    } catch (err: any) {
      const detail =
        err?.response?.data?.error?.message || err?.message || 'checker call failed';
      return {
        checker: name,
        verdict: 'error',
        failures: [],
        passedRules: [],
        error: typeof detail === 'string' ? detail : JSON.stringify(detail),
      };
    }
  }

  /**
   * A checker reply as verdict findings and checker notes.
   *
   * With evidence (the final-answer check), an item of "failures" is a
   * verdict finding only when the code verifies it (checker-findings.ts):
   * its claim is in the answer, the tool data it cites is in the tool
   * results and belongs to the claim's item, and the two values differ
   * where the field can be compared. It is then said in the code's words,
   * naming the item and the field. Every other item, and everything in the
   * reply's "notes", is a checker note: shown on the run, never deciding
   * the verdict. An item the checker itself marks as not failed
   * ("status": "pass") is neither.
   *
   * Without evidence (a workflow's verify step, a mid-run review) there is
   * nothing to verify against, and a failure counts as the checker gave it,
   * unless its reason states a false version order or false day arithmetic.
   */
  readFailures(
    parsed: ParsedVerdict,
    checker: string,
    evidence = '',
    now: Date = new Date(),
    answer = '',
  ): { failures: VerifyFailure[]; notes: CheckerNote[]; listed: number; discarded: Array<{ rule: string; reason: string }> } {
    const items = Array.isArray(parsed.failures) ? parsed.failures : [];
    const failures: VerifyFailure[] = [];
    const notes: CheckerNote[] = [];
    const discarded: Array<{ rule: string; reason: string }> = [];
    for (const f of items) {
      const rule = String((f && typeof f === 'object' ? f.rule : f) ?? 'unspecified');
      const evidenceText = String((f && typeof f === 'object' ? f.evidence : '') ?? '');
      const claim = f && typeof f === 'object' && f.claim !== undefined && f.claim !== null ? String(f.claim) : undefined;
      const status = f && typeof f === 'object' && typeof f.status === 'string' ? f.status.trim().toLowerCase() : '';
      if (status ? !FAILED_STATUSES.has(status) : parsed.verdict === 'pass') {
        discarded.push({ rule, reason: 'the checker did not mark it as failed' });
        continue;
      }
      if (evidence) {
        const check = verifyCheckerFinding({ claim, evidence: evidenceText, rule }, answer, evidence, now);
        if (check.verified) {
          const found = check.finding;
          failures.push({
            rule: verifiedRule(found),
            evidence: evidenceText,
            checker,
            ...(claim ? { claim } : {}),
            kind: 'evidence',
            ...(found.item ? { item: found.item } : {}),
            field: found.field,
          });
        } else {
          notes.push({ checker, text: rule, ...(claim ? { claim } : {}), why: check.why });
        }
        continue;
      }
      const wrongOrder = falseVersionOrder(`${rule}\n${evidenceText}`);
      const wrongDays = wrongOrder ? null : falseDateArithmetic(`${rule}\n${evidenceText}`, now);
      if (wrongOrder || wrongDays) {
        discarded.push({ rule, reason: wrongOrder ?? `its day arithmetic is wrong: ${wrongDays}` });
        continue;
      }
      failures.push({ rule, evidence: evidenceText, checker, ...(claim ? { claim } : {}), kind: 'evidence' });
    }
    if (Array.isArray(parsed.notes)) {
      for (const n of parsed.notes) {
        const text = typeof n === 'string' ? n : n && typeof n === 'object' ? String((n as any).note ?? (n as any).text ?? (n as any).rule ?? '') : '';
        if (text.trim()) notes.push({ checker, text: text.trim() });
      }
    }
    return { failures, notes, listed: items.length, discarded };
  }

  /**
   * Tolerant JSON extraction from a checker reply (handles code fences /
   * prose). A reply cut off mid-JSON (the output limit) is read up to its
   * last complete item, and says so (`truncated`).
   */
  parseCheckerJson(raw: string): (ParsedVerdict & { truncated?: boolean }) | null {
    if (!raw) return null;
    const text = stripClosingFence(raw.trim().replace(/^```(?:json)?\s*/i, ''));
    const whole = asVerdict(tryJson(text));
    if (whole) return whole;
    const start = text.indexOf('{');
    if (start === -1) return null;
    const end = text.lastIndexOf('}');
    if (end > start) {
      const inner = asVerdict(tryJson(text.slice(start, end + 1)));
      if (inner) return inner;
    }
    const salvaged = salvageTruncatedJson(text.slice(start));
    return salvaged ? { ...salvaged, truncated: true } : null;
  }

  /**
   * Merge checker verdicts per policy.
   *  - all_pass:        pass only if every checker explicitly passed (fail OR error blocks)
   *  - majority:        pass if decisive passes outnumber decisive fails (errors ignored; tie blocks)
   *  - any_fail_blocks: pass unless a checker explicitly failed (errors do not veto) — default
   * A checker's verdict is already its verdict findings (readFailures):
   * with evidence, a checker fails only on a finding the code verified.
   * The code checks stand as a checker of their own. Checker notes are
   * gathered here and never change the verdict.
   * If no checker returned a usable verdict, the result is 'fail' and
   * `unavailable`: correctness could not be asserted, so the gate must not
   * silently pass, but nothing was found wrong either, and the failure says
   * that in plain words.
   */
  mergeVerdicts(
    results: CheckerResult[],
    policy: VerifyPolicy,
  ): { verdict: 'pass' | 'fail'; failures: VerifyFailure[]; passedRules: string[]; notes: CheckerNote[]; unavailable?: boolean } {
    // The strongest first: what the code found, then what a checker cited
    // from the tool data and the code confirmed. The answer's note leads
    // with the first.
    const failures = strongestFirst(results.flatMap((r) => r.failures));
    const passedRules = Array.from(new Set(results.flatMap((r) => r.passedRules)));
    const notes = results.flatMap((r) => r.notes ?? []);
    const passes = results.filter((r) => r.verdict === 'pass').length;
    const fails = results.filter((r) => r.verdict === 'fail').length;

    if (passes + fails === 0) {
      const why = results
        .map((r) => (r.error ? `${r.checker}: ${r.error}` : ''))
        .filter(Boolean)
        .join('; ');
      return {
        verdict: 'fail',
        unavailable: true,
        failures: failures.length
          ? failures
          : [
              {
                rule: UNAVAILABLE_RULE,
                evidence: why || 'no checker was configured',
                checker: 'verify',
                code: 'verification_unavailable',
              },
            ],
        passedRules,
        notes,
      };
    }

    let verdict: 'pass' | 'fail';
    switch (policy) {
      case 'all_pass':
        verdict = results.every((r) => r.verdict === 'pass') ? 'pass' : 'fail';
        break;
      case 'majority':
        verdict = passes > fails ? 'pass' : 'fail';
        break;
      case 'any_fail_blocks':
      default:
        verdict = fails > 0 ? 'fail' : 'pass';
        break;
    }
    return { verdict, failures, passedRules, notes };
  }
}