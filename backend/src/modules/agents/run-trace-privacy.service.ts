import { Inject, Injectable, Logger, Optional, forwardRef } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntitySubscriberInterface, InsertEvent, UpdateEvent } from 'typeorm';

import { AgentRun } from '../../entities/agent-run.entity';
import { AgentExecution, AgentExecutionStatus } from '../../entities/agent-execution.entity';
import { ToolExecutorService } from '../tools/tool-executor.service';

/**
 * Personal data hidden in the traces runs leave behind, under the
 * organization's PII filter: the step list of an autonomous run
 * (`agent_runs.steps`) and the node results of a finished workflow run
 * (`agent_executions.nodeResults`), which is what Runs shows. What a tool
 * is called with, and what the model reads, keeps the real values: those
 * travel in memory and in the run's working memory, never through the
 * trace.
 *
 * A workflow's node results are also the state a paused run carries on
 * from (agent-execution.engine resume), so they are hidden only once the
 * run is over. An autonomous run's steps are a record only: the model's
 * conversation is rebuilt from working memory (agent-runtime-builders), and
 * readers of steps take ids and statuses, which the filter keeps.
 *
 * Writes through `save()` are caught here, whichever service makes them; a
 * write through `update()` carries no organization, so its writer hides the
 * steps itself with `hideSteps` (agent-step-processor).
 */

/** Keys of a step's input and output that are ids or states, never personal data. */
const KEEP = ['toolId', 'tool', 'codeExecutionId', 'approvalId', 'status', 'providerId', 'model', 'routing', 'verdict'];

const TERMINAL_EXECUTION = new Set<string>([
  AgentExecutionStatus.COMPLETED,
  AgentExecutionStatus.FAILED,
  AgentExecutionStatus.CANCELLED,
  AgentExecutionStatus.TIMEOUT,
]);

type Step = Record<string, any>;

@Injectable()
export class RunTracePrivacyService implements EntitySubscriberInterface {
  private readonly logger = new Logger(RunTracePrivacyService.name);
  /** A step already hidden, by the object it came from: an unchanged step is not filtered again on the next save. */
  private readonly hidden = new WeakMap<object, Step>();

  constructor(
    @Inject(forwardRef(() => ToolExecutorService))
    private readonly tools: ToolExecutorService,
    @Optional() @InjectDataSource() dataSource?: DataSource,
  ) {
    dataSource?.subscribers.push(this);
  }

  /** The steps as they may be stored: personal data hidden in each step's input, output and error. */
  async hideSteps<T>(steps: T, organizationId: string | null | undefined, userId?: string | null): Promise<T> {
    if (!Array.isArray(steps) || !organizationId || !steps.length) return steps;
    const todo = steps.filter((s) => s && typeof s === 'object' && !this.hidden.has(s));
    if (todo.length) {
      const visible = todo.map((s: Step) => ({ input: s.input, output: s.output, error: s.error }));
      const masked = await this.tools.hidePersonalData(visible, { organizationId, userId: userId ?? undefined } as any);
      todo.forEach((s: Step, i: number) => {
        const m = masked[i] ?? visible[i];
        const out: Step = { ...s };
        if (s.input !== undefined) out.input = keepIds(s.input, m.input);
        if (s.output !== undefined) out.output = keepIds(s.output, m.output);
        if (s.error !== undefined) out.error = m.error;
        this.hidden.set(s, out);
        this.hidden.set(out, out);
      });
    }
    return steps.map((s) => (s && typeof s === 'object' ? this.hidden.get(s) ?? s : s)) as unknown as T;
  }

  /** A workflow run's node results as they may be stored, once the run is over. */
  async hideNodeResults<T>(nodeResults: T, organizationId: string | null | undefined, userId?: string | null): Promise<T> {
    if (!nodeResults || typeof nodeResults !== 'object' || !organizationId) return nodeResults;
    if (this.hidden.has(nodeResults as object)) return this.hidden.get(nodeResults as object) as T;
    const [masked] = await this.tools.hidePersonalData([nodeResults], { organizationId, userId: userId ?? undefined } as any);
    const out = (masked ?? nodeResults) as T;
    this.hidden.set(nodeResults as object, out as any);
    this.hidden.set(out as object, out as any);
    return out;
  }

  // ---------- the subscriber ----------

  beforeInsert(event: InsertEvent<any>): Promise<void> | void {
    return this.hideEntity(event.entity);
  }

  beforeUpdate(event: UpdateEvent<any>): Promise<void> | void {
    return this.hideEntity(event.entity);
  }

  private async hideEntity(entity: any): Promise<void> {
    if (!entity || typeof entity !== 'object') return;
    try {
      if (entity instanceof AgentRun && Array.isArray(entity.steps)) {
        entity.steps = await this.hideSteps(entity.steps, entity.organizationId, entity.userId);
      } else if (entity instanceof AgentExecution && entity.nodeResults && TERMINAL_EXECUTION.has(entity.status)) {
        entity.nodeResults = await this.hideNodeResults(entity.nodeResults, entity.organizationId, entity.userId);
      }
    } catch (err: any) {
      // A run's write never fails on its trace's privacy pass.
      this.logger.warn(`Could not hide personal data in a run's trace: ${err?.message ?? err}`);
    }
  }
}

/** The filtered value, with the original ids and states put back at the top level. */
function keepIds(original: any, masked: any): any {
  if (!original || typeof original !== 'object' || Array.isArray(original) || !masked || typeof masked !== 'object') return masked;
  const out = { ...masked };
  for (const key of KEEP) if (key in original) out[key] = original[key];
  return out;
}
