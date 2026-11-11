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

/** The header names that carry an idempotency key, by the conventions APIs publish them under. */
const IDEMPOTENCY_HEADER = /^(x-)?idempotency-key$/i;

/**
 * The header a tool's call carries its idempotency key in, when the tool
 * accepts one (durable runs step 4): of `names`, the headers the
 * operation declares or the tool's HTTP config sets, the first named
 * `Idempotency-Key` or `X-Idempotency-Key`, any case. Null when it
 * declares none: such a tool is not sent a key.
 */
export function idempotencyHeader(names: Iterable<string>): string | null {
  for (const name of names) if (IDEMPOTENCY_HEADER.test(name)) return name;
  return null;
}

/**
 * Whether a tool accepts an idempotency key (durable runs step 4): its HTTP
 * config sets the header for one, or its generating operation declares it.
 * `operation` must be loaded for an operation-backed tool to be told apart;
 * a tool with neither is sent no key.
 */
export function takesIdempotencyKey(tool: {
  httpConfig?: { headers?: Record<string, any> | null } | null;
  operation?: { parameters?: { header?: Record<string, any> } | null } | null;
}): boolean {
  return idempotencyHeader([...Object.keys(tool.httpConfig?.headers ?? {}), ...operationHeaderParams(tool.operation).map(([name]) => name)]) !== null;
}
