/**
 * An agent answers in markdown (`**Conflicts**`, `- 10:00 ...`, `[link](url)`).
 * Slack and email do not read markdown: the brief arrived with its `**` in
 * it. These turn the common parts into what each platform shows: Slack's
 * own mrkdwn, and plain HTML for the HTML part of an email. Anything else
 * stays as written.
 */

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

/** Markdown as plain text for an email's text part: markers taken out. */
export function markdownToPlainText(text: string): string {
  return String(text ?? '')
    .split('\n')
    .map((line) => (headingText(line) ?? line).replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(LINK, '$1 ($2)'))
    .join('\n');
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Markdown as the HTML part of an email: escaped first, then bold, headings, links and list bullets; line breaks kept. */
export function markdownToEmailHtml(text: string): string {
  const lines = String(text ?? '').split(/\r?\n/).map((raw) => {
    const heading = headingText(raw);
    let line = escapeHtml(heading ?? raw);
    line = line.replace(/^(\s*)[-*]\s+/, '$1&bull; ');
    line = line.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    line = line.replace(/\[([^\]\n]{1,500})\]\((https?:\/\/[^\s)]{1,2000})\)/g, (_m, t, u) => `<a href="${u}">${t}</a>`);
    return heading !== null ? `<strong>${line}</strong>` : line;
  });
  return `<div style="white-space:pre-wrap">${lines.join('<br>')}</div>`;
}
