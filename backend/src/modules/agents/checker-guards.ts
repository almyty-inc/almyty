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
];
/** A denial just before a confirmation: "is not correctly classified", "does not match the evidence". */
const DENIED_BEFORE = /(?:\bnot|\bnever|n't)\s+(?:\w+\s+)?$/i;
/** A real error named after the last confirmation: "the version is correct but the date is wrong". */
const ERROR_AFTER =
  /\b(?:incorrect(?:ly)?|wrong|contradict\w*|(?:does|do|did)\s+not\s+match|(?:doesn't|don't|didn't)\s+match|not\s+(?:stated|supported|present|shown|found|listed|in\s+the\s+(?:evidence|tool\s+results?|results?))|unsupported|invented|fabricated|mismatch(?:es)?|differs?)\b/i;

/**
 * The words in a failure's own reason or evidence that say the claim is
 * right ("which is correct", "is acceptable", "no failure here", "matches
 * evidence"), or null. A failure that confirms one part and names a real
 * error in another ("the tag is correct but the date is wrong") is kept.
 */
export function confirmsClaim(text: string): string | null {
  if (!text) return null;
  let last: { end: number; words: string } | null = null;
  for (const pattern of CONFIRMS) {
    for (const m of text.matchAll(pattern)) {
      const start = m.index ?? 0;
      if (DENIED_BEFORE.test(text.slice(Math.max(0, start - 20), start))) continue;
      const end = start + m[0].length;
      if (!last || end > last.end) last = { end, words: m[0].trim().replace(/^[,;:(]\s*/, '') };
    }
  }
  if (!last) return null;
  return ERROR_AFTER.test(text.slice(last.end)) ? null : last.words;
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
