/**
 * Whether a checker's finding is one the platform can verify.
 *
 * A checker finding decides the verdict only when it cites tool data and
 * the code confirms it: the claim it quotes is in the answer, the evidence
 * it quotes is in the tool results, that evidence belongs to the item the
 * claim is about, and where the field is one that can be compared (a
 * date, version, DOI, id, title, name or label) the two values really
 * differ. Anything else the checker says is a checker note: shown on the
 * run, never deciding the verdict. In six rounds of real runs the
 * checker's rule and selection judgements were unreliable, and filtering
 * them by their wording (relevance, quoted rules, "qualifies it") kept
 * failing on the next phrasing; this asks for proof instead.
 */

import { falseVersionOrder } from './version-order';
import { falseDateArithmetic } from './date-arithmetic';
import { doiKey, itemsOfEntry, parseAnswer, plain, toolItems, type ToolItem } from './answer-checks';

export interface CheckerFindingInput {
  claim?: string;
  evidence?: string;
  rule?: string;
}

export interface VerifiedFinding {
  /** The item the finding is about, as a person knows it. */
  item?: string;
  /** The field that differs ("publication date", "DOI", "version"). */
  field: string;
  /** The value the answer gives, and the one the tool results give. */
  answerValue: string;
  toolValue: string;
}

/** Verified, with what differs; or not, with why (said on the checker note). */
export interface FindingCheck {
  verified: boolean;
  finding?: VerifiedFinding;
  why?: string;
}

/** Text compared loosely: lower case, typographic quotes and dashes plain, markdown marks dropped, one space. */
function loose(text: string): string {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Text compared as JSON data: also without quotes and escapes, and without the space a writer puts after ":" or ",". */
function looseData(text: string): string {
  // loose() leaves single spaces only, so one space either side is all there is to drop.
  return loose(text)
    .replace(/\\[nrt]/g, ' ')
    .replace(/["\\]/g, '')
    .replace(/ +/g, ' ')
    .replace(/ ([:,{}[\]])/g, '$1')
    .replace(/([:,{}[\]]) /g, '$1')
    .trim();
}

/** Whether `quote` is copied from `text`: each piece between "..." must be in it. */
function quotedIn(quote: string, text: string, norm: (s: string) => string): boolean {
  const haystack = norm(text);
  const pieces = quote
    .split(/\.{3}|…/)
    .map((p) => norm(p))
    .filter((p) => p.length > 0);
  if (!pieces.length) return false;
  return pieces.every((p) => p.length >= 3 && haystack.includes(p));
}

/** The tool results of an evidence text: what follows the request at its head. */
function toolPart(evidence: string): string {
  if (!evidence.startsWith('REQUEST:\n')) return evidence;
  const end = evidence.indexOf('\n\n');
  return end === -1 ? '' : evidence.slice(end + 2);
}

type Values = { doi: string[]; date: string[]; version: string[]; id: string[] };

/** The values in a text that can be compared: DOIs, dates, versions, ids. A range (^1.2.3) is not a version. */
function valuesOf(text: string): Values {
  const doi = Array.from(text.matchAll(/\b10\.\d{4,9}\/[^\s"'<>|,;)\]`*]+/g), (m) => doiKey(m[0]));
  const rest = text.replace(/\b10\.\d{4,9}\/[^\s"'<>|,;)\]`*]+/g, ' ').replace(/https?:\/\/\S+/g, ' ');
  const date = Array.from(rest.matchAll(/\b(\d{4}-\d{2}-\d{2})/g), (m) => m[1]);
  const noDates = rest.replace(/\b\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+Z?)?/g, ' ');
  const version = Array.from(noDates.matchAll(/(?<![\w.^~<>=])v?(\d{1,6}\.\d{1,6}\.\d{1,6})(?!\w|\.\d)/gi), (m) => m[1].toLowerCase());
  const id = [
    ...Array.from(rest.matchAll(/\bW\d{6,12}\b/g), (m) => m[0].toLowerCase()),
    ...Array.from(rest.matchAll(/#(\d{1,9})\b/g), (m) => `#${m[1]}`),
    ...Array.from(rest.matchAll(/"?number"?\s*:\s*(\d{1,9})\b/g), (m) => `#${m[1]}`),
  ];
  return { doi, date, version, id };
}

/** Which kind of date a label names: published, updated, created; null when it says none. */
function dateKind(label: string): string | null {
  const l = plain(label);
  if (/\bupdat|\bmodif/.test(l)) return 'updated';
  if (/\bcreat|\bopened/.test(l)) return 'created';
  if (/\bpubli|\brelease|\bissued/.test(l)) return 'published';
  return null;
}

/** The label before the first date in a text ("Published at", "publication_date"). */
function labelBeforeDate(text: string): string {
  const m = /\d{4}-\d{2}-\d{2}/.exec(text);
  return m ? text.slice(Math.max(0, m.index - 40), m.index) : '';
}

/** Fields named in an evidence snippet whose values are text: a title, a name, a label. */
const TEXT_FIELD = /"?(title|display_name|name|label|venue)"?\s*:\s*"([^"]{2,300})"/gi;

type TextField = 'title' | 'author' | 'venue' | 'label';

/** The words in a claim that say it gives that field. */
const TEXT_CUE: Record<TextField, RegExp> = {
  title: /\btitle\b/i,
  author: /\bauthors?\b/i,
  venue: /\b(?:venue|journal|source|published in)\b/i,
  label: /\blabels?\b/i,
};

/**
 * Which field of the item a text value is, read from where the item holds
 * it: under `authorships`/`author` an author, under `source`/`venue` a
 * venue, under `labels` a label, `title` the title. Null when the item
 * does not hold the value under that key, or the place says none of these.
 */
function textFieldOf(item: Record<string, unknown>, key: string, value: string): TextField | null {
  const paths: string[][] = [];
  const walk = (v: unknown, path: string[], depth: number) => {
    if (depth > 8 || v === null || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === key && x === value) paths.push([...path, k]);
      else walk(x, [...path, k], depth + 1);
    }
  };
  walk(item, [], 0);
  for (const path of paths) {
    const words = path.join('.').toLowerCase();
    if (/author/.test(words)) return 'author';
    if (/source|venue|journal/.test(words)) return 'venue';
    if (/label/.test(words)) return 'label';
    if (path[path.length - 1] === 'title') return 'title';
  }
  return null;
}

/** What a claim gives after its label: "First Author: Ali Asgari" gives "Ali Asgari"; a claim with no label, all of it. Read without a regex. */
function valueAfterLabel(claim: string): string {
  const colon = claim.indexOf(':');
  let value = claim;
  if (colon !== -1) {
    let label = claim.slice(0, colon).trim();
    while (label && ' -*+.)0123456789'.includes(label[0])) label = label.slice(1);
    while (label.endsWith('*')) label = label.slice(0, -1);
    if (/^[A-Za-z][A-Za-z ]{0,30}$/.test(label.trim())) value = claim.slice(colon + 1);
  }
  return value.replace(/[*_`"“”]/g, '').trim() || claim.trim();
}

function fieldWords(type: keyof Values, snippet: string): string {
  if (type === 'doi') return 'DOI';
  if (type === 'version') return 'version';
  if (type === 'id') return 'id';
  const key = /"?([a-z_]{0,40}(?:date|_at|At))"?[ \t]{0,3}:/.exec(snippet)?.[1];
  return key ? key.replace(/_/g, ' ').replace(/([a-z])At$/, '$1 at') : 'date';
}

/** The items of the tool results whose data holds the snippet. */
function itemsHolding(snippet: string, items: ToolItem[]): ToolItem[] {
  const s = looseData(snippet);
  return items.filter((it) => looseData(JSON.stringify(it.value)).includes(s));
}

/**
 * Whether a checker finding is verified, and if so which field of which
 * item differs and how. `answer` is the text checked; `evidence` what the
 * checker was given (runEvidence); `now` the day for date arithmetic.
 */
export function verifyCheckerFinding(f: CheckerFindingInput, answer: string, evidence: string, now: Date = new Date()): FindingCheck {
  const claim = String(f.claim ?? '').trim();
  const snippet = String(f.evidence ?? '').trim();
  const rule = String(f.rule ?? '');
  if (!claim) return { verified: false, why: 'it quotes no claim from the answer' };
  if (!snippet) return { verified: false, why: 'it cites no tool data' };
  if (!quotedIn(claim, answer, loose)) return { verified: false, why: 'the claim it quotes is not in the answer' };
  const tools = toolPart(evidence ?? '');
  if (!tools.trim() || !quotedIn(snippet, tools, looseData)) return { verified: false, why: 'the evidence it quotes is not in the tool results' };
  const wrongOrder = falseVersionOrder(`${rule}\n${snippet}`);
  if (wrongOrder) return { verified: false, why: wrongOrder };
  const wrongDays = falseDateArithmetic(rule, now);
  if (wrongDays) return { verified: false, why: `its day arithmetic is wrong: ${wrongDays}` };

  // The snippet must be data of the item the claim is about.
  const index = toolItems(evidence);
  let item: ToolItem | undefined;
  if (index.items.length) {
    const holding = itemsHolding(snippet.split(/\.{3}|…/)[0], index.items);
    if (!holding.length) return { verified: false, why: 'the evidence it quotes is not data of an item the tool returned' };
    const parsed = parseAnswer(answer);
    const claimLoose = loose(claim.split(/\.{3}|…/)[0]);
    const entries = parsed.entries.filter((e) => loose(e.text).includes(claimLoose));
    const about = new Set(entries.flatMap((e) => itemsOfEntry(e, index).items));
    item = holding.find((it) => about.has(it));
    if (!item && entries.length) return { verified: false, why: 'the evidence it quotes is about another item than the claim' };
    if (!item) item = holding.length === 1 ? holding[0] : undefined;
    if (!item) return { verified: false, why: 'it does not say which item the claim is about' };
  }

  const fromClaim = valuesOf(claim);
  const fromTool = valuesOf(snippet);
  // "DOI: none" against a DOI the tool results give (run c62aa29a).
  if (fromTool.doi.length && !fromClaim.doi.length && /\bdoi\b[\s*:=-]*(?:none|null|n\/?a|unknown|not available)\b/i.test(claim)) {
    return { verified: true, finding: { item: item?.label, field: 'DOI', answerValue: 'none', toolValue: fromTool.doi[0] } };
  }
  for (const type of ['doi', 'version', 'id', 'date'] as const) {
    const told = fromTool[type];
    const said = fromClaim[type];
    if (!told.length || !said.length) continue;
    if (told.some((v) => said.includes(v))) continue;
    if (type === 'date') {
      const toolKind = dateKind(labelBeforeDate(snippet));
      const claimKind = dateKind(labelBeforeDate(claim));
      if (toolKind && claimKind && toolKind !== claimKind) continue;
    }
    return { verified: true, finding: { item: item?.label, field: fieldWords(type, snippet), answerValue: said[0], toolValue: told[0] } };
  }
  for (const m of snippet.matchAll(TEXT_FIELD)) {
    const value = m[2];
    // Which field of the item the value is, by where the item holds it.
    const field = item ? textFieldOf(item.value, m[1], value) : m[1].toLowerCase() === 'title' ? 'title' : null;
    if (!field || !TEXT_CUE[field].test(claim)) continue;
    const said = valueAfterLabel(claim);
    const a = plain(said).replace(/ /g, '');
    const b = plain(value).replace(/ /g, '');
    if (b.length < 2 || a.includes(b) || (a.length >= 2 && b.includes(a))) continue;
    return { verified: true, finding: { item: item?.label, field, answerValue: said, toolValue: value } };
  }
  return { verified: false, why: 'the value it quotes from the tool results does not differ from the answer' };
}

/** A verified finding, in plain words that name the item and the field. */
export function verifiedRule(found: VerifiedFinding): string {
  const value = found.answerValue.length > 80 ? `${found.answerValue.slice(0, 79)}…` : found.answerValue;
  const lead = found.item ? `${found.item}: ` : '';
  return `${lead}the answer gives ${found.field} ${value}, but the tool results say ${found.toolValue}`;
}