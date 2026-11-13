import type { ToolRunEnvelope } from './api'

/** A test run as the tool page shows it. */
export interface ToolRunOutcome {
  success: boolean
  data?: unknown
  error?: string
  message?: string
  statusCode?: number
  url?: string
  method?: string
  metadata?: ToolRunEnvelope['metadata']
  /** What the upstream answered on a failed run, shown beside the error. */
  fullError?: unknown
}

/**
 * Reads a tool run's answer. A run is a success only when the backend says
 * so: an upstream 404 or 400 arrives as HTTP 200 with success:false and the
 * upstream body in `data`, and must not read as a green Success.
 */
export function toolRunOutcome(envelope: ToolRunEnvelope | null | undefined): ToolRunOutcome {
  const metadata = envelope?.metadata
  if (envelope?.success === true) {
    return { success: true, data: envelope.data, message: envelope.message, metadata }
  }
  const status = metadata?.httpStatus
  return {
    success: false,
    error: envelope?.error || envelope?.message || 'The tool run failed.',
    message: envelope?.message,
    statusCode: typeof status === 'number' && status > 0 ? status : undefined,
    url: metadata?.url,
    method: metadata?.method,
    metadata,
    fullError: envelope?.data ?? undefined,
  }
}
