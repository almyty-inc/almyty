import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AgentExecution, AgentExecutionStatus } from '../../entities/agent-execution.entity';

/**
 * Statuses a workflow execution never leaves. Cancelling one of these is a
 * 409, not a crash and not a silent success: the caller asked to stop
 * something that had already stopped, and saying so is the only honest
 * answer.
 */
const TERMINAL_STATUSES: ReadonlySet<AgentExecutionStatus> = new Set([
  AgentExecutionStatus.COMPLETED,
  AgentExecutionStatus.FAILED,
  AgentExecutionStatus.CANCELLED,
  AgentExecutionStatus.TIMEOUT,
]);

interface InFlightExecution {
  controller: AbortController;
  organizationId: string;
  /** Set by an explicit cancel(), as opposed to an upstream client disconnect. */
  cancelled: boolean;
}

/**
 * The registry of workflow executions running in this process, and the one
 * place that turns "stop this execution" into an aborted signal.
 *
 * The engine has always cancelled cooperatively on `ExecuteAgentOptions.signal`,
 * but nothing held on to the controller behind that signal once `execute()`
 * had started, so an execution could only be stopped by the caller that
 * started it -- and a gateway client that cancels without dropping its
 * connection, or any caller wanting to stop an execution it started
 * elsewhere, had nothing to reach for. The pipeline ran on, billing model
 * calls nobody would read.
 *
 * Scope: this process. A cancel for an execution running on another replica
 * still persists CANCELLED (so the record and the UI are honest and a
 * scheduler will not resume it), but cannot abort that replica's in-flight
 * calls. Cross-process abort would need the run bus; this is deliberately
 * the smaller thing.
 */
@Injectable()
export class AgentExecutionCancellationService {
  private readonly logger = new Logger(AgentExecutionCancellationService.name);
  private readonly inFlight = new Map<string, InFlightExecution>();

  constructor(
    @InjectRepository(AgentExecution)
    private readonly executionRepository: Repository<AgentExecution>,
  ) {}

  /**
   * Track a starting execution and return the controller whose signal the
   * engine should actually run on. An upstream signal (the HTTP request's,
   * a parent run's) is mirrored into it, so nodes see one signal covering
   * both client-disconnect and explicit cancel.
   */
  register(executionId: string, organizationId: string, upstream?: AbortSignal): AbortController {
    const controller = new AbortController();

    if (upstream) {
      if (upstream.aborted) {
        controller.abort();
      } else {
        upstream.addEventListener('abort', () => controller.abort(), { once: true });
      }
    }

    this.inFlight.set(executionId, { controller, organizationId, cancelled: false });
    return controller;
  }

  /** Stop tracking a finished execution. Always called, including on crash. */
  release(executionId: string): void {
    this.inFlight.delete(executionId);
  }

  /**
   * Was this execution explicitly cancelled (as opposed to its client
   * merely going away)? The engine asks before it writes COMPLETED: a
   * cancel that lands during the final layer has no next layer left to
   * guard it, and without this the engine would overwrite the CANCELLED
   * row this service just wrote.
   */
  isCancelled(executionId: string): boolean {
    return this.inFlight.get(executionId)?.cancelled === true;
  }

  /** Visible for tests and diagnostics. */
  isTracked(executionId: string): boolean {
    return this.inFlight.has(executionId);
  }

  /**
   * Cancel a workflow execution: abort its signal if it is running here,
   * and record CANCELLED either way.
   *
   * Org-scoped exactly like AgentRuntimeService.cancelRun -- an execution
   * belonging to another organization is reported as not found, so the
   * endpoint cannot be used to probe for ids. `agentId`, when given,
   * asserts the execution belongs to that agent (the gateway route names
   * one).
   */
  async cancel(executionId: string, organizationId: string, agentId?: string): Promise<AgentExecution> {
    if (!organizationId) {
      throw new NotFoundException(`Execution ${executionId} not found`);
    }

    const execution = await this.executionRepository.findOne({
      where: {
        id: executionId,
        organizationId,
        ...(agentId ? { agentId } : {}),
      },
    });

    if (!execution) {
      // Wrong org, wrong agent and genuinely absent are one answer on
      // purpose: any other shape tells a caller which ids exist.
      throw new NotFoundException(`Execution ${executionId} not found`);
    }

    if (TERMINAL_STATUSES.has(execution.status)) {
      throw new ConflictException(`Execution ${executionId} is already ${execution.status}`);
    }

    const entry = this.inFlight.get(executionId);
    // The org check has already passed against the row; the entry check is
    // defence in depth against a stale registry key.
    if (entry && entry.organizationId === organizationId) {
      entry.cancelled = true;
      entry.controller.abort();
    }

    execution.status = AgentExecutionStatus.CANCELLED;
    execution.error = 'Execution cancelled';
    await this.executionRepository.save(execution);

    this.logger.log(
      `Execution ${executionId} cancelled (in-process=${entry ? 'yes' : 'no'}, org=${organizationId})`,
    );

    return execution;
  }
}
