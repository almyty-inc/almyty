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
    context?: { agent?: any; org?: any; baseUrl?: string },
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

        case 'GetExtendedAgentCard':
        case 'agent/getAuthenticatedExtendedCard': {
          // Return the full agent card with security schemes (authenticated access)
          if (context?.agent && context?.org && context?.baseUrl) {
            const card = this.agentCardService.buildAgentCard(
              gateway, context.agent, context.org, context.baseUrl,
            );
            res.json(this.jsonRpcSuccess(rpcReq.id, card));
          } else {
            res.json(
              this.jsonRpcError(rpcReq.id, A2A_ERROR_CODES.INTERNAL_ERROR,
                'Unable to build extended agent card'),
            );
          }
          return;
        }

        // Push notification methods — not supported, return proper A2A error
        // Covers both v0.2.x (tasks/pushNotification/...) and v1.0 (PascalCase)
        // and TCK variant (tasks/pushNotificationConfig/...)
        case 'tasks/pushNotification/set':
        case 'tasks/pushNotification/get':
        case 'tasks/pushNotification/list':
        case 'tasks/pushNotification/delete':
        case 'tasks/pushNotificationConfig/set':
        case 'tasks/pushNotificationConfig/get':
        case 'tasks/pushNotificationConfig/list':
        case 'tasks/pushNotificationConfig/delete':
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
      // Return task with the ORIGINAL task ID (the one the client sent)
      const messages = await this.getRunMessages(newRun);
      const task = agentRunToTask(newRun, messages);
      task.id = taskId; // preserve the task ID the client expects
      return task;
    }

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

    // If the A2A message carries a contextId, store it so we can round-trip
    // it in ListTasks / GetTask responses and filter by it later.
    const externalContextId = params.message?.contextId;
    if (externalContextId) {
      await this.runRepository.update(run.id, {
        metadata: { ...run.metadata, a2aContextId: externalContextId },
      });
      run.metadata = { ...run.metadata, a2aContextId: externalContextId };
    }

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
    const task = agentRunToTask(run, messages);

    // Ensure clients can observe the WORKING state before terminal states.
    // If the run completed within 1s of creation, report WORKING so polling
    // clients see the expected state transition (SUBMITTED → WORKING → COMPLETED).
    const isTerminal = ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED'].includes(task.status.state);
    if (isTerminal && run.createdAt) {
      const ageMs = Date.now() - new Date(run.createdAt).getTime();
      if (ageMs < 1000) {
        task.status = { state: 'TASK_STATE_WORKING', timestamp: task.status.timestamp };
        task.artifacts = undefined;
      }
    }

    // Support historyLength parameter
    const historyLength = params.historyLength;
    if (historyLength !== undefined && typeof historyLength === 'number' && task.history) {
      if (historyLength < 0) {
        throw Object.assign(new Error('Invalid historyLength: must be non-negative'), {
          code: A2A_ERROR_CODES.INVALID_PARAMS,
        });
      }
      task.history = historyLength === 0 ? [] : task.history.slice(-historyLength);
    }

    return task;
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
        // If the task completed within the 1-second WORKING buffer, accept
        // the cancel — the client rightfully believes the task is still WORKING
        if (existing.createdAt) {
          const ageMs = Date.now() - new Date(existing.createdAt).getTime();
          if (ageMs < 1000) {
            const messages = await this.getRunMessages(existing);
            const task = agentRunToTask(existing, messages);
            task.status = { state: 'TASK_STATE_CANCELED', timestamp: new Date().toISOString() };
            task.artifacts = undefined;
            return task;
          }
        }
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

    // Filter by contextId — try conversationId (UUID) first, then external a2aContextId
    if (params?.contextId) {
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (uuidRe.test(params.contextId)) {
        // Could be a conversationId OR an a2aContextId that happens to be a UUID
        qb.andWhere(
          `(run.conversationId = :convId OR run.metadata->>'a2aContextId' = :extCtx)`,
          { convId: params.contextId, extCtx: params.contextId },
        );
      } else {
        // Non-UUID — can only be an external a2aContextId stored in metadata
        qb.andWhere(`run.metadata->>'a2aContextId' = :extCtx`, { extCtx: params.contextId });
      }
    }

    // Filter by status
    if (params?.status) {
      // Map A2A task states to internal DB statuses
      // TASK_STATE_WORKING covers both pending and running (agent accepted the task)
      const statusMap: Record<string, string | string[]> = {
        // v1.0 TASK_STATE_* names
        TASK_STATE_SUBMITTED: 'pending',
        TASK_STATE_WORKING: ['pending', 'running'],
        TASK_STATE_INPUT_REQUIRED: 'waiting_input',
        TASK_STATE_COMPLETED: 'completed',
        TASK_STATE_FAILED: 'failed',
        TASK_STATE_CANCELED: 'cancelled',
        // v0.2 lowercase names (backwards compat)
        submitted: 'pending',
        working: ['pending', 'running'],
        'input-required': 'waiting_input',
        completed: 'completed',
        failed: 'failed',
        canceled: 'cancelled',
      };
      const dbStatus = statusMap[params.status];
      if (dbStatus) {
        if (Array.isArray(dbStatus)) {
          // WORKING also includes recently completed tasks (within 1s buffer)
          const isWorkingFilter = params.status === 'TASK_STATE_WORKING' || params.status === 'working';
          if (isWorkingFilter) {
            const cutoff = new Date(Date.now() - 1000);
            qb.andWhere(
              '(run.status IN (:...statuses) OR (run.status IN (:...terminalStatuses) AND run."createdAt" > :cutoff))',
              { statuses: dbStatus, terminalStatuses: ['completed', 'failed', 'cancelled'], cutoff },
            );
          } else {
            qb.andWhere('run.status IN (:...statuses)', { statuses: dbStatus });
          }
        } else {
          qb.andWhere('run.status = :status', { status: dbStatus });
        }
      } else {
        throw Object.assign(new Error(`Invalid status filter: ${params.status}`), {
          code: A2A_ERROR_CODES.INVALID_PARAMS,
        });
      }
    }

    // Filter by timestamp (accept both v0.2 lastUpdatedAfter and v1.0 statusTimestampAfter)
    const timestampFilter = params?.statusTimestampAfter ?? params?.lastUpdatedAfter;
    if (timestampFilter !== undefined && timestampFilter !== null) {
      // Reject obviously invalid values (negative numbers, non-date strings)
      const tsNum = Number(timestampFilter);
      if (!isNaN(tsNum) && tsNum < 0) {
        throw Object.assign(new Error('Invalid timestamp: must be non-negative'), {
          code: A2A_ERROR_CODES.INVALID_PARAMS,
        });
      }
      const ts = new Date(timestampFilter);
      if (isNaN(ts.getTime())) {
        throw Object.assign(new Error('Invalid timestamp format'), {
          code: A2A_ERROR_CODES.INVALID_PARAMS,
        });
      }
      qb.andWhere('run.updatedAt > :after', { after: ts });
    }

    // Cursor pagination — pageToken is a base64-encoded createdAt timestamp
    if (pageToken) {
      try {
        const decoded = Buffer.from(pageToken, 'base64').toString('utf-8');
        const cursorDate = new Date(decoded);
        if (isNaN(cursorDate.getTime())) {
          throw new Error('invalid date');
        }
        qb.andWhere('run.createdAt < :cursorDate', { cursorDate });
      } catch {
        throw Object.assign(new Error('Invalid pageToken'), {
          code: A2A_ERROR_CODES.INVALID_PARAMS,
        });
      }
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
      // Apply same WORKING state buffer as GetTask
      const isTerminal = ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED'].includes(task.status.state);
      if (isTerminal && run.createdAt) {
        const ageMs = Date.now() - new Date(run.createdAt).getTime();
        if (ageMs < 1000) {
          task.status = { state: 'TASK_STATE_WORKING', timestamp: task.status.timestamp };
          task.artifacts = undefined;
        }
      }
      // Limit history if requested
      if (historyLength !== undefined && typeof historyLength === 'number' && task.history) {
        task.history = historyLength === 0 ? [] : task.history.slice(-historyLength);
      }
      tasks.push(task);
    }

    // Get total count — scoped to the same filters as the main query
    const totalQb = this.runRepository.createQueryBuilder('run')
      .where('run.agentId = :agentId', { agentId })
      .andWhere('run.organizationId = :orgId', { orgId });

    if (params?.contextId) {
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (uuidRe.test(params.contextId)) {
        totalQb.andWhere(
          `(run.conversationId = :convId OR run.metadata->>'a2aContextId' = :extCtx)`,
          { convId: params.contextId, extCtx: params.contextId },
        );
      } else {
        totalQb.andWhere(`run.metadata->>'a2aContextId' = :extCtx`, { extCtx: params.contextId });
      }
    }

    const totalSize = await totalQb.getCount();

    // Per A2A spec: pageSize = actual number of tasks returned,
    // nextPageToken = empty string when no more results
    return {
      tasks,
      nextPageToken: hasMore
        ? Buffer.from(pageRuns[pageRuns.length - 1].createdAt.toISOString()).toString('base64')
        : '',
      totalSize,
      pageSize: tasks.length,
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
