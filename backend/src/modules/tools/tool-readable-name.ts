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

function machinePrefix(apiName: string): string {
  return apiName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
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
  const summary = tool.operation?.name?.trim().replace(/\.+$/, '');
  if (summary && !looksLikeMachineName(summary) && !/^[A-Z]+ \//.test(summary)) return summary;
  const apiName = tool.api?.name ?? tool.operation?.api?.name ?? '';
  const prefix = apiName ? machinePrefix(apiName) : '';
  let rest = tool.name;
  if (prefix && rest.toLowerCase().startsWith(`${prefix}_`) && rest.length > prefix.length + 1) rest = rest.slice(prefix.length + 1);
  return looksLikeMachineName(rest) ? humanize(rest) : rest;
}
