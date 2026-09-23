import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectRedis } from '@nestjs-modules/ioredis';
import { Repository } from 'typeorm';
import type Redis from 'ioredis';

import {
  AgentExecution,
  AgentExecutionStatus,
  TERMINAL_EXECUTION_STATUSES,
} from '../../entities/agent-execution.entity';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';
import { AuditLogService } from '../audit-log/audit-log.service';

/**
 * Statuses a workflow execution never leaves. Cancelling one of these is a
 * 409, not a crash and not a silent success: the caller asked to stop
 * something that had already stopped, and saying so is the only honest
 * answer.
 */
const TERMINAL_STATUSES: ReadonlySet<AgentExecutionStatus> = new Set(TERMINAL_EXECUTION_STATUSES);

/**
 * The Redis pub/sub channel every API replica listens on for cancels.
 *
 * Exported so a test can assert the wire, and so the channel name lives in
 * exactly one place.
 */
export const EXECUTION_CANCEL_CHANNEL = 'almyty:agent-execution:cancel';

/**
 * How long boot will wait for the subscription to be confirmed before
 * carrying on without it. See onModuleInit for why this is not an
 * unbounded await.
 */
const DEFAULT_SUBSCRIBE_CONFIRM_MS = 5_000;
/** Read per call, not at import, so a test can shorten it. */
const subscribeConfirmMs = () =>
  Number(process.env.EXECUTION_CANCEL_SUBSCRIBE_MS) || DEFAULT_SUBSCRIBE_CONFIRM_MS;

/** What travels on {@link EXECUTION_CANCEL_CHANNEL}. */
interface CancelSignal {
  executionId: string;
  organizationId: string;
}

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
 * Scope: every replica, via Redis pub/sub.
 *
 * The registry is a per-process `Map`, and the API runs `replicas: 2` with
 * no separate worker, so roughly half of all cancels landed on the replica
 * that was NOT running the execution: the row was written CANCELLED and the
 * caller got its 200, while the replica actually holding the run never heard
 * and carried on spending. `cancel()` therefore also publishes the id on
 * {@link EXECUTION_CANCEL_CHANNEL}; every replica subscribes, and whichever
 * one holds the run aborts it locally through this same registry.
 *
 * Redis is not a new dependency (BullMQ and the throttler already require
 * it) and it is not a hard one here either: with no Redis, or with a Redis
 * that goes away, publish and subscribe are skipped with a warning and the
 * service behaves exactly as it did before -- the row is still written
 * CANCELLED, a same-replica cancel still aborts. The guarded terminal writes
 * in the engine are what make that degraded mode safe, because a late
 * replica can no longer overwrite CANCELLED with COMPLETED.
 */
@Injectable()
export class AgentExecutionCancellationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentExecutionCancellationService.name);
  private readonly inFlight = new Map<string, InFlightExecution>();
  /**
   * A subscribed Redis connection cannot issue ordinary commands, so the
   * listener gets its own duplicate of the injected client. Undefined when
   * Redis is absent or refused the subscription.
   */
  private subscriber?: Redis;

  constructor(
    @InjectRepository(AgentExecution)
    private readonly executionRepository: Repository<AgentExecution>,
    // Everything below is appended last and @Optional(), because the spec
    // harnesses for this service and for the engine construct it
    // positionally: a parameter inserted above would silently shift the
    // ones after it, which is exactly how this engine was broken before.
    @Optional()
    @InjectRedis()
    private readonly redis?: Redis,
    @Optional()
    private readonly auditLog?: AuditLogService,
  ) {}

  /**
   * Subscribe to the cancel channel. Failures here are logged and dropped:
   * a replica that cannot subscribe still cancels its own executions, it
   * just cannot be reached by another replica's cancel.
   */
  async onModuleInit(): Promise<void> {
    if (!this.redis || typeof (this.redis as any).duplicate !== 'function') {
      this.logger.warn(
        'No Redis connection: cross-replica execution cancel is off, cancels only abort runs held by this process',
      );
      return;
    }

    try {
      const subscriber = (this.redis as any).duplicate() as Redis;
      // Without this a dropped connection surfaces as an unhandled 'error'
      // event, which takes the process down over a cancel channel.
      subscriber.on?.('error', (err: Error) => {
        this.logger.warn(`Execution cancel subscriber error: ${err.message}`);
      });
      subscriber.on?.('message', (channel: string, raw: string) => {
        if (channel !== EXECUTION_CANCEL_CHANNEL) return;
        this.applyRemoteCancel(raw);
      });
      // Held before the subscription is confirmed, so onModuleDestroy can
      // still close a connection that is mid-handshake.
      this.subscriber = subscriber;

      // Bounded, and this is the whole reason it is not a bare `await`.
      // ioredis queues commands while it is offline and retries connecting
      // for ever, so awaiting a subscribe against a Redis that is down
      // never returns -- and `onModuleInit` not returning means the
      // process never finishes booting. A cancel channel must not be able
      // to stop the API from starting. The message handler is attached
      // already, so a subscription that completes after this method
      // returns still works; what this refuses to do is wait for it.
      const confirmMs = subscribeConfirmMs();
      const confirmed = await Promise.race([
        subscriber.subscribe(EXECUTION_CANCEL_CHANNEL).then(
          () => true,
          (err: Error) => {
            this.logger.warn(`Could not subscribe to ${EXECUTION_CANCEL_CHANNEL}: ${err.message}`);
            return false;
          },
        ),
        new Promise<boolean>((resolve) => {
          setTimeout(() => resolve(false), confirmMs).unref?.();
        }),
      ]);

      if (confirmed) {
        this.logger.log(`Listening for cross-replica cancels on ${EXECUTION_CANCEL_CHANNEL}`);
      } else {
        this.logger.warn(
          `Subscription to ${EXECUTION_CANCEL_CHANNEL} not confirmed within ${confirmMs}ms; ` +
            'booting anyway, cross-replica cancel will start working if Redis comes back',
        );
      }
    } catch (err: any) {
      this.subscriber = undefined;
      this.logger.warn(
        `Could not subscribe to ${EXECUTION_CANCEL_CHANNEL} (${err?.message}); ` +
          'cross-replica execution cancel is off',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    const subscriber = this.subscriber;
    this.subscriber = undefined;
    if (!subscriber) return;
    try {
      // Not awaited: like every other command, these queue while the
      // client is offline, and shutdown must not hang behind a Redis that
      // is already gone. `disconnect` closes the socket then and there,
      // which is what we actually need.
      Promise.resolve(subscriber.unsubscribe?.(EXECUTION_CANCEL_CHANNEL)).catch(() => {});
      if (typeof (subscriber as any).disconnect === 'function') {
        (subscriber as any).disconnect();
      } else {
        Promise.resolve(subscriber.quit?.()).catch(() => {});
      }
    } catch {
      // Shutting down; a subscriber that will not close cleanly is not
      // worth failing the shutdown over.
    }
  }

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
   * Cancel a workflow execution: abort its signal wherever it is running,
   * and record CANCELLED either way.
   *
   * Org-scoped exactly like AgentRuntimeService.cancelRun -- an execution
   * belonging to another organization is reported as not found, so the
   * endpoint cannot be used to probe for ids. `agentId`, when given,
   * asserts the execution belongs to that agent (the gateway route names
   * one). `userId`, when given, is who gets named on the audit row.
   */
  async cancel(
    executionId: string,
    organizationId: string,
    agentId?: string,
    userId?: string,
  ): Promise<AgentExecution> {
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

    // Local first, so a cancel for a run this replica holds stops spending
    // before the row is even written.
    const abortedHere = this.abortLocally(executionId, organizationId);

    execution.status = AgentExecutionStatus.CANCELLED;
    execution.error = 'Execution cancelled';
    await this.executionRepository.save(execution);

    // Then the other replicas. After the write, so a replica that acts on
    // the signal and finishes its own terminal write races against a row
    // that is already CANCELLED -- which the engine's guarded writes
    // refuse to overwrite.
    this.publishCancel({ executionId, organizationId });

    // Cancelling stops work somebody is paying for and any org member can
    // do it, so it leaves a row. Fire-and-forget: AuditLogService.log
    // never throws, and a missing audit row must not fail the cancel.
    this.auditLog
      ?.log({
        organizationId,
        userId,
        action: AuditAction.RUN_CANCEL,
        resourceType: AuditResource.AGENT_RUN,
        resourceId: executionId,
        details: {
          kind: 'workflow_execution',
          agentId: execution.agentId,
          abortedOnThisReplica: abortedHere,
          totalCost: execution.totalCost,
          totalTokens: execution.totalTokens,
        },
      })
      .catch(() => {});

    this.logger.log(
      `Execution ${executionId} cancelled (in-process=${abortedHere ? 'yes' : 'no'}, org=${organizationId})`,
    );

    return execution;
  }

  /**
   * Abort the execution if this process is the one running it. Idempotent:
   * a second call (a duplicate pub/sub delivery, or the publishing replica
   * receiving its own message) re-aborts an already-aborted controller,
   * which is a no-op.
   *
   * Returns whether this replica held the run.
   */
  private abortLocally(executionId: string, organizationId: string): boolean {
    const entry = this.inFlight.get(executionId);
    // A cancel for a run this replica does not hold is the common case with
    // more than one replica, and is not an error -- the replica that does
    // hold it gets the same message.
    if (!entry) return false;
    // The org check has already passed against the row on the publishing
    // replica; this is defence in depth against a stale registry key.
    if (entry.organizationId !== organizationId) return false;
    entry.cancelled = true;
    entry.controller.abort();
    return true;
  }

  /** Fan the cancel out to the other replicas. Best effort by design. */
  private publishCancel(signal: CancelSignal): void {
    if (!this.redis || typeof (this.redis as any).publish !== 'function') return;
    try {
      const result = (this.redis as any).publish(EXECUTION_CANCEL_CHANNEL, JSON.stringify(signal));
      // ioredis returns a promise; a mock may return a plain value.
      if (result && typeof result.catch === 'function') {
        result.catch((err: Error) => {
          this.logger.warn(`Could not publish cancel for ${signal.executionId}: ${err.message}`);
        });
      }
    } catch (err: any) {
      this.logger.warn(`Could not publish cancel for ${signal.executionId}: ${err?.message}`);
    }
  }

  /**
   * A cancel published by another replica. Aborts locally and writes
   * nothing: the publishing replica already persisted CANCELLED, and a
   * second writer here would only re-race the row.
   *
   * Visible for tests.
   */
  applyRemoteCancel(raw: string): void {
    let signal: CancelSignal;
    try {
      signal = JSON.parse(raw);
    } catch {
      this.logger.warn('Ignoring unparseable cancel message');
      return;
    }
    if (!signal?.executionId || !signal?.organizationId) return;
    if (this.abortLocally(signal.executionId, signal.organizationId)) {
      this.logger.log(`Execution ${signal.executionId} aborted by a cancel from another replica`);
    }
  }
}
