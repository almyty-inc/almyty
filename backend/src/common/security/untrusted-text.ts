/**
 * Escaping for text that comes from an imported API schema (operation
 * names and summaries, descriptions, parameter names, enum values and
 * defaults, server URLs) on its way into a generated artefact: a bash or
 * Node CLI wrapper, a TypeScript SDK, or a SKILL.md that `@almyty/skills
 * install` writes into a coding agent's skills directory.
 *
 * Every one of those strings is attacker-controlled: whoever gets an org
 * to import their OpenAPI/GraphQL/SOAP document chooses them. So each
 * target gets its own escaper, applied where the string is placed, and no
 * renderer interpolates schema text raw:
 *
 *   - bash: `bashSingleQuote` (nothing is special inside '...'),
 *     `bashComment` (one line, so a newline can't start a command).
 *   - JS/TS: `jsStringLiteral` (JSON.stringify), `jsComment` / `jsDocText`
 *     (one line, comment terminator defused), `jsIdentifier`,
 *     `tsPropertyKey`.
 *   - Markdown: `markdownInline` / `markdownCodeSpan` for one-line fields,
 *     `markdownQuotedData` for free text (a blockquote, every line
 *     escaped, so it can't open a heading, a code fence, HTML, a link or
 *     image, or a front-matter break), `markdownFence` for code blocks
 *     (fence longer than any backtick run inside), `yamlScalar` for
 *     front matter.
 */

/** C0/C1 controls except TAB and LF; DEL. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
/** Zero-width and bidi-override characters (Trojan Source style hiding). */
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
/** Every line terminator a shell, JS parser or markdown renderer honours. */
const LINE_BREAKS = /\r\n|[\r\n\u000B\u000C\u0085\u2028\u2029]/g;

/** Default cap for one-line fields (names, summaries, parameter text). */
export const MAX_INLINE_TEXT = 300;
/** Default cap for free-text blocks (tool descriptions). */
export const MAX_BLOCK_TEXT = 4000;

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, Math.max(0, maxLength - 3)).trimEnd() + '...';
}

/**
 * Normalise a schema-derived value to plain text: coerce to string, unify
 * line breaks to `\n`, drop control and invisible characters, cap length.
 * Newlines are kept; use `singleLine` where the target is one line.
 */
export function sanitizeSchemaText(value: unknown, maxLength = MAX_BLOCK_TEXT): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : String(value);
  return truncate(
    text.replace(LINE_BREAKS, '\n').replace(CONTROL_CHARS, '').replace(INVISIBLE_CHARS, ''),
    maxLength,
  );
}

/** Sanitise and collapse all whitespace (including newlines) to single spaces. */
export function singleLine(value: unknown, maxLength = MAX_INLINE_TEXT): string {
  return truncate(
    sanitizeSchemaText(value, Number.MAX_SAFE_INTEGER).replace(/\s+/g, ' ').trim(),
    maxLength,
  );
}

// ---------------------------------------------------------------- bash

/** Quote a value as one bash word. Nothing is special inside single quotes. */
export function bashSingleQuote(value: unknown): string {
  const text = sanitizeSchemaText(value, Number.MAX_SAFE_INTEGER);
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** Leave simple words bare, single-quote anything else. */
export function bashWord(value: unknown): string {
  const text = sanitizeSchemaText(value, Number.MAX_SAFE_INTEGER);
  return /^[A-Za-z0-9_.,:\/=@%+-]+$/.test(text) ? text : bashSingleQuote(text);
}

/** A `# ...` comment line that can't spill onto a second, executable line. */
export function bashComment(value: unknown, maxLength = MAX_INLINE_TEXT): string {
  return `# ${singleLine(value, maxLength)}`;
}

// ---------------------------------------------------------------- JS / TS

/** A JS/TS string literal. JSON string syntax is a subset of JS's. */
export function jsStringLiteral(value: unknown, maxLength = Number.MAX_SAFE_INTEGER): string {
  return JSON.stringify(sanitizeSchemaText(value, maxLength))
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** A `// ...` line comment. */
export function jsComment(value: unknown, maxLength = MAX_INLINE_TEXT): string {
  return `// ${singleLine(value, maxLength)}`;
}

/** Text safe inside a JSDoc block: one line, no comment terminator. */
export function jsDocText(value: unknown, maxLength = MAX_INLINE_TEXT): string {
  return singleLine(value, maxLength).replace(/\*\//g, '*\\/');
}

const RESERVED_WORDS = new Set(
  (
    'break case catch class const continue debugger default delete do else enum export extends ' +
    'false finally for function if import in instanceof new null return super switch this throw ' +
    'true try typeof var void while with yield let static implements interface package private ' +
    'protected public await arguments eval undefined NaN Infinity any boolean number string symbol ' +
    'never unknown object type declare namespace module'
  ).split(' '),
);

/** Coerce to a valid, non-reserved JS identifier. */
export function jsIdentifier(value: unknown, fallback = 'unnamed'): string {
  let id = singleLine(value, 128).replace(/[^A-Za-z0-9_$]/g, '');
  if (!id) id = fallback;
  if (/^[0-9]/.test(id)) id = `_${id}`;
  if (RESERVED_WORDS.has(id)) id = `${id}_`;
  return id;
}

/** An object/interface property key: bare when it is an identifier, quoted otherwise. */
export function tsPropertyKey(value: unknown): string {
  const text = sanitizeSchemaText(value, 256);
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text) ? text : jsStringLiteral(text);
}

// ---------------------------------------------------------------- CLI flags

/** A `--flag` name: lowercase kebab over `[a-z0-9_-]`, or '' when nothing survives. */
export function cliFlagName(value: unknown): string {
  return singleLine(value, 128)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------- markdown / yaml

function escapeMarkdownLine(line: string): string {
  return line
    .replace(/[\\`*_\[\]()!|~{}]/g, (c) => `\\${c}`)
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/^(\s*)([#+=-])/, '$1\\$2')
    .replace(/^(\s*\d+)([.)])/, '$1\\$2');
}

/**
 * One line of markdown with every inline construct disarmed: no code
 * spans, emphasis, links or images (an image URL is the classic way to
 * exfiltrate context from an agent that renders markdown), raw HTML or
 * comments, table pipes.
 */
export function markdownInline(value: unknown, maxLength = MAX_INLINE_TEXT): string {
  return escapeMarkdownLine(singleLine(value, maxLength));
}

/** Text for inside a single-backtick code span. */
export function markdownCodeSpan(value: unknown, maxLength = 128): string {
  return '`' + singleLine(value, maxLength).replace(/`/g, "'") + '`';
}

/**
 * Free text from the schema, delimited as quoted data: a blockquote whose
 * every line is escaped. It renders as a quote and can't open a heading,
 * a code fence, an HTML block, a link or a front-matter break.
 */
export function markdownQuotedData(value: unknown, maxLength = MAX_BLOCK_TEXT): string {
  const text = sanitizeSchemaText(value, maxLength).trim();
  if (!text) return '';
  return text
    .split('\n')
    .map((line) => {
      const escaped = escapeMarkdownLine(line.replace(/\t/g, '  ').trimEnd());
      return escaped ? `> ${escaped}` : '>';
    })
    .join('\n');
}

/**
 * A fenced code block whose fence is longer than any backtick run in the
 * content, so the content can't close it early. The content is sanitised
 * but otherwise verbatim: it is code the reader copies.
 */
export function markdownFence(content: string, lang = ''): string {
  const body = sanitizeSchemaText(content, Number.MAX_SAFE_INTEGER);
  const longestRun = Math.max(0, ...(body.match(/`+/g) || []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}${lang.replace(/[^A-Za-z0-9_+-]/g, '')}\n${body}\n${fence}`;
}

/**
 * A YAML front-matter scalar on one line: plain when unambiguous, else a
 * JSON string (valid YAML double-quoted), so a value can never end the
 * front matter, start a new key, or change type.
 */
export function yamlScalar(value: unknown, maxLength = MAX_INLINE_TEXT): string {
  const text = singleLine(value, maxLength);
  if (
    /^[A-Za-z0-9][A-Za-z0-9 _.,()\/+-]*$/.test(text) &&
    !/^(true|false|yes|no|on|off|null)$/i.test(text)
  ) {
    return text;
  }
  return JSON.stringify(text);
}

/** A GraphQL Name (`[_A-Za-z][_0-9A-Za-z]*`). */
export function graphqlName(value: unknown, fallback = 'op'): string {
  let name = singleLine(value, 128).replace(/[^_A-Za-z0-9]/g, '_');
  if (!name) name = fallback;
  if (/^[0-9]/.test(name)) name = `_${name}`;
  return name;
}

/** A GraphQL type reference such as `[String!]!`; anything else becomes `String`. */
export function graphqlTypeRef(value: unknown): string {
  const text = singleLine(value, 128).replace(/ /g, '');
  return /^[\[\]!_A-Za-z0-9]+$/.test(text) ? text : 'String';
}
