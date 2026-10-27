/**
 * Header parameters an operation declares that a tool takes as inputs.
 *
 * Some APIs need a header on every call that is not a key: Xero's
 * `xero-tenant-id` names the organisation, Notion's `Notion-Version` the
 * API version. Leaving them out of the tool made those APIs uncallable, so
 * they are tool inputs like path and query parameters, and the HTTP
 * executor sends them as headers. Headers the credential or the executor
 * set themselves are never inputs: a tool argument must not replace the key,
 * and a SOAP call names its own SOAPAction.
 */
const NOT_AN_INPUT = new Set(['authorization', 'proxy-authorization', 'cookie', 'content-type', 'content-length', 'host', 'accept', 'soapaction']);

export function operationHeaderParams(
  operation: { parameters?: { header?: Record<string, any> } | null } | null | undefined,
): Array<[string, any]> {
  const declared = operation?.parameters?.header;
  if (!declared || typeof declared !== 'object') return [];
  return Object.entries(declared).filter(([name]) => !NOT_AN_INPUT.has(name.toLowerCase()));
}
