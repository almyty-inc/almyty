import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

/**
 * Per-request correlation context.
 *
 * One id is minted for every inbound HTTP request (or accepted from an
 * inbound `x-request-id` when a caller or proxy already has one), echoed
 * back as `X-Request-Id`, appended to every log line by
 * `CorrelatedConsoleLogger`, and written to `request_logs.requestId`.
 * The same id then rides into BullMQ job payloads and onto the rows the
 * jobs produce, which is what makes "it said Internal server error when
 * I saved an agent" joinable to a log line, a run, and a tool execution.
 *
 * AsyncLocalStorage rather than an explicit parameter on purpose: an
 * explicit id is the thing that gets forgotten at the one call site that
 * mattered. Work that starts outside a request (a queue consumer, the
 * scheduler) opens its own scope with `runWithRequestContext`.
 */
export interface RequestContextStore {
  /** Correlation id. Present for the whole lifetime of a scope. */
  requestId: string;
  organizationId?: string | null;
  userId?: string | null;
  /** Set once a gateway has been resolved (see `setProtocolContext`). */
  gatewayId?: string | null;
  /** Set for the duration of an agent run, so its tool calls inherit it. */
  runId?: string | null;
  /** Set for the duration of a pipeline node's execution. */
  nodeId?: string | null;
  /** Queue name + job id, when the scope is a background job. */
  jobId?: string | null;
  queue?: string | null;
}

export const requestContext = new AsyncLocalStorage<RequestContextStore>();

/** Header a caller or proxy can use to supply its own id. */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * A caller-supplied id is only honoured when it looks like an id: it
 * lands in a log line and a database column, so an arbitrary header
 * value must not be able to inject newlines or grow unbounded.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export function newRequestId(): string {
  return randomUUID();
}

export function sanitizeInboundRequestId(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return SAFE_REQUEST_ID.test(trimmed) ? trimmed : undefined;
}

export function getRequestContext(): RequestContextStore | undefined {
  return requestContext.getStore();
}

export function getRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

/**
 * Open a scope. Inherits the enclosing scope's fields when there is one,
 * so a run opened inside a request keeps the request's id rather than
 * minting a second, unjoinable one.
 */
export function runWithRequestContext<T>(
  fields: Partial<RequestContextStore>,
  fn: () => T,
): T {
  const parent = requestContext.getStore();
  const store: RequestContextStore = {
    ...(parent ?? {}),
    ...fields,
    requestId: fields.requestId ?? parent?.requestId ?? newRequestId(),
  };
  return requestContext.run(store, fn);
}

/**
 * Add to the current scope in place — for facts discovered mid-request
 * (the authenticated user, the resolved gateway). No-op outside a scope
 * rather than throwing: a unit test that calls a service directly has no
 * request, and that is not an error.
 */
export function updateRequestContext(fields: Partial<RequestContextStore>): void {
  const store = requestContext.getStore();
  if (!store) return;
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) (store as unknown as Record<string, unknown>)[k] = v;
  }
}
