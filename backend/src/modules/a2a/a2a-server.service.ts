import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Request, Response } from 'express';

import { Gateway } from '../../entities/gateway.entity';
import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { Conversation } from '../../entities/conversation.entity';
import { Message } from '../../entities/message.entity';

import { AgentRuntimeService } from '../agents/agent-runtime.service';
import { A2AAgentCardService } from './a2a-agent-card.service';
import { agentRunToTask } from './a2a-task.mapper';
import { a2aPartsToAgentInput } from './a2a-part.mapper';
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  Task,
} from './types/a2a-spec.types';
import { A2A_ERROR_CODES } from './types/a2a-spec.types';

/** Default poll timeout for message/send (ms). */
const SEND_POLL_TIMEOUT_MS = 30_000;
const SEND_POLL_INTERVAL_MS = 500;

@Injectable()
export class A2AServerService {
  private readonly logger = new Logger(A2AServerService.name);

  constructor(
    private readonly agentRuntimeService: AgentRuntimeService,
    private readonly agentCardService: A2AAgentCardService,
    @InjectRepository(AgentRun)
    private readonly runRepository: Repository<AgentRun>,
    @InjectRepository(Conversation)
    private readonly conversationRepository: Repository<Conversation>,
    @InjectRepository(Message)
    private readonly messageRepository: Repository<Message>,
  ) {}

  // ─── Main JSON-RPC dispatcher ──────────────────────────────────────

  async handleJsonRpc(
    gateway: Gateway,
    req: Request,
    body: any,
    res: Response,
  ): Promise<void> {
    // Malformed / empty body
    if (!body || typeof body !== 'object') {
      res.json(this.jsonRpcError(null, A2A_ERROR_CODES.PARSE_ERROR, 'Parse error: invalid JSON'));
      return;
    }

    // Missing or wrong jsonrpc version
    if (body.jsonrpc !== '2.0') {
      res.json(this.jsonRpcError(body.id ?? null, A2A_ERROR_CODES.INVALID_REQUEST, 'Invalid Request: jsonrpc must be "2.0"'));
      return;
    }

    // Missing method
    if (!body.method || typeof body.method !== 'string') {
      res.json(this.jsonRpcError(body.id ?? null, A2A_ERROR_CODES.INVALID_REQUEST, 'Invalid Request: method is required'));
      return;
    }

    // Missing or invalid id (notifications not supported, id must be string or number)
    if (body.id == null) {
      res.json(this.jsonRpcError(null, A2A_ERROR_CODES.INVALID_REQUEST, 'Invalid Request: id is required'));
      return;
    }
    if (typeof body.id !== 'string' && typeof body.id !== 'number') {
      res.json(this.jsonRpcError(null, A2A_ERROR_CODES.INVALID_REQUEST, 'Invalid Request: id must be a string or number'));
      return;
    }

    // Invalid params type
    if (body.params !== undefined && typeof body.params !== 'object') {
      res.json(this.jsonRpcError(body.id, A2A_ERROR_CODES.INVALID_PARAMS, 'Invalid params: must be an object'));
      return;
    }

    const rpcReq = body as JsonRpcRequest;

    try {
      // Normalize method names: support both v0.2.x (message/send) and v1.0 (SendMessage)
      const method = rpcReq.method;

      switch (method) {
        case 'message/send':
        case 'SendMessage': {
          const task = await this.handleMessageSend(gateway, rpcReq.params, rpcReq.id);
          // v1.0 (PascalCase) wraps in { task }, v0.2.x returns task directly
          const result = method === 'SendMessage' ? { task } : task;
          res.json(this.jsonRpcSuccess(rpcReq.id, result));
          return;
        }

        case 'message/stream':
        case 'StreamMessage': {
          await this.handleMessageStream(gateway, rpcReq.params, rpcReq.id, req, res);
          return;
        }

        case 'tasks/get':
        case 'GetTask': {
          const task = await this.handleTasksGet(gateway, rpcReq.params, rpcReq.id);
          res.json(this.jsonRpcSuccess(rpcReq.id, task));
          return;
        }

        case 'tasks/cancel':
        case 'CancelTask': {
          const task = await this.handleTasksCancel(gateway, rpcReq.params, rpcReq.id);
          res.json(this.jsonRpcSuccess(rpcReq.id, task));
          return;
        }

        case 'tasks/list':
        case 'ListTasks': {
          const result = await this.handleTasksList(gateway, rpcReq.params, rpcReq.id);
          res.json(this.jsonRpcSuccess(rpcReq.id, result));
          return;
        }

        // Push notification methods — not supported, return proper A2A error
        case 'tasks/pushNotification/set':
        case 'tasks/pushNotification/get':
        case 'tasks/pushNotification/list':
        case 'tasks/pushNotification/delete':
        case 'SetTaskPushNotificationConfig':
        case 'GetTaskPushNotificationConfig':
        case 'ListTaskPushNotificationConfigs':
        case 'DeleteTaskPushNotificationConfig':
          res.json(
            this.jsonRpcError(rpcReq.id, A2A_ERROR_CODES.PUSH_NOTIFICATIONS_NOT_SUPPORTED,
              'Push notifications are not supported. Use message/stream for real-time updates.'),
          );
          return;

        default:
          res.json(
            this.jsonRpcError(rpcReq.id, A2A_ERROR_CODES.METHOD_NOT_FOUND, `Unknown method: ${rpcReq.method}`),
          );
          return;
      }
    } catch (error: any) {
      const errorCode = error.code && typeof error.code === 'number'
        ? error.code
        : A2A_ERROR_CODES.INTERNAL_ERROR;
      this.logger.error(`A2A JSON-RPC error [${rpcReq.method}] (${errorCode}): ${error.message}`, error.stack);
      res.json(
        this.jsonRpcError(rpcReq.id, errorCode, error.message),
      );
    }
  }

  // ─── message/send ──────────────────────────────────────────────────

  /**
   * Start or continue an agent run and wait for completion (with timeout).
   *
   * NOTE: Only autonomous agents are supported via A2A right now because
   * AgentRuntimeService.startRun rejects non-autonomous agents (line 145).
   * Workflow agents should use the invoke/stream endpoints instead.
   */
  private async handleMessageSend(
    gateway: Gateway,
    params: any,
    rpcId: string | number,
  ): Promise<Task> {
    if (!params?.message?.parts || !Array.isArray(params.message.parts)) {
      throw Object.assign(new Error('Invalid params: message.parts must be an array'), {
        code: A2A_ERROR_CODES.INVALID_PARAMS,
      });
    }

    const { text } = a2aPartsToAgentInput(params.message.parts);

    // If contextId is provided, look for an existing conversation/run
    if (params.contextId) {
      const existingRun = await this.findActiveRunByConversationId(
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
          if (params.configuration?.blocking) {
            return this.pollForCompletion(existingRun.id, gateway.organizationId);
          }
          const refreshed = await this.agentRuntimeService.getRun(existingRun.id, gateway.organizationId);
          const msgs = await this.getRunMessages(refreshed);
          return agentRunToTask(refreshed, msgs);
        }

        // Run exists but is still processing — return current state
        if (!existingRun.isDone()) {
          const msgs = await this.getRunMessages(existingRun);
          return agentRunToTask(existingRun, msgs);
        }
      }
    }

    // Start a new run — return immediately, client polls via GetTask
    const run = await this.agentRuntimeService.startRun(
      gateway.agentId,
      gateway.organizationId,
      null, // no user context in A2A calls
      text,
    );

    // If configuration.blocking is true, wait for completion (v0.2 behavior)
    if (params.configuration?.blocking) {
      return this.pollForCompletion(run.id, gateway.organizationId);
    }

    // Return task in initial state — client uses GetTask to poll
    const messages = await this.getRunMessages(run);
    return agentRunToTask(run, messages);
  }

  // ─── message/stream ────────────────────────────────────────────────

  private async handleMessageStream(
    gateway: Gateway,
    params: any,
    rpcId: string | number,
    req: Request,
    res: Response,
  ): Promise<void> {
    if (!params?.message?.parts) {
      const error = this.jsonRpcError(rpcId, A2A_ERROR_CODES.INVALID_PARAMS, 'Missing message.parts in params');
      res.json(error);
      return;
    }

    const { text } = a2aPartsToAgentInput(params.message.parts);

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let run: AgentRun;

    // Resume or start a new run
    if (params.contextId) {
      const existingRun = await this.findActiveRunByConversationId(
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
      }
    } else {
      run = await this.agentRuntimeService.startRun(
        gateway.agentId,
        gateway.organizationId,
        null,
        text,
      );
    }

    // Stream events from the run emitter
    const emitter = this.agentRuntimeService.getRunEmitter(run.id);
    if (!emitter) {
      // No emitter means the run already completed synchronously
      const finalRun = await this.runRepository.findOne({ where: { id: run.id } });
      if (finalRun) {
        const messages = await this.getRunMessages(finalRun);
        const task = agentRunToTask(finalRun, messages);
        this.writeSseEvent(res, 'status', {
          type: 'status',
          taskId: task.id,
          contextId: task.contextId,
          status: task.status,
          final: true,
        });
      }
      res.end();
      return;
    }

    const onEvent = async (event: { type: string; data: any; timestamp: string }) => {
      const updatedRun = await this.runRepository.findOne({ where: { id: run.id } });
      if (!updatedRun) return;

      const messages = await this.getRunMessages(updatedRun);
      const task = agentRunToTask(updatedRun, messages);
      const isFinal = ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type);

      this.writeSseEvent(res, 'status', {
        type: 'status',
        taskId: task.id,
        contextId: task.contextId,
        status: task.status,
        final: isFinal,
      });

      // If the run completed with an artifact, send it as well
      if (isFinal && task.artifacts?.length) {
        for (const artifact of task.artifacts) {
          this.writeSseEvent(res, 'artifact', {
            type: 'artifact',
            taskId: task.id,
            contextId: task.contextId,
            artifact,
          });
        }
      }
    };

    const onDone = () => {
      emitter.removeListener('event', onEvent);
      res.end();
    };

    emitter.on('event', onEvent);
    emitter.once('done', onDone);

    // Clean up if client disconnects
    req.on('close', () => {
      emitter.removeListener('event', onEvent);
      emitter.removeListener('done', onDone);
    });
  }

  // ─── tasks/get ─────────────────────────────────────────────────────

  private async handleTasksGet(
    gateway: Gateway,
    params: any,
    _rpcId: string | number,
  ): Promise<Task> {
    if (!params?.id) {
      throw Object.assign(new Error('Missing task id'), {
        code: A2A_ERROR_CODES.INVALID_PARAMS,
      });
    }

    // Validate UUID format to prevent Postgres errors
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

    const messages = await this.getRunMessages(run);
    return agentRunToTask(run, messages);
  }

  // ─── tasks/cancel ──────────────────────────────────────────────────

  private async handleTasksCancel(
    gateway: Gateway,
    params: any,
    _rpcId: string | number,
  ): Promise<Task> {
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

    const existing = await this.runRepository.findOne({
      where: { id: params.id, organizationId: gateway.organizationId },
    });
    if (!existing) {
      throw Object.assign(new Error('Task not found'), {
        code: A2A_ERROR_CODES.TASK_NOT_FOUND,
      });
    }

    try {
      const run = await this.agentRuntimeService.cancelRun(
        params.id,
        gateway.organizationId,
      );
      const messages = await this.getRunMessages(run);
      return agentRunToTask(run, messages);
    } catch (error: any) {
      if (error.message?.includes('already completed') || error.message?.includes('not cancelable')) {
        throw Object.assign(new Error('Task is not cancelable'), {
          code: A2A_ERROR_CODES.TASK_NOT_CANCELABLE,
        });
      }
      throw error;
    }
  }

  // ─── tasks/list ────────────────────────────────────────────────────

  /**
   * List tasks (agent runs) with optional filtering and pagination.
   *
   * A2A v0.3.0 §7.4: tasks/list
   *
   * Params:
   *   - contextId?: string — filter by conversation
   *   - status?: string — filter by task state
   *   - pageSize?: number — max results (default 50, max 100)
   *   - pageToken?: string — opaque cursor for next page (run ID)
   *   - lastUpdatedAfter?: string — ISO8601 timestamp filter
   */
  private async handleTasksList(
    gateway: Gateway,
    params: any,
    _rpcId: string | number,
  ): Promise<{ tasks: Task[]; nextPageToken?: string; totalSize?: number; pageSize?: number }> {
    const agentId = gateway.agentId;
    const orgId = gateway.organizationId;

    if (!agentId) {
      throw Object.assign(new Error('Gateway has no agent'), {
        code: A2A_ERROR_CODES.INTERNAL_ERROR,
      });
    }

    // Validate pagination params
    if (params?.pageSize !== undefined) {
      if (typeof params.pageSize !== 'number' || params.pageSize < 0) {
        throw Object.assign(new Error('Invalid pageSize: must be a non-negative integer'), {
          code: A2A_ERROR_CODES.INVALID_PARAMS,
        });
      }
      if (params.pageSize === 0) {
        throw Object.assign(new Error('Invalid pageSize: must be greater than 0'), {
          code: A2A_ERROR_CODES.INVALID_PARAMS,
        });
      }
      if (params.pageSize > 100) {
        throw Object.assign(new Error('Invalid pageSize: maximum is 100'), {
          code: A2A_ERROR_CODES.INVALID_PARAMS,
        });
      }
    }

    if (params?.historyLength !== undefined && typeof params.historyLength === 'number' && params.historyLength < 0) {
      throw Object.assign(new Error('Invalid historyLength: must be non-negative'), {
        code: A2A_ERROR_CODES.INVALID_PARAMS,
      });
    }

    const pageSize = params?.pageSize ?? 50;
    const pageToken = params?.pageToken;

    // Build query
    const qb = this.runRepository.createQueryBuilder('run')
      .where('run.agentId = :agentId', { agentId })
      .andWhere('run.organizationId = :orgId', { orgId })
      .orderBy('run.createdAt', 'DESC')
      .take(pageSize + 1); // +1 to detect next page

    // Filter by contextId (conversationId) — must be valid UUID or skip
    if (params?.contextId) {
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRe.test(params.contextId)) {
        // Non-UUID contextId — no matches, return empty
        return { tasks: [], totalSize: 0, pageSize };
      }
      qb.andWhere('run.conversationId = :convId', { convId: params.contextId });
    }

    // Filter by status
    if (params?.status) {
      const statusMap: Record<string, string> = {
        // v1.0 TASK_STATE_* names
        TASK_STATE_SUBMITTED: 'pending',
        TASK_STATE_WORKING: 'running',
        TASK_STATE_INPUT_REQUIRED: 'waiting_input',
        TASK_STATE_COMPLETED: 'completed',
        TASK_STATE_FAILED: 'failed',
        TASK_STATE_CANCELED: 'cancelled',
        // v0.2 lowercase names (backwards compat)
        submitted: 'pending',
        working: 'running',
        'input-required': 'waiting_input',
        completed: 'completed',
        failed: 'failed',
        canceled: 'cancelled',
      };
      const dbStatus = statusMap[params.status];
      if (dbStatus) {
        qb.andWhere('run.status = :status', { status: dbStatus });
      } else {
        throw Object.assign(new Error(`Invalid status filter: ${params.status}`), {
          code: A2A_ERROR_CODES.INVALID_PARAMS,
        });
      }
    }

    // Filter by timestamp (accept both v0.2 lastUpdatedAfter and v1.0 statusTimestampAfter)
    const timestampFilter = params?.statusTimestampAfter || params?.lastUpdatedAfter;
    if (timestampFilter) {
      const ts = new Date(timestampFilter);
      if (isNaN(ts.getTime())) {
        throw Object.assign(new Error('Invalid timestamp format'), {
          code: A2A_ERROR_CODES.INVALID_PARAMS,
        });
      }
      qb.andWhere('run.updatedAt > :after', { after: ts });
    }

    // Cursor pagination — validate UUID format
    if (pageToken) {
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRe.test(pageToken)) {
        throw Object.assign(new Error('Invalid pageToken'), {
          code: A2A_ERROR_CODES.INVALID_PARAMS,
        });
      }
      qb.andWhere('run.id < :cursor', { cursor: pageToken });
    }

    const runs = await qb.getMany();

    // Check for next page
    const hasMore = runs.length > pageSize;
    const pageRuns = hasMore ? runs.slice(0, pageSize) : runs;

    // Map to A2A Tasks (with optional history length limiting)
    const historyLength = params?.historyLength;
    const tasks: Task[] = [];
    for (const run of pageRuns) {
      const messages = await this.getRunMessages(run);
      const task = agentRunToTask(run, messages);
      // Limit history if requested
      if (historyLength !== undefined && typeof historyLength === 'number' && task.history) {
        task.history = historyLength === 0 ? [] : task.history.slice(-historyLength);
      }
      tasks.push(task);
    }

    // Get total count
    const totalQb = this.runRepository.createQueryBuilder('run')
      .where('run.agentId = :agentId', { agentId })
      .andWhere('run.organizationId = :orgId', { orgId });
    const totalSize = await totalQb.getCount();

    return {
      tasks,
      ...(hasMore ? { nextPageToken: pageRuns[pageRuns.length - 1].id } : {}),
      totalSize,
      pageSize,
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  /**
   * Poll the run until it reaches a terminal state or timeout.
   */
  private async pollForCompletion(
    runId: string,
    organizationId: string,
  ): Promise<Task> {
    const maxAttempts = Math.ceil(SEND_POLL_TIMEOUT_MS / SEND_POLL_INTERVAL_MS);

    for (let i = 0; i < maxAttempts; i++) {
      const run = await this.runRepository.findOne({
        where: { id: runId, organizationId },
      });
      if (!run) {
        throw Object.assign(new Error('Task not found'), {
          code: A2A_ERROR_CODES.TASK_NOT_FOUND,
        });
      }

      if (run.isDone() || run.status === AgentRunStatus.WAITING_INPUT) {
        const messages = await this.getRunMessages(run);
        return agentRunToTask(run, messages);
      }

      await this.sleep(SEND_POLL_INTERVAL_MS);
    }

    // Timeout: return current state without waiting further
    const run = await this.runRepository.findOne({
      where: { id: runId, organizationId },
    });
    const messages = run ? await this.getRunMessages(run) : [];
    return agentRunToTask(run, messages);
  }

  private async findActiveRunByConversationId(
    conversationId: string,
    organizationId: string,
  ): Promise<AgentRun | null> {
    return this.runRepository.findOne({
      where: { conversationId, organizationId },
      order: { createdAt: 'DESC' },
    });
  }

  private async getRunMessages(run: AgentRun): Promise<Message[]> {
    if (!run.conversationId) return [];
    return this.messageRepository.find({
      where: { conversationId: run.conversationId },
      order: { createdAt: 'ASC' },
    });
  }

  private writeSseEvent(res: Response, eventName: string, data: any): void {
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private jsonRpcSuccess(id: string | number, result: any): JsonRpcResponse {
    return { jsonrpc: '2.0', result, id };
  }

  private jsonRpcError(
    id: string | number | null,
    code: number,
    message: string,
    data?: any,
  ): JsonRpcResponse {
    return { jsonrpc: '2.0', error: { code, message, data }, id };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
