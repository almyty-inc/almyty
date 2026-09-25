import { ConsoleLogger } from '@nestjs/common';

import { redactQueryError } from '../errors/redact-query-error';
import { getRequestContext } from '../request-context';

/**
 * The stock console logger, plus the correlation fields of whatever
 * scope the log call happened in.
 *
 * Chosen over passing an id explicitly to each log call: an explicit
 * parameter is exactly the thing that is forgotten at the call site that
 * turns out to matter, and there are several thousand log calls. This
 * way a line is correlated because it was logged, not because someone
 * remembered.
 *
 * The suffix is appended, never prefixed, so the existing
 * `[ClassName] message` shape the runbook greps match is untouched:
 *
 *   [Nest] 1 - ... ERROR [AgentRuntimeProcessor] run 123 failed | req=<uuid> org=<uuid> run=<uuid>
 *
 * Fields are only added when a scope exists, so boot-time lines and
 * unit-test lines look exactly as they did before.
 */
export class CorrelatedConsoleLogger extends ConsoleLogger {
  private suffix(): string {
    const ctx = getRequestContext();
    if (!ctx) return '';
    const parts: string[] = [`req=${ctx.requestId}`];
    if (ctx.organizationId) parts.push(`org=${ctx.organizationId}`);
    if (ctx.runId) parts.push(`run=${ctx.runId}`);
    if (ctx.nodeId) parts.push(`node=${ctx.nodeId}`);
    if (ctx.jobId) parts.push(`job=${ctx.queue ?? 'queue'}:${ctx.jobId}`);
    return ` | ${parts.join(' ')}`;
  }

  /**
   * Only a string message is decorated. An object message is a
   * structured payload someone means to read as JSON, and appending to
   * it would corrupt it; the stack-trace second argument is likewise
   * left alone.
   *
   * A failed query's error handed over as an object is printed whole by
   * the console logger (util.inspect), bound parameters included; those
   * are row contents and are redacted first (redact-query-error.ts).
   */
  private decorate(message: unknown): unknown {
    redactQueryError(message);
    if (typeof message !== 'string') return message;
    const suffix = this.suffix();
    return suffix ? `${message}${suffix}` : message;
  }

  private redactRest(rest: any[]): any[] {
    rest.forEach((arg) => redactQueryError(arg));
    return rest;
  }

  log(message: any, ...rest: any[]): void {
    super.log(this.decorate(message) as any, ...this.redactRest(rest));
  }

  error(message: any, ...rest: any[]): void {
    super.error(this.decorate(message) as any, ...this.redactRest(rest));
  }

  warn(message: any, ...rest: any[]): void {
    super.warn(this.decorate(message) as any, ...this.redactRest(rest));
  }

  debug(message: any, ...rest: any[]): void {
    super.debug(this.decorate(message) as any, ...this.redactRest(rest));
  }

  verbose(message: any, ...rest: any[]): void {
    super.verbose(this.decorate(message) as any, ...this.redactRest(rest));
  }

  fatal(message: any, ...rest: any[]): void {
    super.fatal(this.decorate(message) as any, ...this.redactRest(rest));
  }
}
