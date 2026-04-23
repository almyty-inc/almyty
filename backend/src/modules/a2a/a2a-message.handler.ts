import { Repository } from 'typeorm';
import { Request, Response } from 'express';

import { Gateway } from '../../entities/gateway.entity';
import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { Message } from '../../entities/message.entity';

import { AgentRuntimeService } from '../agents/agent-runtime.service';
import { agentRunToTask } from './a2a-task.mapper';
import { a2aPartsToAgentInput } from './a2a-part.mapper';
import type { Task, JsonRpcResponse } from './types/a2a-spec.types';
import { A2A_ERROR_CODES } from './types/a2a-spec.types';

export class A2AMessageHandler {
  constructor(
    private readonly agentRuntimeService: AgentRuntimeService,
    private readonly runRepository: Repository<AgentRun>,
    private readonly messageRepository: Repository<Message>,
    private readonly helpers: {
      pollForCompletion: (runId: string, organizationId: string) => Promise<Task>;
      getRunMessages: (run: AgentRun) => Promise<Message[]>;
      findActiveRunByConversationId: (conversationId: string, organizationId: string) => Promise<AgentRun | null>;
      writeSseEvent: (res: Response, eventName: string, data: any) => void;
      jsonRpcError: (id: string | number | null, code: number, message: string, data?: any) => JsonRpcResponse;
    },
  ) {}

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
          if (params.configuration?.blocking) {
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

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

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
        const messages = await this.helpers.getRunMessages(finalRun);
        const task = agentRunToTask(finalRun, messages);
        this.helpers.writeSseEvent(res, 'status', {
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

      const messages = await this.helpers.getRunMessages(updatedRun);
      const task = agentRunToTask(updatedRun, messages);
      const isFinal = ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type);

      this.helpers.writeSseEvent(res, 'status', {
        type: 'status',
        taskId: task.id,
        contextId: task.contextId,
        status: task.status,
        final: isFinal,
      });

      // If the run completed with an artifact, send it as well
      if (isFinal && task.artifacts?.length) {
        for (const artifact of task.artifacts) {
          this.helpers.writeSseEvent(res, 'artifact', {
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
}
