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
import { A2AMessageHandler } from './a2a-message.handler';
import { A2ATaskHandler } from './a2a-task.handler';
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
  private readonly messageHandler: A2AMessageHandler;
  private readonly taskHandler: A2ATaskHandler;

  constructor(
    private readonly agentRuntimeService: AgentRuntimeService,
    private readonly agentCardService: A2AAgentCardService,
    @InjectRepository(AgentRun)
    private readonly runRepository: Repository<AgentRun>,
    @InjectRepository(Conversation)
    private readonly conversationRepository: Repository<Conversation>,
    @InjectRepository(Message)
    private readonly messageRepository: Repository<Message>,
  ) {
    const helpers = {
      pollForCompletion: this.pollForCompletion.bind(this),
      getRunMessages: this.getRunMessages.bind(this),
      findActiveRunByConversationId: this.findActiveRunByConversationId.bind(this),
      writeSseEvent: this.writeSseEvent.bind(this),
      jsonRpcError: this.jsonRpcError.bind(this),
    };

    this.messageHandler = new A2AMessageHandler(
      agentRuntimeService,
      runRepository,
      messageRepository,
      helpers,
    );

    this.taskHandler = new A2ATaskHandler(
      agentRuntimeService,
      runRepository,
      messageRepository,
      { getRunMessages: helpers.getRunMessages },
    );
  }

  // --- Main JSON-RPC dispatcher ---

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
          const task = await this.messageHandler.handleMessageSend(gateway, rpcReq.params, rpcReq.id);
          // v1.0 (PascalCase) wraps in { task }, v0.2.x returns task directly
          const result = method === 'SendMessage' ? { task } : task;
          res.json(this.jsonRpcSuccess(rpcReq.id, result));
          return;
        }

        case 'message/stream':
        case 'StreamMessage': {
          await this.messageHandler.handleMessageStream(gateway, rpcReq.params, rpcReq.id, req, res);
          return;
        }

        case 'tasks/get':
        case 'GetTask': {
          const task = await this.taskHandler.handleTasksGet(gateway, rpcReq.params, rpcReq.id);
          res.json(this.jsonRpcSuccess(rpcReq.id, task));
          return;
        }

        case 'tasks/cancel':
        case 'CancelTask': {
          const task = await this.taskHandler.handleTasksCancel(gateway, rpcReq.params, rpcReq.id);
          res.json(this.jsonRpcSuccess(rpcReq.id, task));
          return;
        }

        case 'tasks/list':
        case 'ListTasks': {
          const result = await this.taskHandler.handleTasksList(gateway, rpcReq.params, rpcReq.id);
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

        // Push notification methods -- not supported, return proper A2A error
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
        case 'CreateTaskPushNotificationConfig':
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

  // --- Helpers (shared across handlers) ---

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
