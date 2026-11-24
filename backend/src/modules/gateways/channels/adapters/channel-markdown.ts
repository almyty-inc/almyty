/**
 * An agent answers in markdown (`**Conflicts**`, `- 10:00 ...`, `[link](url)`).
 * Slack and email do not read markdown: the brief arrived with its `**` in
 * it. These turn the common parts into what each platform shows: Slack's
 * own mrkdwn, and plain HTML for the HTML part of an email. Anything else
 * stays as written.
 */

/*
 * The part of markdown-it used here, typed by hand: @types/markdown-it
 * resolves to a bare namespace under ts-jest, so the package is required
 * untyped and held to this shape.
 */
interface Token {
  type: string;
  tag: string;
  content: string;
  children: Token[] | null;
  attrGet(name: string): string | null;
  attrSet(name: string, value: string): void;
}
interface Renderer {
  rules: Record<string, (tokens: Token[], idx: number, options: unknown, env: unknown, self: Renderer) => string>;
  renderToken(tokens: Token[], idx: number, options: unknown): string;
}
interface MarkdownIt {
  disable(rule: string): MarkdownIt;
  core: { ruler: { push(name: string, fn: (state: { tokens: Token[] }) => void): void } };
  utils: { escapeHtml(s: string): string };
  renderer: Renderer;
  render(src: string): string;
  parse(src: string, env: object): Token[];
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const MarkdownIt: new (options: Record<string, unknown>) => MarkdownIt = require('markdown-it');

const LINK = /\[([^\]\n]{1,500})\]\((https?:\/\/[^\s)]{1,2000})\)/g;

/**
 * A markdown heading's text ("## Outreach" -> "Outreach"), or null for any
 * other line. Read by hand: the regex for it backtracks on long runs of
 * spaces (regexp/no-super-linear-backtracking).
 */
export function headingText(line: string): string | null {
  let i = 0;
  while (i < 3 && line[i] === ' ') i++;
  let hashes = 0;
  while (line[i + hashes] === '#') hashes++;
  if (hashes < 1 || hashes > 6) return null;
  const rest = line.slice(i + hashes);
  if (!rest || !/^\s/.test(rest)) return null;
  return rest.trim();
}

/** Markdown as Slack mrkdwn: `**b**` -> `*b*`, `# H` -> `*H*`, `[t](u)` -> `<u|t>`, `- x` -> `• x`. */
export function toSlackMrkdwn(text: string): string {
  return String(text ?? '')
    .split('\n')
    .map((line) => {
      const heading = headingText(line);
      let out = heading !== null ? `*${heading.replace(/\*\*/g, '')}*` : line;
      out = out.replace(/^(\s*)[-*]\s+/, '$1• ');
      out = out.replace(/\*\*([^*\n]+)\*\*/g, '*$1*');
      out = out.replace(LINK, (_m, t, u) => `<${u}|${t}>`);
      return out;
    })
    .join('\n');
}

/*
 * Email. The answer is parsed as markdown (GFM tables included) by
 * markdown-it and rendered twice: as HTML for the mail's HTML part and as
 * plain text for its text part.
 *
 * The answer is untrusted. `html: false` escapes any markup in it as text,
 * markdown-it's link check drops `javascript:`, `vbscript:`, `file:` and
 * `data:` links, and images are off (a remote image in a mail is a
 * tracking pixel the agent could be talked into adding).
 *
 * Mail clients drop <style> blocks, so every element carries its style
 * inline. The body sits in a 640px column that shrinks to the screen, and
 * a wide table scrolls inside its own box rather than widening the mail.
 */

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";
const TEXT = '#141E30';
const MUTED = '#5C6980';
const RULE = '#E6EBF2';
const SURFACE = '#F6F9FD';
const LINK_COLOR = '#1469EC';

/** Inline style per opening token. */
const EMAIL_STYLES: Record<string, string> = {
  paragraph_open: 'margin:0 0 12px;',
  bullet_list_open: 'margin:0 0 12px;padding-left:22px;',
  ordered_list_open: 'margin:0 0 12px;padding-left:22px;',
  list_item_open: 'margin:0 0 6px;',
  blockquote_open: `margin:0 0 12px;padding:0 0 0 12px;border-left:3px solid ${RULE};color:${MUTED};`,
  hr: `border:none;border-top:1px solid ${RULE};margin:20px 0;`,
  link_open: `color:${LINK_COLOR};text-decoration:underline;word-break:break-word;`,
  code_inline: `font-family:${MONO};font-size:13px;background:${SURFACE};border:1px solid ${RULE};border-radius:4px;padding:1px 4px;`,
  table_open: `width:100%;border-collapse:collapse;font-size:14px;line-height:1.4;`,
  th_open: `text-align:left;vertical-align:top;padding:8px 10px;border:1px solid ${RULE};background:${SURFACE};font-weight:600;`,
  td_open: `text-align:left;vertical-align:top;padding:8px 10px;border:1px solid ${RULE};`,
};

const HEADING_STYLES: Record<string, string> = {
  h1: 'font-size:22px;line-height:1.3;margin:0 0 14px;',
  h2: 'font-size:18px;line-height:1.35;margin:22px 0 10px;',
  h3: 'font-size:16px;line-height:1.4;margin:18px 0 8px;',
};
const HEADING_DEFAULT = 'font-size:15px;line-height:1.4;margin:16px 0 8px;';

function newParser(): MarkdownIt {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });
  md.disable('image');
  return md;
}

let emailMd: MarkdownIt | null = null;

function styleTokens(tokens: Token[]): void {
  for (const token of tokens) {
    const style =
      token.type === 'heading_open' ? `${HEADING_STYLES[token.tag] ?? HEADING_DEFAULT}color:${TEXT};font-weight:700;` : EMAIL_STYLES[token.type];
    if (style) {
      // A column's alignment comes in as its own style ("text-align:right"); it wins over the default.
      const own = token.attrGet('style');
      token.attrSet('style', own ? `${style}${own}` : style);
    }
    if (token.children) styleTokens(token.children);
  }
}

function emailParser(): MarkdownIt {
  if (emailMd) return emailMd;
  const md = newParser();
  md.core.ruler.push('email_inline_styles', (state) => {
    styleTokens(state.tokens);
  });
  const { escapeHtml: esc } = md.utils;
  const pre = `margin:0 0 12px;padding:10px 12px;background:${SURFACE};border:1px solid ${RULE};border-radius:6px;font-family:${MONO};font-size:13px;line-height:1.45;white-space:pre-wrap;word-break:break-word;overflow-x:auto;`;
  const block = (tokens: Token[], idx: number) => `<pre style="${pre}"><code>${esc(tokens[idx].content)}</code></pre>\n`;
  md.renderer.rules.fence = block;
  md.renderer.rules.code_block = block;
  md.renderer.rules.table_open = (tokens, idx, options, _env, self) =>
    `<div style="width:100%;overflow-x:auto;margin:0 0 14px;">${self.renderToken(tokens, idx, options)}`;
  md.renderer.rules.table_close = (tokens, idx, options, _env, self) => `${self.renderToken(tokens, idx, options)}</div>\n`;
  emailMd = md;
  return md;
}

/** Markdown as the HTML part of an email: escaped, rendered with inline styles, in a column readable on a phone. */
export function markdownToEmailHtml(text: string): string {
  const body = emailParser().render(String(text ?? ''));
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">` +
    `<tr><td align="center" style="padding:16px 12px;">` +
    `<div style="max-width:640px;margin:0 auto;text-align:left;font-family:${FONT};font-size:15px;line-height:1.55;color:${TEXT};word-wrap:break-word;">` +
    body +
    `</div></td></tr></table>`
  );
}

let plainMd: MarkdownIt | null = null;

/** Inline tokens as text: markers out, a link's address after its text, line breaks kept. */
function inlineText(children: Token[] | null): string {
  let out = '';
  const hrefs: { href: string; start: number }[] = [];
  for (const t of children ?? []) {
    switch (t.type) {
      case 'text':
      case 'code_inline':
        out += t.content;
        break;
      case 'softbreak':
      case 'hardbreak':
        out += '\n';
        break;
      case 'link_open':
        hrefs.push({ href: String(t.attrGet('href') ?? ''), start: out.length });
        break;
      case 'link_close': {
        const link = hrefs.pop();
        if (!link) break;
        const label = out.slice(link.start);
        // An address written out bare is its own label: not repeated.
        if (link.href && label !== link.href && link.href !== `mailto:${label}` && link.href !== `http://${label}`) {
          out += ` (${link.href})`;
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/**
 * Markdown as plain text for an email's text part: markers taken out,
 * lists kept as lists, and each table row as one line of its cells.
 */
export function markdownToPlainText(text: string): string {
  if (!plainMd) plainMd = newParser();
  const tokens = plainMd.parse(String(text ?? ''), {});
  const blocks: string[] = [];
  // Open lists, innermost last: the marker of each item and how far it is indented.
  const lists: { ordered: boolean; next: number }[] = [];
  let itemPrefix: string | null = null;
  let quoteDepth = 0;
  let table: string[][] | null = null;
  let row: string[] | null = null;

  const indent = () => '   '.repeat(Math.max(0, lists.length - 1));
  const push = (body: string) => {
    let lines = body.split('\n');
    if (lists.length) {
      const pad = indent();
      const first = itemPrefix ?? '';
      const cont = ' '.repeat(first.length);
      lines = lines.map((l, i) => (i === 0 ? `${pad}${first}${l}` : `${pad}${cont}${l}`));
      itemPrefix = null;
    }
    if (quoteDepth) lines = lines.map((l) => `${'> '.repeat(quoteDepth)}${l}`);
    // Items of one list sit on consecutive lines; anything else is a block of its own.
    blocks.push(lines.join('\n') + (lists.length ? '\n' : '\n\n'));
  };
  const closeList = () => {
    // The end of a list ends its block with a blank line.
    const last = blocks.length - 1;
    if (!lists.length && last >= 0 && !blocks[last].endsWith('\n\n')) blocks[last] += '\n';
  };

  for (const t of tokens) {
    switch (t.type) {
      case 'bullet_list_open':
        lists.push({ ordered: false, next: 0 });
        break;
      case 'ordered_list_open':
        lists.push({ ordered: true, next: Number(t.attrGet('start') ?? 1) });
        break;
      case 'bullet_list_close':
      case 'ordered_list_close':
        lists.pop();
        closeList();
        break;
      case 'list_item_open': {
        const list = lists[lists.length - 1];
        itemPrefix = list?.ordered ? `${list.next++}. ` : '- ';
        break;
      }
      case 'blockquote_open':
        quoteDepth++;
        break;
      case 'blockquote_close':
        quoteDepth--;
        break;
      case 'table_open':
        table = [];
        break;
      case 'tr_open':
        row = [];
        break;
      case 'tr_close':
        if (table && row) table.push(row);
        row = null;
        break;
      case 'table_close': {
        if (table && table.length) {
          const [head, ...rows] = table;
          // The header once, then one line per row; " · " between cells.
          const lines = [head.join(' · '), ...rows.map((r) => `- ${r.join(' · ')}`)];
          push(lines.join('\n'));
        }
        table = null;
        break;
      }
      case 'inline':
        if (row) row.push(inlineText(t.children).replace(/\n/g, ' ').trim());
        else push(inlineText(t.children));
        break;
      case 'fence':
      case 'code_block':
        push(t.content.replace(/\n$/, ''));
        break;
      case 'hr':
        push('---');
        break;
      default:
        break;
    }
  }
  return blocks.join('').replace(/\n{3,}/g, '\n\n').trim();
}