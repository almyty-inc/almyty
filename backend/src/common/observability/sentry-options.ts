import { redactQueryError } from '../errors/redact-query-error';

/**
 * The @sentry/node options main.ts initializes with, or null when no DSN
 * is configured (Sentry ships dark).
 *
 * An event can carry a failed query's row two ways: the error object
 * itself (its `parameters`, and Postgres' `detail`), and the console
 * breadcrumbs recorded before it, which keep the objects a
 * `console.error(msg, err)` was handed and serialize them whole. Both are
 * redacted here (see redact-query-error.ts).
 */
export interface SentryInitOptions {
  dsn: string;
  environment: string;
  tracesSampleRate: number;
  beforeBreadcrumb: (breadcrumb: any, hint?: any) => any;
  beforeSend: (event: any, hint?: any) => any;
}

function redactEach(values: unknown): void {
  if (!Array.isArray(values)) return;
  for (const value of values) redactQueryError(value);
}

export function redactSentryBreadcrumb(breadcrumb: any, hint?: any): any {
  redactEach(hint?.input);
  redactEach(breadcrumb?.data?.arguments);
  return breadcrumb;
}

export function redactSentryEvent(event: any, hint?: any): any {
  redactQueryError(hint?.originalException);
  for (const breadcrumb of event?.breadcrumbs ?? []) redactEach(breadcrumb?.data?.arguments);
  for (const value of Object.values(event?.contexts ?? {})) redactQueryError(value);
  for (const value of Object.values(event?.extra ?? {})) redactQueryError(value);
  return event;
}

export function sentryInitOptions(vars: NodeJS.ProcessEnv = process.env): SentryInitOptions | null {
  if (!vars.SENTRY_DSN) return null;
  return {
    dsn: vars.SENTRY_DSN,
    environment: vars.SENTRY_ENVIRONMENT || vars.NODE_ENV || 'development',
    // Error tracking only by default: no performance tracing until
    // explicitly opted into. Keeps overhead negligible.
    tracesSampleRate: 0,
    beforeBreadcrumb: redactSentryBreadcrumb,
    beforeSend: redactSentryEvent,
  };
}
