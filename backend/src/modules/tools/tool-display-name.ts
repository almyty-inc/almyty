/**
 * The name people read for a tool made from an API operation, kept on the
 * tool as `metadata.displayName`. The tool's `name` stays the machine name
 * (`hubspot_companies_get_crm_v3_objects_companies_company_id_937ca5`):
 * stable, unique in the organization, what agents call it by.
 *
 * In order: the operation's summary; its operationId in words
 * (`listPets` -> "List pets"); else the method and the last meaningful
 * path segments (`GET /crm/v3/objects/companies/{companyId}` -> "Get company
 * by id", `GET /crm/v3/owners` -> "Get owners").
 */

export interface OperationNaming {
  /** The parser's name: the summary, else the operationId, else "GET /path". */
  name?: string | null;
  operationId?: string | null;
  method?: string | null;
  endpoint?: string | null;
}

const VERBS: Record<string, string> = {
  get: 'Get',
  post: 'Create',
  put: 'Update',
  patch: 'Update',
  delete: 'Delete',
  head: 'Check',
};

/** "listPets", "list_pets", "list-pets" -> "list pets". */
function words(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.\s]+/g, ' ')
    .trim()
    .toLowerCase();
}

function sentence(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

/** A summary is a name; "GET /pets" (what a spec with neither gets) and a bare identifier are not. */
function isSummary(name: string, operationId?: string | null): boolean {
  if (operationId && name === operationId) return false;
  if (/^[A-Z]+\s+\//.test(name)) return false;
  return /\s/.test(name);
}

/** An operationId that reads as words once split: no path, no braces. */
function isWordlike(operationId: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_.\-]*$/.test(operationId);
}

/** `v3`, `v1.0`, `api` and empty segments say nothing about the operation. */
function isNoise(segment: string): boolean {
  return !segment || /^v\d+(\.\d+)*$/i.test(segment) || /^(api|rest)$/i.test(segment);
}

function isParam(segment: string): boolean {
  return /^\{.+\}$/.test(segment) || /^:.+/.test(segment);
}

/** A naive singular for a resource read before its id: "companies" -> "company", "owners" -> "owner". */
function singular(word: string): string {
  if (/ies$/i.test(word)) return word.replace(/ies$/i, 'y');
  if (/(ss|us)$/i.test(word)) return word;
  if (/s$/i.test(word)) return word.replace(/s$/i, '');
  return word;
}

/** "GET /crm/v3/objects/companies/{companyId}" -> "Get company by id". */
export function nameFromPath(method: string | null | undefined, endpoint: string | null | undefined): string | null {
  const segments = (endpoint ?? '').split('?')[0].split('/').filter((s) => !isNoise(s));
  if (segments.length === 0) return null;
  const verb = VERBS[(method ?? 'get').toLowerCase()] ?? sentence((method ?? '').toLowerCase());
  let last = segments.length - 1;
  const trailing: string[] = [];
  while (last >= 0 && isParam(segments[last])) trailing.unshift(segments[last--]);
  if (last < 0) return null;
  const resource = words(segments[last]);
  if (trailing.length === 0) return `${verb} ${resource}`.trim();
  const one = singular(resource.split(' ').pop() ?? resource);
  const head = resource.split(' ').slice(0, -1).concat(one).join(' ');
  const by = trailing
    .map((p) => words(p.replace(/^[{:]|\}$/g, '')))
    // `{companyId}` after "companies" is the company's id.
    .map((p) => (p === `${one} id` || p === `${resource} id` ? 'id' : p))
    .join(' and ');
  return `${verb} ${head} by ${by}`.trim();
}

export function toolDisplayName(operation: OperationNaming): string | null {
  const name = (operation.name ?? '').trim();
  if (name && isSummary(name, operation.operationId)) {
    let summary = name;
    while (summary.endsWith('.')) summary = summary.slice(0, -1);
    return summary;
  }
  const operationId = (operation.operationId ?? '').trim();
  if (operationId && isWordlike(operationId)) return sentence(words(operationId));
  return nameFromPath(operation.method, operation.endpoint) ?? (name || null);
}
