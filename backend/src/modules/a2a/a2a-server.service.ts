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

    // Missing id (notifications not supported)
    if (body.id == null) {
      res.json(this.jsonRpcError(null, A2A_ERROR_CODES.INVALID_REQUEST, 'Invalid Request: id is required'));
      return;
    }

    // Invalid params type
    if (body.params !== undefined && typeof body.params !== 'object') {
      res.json(this.jsonRpcError(body.id, A2A_ERROR_CODES.INVALID_PARAMS, 'Invalid params: must be an object'));
      return;
    }

    const rpcReq = body as JsonRpcRequest;

    try {
      switch (rpcReq.method) {
        case 'message/send': {
          const task = await this.handleMessageSend(gateway, rpcReq.params, rpcReq.id);
          res.json(this.jsonRpcSuccess(rpcReq.id, task));
          return;
        }

        case 'message/stream': {
          await this.handleMessageStream(gateway, rpcReq.params, rpcReq.id, req, res);
          return;
        }

        case 'tasks/get': {
          const task = await this.handleTasksGet(gateway, rpcReq.params, rpcReq.id);
          res.json(this.jsonRpcSuccess(rpcReq.id, task));
          return;
        }

        case 'tasks/cancel': {
          const task = await this.handleTasksCancel(gateway, rpcReq.params, rpcReq.id);
          res.json(this.jsonRpcSuccess(rpcReq.id, task));
          return;
        }

        default:
          res.json(
            this.jsonRpcError(rpcReq.id, A2A_ERROR_CODES.METHOD_NOT_FOUND, `Unknown method: ${rpcReq.method}`),
          );
          return;
      }
    } catch (error: any) {
      this.logger.error(`A2A JSON-RPC error [${rpcReq.method}]: ${error.message}`, error.stack);
      res.json(
        this.jsonRpcError(rpcReq.id, A2A_ERROR_CODES.INTERNAL_ERROR, error.message),
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
    if (!params?.message?.parts) {
      throw Object.assign(new Error('Missing message.parts in params'), {
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
          // Resume the waiting run with new input
          await this.agentRuntimeService.sendInput(
            existingRun.id,
            gateway.organizationId,
            text,
          );
          return this.pollForCompletion(existingRun.id, gateway.organizationId);
        }

        // Run exists but is still processing — just return current state
        if (!existingRun.isDone()) {
          return this.pollForCompletion(existingRun.id, gateway.organizationId);
        }
      }
    }

    // Start a new run
    const run = await this.agentRuntimeService.startRun(
      gateway.agentId,
      gateway.organizationId,
      null, // no user context in A2A calls
      text,
    );

    return this.pollForCompletion(run.id, gateway.organizationId);
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

    try {
      const run = await this.agentRuntimeService.cancelRun(
        params.id,
        gateway.organizationId,
      );
      const messages = await this.getRunMessages(run);
      return agentRunToTask(run, messages);
    } catch (error: any) {
      if (error.message?.includes('already completed')) {
        throw Object.assign(new Error('Task is not cancelable'), {
          code: A2A_ERROR_CODES.TASK_NOT_CANCELABLE,
        });
      }
      throw error;
    }
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
