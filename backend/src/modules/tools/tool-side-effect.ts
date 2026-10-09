/**
 * The side-effect class of a tool: what calling it does to data
 * (docs/design/code-mode.md, part A).
 *
 *   read         looks something up; changes nothing
 *   write        creates or changes something
 *   destructive  deletes something
 *
 * plus `openWorld` (it reaches a third party) and where the class came from.
 * Code mode stages destructive calls (and writes when staging is on), MCP
 * clients read it as annotations, and the class is part of the tool's
 * integrity hash, so it cannot drop from destructive to read unnoticed.
 *
 * | Source (`sideEffectSource`) | Rule                                                        |
 * |-----------------------------|-------------------------------------------------------------|
 * | override                    | set by a person on the tool; survives re-import             |
 * | annotation                  | a remote MCP tool's own annotations: readOnlyHint -> read,  |
 * |                             | destructiveHint -> destructive, else write                  |
 * | http_method                 | GET/HEAD/OPTIONS read, DELETE destructive, POST/PUT/PATCH   |
 * |                             | write (generated from OpenAPI, or a hand-made HTTP tool)    |
 * | graphql                     | query and subscription read, mutation write                 |
 * | default                     | an LLM tool reads (closed world); anything else with no     |
 * |                             | reliable signal (SOAP, gRPC, SDK, JavaScript, templated     |
 * |                             | HTTP method) is write, never destructive by guess           |
 * |                             | (code-mode decision 4)                                      |
 *
 * The class is computed when a tool is written (the entity hook in
 * tool.entity.ts), never at call time.
 */

export type SideEffect = 'read' | 'write' | 'destructive';
export type SideEffectSource = 'override' | 'annotation' | 'http_method' | 'graphql' | 'default';

export const SIDE_EFFECTS: readonly SideEffect[] = ['read', 'write', 'destructive'];
export const SIDE_EFFECT_SOURCES: readonly SideEffectSource[] = ['override', 'annotation', 'http_method', 'graphql', 'default'];

export function isSideEffect(value: unknown): value is SideEffect {
  return value === 'read' || value === 'write' || value === 'destructive';
}

export interface ToolClass {
  sideEffect: SideEffect;
  openWorld: boolean;
  sideEffectSource: SideEffectSource;
}

/** The parts of a tool the class is computed from: all columns of the tool row itself. */
export interface ClassifiableTool {
  sideEffect?: string | null;
  sideEffectSource?: string | null;
  executionMethod?: string | null;
  metadata?: Record<string, any> | null;
  configuration?: Record<string, any> | null;
  httpConfig?: { method?: string | null } | null;
  graphqlConfig?: { query?: string | null } | null;
  llmConfig?: unknown;
  /** The generating operation, when the relation is loaded. */
  operation?: { method?: string | null; type?: string | null; endpoint?: string | null; operationId?: string | null } | null;
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/** The operation type of a GraphQL document: `query`, `mutation`, `subscription`, or null. */
export function graphqlKind(query: string | null | undefined): 'query' | 'mutation' | 'subscription' | null {
  const match = /^\s*(?:#[^\n]*\n\s*)*(query|mutation|subscription)\b/i.exec(query ?? '');
  if (match) return match[1].toLowerCase() as 'query' | 'mutation' | 'subscription';
  // A bare selection set (`{ users { id } }`) is a query.
  return /^\s*\{/.test(query ?? '') ? 'query' : null;
}

/** A literal HTTP method; a templated one (`{method}`) or anything else is no signal. */
function literalMethod(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const method = value.trim().toUpperCase();
  return READ_METHODS.has(method) || WRITE_METHODS.has(method) || method === 'DELETE' ? method : null;
}

/**
 * Whether a POST operation is a search: its path ends in `/search`,
 * `/query` or `/batch/read`, or its operation id ends in `search`,
 * `doSearch` or `query` (`calendar.freebusy.query`).
 */
export function isSearchOperation(operation: { endpoint?: string | null; operationId?: string | null } | null | undefined): boolean {
  const endpoint = String(operation?.endpoint ?? '').toLowerCase().replace(/\/+$/, '');
  if (/\/(search|query|batch\/read)$/.test(endpoint)) return true;
  const id = String(operation?.operationId ?? '');
  return /(?:^|[._\-/])(?:search|dosearch|query)$/i.test(id) || /_doSearch$/.test(id);
}

function classOfMethod(method: string): SideEffect {
  if (READ_METHODS.has(method)) return 'read';
  return method === 'DELETE' ? 'destructive' : 'write';
}

/** The class a tool gets from its definition, ignoring any override. */
export function derivedToolClass(tool: ClassifiableTool): ToolClass {
  const isLlm = tool.executionMethod === 'llm' || !!tool.llmConfig;

  // A remote MCP tool says what it does.
  const remote = tool.configuration?.mcp?.annotations;
  if (remote && typeof remote === 'object' && (typeof remote.readOnlyHint === 'boolean' || typeof remote.destructiveHint === 'boolean')) {
    const sideEffect: SideEffect = remote.readOnlyHint === true ? 'read' : remote.destructiveHint === true ? 'destructive' : 'write';
    const openWorld = typeof remote.openWorldHint === 'boolean' ? remote.openWorldHint : true;
    return { sideEffect, openWorld, sideEffectSource: 'annotation' };
  }

  if (isLlm) return { sideEffect: 'read', openWorld: false, sideEffectSource: 'default' };

  // Generated from an API operation: GraphQL by its operation type, the
  // rest by HTTP method.
  // The generating operation: its method and type are copied into
  // metadata.sourceOperation; the relation, when loaded, says the same.
  const operation = tool.operation ?? tool.metadata?.sourceOperation;
  const sourceApiType = String(tool.metadata?.sourceApi?.type ?? '').toLowerCase();
  const operationType = String(operation?.type ?? '').toLowerCase();
  if (sourceApiType === 'graphql' && (operationType === 'query' || operationType === 'subscription' || operationType === 'mutation')) {
    return { sideEffect: operationType === 'mutation' ? 'write' : 'read', openWorld: true, sideEffectSource: 'graphql' };
  }

  const graphql = graphqlKind(tool.graphqlConfig?.query);
  if (graphql) {
    return { sideEffect: graphql === 'mutation' ? 'write' : 'read', openWorld: true, sideEffectSource: 'graphql' };
  }

  const method = literalMethod(operation?.method) ?? literalMethod(tool.httpConfig?.method);
  // A search or query sent as POST (HubSpot's /search, Google's
  // freebusy.query, a "batch/read") changes nothing: its body is the
  // question. Told apart by the operation's own path or id, never guessed
  // from a description.
  if (method === 'POST' && isSearchOperation(operation)) {
    return { sideEffect: 'read', openWorld: true, sideEffectSource: 'http_method' };
  }
  if (method) return { sideEffect: classOfMethod(method), openWorld: true, sideEffectSource: 'http_method' };

  return { sideEffect: 'write', openWorld: true, sideEffectSource: 'default' };
}

/**
 * The class a tool has: a person's override when there is one (the
 * `override` source, or the older `metadata.sideEffect`), else the derived
 * class. `openWorld` is always derived; an override changes only the class.
 */
export function toolClass(tool: ClassifiableTool): ToolClass {
  const derived = derivedToolClass(tool);
  if (tool.sideEffectSource === 'override' && isSideEffect(tool.sideEffect)) {
    return { ...derived, sideEffect: tool.sideEffect, sideEffectSource: 'override' };
  }
  const legacy = tool.metadata?.sideEffect;
  if (isSideEffect(legacy)) return { ...derived, sideEffect: legacy, sideEffectSource: 'override' };
  return derived;
}

/** The columns the class is computed from; a write that did not load one of them must not reclassify. */
export const CLASS_INPUT_COLUMNS = ['executionMethod', 'metadata', 'configuration', 'httpConfig', 'graphqlConfig', 'llmConfig'] as const;
