/**
 * A tool's name for people, the way the dashboard shows it
 * (frontend/src/lib/tool-names.ts): the operation's own summary when the
 * spec has one ("Issue a refund for an order"), else the operation part of
 * the machine name in words ("Create refund"). Used where the server writes
 * a sentence a person reads: an approval request's reason.
 */
export interface NamedTool {
  name: string;
  api?: { name?: string | null } | null;
  operation?: { name?: string | null; api?: { name?: string | null } | null } | null;
}

/** `value` without any leading or trailing `ch`, with no regex to backtrack. */
function trimChar(value: string, ch: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === ch) start++;
  while (end > start && value[end - 1] === ch) end--;
  return value.slice(start, end);
}

function machinePrefix(apiName: string): string {
  return trimChar(apiName.toLowerCase().replace(/[^a-z0-9]+/g, '_'), '_');
}

function humanize(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.\s]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : value;
}

function looksLikeMachineName(value: string): boolean {
  return !/\s/.test(value) && /[_-]|[a-z][A-Z]/.test(value);
}

export function readableToolName(tool: NamedTool): string {
  // A summary is a name here, so a sentence's closing full stop goes.
  let summary = tool.operation?.name?.trim();
  while (summary && summary.endsWith('.')) summary = summary.slice(0, -1);
  if (summary && !looksLikeMachineName(summary) && !/^[A-Z]+ \//.test(summary)) return summary;
  const apiName = tool.api?.name ?? tool.operation?.api?.name ?? '';
  const prefix = apiName ? machinePrefix(apiName) : '';
  let rest = tool.name;
  if (prefix && rest.toLowerCase().startsWith(`${prefix}_`) && rest.length > prefix.length + 1) rest = rest.slice(prefix.length + 1);
  return looksLikeMachineName(rest) ? humanize(rest) : rest;
}
