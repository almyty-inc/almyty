/**
 * How a tool presents itself in an MCP `tools/list`: its readable title,
 * its behaviour hints (annotations) and its icons.
 *
 * Annotations come from the tool's side-effect class
 * (docs/design/code-mode.md, part A), stored on the tool by
 * modules/tools/tool-side-effect.ts: `readOnlyHint` for read,
 * `destructiveHint` for destructive, `openWorldHint` from `openWorld`. A
 * remote MCP tool whose class came from its own annotations keeps them as
 * its server declared them. A row without the stored class (the
 * management tools, plain objects in tests) is classified on the spot by
 * the same function.
 *
 * `idempotentHint` is set where the method says so (GET, HEAD, OPTIONS,
 * PUT, DELETE).
 *
 * Annotations are hints. Clients must not make security decisions on them
 * (2025-06-18 tools, "Tool Annotations"), and neither does this server:
 * approval policies and gateway security policies are enforced by the
 * executor regardless.
 */
import { ClassifiableTool, SideEffect, ToolClass, isSideEffect, toolClass } from '../../tools/tool-side-effect';

export type { SideEffect };

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
export interface PresentableTool extends ClassifiableTool {
  name: string;
  description?: string | null;
  type?: string | null;
  openWorld?: boolean | null;
  operation?: { method?: string | null; type?: string | null } | null;
  api?: { metadata?: Record<string, any> | null } | null;
}

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

/** The HTTP method a tool's calls use, when it has one. */
function httpMethodOf(tool: PresentableTool): string | null {
  const method = tool.operation?.method ?? tool.metadata?.sourceOperation?.method ?? tool.httpConfig?.method ?? null;
  return method ? String(method).toUpperCase() : null;
}

/** The class stored on the tool, or computed from its definition when the row carries none. */
export function classOf(tool: PresentableTool): ToolClass {
  if (isSideEffect(tool.sideEffect) && typeof tool.sideEffectSource === 'string') {
    return { sideEffect: tool.sideEffect, openWorld: tool.openWorld !== false, sideEffectSource: tool.sideEffectSource as ToolClass['sideEffectSource'] };
  }
  return toolClass(tool);
}

/** The tool's annotations, from its side-effect class. */
export function toolAnnotations(tool: PresentableTool): ToolAnnotations {
  const cls = classOf(tool);

  // A remote MCP tool's own annotations, as its server declared them.
  const remote = tool.configuration?.mcp?.annotations;
  if (cls.sideEffectSource === 'annotation' && remote && typeof remote === 'object') {
    const copied: ToolAnnotations = {};
    for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
      if (typeof remote[key] === 'boolean') copied[key] = remote[key];
    }
    if (Object.keys(copied).length) return copied;
  }

  const method = httpMethodOf(tool);
  const annotations: ToolAnnotations = {
    readOnlyHint: cls.sideEffect === 'read',
    openWorldHint: cls.openWorld,
  };
  // destructiveHint is meaningful only when readOnlyHint is false (2025-06-18 schema).
  if (cls.sideEffect !== 'read') annotations.destructiveHint = cls.sideEffect === 'destructive';
  if (method && IDEMPOTENT_METHODS.has(method)) annotations.idempotentHint = true;
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
