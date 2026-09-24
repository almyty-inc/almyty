import { Repository } from 'typeorm';
import { Request, Response } from 'express';

import { Gateway } from '../../entities/gateway.entity';
import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { Message } from '../../entities/message.entity';

import { AgentRuntimeService } from '../agents/agent-runtime.service';
import { MetricsRecorderService } from '../../common/metrics/metrics-recorder.service';
import { MetricType } from '../../entities/usage-metric.entity';
import { agentRunToTask } from './a2a-task.mapper';
import { a2aPartsToAgentInput } from './a2a-part.mapper';
import type {
  Task,
  JsonRpcResponse,
  StreamResponse,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from './types/a2a-spec.types';
import { A2A_ERROR_CODES, TERMINAL_TASK_STATES } from './types/a2a-spec.types';

/**
 * SSE keep-alive cadence, matching the MCP Streamable HTTP transport. Well
 * under a typical nginx/LB idle timeout, so a long agent run does not get its
 * stream reaped mid-task with the client never seeing a terminal event.
 */
const KEEPALIVE_INTERVAL_MS = 15_000;

export class A2AMessageHandler {
  constructor(
    private readonly agentRuntimeService: AgentRuntimeService,
    private readonly runRepository: Repository<AgentRun>,
    private readonly messageRepository: Repository<Message>,
    private readonly helpers: {
      pollForCompletion: (runId: string, organizationId: string) => Promise<Task>;
      getRunMessages: (run: AgentRun) => Promise<Message[]>;
      findActiveRunByConversationId: (conversationId: string, organizationId: string) => Promise<AgentRun | null>;
      writeStreamResponse: (res: Response, rpcId: string | number, payload: StreamResponse) => void;
      jsonRpcError: (id: string | number | null, code: number, message: string, data?: any) => JsonRpcResponse;
    },
    private readonly metrics?: MetricsRecorderService,
  ) {}

  /**
   * Whether the client asked us to hold the response until the task settles.
   *
   * The flag changed name AND polarity between versions:
   *   - v0.2.x / v0.3.x: `configuration.blocking` — true means wait.
   *   - v1.0: `configuration.returnImmediately` — true means DON'T wait, and
   *     the proto default of false means the server MUST wait until the task
   *     reaches a terminal or interrupted state.
   *
   * We emit v1.0, so we honour v1.0's default: no configuration, or a
   * configuration that states neither flag, means wait. A v1.0 client that
   * sends nothing expects a settled Task, and handing it a SUBMITTED one is
   * a conformance failure the client cannot detect — it reads an unfinished
   * task as the answer.
   *
   * A v0.x client is unaffected in practice: `blocking` is the only flag it
   * knows, and stating it either way still decides. The one behaviour that
   * changes is a v0.x client that sends no configuration at all and relied
   * on `blocking` defaulting to false; such a client now waits up to
   * SEND_POLL_TIMEOUT_MS, and gets a settled task rather than one it would
   * have had to poll for.
   */
  private shouldBlock(params: any): boolean {
    const config = params?.configuration;
    if (!config) return true;
    if (config.returnImmediately === false) return true;
    if (config.returnImmediately === true) return false;
    if (config.blocking === true) return true;
    if (config.blocking === false) return false;
    return true;
  }

  /** A new agent run started via A2A is one workflow execution. */
  private recordWorkflow(gateway: Gateway): void {
    this.metrics?.record(MetricType.A2A_WORKFLOW, {
      organizationId: gateway.organizationId,
      dimensions: { agentId: gateway.agentId },
    });
  }

  /**
   * Start or continue an agent run and wait for completion (with timeout).
   *
   * NOTE: Only autonomous agents are supported via A2A right now because
   * AgentRuntimeService.startRun rejects non-autonomous agents (line 145).
   * Workflow agents should use the invoke/stream endpoints instead.
   */
  async handleMessageSend(
    gateway: Gateway,
    params: any,
    _rpcId: string | number,
  ): Promise<Task> {
    if (!params?.message?.parts || !Array.isArray(params.message.parts)) {
      throw Object.assign(new Error('Invalid params: message.parts must be an array'), {
        code: A2A_ERROR_CODES.INVALID_PARAMS,
      });
    }

    const { text } = a2aPartsToAgentInput(params.message.parts);

    // If message.taskId is provided, continue that specific task
    if (params.message?.taskId) {
      const taskId = params.message.taskId;
      const existingRun = await this.runRepository.findOne({
        where: { id: taskId, organizationId: gateway.organizationId },
      });
      if (!existingRun) {
        throw Object.assign(new Error('Task not found'), {
          code: A2A_ERROR_CODES.TASK_NOT_FOUND,
        });
      }
      // Start a new run in the same conversation, returning the original task ID
      const newRun = await this.agentRuntimeService.startRun(
        gateway.agentId,
        gateway.organizationId,
        null,
        text,
        existingRun.conversationId ? { conversationId: existingRun.conversationId } : undefined,
      );
      this.recordWorkflow(gateway);
      // Return task with the ORIGINAL task ID (the one the client sent)
      const messages = await this.helpers.getRunMessages(newRun);
      const task = agentRunToTask(newRun, messages);
      task.id = taskId; // preserve the task ID the client expects
      return task;
    }

    // If contextId is provided, look for an existing conversation/run
    if (params.contextId) {
      const existingRun = await this.helpers.findActiveRunByConversationId(
        params.contextId,
        gateway.organizationId,
      );

      if (existingRun) {
        if (existingRun.status === AgentRunStatus.WAITING_INPUT) {
          await this.agentRuntimeService.sendInput(
            existingRun.id,
            gateway.organizationId,
            text,
          );
          if (this.shouldBlock(params)) {
            return this.helpers.pollForCompletion(existingRun.id, gateway.organizationId);
          }
          const refreshed = await this.agentRuntimeService.getRun(existingRun.id, gateway.organizationId);
          const msgs = await this.helpers.getRunMessages(refreshed);
          return agentRunToTask(refreshed, msgs);
        }

        // Run exists but is still processing -- return current state
        if (!existingRun.isDone()) {
          const msgs = await this.helpers.getRunMessages(existingRun);
          return agentRunToTask(existingRun, msgs);
        }
      }
    }

    // Start a new run -- return immediately, client polls via GetTask
    const run = await this.agentRuntimeService.startRun(
      gateway.agentId,
      gateway.organizationId,
      null, // no user context in A2A calls
      text,
    );
    this.recordWorkflow(gateway);

    // If the A2A message carries a contextId, store it so we can round-trip
    // it in ListTasks / GetTask responses and filter by it later.
    const externalContextId = params.message?.contextId;
    if (externalContextId) {
      await this.runRepository.update(run.id, {
        metadata: { ...run.metadata, a2aContextId: externalContextId },
      });
      run.metadata = { ...run.metadata, a2aContextId: externalContextId };
    }

    // Hold the response only when the client asked for it (see shouldBlock).
    if (this.shouldBlock(params)) {
      return this.helpers.pollForCompletion(run.id, gateway.organizationId);
    }

    // Return task in initial state -- client uses GetTask to poll
    const messages = await this.helpers.getRunMessages(run);
    return agentRunToTask(run, messages);
  }

  async handleMessageStream(
    gateway: Gateway,
    params: any,
    rpcId: string | number,
    req: Request,
    res: Response,
  ): Promise<void> {
    if (!params?.message?.parts) {
      const error = this.helpers.jsonRpcError(rpcId, A2A_ERROR_CODES.INVALID_PARAMS, 'Missing message.parts in params');
      res.json(error);
      return;
    }

    const { text } = a2aPartsToAgentInput(params.message.parts);

    this.openSseStream(res);

    let run: AgentRun;

    // Resume or start a new run
    if (params.contextId) {
      const existingRun = await this.helpers.findActiveRunByConversationId(
        params.contextId,
        gateway.organizationId,
      );
      if (existingRun && existingRun.status === AgentRunStatus.WAITING_INPUT) {
        await this.agentRuntimeService.sendInput(
          existingRun.id,
          gateway.organizationId,
          text,
        );
        run = existingRun;
      } else {
        run = await this.agentRuntimeService.startRun(
          gateway.agentId,
          gateway.organizationId,
          null,
          text,
        );
        this.recordWorkflow(gateway);
      }
    } else {
      run = await this.agentRuntimeService.startRun(
        gateway.agentId,
        gateway.organizationId,
        null,
        text,
      );
      this.recordWorkflow(gateway);
    }

    await this.pipeRunToStream(run.id, rpcId, req, res);
  }

  /**
   * `SubscribeToTask` (v1.0) / `tasks/resubscribe` (v0.2.x, v0.3.x): reattach
   * an SSE stream to a task that is already running, for a client whose
   * original stream dropped. Without this a lost stream is unrecoverable while
   * the agent card advertises `capabilities.streaming`.
   */
  async handleTaskSubscribe(
    gateway: Gateway,
    params: any,
    rpcId: string | number,
    req: Request,
    res: Response,
  ): Promise<void> {
    if (!params?.id) {
      throw Object.assign(new Error('Missing task id'), {
        code: A2A_ERROR_CODES.INVALID_PARAMS,
      });
    }

    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRe.test(params.id)) {
      throw Object.assign(new Error('Task not found'), {
        code: A2A_ERROR_CODES.TASK_NOT_FOUND,
      });
    }

    const run = await this.runRepository.findOne({
      where: { id: params.id, organizationId: gateway.organizationId },
    });
    if (!run) {
      throw Object.assign(new Error('Task not found'), {
        code: A2A_ERROR_CODES.TASK_NOT_FOUND,
      });
    }

    const messages = await this.helpers.getRunMessages(run);
    const task = agentRunToTask(run, messages);

    // Spec: subscribing to a task in a terminal state is an unsupported
    // operation -- there will never be another event to deliver.
    if (TERMINAL_TASK_STATES.includes(task.status.state)) {
      throw Object.assign(new Error('Task is in a terminal state and cannot be subscribed to'), {
        code: A2A_ERROR_CODES.UNSUPPORTED_OPERATION,
      });
    }

    this.openSseStream(res);

    // Replay the task's current state first so a reattaching client is not
    // left guessing about everything it missed while disconnected.
    this.helpers.writeStreamResponse(res, rpcId, { task });

    await this.pipeRunToStream(run.id, rpcId, req, res);
  }

  // --- SSE plumbing ------------------------------------------------------

  /**
   * SSE response headers.
   *
   * `no-transform` keeps the compression() middleware from gzip-buffering the
   * stream, and `X-Accel-Buffering: no` keeps nginx from holding events; both
   * are what the MCP Streamable HTTP transport uses and both are load-bearing
   * behind the ingress.
   */
  private openSseStream(res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
  }

  /**
   * Attach to a run's event emitter and translate its events into A2A
   * StreamResponse frames until the run finishes or the client hangs up.
   */
  private async pipeRunToStream(
    runId: string,
    rpcId: string | number,
    req: Request,
    res: Response,
  ): Promise<void> {
    const emitFinalSnapshot = async (): Promise<void> => {
      const finalRun = await this.runRepository.findOne({ where: { id: runId } });
      if (!finalRun) return;
      const messages = await this.helpers.getRunMessages(finalRun);
      const task = agentRunToTask(finalRun, messages);
      this.writeStatusUpdate(res, rpcId, task);
      this.writeArtifactUpdates(res, rpcId, task);
    };

    const emitter = this.agentRuntimeService.getRunEmitter(runId);
    if (!emitter) {
      // No emitter means the run already completed synchronously
      await emitFinalSnapshot();
      res.end();
      return;
    }

    // Keep-alive comment frames. SSE comments are ignored by every conforming
    // client but keep the connection from going idle at the proxy.
    const keepAlive = setInterval(() => {
      if (res.destroyed) return;
      try {
        res.write(': keep-alive\n\n');
      } catch {
        /* client gone; the close handler cleans up */
      }
    }, KEEPALIVE_INTERVAL_MS);
    keepAlive.unref?.();

    const onEvent = async (event: { type: string; data: any; timestamp: string }) => {
      const updatedRun = await this.runRepository.findOne({ where: { id: runId } });
      if (!updatedRun) return;

      const messages = await this.helpers.getRunMessages(updatedRun);
      const task = agentRunToTask(updatedRun, messages);
      const isFinal = ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type);

      this.writeStatusUpdate(res, rpcId, task);

      // If the run completed with an artifact, send it as well
      if (isFinal) {
        this.writeArtifactUpdates(res, rpcId, task);
      }
    };

    const onDone = () => {
      clearInterval(keepAlive);
      emitter.removeListener('event', onEvent);
      res.end();
    };

    emitter.on('event', onEvent);
    emitter.once('done', onDone);

    // Clean up if client disconnects
    req.on('close', () => {
      clearInterval(keepAlive);
      emitter.removeListener('event', onEvent);
      emitter.removeListener('done', onDone);
    });
  }

  private writeStatusUpdate(res: Response, rpcId: string | number, task: Task): void {
    const statusUpdate: TaskStatusUpdateEvent = {
      taskId: task.id,
      contextId: task.contextId ?? task.id,
      status: task.status,
    };
    this.helpers.writeStreamResponse(res, rpcId, { statusUpdate });
  }

  private writeArtifactUpdates(res: Response, rpcId: string | number, task: Task): void {
    if (!task.artifacts?.length) return;
    for (const artifact of task.artifacts) {
      const artifactUpdate: TaskArtifactUpdateEvent = {
        taskId: task.id,
        contextId: task.contextId ?? task.id,
        artifact,
        lastChunk: true,
      };
      this.helpers.writeStreamResponse(res, rpcId, { artifactUpdate });
    }
  }
}
