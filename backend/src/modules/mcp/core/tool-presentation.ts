/**
 * How a tool presents itself in an MCP `tools/list`: its readable title,
 * its behaviour hints (annotations) and its icons.
 *
 * Annotations follow the side-effect mapping of docs/design/code-mode.md,
 * part A, which this module applies at listing time until that design
 * stores the class on the tool:
 *
 *   | Source                              | Class                          |
 *   |-------------------------------------|--------------------------------|
 *   | manual override (metadata.sideEffect)| wins                           |
 *   | remote MCP annotations              | copied                         |
 *   | HTTP GET / HEAD / OPTIONS           | read                           |
 *   | HTTP DELETE                         | destructive                    |
 *   | HTTP POST / PUT / PATCH             | write                          |
 *   | GraphQL query / subscription        | read; mutation: write          |
 *   | LLM tool                            | read, closed world             |
 *   | anything else                       | write (code-mode decision 4)   |
 *
 * `idempotentHint` is set where the method says so (GET, HEAD, OPTIONS,
 * PUT, DELETE). `openWorldHint` is true for anything that calls out to a
 * third party, false for LLM tools.
 *
 * Annotations are hints. Clients must not make security decisions on them
 * (2025-06-18 tools, "Tool Annotations"), and neither does this server:
 * approval policies and gateway security policies are enforced by the
 * executor regardless.
 */

export type SideEffect = 'read' | 'write' | 'destructive';

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  title?: string;
}

export interface ToolIcon {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: 'light' | 'dark';
}

/** The parts of a Tool entity this module reads. Loose on purpose: callers pass entities or plain rows. */
export interface PresentableTool {
  name: string;
  description?: string | null;
  executionMethod?: string | null;
  type?: string | null;
  metadata?: Record<string, any> | null;
  configuration?: Record<string, any> | null;
  httpConfig?: { method?: string } | null;
  graphqlConfig?: { query?: string } | null;
  llmConfig?: unknown;
  operation?: { method?: string | null; type?: string | null } | null;
  api?: { metadata?: Record<string, any> | null } | null;
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

function isSideEffect(value: unknown): value is SideEffect {
  return value === 'read' || value === 'write' || value === 'destructive';
}

function graphqlKind(query: string | undefined): 'query' | 'mutation' | 'subscription' | null {
  const match = /^\s*(?:#[^\n]*\n\s*)*(query|mutation|subscription)\b/i.exec(query ?? '');
  if (match) return match[1].toLowerCase() as 'query' | 'mutation' | 'subscription';
  // A bare selection set (`{ users { id } }`) is a query.
  return /^\s*\{/.test(query ?? '') ? 'query' : null;
}

/** The HTTP method a tool's calls use, when it has one. */
function httpMethodOf(tool: PresentableTool): string | null {
  const method = tool.operation?.method ?? tool.httpConfig?.method ?? null;
  return method ? String(method).toUpperCase() : null;
}

/** Annotations, or null when the tool carries none and none can be derived. */
export function toolAnnotations(tool: PresentableTool): ToolAnnotations {
  // A remote MCP tool's own annotations, as its server declared them.
  const remote = tool.configuration?.mcp?.annotations;
  if (remote && typeof remote === 'object') {
    const copied: ToolAnnotations = {};
    for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
      if (typeof remote[key] === 'boolean') copied[key] = remote[key];
    }
    if (Object.keys(copied).length) return copied;
  }

  const isLlm = tool.executionMethod === 'llm' || !!tool.llmConfig;
  const openWorldHint = !isLlm;
  const method = httpMethodOf(tool);

  let sideEffect: SideEffect = 'write';
  const override = tool.metadata?.sideEffect;
  if (isSideEffect(override)) {
    sideEffect = override;
  } else if (isLlm) {
    sideEffect = 'read';
  } else if (method) {
    sideEffect = READ_METHODS.has(method) ? 'read' : method === 'DELETE' ? 'destructive' : 'write';
  } else {
    const kind =
      graphqlKind(tool.graphqlConfig?.query) ??
      (tool.operation?.type === 'query' || tool.operation?.type === 'subscription'
        ? 'query'
        : tool.operation?.type === 'mutation'
          ? 'mutation'
          : null);
    if (kind === 'query' || kind === 'subscription') sideEffect = 'read';
  }

  const annotations: ToolAnnotations = {
    readOnlyHint: sideEffect === 'read',
    openWorldHint,
  };
  // destructiveHint and idempotentHint are meaningful only when
  // readOnlyHint is false (2025-06-18 schema).
  if (sideEffect !== 'read') annotations.destructiveHint = sideEffect === 'destructive';
  if (sideEffect !== 'read' && method && IDEMPOTENT_METHODS.has(method)) annotations.idempotentHint = true;
  if (sideEffect === 'read' && method && IDEMPOTENT_METHODS.has(method)) annotations.idempotentHint = true;
  return annotations;
}

/**
 * `list_pets` -> "List pets", `getPetById` -> "Get pet by id". Only used
 * when the tool carries no title of its own.
 */
export function humanizeToolName(name: string | null | undefined): string {
  if (!name) return 'Unnamed tool';
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (/^[A-Z0-9]+$/.test(w) && w.length > 1 ? w : w.toLowerCase()));
  if (!words.length) return name;
  const first = words[0];
  words[0] = first.charAt(0).toUpperCase() + first.slice(1);
  return words.join(' ');
}

export function toolTitle(tool: PresentableTool): string {
  const own = tool.metadata?.title ?? tool.metadata?.displayName;
  if (typeof own === 'string' && own.trim()) return own.trim().slice(0, 200);
  return humanizeToolName(tool.name);
}

function iconFrom(value: unknown): ToolIcon | null {
  if (typeof value === 'string') value = { src: value };
  if (!value || typeof value !== 'object') return null;
  const src = (value as any).src;
  if (typeof src !== 'string') return null;
  // https only, or an inline image. An http or javascript URL in a client's
  // UI is a mixed-content or script problem the client should not inherit.
  if (!/^https:\/\//i.test(src) && !/^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,/i.test(src)) return null;
  const icon: ToolIcon = { src };
  const { mimeType, sizes, theme } = value as any;
  if (typeof mimeType === 'string') icon.mimeType = mimeType;
  if (Array.isArray(sizes) && sizes.every((s) => typeof s === 'string')) icon.sizes = sizes;
  if (theme === 'light' || theme === 'dark') icon.theme = theme;
  return icon;
}

/**
 * Icons the tool or the API behind it carries: the tool's own
 * `metadata.icons`, a remote MCP tool's icons, or the API's
 * `metadata.icon` / `metadata.iconUrl` / OpenAPI `x-logo`. Empty when
 * there are none; nothing is invented.
 */
export function toolIcons(tool: PresentableTool): ToolIcon[] {
  const candidates: unknown[] = [];
  const push = (value: unknown) => {
    if (Array.isArray(value)) candidates.push(...value);
    else if (value) candidates.push(value);
  };
  push(tool.metadata?.icons);
  push(tool.configuration?.mcp?.icons);
  if (!candidates.length) {
    const api = tool.api?.metadata ?? {};
    push(api.icons ?? api.icon ?? api.iconUrl ?? api['x-logo']?.url ?? api.info?.['x-logo']?.url);
  }
  return candidates.map(iconFrom).filter((i): i is ToolIcon => !!i).slice(0, 8);
}
