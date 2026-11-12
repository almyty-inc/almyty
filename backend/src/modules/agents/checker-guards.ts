/**
 * Deterministic checks on a checker's failures, before any of them counts.
 *
 * Checkers listed confirmations as failures ("DOI is null in evidence and
 * output correctly states none; no failure here"), and one such item was
 * enough to fail a correct answer and stamp it with that reason (run
 * 9fc02bae). Checkers also called real items "invented" or "not found"
 * when the item's DOI, number or title was right there in the evidence
 * (runs 0db5d8dd, 31423ff5). Neither is a refutation. Nothing here knows
 * any API: it reads the failure's own words and looks identifiers up in
 * the evidence text the checker was given.
 */

const CONFIRMS: RegExp[] = [
  /\bno (?:failure|issue|problem|error|violation|discrepancy|discrepancies)s?\b/gi,
  /\bnot an? (?:failure|violation|problem|issue|error)\b/gi,
  /\b(?:is|are|was|were|seems|appears|looks) (?:correct|accurate|acceptable|fine|valid|right)\b/gi,
  /\bcorrectly\b/gi,
  /\bmatch(?:es|ed)? (?:the )?(?:evidence|tool|npm|returned|result|search)/gi,
  /\b(?:this|the) claim (?:is a )?pass(?:es)?\b/gi,
  /(?:^|[,;:(] ?)correct[.)]?$/gim,
  // "All packages from package.json are in the table", "all 8 packages are
  // present in the table" (run 6933d7e2): the answer has every item, which
  // is what a claim of completeness says. Only where the answer is named:
  // "all releases are listed in the tool results" says nothing about the answer.
  /\ball\b(?:[^;:\n.]|\.(?=\S)){0,60}?\b(?:are|were)\s+(?:all\s+)?(?:(?:present|included|listed|shown|covered)\s+)?in\s+the\s+(?:table|output|answer|list|report|summary)\b/gi,
];
/**
 * "The 'bug' label is present, which qualifies it as a high-priority
 * issue per the instructions" (run dda8789a): the item meets the rule the
 * failure names. Read as a confirmation only where the failure is about an
 * item the answer lists; where it says the item was wrongly left out
 * ("should be included; exclusion is incorrect ... qualifies it for
 * inclusion", run 9b63b1d0), qualifying is the failure's own reason.
 */
const QUALIFIES = /\bqualif(?:ies|y|ied) (?:it|them|this|that|the (?:item|issue|release|package|paper|work))\b/gi;
const LEFT_OUT_WORDS = /\b(?:should (?:also )?(?:be|have been) (?:included|listed|reported|shown)|exclu(?:sion|ded|des|de)|left out|omit(?:s|ted|ting)?|missing)\b/i;
/**
 * "... so this is outdated-minor, but the note incorrectly states ..."
 * (run c04b7a9b): the failure's own reasoning arrives at what the claim
 * says. Read only against the claim: the word after "so this is" must be
 * in it.
 */
const SO_THIS_IS = /\bso (?:this|it|that) (?:is|was|counts as|remains) (?:an? |the )?([a-z0-9][\w./-]{2,40})/gi;
const NOT_A_VERDICT = /^(?:wrong|incorrect|invalid|inaccurate|unsupported|not|false|missing|failure|failed|violation|mistake|error|outside|older|newer|before|after)$/i;
/** A denial just before a confirmation: "is not correctly classified", "does not match the evidence". */
const DENIED_BEFORE = /(?:\bnot|\bnever|n't)\s+(?:\w+\s+)?$/i;
/** A real error named after the last confirmation: "the version is correct but the date is wrong". */
const ERROR_AFTER =
  /\b(?:incorrect(?:ly)?|wrong|contradict\w*|(?:does|do|did)\s+not\s+match|(?:doesn't|don't|didn't)\s+match|not\s+(?:stated|supported|present|shown|found|listed|in\s+the\s+(?:evidence|tool\s+results?|results?))|unsupported|invented|fabricated|mismatch(?:es)?|differs?|except|other\s+than|apart\s+from|missing|omit(?:s|ted)?|left\s+out)\b/i;
/**
 * A complaint about wording, not a fact: "the note incorrectly states 'from
 * 2.29 to 2.31' when it should clarify the minor version jump". Taken out
 * of the text after a confirmation before looking for a real error in it.
 * "but the date is wrong" is not wording and stays.
 */
const WORDING_ONLY =
  /\b(?:incorrectly|wrongly)\s+(?:states?|says?|describes?|words?|phrases?)\b(?:[^.;\n]|\.(?=\d))*?\b(?:when|where|as|while|since)\s+it\s+should\s+(?:clarify|explain|elaborate|mention|specify|spell\s+out|make\s+clear|be\s+(?:clearer|more\s+(?:precise|specific|explicit)))\b(?:[^.;\n]|\.(?=\d))*/gi;

/**
 * The words in a failure's own reason or evidence that say the claim is
 * right ("which is correct", "is acceptable", "no failure here", "matches
 * evidence", "which qualifies it"), or null. A failure that confirms one
 * part and names a real error in another ("the tag is correct but the date
 * is wrong") is kept. `claim`, when given, lets "so this is <X>" count as
 * a confirmation where X is what the claim says.
 */
export function confirmsClaim(text: string, claim?: string): string | null {
  if (!text) return null;
  let last = null as { end: number; words: string } | null;
  const consider = (start: number, words: string) => {
    if (DENIED_BEFORE.test(text.slice(Math.max(0, start - 20), start))) return;
    const end = start + words.length;
    if (!last || end > last.end) last = { end, words: words.trim().replace(/^[,;:(]\s*/, '') };
  };
  for (const pattern of CONFIRMS) {
    for (const m of text.matchAll(pattern)) consider(m.index ?? 0, m[0]);
  }
  if (!LEFT_OUT_WORDS.test(text)) {
    for (const m of text.matchAll(QUALIFIES)) consider(m.index ?? 0, m[0]);
  }
  const said = claim ? normal(claim) : '';
  if (said) {
    for (const m of text.matchAll(SO_THIS_IS)) {
      const what = trimEnd(m[1]);
      if (what.length < 3 || NOT_A_VERDICT.test(what) || !said.includes(normal(what))) continue;
      consider(m.index ?? 0, m[0]);
    }
  }
  if (!last) return null;
  const after = text.slice(last.end).replace(WORDING_ONLY, ' ');
  return ERROR_AFTER.test(after) ? null : last.words;
}

/** Words that say an item is not in the tool results at all. */
const INVENTED = /\b(?:invented|fabricated|made[- ]up|hallucinated|(?:does|do) not exist|(?:doesn't|don't) exist|non-?existent)\b/i;
const ABSENT =
  /\b(?:not found|not present|not listed|not included|not among|not in|not shown|not returned|absent|no such|(?:does|do|did)\s+not\s+(?:appear|include|contain|show|list)|(?:doesn't|don't|didn't)\s+(?:appear|include|contain|show|list))\b/gi;
const EVIDENCE_WORDS = /\b(?:evidence|tool|results?|search|returned|response|api|openalex|github|npm|registry|items)\b/i;
const OUTPUT_WORDS = /\b(?:output|answer|report|table|summary)\b/i;

/**
 * Whether a failure says an item is absent from the evidence: invented,
 * fabricated, or not found / not present in the tool results. "Not in the
 * OUTPUT" is an omission from the answer, not an absence from the
 * evidence, and is not read as one.
 */
export function saysAbsentFromEvidence(text: string): boolean {
  if (!text) return false;
  if (INVENTED.test(text)) return true;
  for (const m of text.matchAll(ABSENT)) {
    const start = m.index ?? 0;
    const after = text.slice(start + m[0].length, start + m[0].length + 80);
    const outputAt = after.search(OUTPUT_WORDS);
    const evidenceAt = after.search(EVIDENCE_WORDS);
    if (outputAt !== -1 && (evidenceAt === -1 || outputAt < evidenceAt)) continue;
    if (evidenceAt !== -1) return true;
    const before = text.slice(Math.max(0, start - 80), start);
    if (EVIDENCE_WORDS.test(before) && !OUTPUT_WORDS.test(before)) return true;
  }
  return false;
}

function normal(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ');
}

/** Without trailing punctuation that ends the sentence around an identifier. One pass, no regex. */
function trimEnd(s: string): string {
  let end = s.length;
  while (end > 0 && ')].,;:!?\'"'.includes(s[end - 1])) end--;
  return s.slice(0, end);
}

const OPEN_QUOTES = '"“‘\'';
const CLOSE_QUOTES = '"”’\'';

/** The quoted strings in `text`, read in one pass. */
function quoted(text: string): string[] {
  const out: string[] = [];
  let open = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (open === -1) {
      // An apostrophe inside a word ("doesn't") does not open a quote.
      if (OPEN_QUOTES.includes(c) && !(c === "'" && /\w/.test(text[i - 1] ?? ''))) open = i;
    } else if (CLOSE_QUOTES.includes(c) && !(c === "'" && /\w/.test(text[i + 1] ?? ''))) {
      out.push(text.slice(open + 1, i).trim());
      open = -1;
    }
  }
  return out;
}

/**
 * What identifies the item a claim is about: DOIs, OpenAlex ids, issue
 * and pull request numbers, URLs and versions (`strong`), and quoted or
 * leading titles (`titles`).
 */
export function identifiersOf(claim: string): { strong: Array<{ id: string; test: (evidence: string) => boolean }>; titles: string[] } {
  const strong: Array<{ id: string; test: (evidence: string) => boolean }> = [];
  const text = claim ?? '';
  const dois = new Set<string>();
  for (const m of text.matchAll(/\b10\.\d{4,9}\/[^\s"'<>,;]+/g)) dois.add(trimEnd(m[0]));
  for (const doi of dois) strong.push({ id: doi, test: (e) => e.includes(normal(doi)) });
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
    const url = trimEnd(m[0]);
    if (/doi\.org\//i.test(url)) continue;
    strong.push({ id: url, test: (e) => e.includes(normal(url)) });
  }
  for (const m of text.matchAll(/\bW\d{6,12}\b/g)) {
    const id = m[0];
    strong.push({ id, test: (e) => e.includes(id.toLowerCase()) });
  }
  for (const m of text.matchAll(/#(\d{1,9})\b/g)) {
    const n = m[1];
    const re = new RegExp(`"number":\\s*${n}\\b|/(?:issues|pull|pulls)/${n}\\b|#${n}\\b`);
    strong.push({ id: `#${n}`, test: (e) => re.test(e) });
  }
  if (!dois.size) {
    for (const m of text.matchAll(/(?<![\w.^~])v?\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9a-z.]+)?\b/gi)) {
      const v = m[0];
      const re = new RegExp(`(?<![\\w.])${v.replace(/[.]/g, '\\.')}(?![\\w.]*\\d)`, 'i');
      strong.push({ id: v, test: (e) => re.test(e) });
    }
  }
  const titles = quoted(text).filter((q) => q.length >= 12);
  // The claim's leading title: "8. <title> - DOI: ...", "[#1] <title> (...)".
  let lead = text.replace(/\s+/g, ' ').trim();
  const prefix = /^(?:\[[^\]]{0,40}\]|#?\d{1,3}[.)]|[-*]) ?/.exec(lead);
  if (prefix) lead = lead.slice(prefix[0].length);
  const ends = [' - ', ' – ', ' — ', ', DOI', '; DOI', ' DOI:', ' (', 'http']
    .map((marker) => lead.indexOf(marker))
    .filter((at) => at > 0);
  if (ends.length) lead = lead.slice(0, Math.min(...ends));
  lead = lead.trim();
  if (lead.length >= 20) titles.push(lead);
  return { strong, titles };
}

/**
 * For a failure that says its item is absent from the evidence (invented,
 * fabricated, not found), the identifier of that item the evidence does
 * hold, or null. Every strong identifier the claim names (DOI, id,
 * number, URL, version) must be in the evidence; a claim that names none
 * is matched on its title.
 */
export function presentInEvidence(failure: { claim?: string; rule?: string; evidence?: string }, evidence: string): string | null {
  if (!evidence) return null;
  const words = `${failure.rule ?? ''} ${failure.evidence ?? ''}`;
  if (!saysAbsentFromEvidence(words)) return null;
  // The claim names the item. The reason often names other items, present
  // ones, as a contrast ("results show #67391, #67423 ... but not #67389").
  const { strong, titles } = identifiersOf(failure.claim ?? '');
  const haystack = normal(evidence);
  if (strong.length) return strong.every((s) => s.test(haystack)) ? strong.map((s) => s.id).join(', ') : null;
  const title = titles.find((t) => haystack.includes(normal(t)));
  return title ? `"${title.length > 80 ? `${title.slice(0, 79)}…` : title}"` : null;
}

/** Whether a failure's claim is one the checker also listed as confirmed. */
export function listedAsConfirmed(claim: string | undefined, confirmed: string[]): boolean {
  if (!claim || !confirmed.length) return false;
  const c = normal(claim).trim();
  if (c.length < 4) return false;
  return confirmed.some((x) => {
    const k = normal(x).trim();
    return k === c || (k.length >= 15 && c.length >= 15 && (k.includes(c) || c.includes(k)));
  });
}

/** Words that say something is missing: from the evidence, or from the answer. */
const MISSING =
  /\b(?:omit(?:s|ted|ting)?|missing|absent|lacks?|lacking|not (?:provided|given|specified|listed|included|shown|present|available|found|stated|mentioned|named|supported)|(?:does|do|did)(?:n't| not) (?:provide|specify|list|include|show|contain|give|mention|name|have|state|support)|unsupported|cannot be (?:verified|confirmed)|can't be (?:verified|confirmed)|unverifiable)\b/i;

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The names a left-out path goes by in prose: the fields after its list item ("primary_location", "source"). */
function namesOf(path: string): string[] {
  const at = path.lastIndexOf('[].');
  const tail = at === -1 ? path : path.slice(at + 3);
  return tail
    .split('.')
    .map((s) => s.replace(/\[\]$/, ''))
    .filter((s) => s.length >= 3);
}

/**
 * For a failure about a field the evidence left out ("evidence does not
 * provide the first author", "output omits the venue" where the note says
 * `results[].authorships[].author` or `results[].primary_location.source`
 * was left out), the path it is about, or null. The checker never saw
 * that field, so it can neither find it missing nor find it wrong by its
 * absence (runs 5f990f9e, f734e7d6). `leftOut` is what the evidence's
 * shortening notes name (checker-evidence.ts leftOutFieldsOf).
 */
export function aboutLeftOutField(failure: { rule?: string; evidence?: string }, leftOut: string[]): string | null {
  if (!leftOut.length) return null;
  const words = `${failure.rule ?? ''}\n${failure.evidence ?? ''}`;
  if (!MISSING.test(words)) return null;
  for (const path of leftOut) {
    for (const name of namesOf(path)) {
      const variants = new Set([name, name.replace(/_/g, ' ')]);
      for (const v of variants) {
        if (new RegExp(`(?<![\\w])${escapeRe(v)}s?(?![\\w])`, 'i').test(words)) return path;
      }
    }
  }
  return null;
}

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

/** The lengths of the lists of items a result holds, outside any item: `results`, `items`, a top-level array. */
function itemListLengths(v: unknown, inItem: boolean, depth: number, out: Set<number>): void {
  if (depth > 12 || v === null || typeof v !== 'object') return;
  if (Array.isArray(v)) {
    const items = v.length > 0 && v.every((x) => x !== null && typeof x === 'object' && !Array.isArray(x));
    if (!inItem && items) out.add(v.length);
    for (const x of v) itemListLengths(x, inItem || items, depth + 1, out);
    return;
  }
  for (const x of Object.values(v as Record<string, unknown>)) itemListLengths(x, inItem, depth + 1, out);
}

/** Evidence the count of items cannot be read from: a result left out, cut off, or stored only in part. */
const COUNT_UNREADABLE = /\[result left out|the end was cut off|only the start is shown|the stored result was cut|chars stored in part/;

/**
 * "The tool returned 15 works, not 10" (run 7e4e631b): the count of items
 * a failure says the tool returned. Read from its reason first, then its
 * evidence. Null when it states none.
 */
const RETURNED_COUNT =
  /\b(?:tool|tools|search|api|query|call|request|response|openalex|github|npm|registry|it|results?)\b[^.;\n]{0,30}?\b(?:returned|returns|gave|gives|lists|listed|contains|contained|holds|held)\s+(?:only\s+|exactly\s+|just\s+)?(\d{1,6})\s+(?:[a-z-]+\s+){0,2}?(?:works|items|results|papers|articles|issues|pull requests|releases|packages|entries|records|hits|rows|repositories|versions|tags)\b/i;

/**
 * For a failure that states how many items a tool returned, the counts the
 * evidence holds when the stated one is not among them, or null. The
 * counts are the lengths of the lists of items in the tool results, and
 * the totals a shortening note gives ("10 of 25 items shown"); a total
 * match count a result reports about the whole collection
 * (`meta.count`) is not a count of what was returned. Nothing is said when
 * the evidence holds no list, or a result is cut off.
 */
export function wrongReturnedCount(failure: { rule?: string; evidence?: string }, evidence: string): string | null {
  if (!evidence || COUNT_UNREADABLE.test(evidence)) return null;
  const m = RETURNED_COUNT.exec(failure.rule ?? '') ?? RETURNED_COUNT.exec(failure.evidence ?? '');
  if (!m) return null;
  const stated = Number(m[1]);
  const counts = new Set<number>();
  for (const value of evidenceJson(evidence)) itemListLengths(value, false, 0, counts);
  for (const shown of evidence.matchAll(/ of (\d{1,9}) items shown/g)) counts.add(Number(shown[1]));
  if (!counts.size || counts.has(stated)) return null;
  const held = Array.from(counts).sort((a, b) => b - a);
  return `it says the tool returned ${stated}, but the tool results hold ${held.length === 1 ? held[0] : held.join(' or ')}`;
}

/**
 * A failure on the checker's own sense of what belongs: "off-topic", "not
 * relevant", "unrelated to the topic", "should be excluded" (runs
 * bd98321b, 7e4e631b). A checker refutes claims the evidence contradicts
 * and items that break the agent's stated rules; what is on topic is the
 * agent's call unless its instructions make it a rule.
 */
const RELEVANCE =
  /\b(?:off[- ]topic|not\s+(?:relevant|related|pertinent|on[- ]topic)|irrelevant|unrelated|(?:invents?|invented|speculates?|speculating|overstates?|stretches?)\s+(?:on\s+|about\s+)?(?:the\s+|its\s+)?relevance|relevance\s+(?:is\s+)?(?:not\s+supported|unsupported|questionable|tenuous|weak|speculative|doubtful)|(?:no|little|weak|tenuous|questionable)\s+relevance|should\s+(?:be\s+excluded|not\s+be\s+(?:included|listed)|have\s+been\s+excluded|be\s+removed)|inclusion\s+is\s+(?:questionable|not\s+justified)|does\s+not\s+belong)\b/i;
/** Words in a failure that name a fact the evidence contradicts, which no relevance or rule guard drops. */
const EVIDENCE_CONTRADICTION =
  /\b(?:wrong|incorrect(?:ly)?|mismatch(?:es|ed)?|fabricated|invented(?!\s+relevance)|contradict(?:s|ed|ing)?\s+(?:by\s+)?(?:the\s+|what\s+the\s+)?(?:evidence|tool|results?|search|api|response)|(?:does|do|did)(?:\s+not|n't)\s+match\s+(?:the\s+|what\s+the\s+)?(?:evidence|tool|results?|search|api|response)|not\s+(?:in|found\s+in|present\s+in|listed\s+in|shown\s+in)\s+the\s+(?:evidence|tool\s+results?|results|search\s+results|response))\b/i;
/** Instructions that make what is on topic a rule: "only include relevant papers", "skip anything off-topic". */
const RELEVANCE_RULE =
  /\b(?:relevan(?:t|ce)|on[- ]topic|off[- ]topic|unrelated|irrelevant|related\s+to\s+the\s+(?:topic|request|query|subject))\b|\bonly\s+(?:include|list|report|keep|pick)\b[^.\n]{0,60}\b(?:about|on|related|matching)\b/i;

/**
 * For a failure that judges relevance (off-topic, unrelated, should be
 * excluded) where neither the agent's instructions nor the spec make
 * relevance a rule, the words that say so, or null. A failure that also
 * names a contradiction with the evidence ("wrong", "does not match the
 * tool results") is not this.
 */
export function judgesRelevance(failure: { rule?: string; evidence?: string }, standard: string): string | null {
  const words = `${failure.rule ?? ''}\n${failure.evidence ?? ''}`;
  const m = RELEVANCE.exec(words);
  if (!m) return null;
  if (EVIDENCE_CONTRADICTION.test(words.replace(/incorrectly\s+(?:includ|list)\w*/gi, ''))) return null;
  if (RELEVANCE_RULE.test(standard ?? '')) return null;
  return m[0];
}

/** Words that say a failure rests on the agent's instructions, not on the evidence. */
const RULE_WORDS =
  /\b(?:(?:agent(?:'s)?|the|its|stated|your|these)\s+(?:instructions?|rules?)|instructions?\s+(?:say|says|state|states|require|requires|required|told|tell|ask|asks)|(?:the|a|its)\s+requirement\s+(?:to|that|of)|violat(?:es|ed|ion\s+of|ing)\s+(?:the|a|its)\s+(?:rule|requirement|instruction)|required\s+by|criteri(?:a|on)|per\s+the\s+instructions)\b/i;

/** Whether a failure rests on the agent's instructions (a rule), rather than on a contradiction with the evidence. */
export function restsOnRules(failure: { rule?: string; evidence?: string; instruction?: string }): boolean {
  if (typeof failure.instruction === 'string' && failure.instruction.trim()) return true;
  const words = `${failure.rule ?? ''}\n${failure.evidence ?? ''}`;
  return RULE_WORDS.test(words) && !EVIDENCE_CONTRADICTION.test(words);
}

/** Text compared as instructions: lower case, quotes, brackets and punctuation between words dropped, one space. */
function plainWords(text: string): string {
  return normal(text)
    .replace(/[^\p{L}\p{N}\s/'-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The fewest words a quote must have to be a quote of an instruction, not a label or a name ("bug", "security"). */
const MIN_QUOTE_WORDS = 4;

/**
 * For a failure that rests on the agent's instructions, why it does not
 * count, or null when it does. A rule failure must quote the instruction
 * it relies on (its `instruction`, else a quoted passage in its words) of
 * at least four words, found in the AGENT INSTRUCTIONS as written. A
 * checker overrode the rule it named ("the 'security' label alone does not
 * make it a high-priority bug" where the instructions list `security`,
 * run 887a8bfe): paraphrased, a rule can say anything.
 */
export function unquotedRule(failure: { rule?: string; evidence?: string; instruction?: string }, instructions: string): string | null {
  if (!instructions?.trim() || !restsOnRules(failure)) return null;
  const haystack = plainWords(instructions);
  const pieces = (quote: string) =>
    quote
      .split(/\.{3}|…/)
      .map(plainWords)
      .filter((p) => p.split(' ').length >= MIN_QUOTE_WORDS);
  const given = typeof failure.instruction === 'string' ? failure.instruction.trim() : '';
  if (given) {
    const parts = pieces(given);
    if (!parts.length) return `the instruction it quotes ("${given.length > 60 ? `${given.slice(0, 59)}…` : given}") is too short to be a rule`;
    return parts.every((p) => haystack.includes(p)) ? null : 'the instruction it quotes is not in the agent instructions';
  }
  const quotes = quoted(`${failure.rule ?? ''}\n${failure.evidence ?? ''}`).flatMap(pieces);
  if (quotes.some((p) => haystack.includes(p))) return null;
  return 'it names a rule but quotes nothing from the agent instructions';
}

/** What a failure rests on, strongest first: a platform check, the evidence, the agent's rules. */
export type FailureKind = 'deterministic' | 'evidence' | 'rule';

const KIND_RANK: Record<FailureKind, number> = { deterministic: 0, evidence: 1, rule: 2 };

/** What a failure rests on: its `kind` when set, a platform code, else read from its words. */
export function failureKind(f: { kind?: unknown; code?: unknown; rule?: unknown; evidence?: unknown; instruction?: unknown } | null | undefined): FailureKind {
  if (f?.kind === 'deterministic' || f?.kind === 'evidence' || f?.kind === 'rule') return f.kind;
  if (typeof f?.code === 'string' && f.code && f.code !== 'verification_unavailable') return 'deterministic';
  return restsOnRules({
    rule: typeof f?.rule === 'string' ? f.rule : '',
    evidence: typeof f?.evidence === 'string' ? f.evidence : '',
    instruction: typeof f?.instruction === 'string' ? f.instruction : undefined,
  })
    ? 'rule'
    : 'evidence';
}

/** Failures with the strongest first: platform findings, then contradictions with the evidence, then rule failures. Stable. */
export function strongestFirst<T>(failures: T[]): T[] {
  return failures
    .map((f, i) => ({ f, i, rank: KIND_RANK[failureKind(f as any)] }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.f);
}