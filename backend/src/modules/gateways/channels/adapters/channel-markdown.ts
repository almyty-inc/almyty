/**
 * An agent answers in markdown (`**Conflicts**`, `- 10:00 ...`, `[link](url)`).
 * Slack and email do not read markdown: the brief arrived with its `**` in
 * it. These turn the common parts into what each platform shows: Slack's
 * own mrkdwn, and plain HTML for the HTML part of an email. Anything else
 * stays as written.
 */

const LINK = /\[([^\]\n]{1,500})\]\((https?:\/\/[^\s)]{1,2000})\)/g;

/** Markdown as Slack mrkdwn: `**b**` -> `*b*`, `# H` -> `*H*`, `[t](u)` -> `<u|t>`, `- x` -> `• x`. */
export function toSlackMrkdwn(text: string): string {
  return String(text ?? '')
    .split('\n')
    .map((line) => {
      const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
      let out = heading ? `*${heading[1].replace(/\*\*/g, '')}*` : line;
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
    .map((line) => line.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(LINK, '$1 ($2)'))
    .join('\n');
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Markdown as the HTML part of an email: escaped first, then bold, headings, links and list bullets; line breaks kept. */
export function markdownToEmailHtml(text: string): string {
  const lines = String(text ?? '').split(/\r?\n/).map((raw) => {
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(raw);
    let line = escapeHtml(heading ? heading[1] : raw);
    line = line.replace(/^(\s*)[-*]\s+/, '$1&bull; ');
    line = line.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    line = line.replace(/\[([^\]\n]{1,500})\]\((https?:\/\/[^\s)]{1,2000})\)/g, (_m, t, u) => `<a href="${u}">${t}</a>`);
    return heading ? `<strong>${line}</strong>` : line;
  });
  return `<div style="white-space:pre-wrap">${lines.join('<br>')}</div>`;
}
