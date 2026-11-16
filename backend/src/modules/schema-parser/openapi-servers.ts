/**
 * Where an OpenAPI 3 operation is called, by the spec's own precedence:
 * the operation's `servers`, else its path's, else the document's.
 *
 * Open-Meteo's forecast.yml declares its servers on the path only, so
 * reading just the document's `servers` gave the API the address the
 * description was downloaded from (raw.githubusercontent.com).
 *
 * Pure: no I/O, no DI.
 */
import { hasDelimited, replaceDelimited } from '../../common/security/linear-text';

const OPERATION_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

/** `https://{region}.example.com` with the variables' defaults filled in; relative URLs against where the spec came from. */
export function resolveServerUrl(server: any, sourceUrl?: string): string | null {
  let url = String(server.url).trim();
  const vars = server.variables && typeof server.variables === 'object' ? server.variables : {};
  // Not /\{([^}]+)\}/g: from every `{` of a URL with no `}` after it, that
  // rescanned to the end (linear-text.ts).
  url = replaceDelimited(url, '{', '}', (whole, name) => {
    const v = vars[name];
    return v && v.default != null ? String(v.default) : whole;
  });
  if (hasDelimited(url, '{', '}')) return null;
  return absoluteUrl(url, sourceUrl);
}

/** The first server of a `servers` list whose address can be worked out, or null. */
export function firstServerUrl(servers: unknown, sourceUrl?: string): string | null {
  if (!Array.isArray(servers)) return null;
  for (const server of servers) {
    if (typeof server?.url !== 'string' || !server.url.trim()) continue;
    const url = resolveServerUrl(server, sourceUrl);
    if (url) return url;
  }
  return null;
}

/** An operation's own server: its `servers`, else its path's. Null when neither declares one. */
export function ownServerUrl(pathItem: any, operation: any, sourceUrl?: string): string | null {
  return firstServerUrl(operation?.servers, sourceUrl) ?? firstServerUrl(pathItem?.servers, sourceUrl);
}

/** Each `servers` list the description declares, the document's first, then each operation's own (operation over path). */
function* serverLists(doc: any): Generator<unknown> {
  yield doc?.servers;
  const paths = doc?.paths && typeof doc.paths === 'object' ? doc.paths : {};
  for (const pathItem of Object.values<any>(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const method of OPERATION_METHODS) {
      const operation = pathItem[method];
      if (!operation || typeof operation !== 'object') continue;
      yield operation.servers;
      yield pathItem.servers;
    }
  }
}

/**
 * The API's address: the document's servers; with none, the first
 * operation's own server. Null when nothing declares a usable one.
 */
export function openApi3BaseUrl(doc: any, sourceUrl?: string): string | null {
  for (const servers of serverLists(doc)) {
    const url = firstServerUrl(servers, sourceUrl);
    if (url) return url;
  }
  return null;
}

/** Whether the description names any server, at any level. */
export function declaresServers(doc: any): boolean {
  for (const servers of serverLists(doc)) {
    if (Array.isArray(servers) && servers.some((s: any) => typeof s?.url === 'string' && s.url.trim())) return true;
  }
  return false;
}

/**
 * The address an operation is called on when it is not the API's own:
 * set at import from the operation's or path's `servers` and kept in the
 * operation's metadata as `serverUrl`. Only an absolute http(s) URL counts.
 */
export function operationServerUrl(operation: { metadata?: Record<string, any> | null } | null | undefined): string | null {
  const url = operation?.metadata?.serverUrl;
  return typeof url === 'string' && /^https?:\/\/[^/]/i.test(url) ? url : null;
}

export function absoluteUrl(url: string, sourceUrl?: string): string | null {
  if (/^https?:\/\//i.test(url)) return trimSlash(url);
  if (!sourceUrl) return null;
  try {
    return trimSlash(new URL(url, sourceUrl).toString());
  } catch {
    return null;
  }
}

export function trimSlash(url: string): string {
  return url.length > 1 && url.endsWith('/') && !/^https?:\/\/$/.test(url) ? url.replace(/(?<!\/)\/+$/, '') : url;
}
