import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Request, Response } from 'express';

import { Gateway } from '../../entities/gateway.entity';
import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { Message } from '../../entities/message.entity';

import { AgentRuntimeService } from '../agents/agent-runtime.service';
import { agentRunToSessionUpdate } from './acp-session.mapper';
import { acpPartsToAgentInput } from './acp-part.mapper';
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  SessionUpdate,
} from './types/acp.types';
import { ACP_ERROR_CODES } from './types/acp.types';
import { gatewayPrincipal } from '../../common/authorization/execution-access.service';
import { findGatewayRun } from '../gateways/gateway-servable';

/** Default poll timeout for session/prompt (ms). */
const PROMPT_POLL_TIMEOUT_MS = 30_000;
const PROMPT_POLL_INTERVAL_MS = 500;

/**
 * Ceiling on the conversation history attached to a SessionUpdate. The
 * history is re-read and re-serialized on every poll tick and every
 * streamed event, so it must not grow with the conversation.
 */
const MAX_HISTORY_MESSAGES = 200;

/** Both `agent_runs.id` and `agent_runs.conversationId` are uuid columns. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class AcpServerService {
  private readonly logger = new Logger(AcpServerService.name);

  constructor(
    private readonly agentRuntimeService: AgentRuntimeService,
    @InjectRepository(AgentRun)
    private readonly runRepository: Repository<AgentRun>,
    @InjectRepository(Message)
    private readonly messageRepository: Repository<Message>,
  ) {}

  // --- Main JSON-RPC dispatcher -----------------------------------------

  async handleJsonRpc(
    gateway: Gateway,
    req: Request,
    body: any,
    res: Response,
  ): Promise<void> {
    // Validate JSON-RPC envelope
    if (!body || body.jsonrpc !== '2.0' || !body.method || body.id == null) {
      const errorResponse = this.jsonRpcError(
        body?.id ?? null,
        ACP_ERROR_CODES.INVALID_REQUEST,
        'Invalid JSON-RPC request: must include jsonrpc "2.0", method, and id',
      );
      res.json(errorResponse);
      return;
    }

    const rpcReq = body as JsonRpcRequest;

    try {
      switch (rpcReq.method) {
        case 'initialize': {
          const result = await this.handleInitialize(gateway, rpcReq.params, rpcReq.id);
          res.json(this.jsonRpcSuccess(rpcReq.id, result));
          return;
        }

        case 'session/new': {
          const update = await this.handleSessionNew(gateway, rpcReq.params, rpcReq.id);
          res.json(this.jsonRpcSuccess(rpcReq.id, update));
          return;
        }

        case 'session/prompt': {
          const update = await this.handleSessionPrompt(gateway, rpcReq.params, rpcReq.id);
          res.json(this.jsonRpcSuccess(rpcReq.id, update));
          return;
        }

        case 'session/stream': {
          await this.handleSessionStream(gateway, rpcReq.params, rpcReq.id, req, res);
          return;
        }

        case 'session/get': {
          const update = await this.handleSessionGet(gateway, rpcReq.params, rpcReq.id);
          res.json(this.jsonRpcSuccess(rpcReq.id, update));
          return;
        }

        case 'session/cancel': {
          const update = await this.handleSessionCancel(gateway, rpcReq.params, rpcReq.id);
          res.json(this.jsonRpcSuccess(rpcReq.id, update));
          return;
        }

        default:
          res.json(
            this.jsonRpcError(rpcReq.id, ACP_ERROR_CODES.METHOD_NOT_FOUND, `Unknown method: ${rpcReq.method}`),
          );
          return;
      }
    } catch (error: any) {
      this.logger.error(`ACP JSON-RPC error [${rpcReq.method}]: ${error.message}`, error.stack);
      res.json(
        this.jsonRpcError(rpcReq.id, error.code || ACP_ERROR_CODES.INTERNAL_ERROR, error.message),
      );
    }
  }

  // --- initialize -------------------------------------------------------

  private async handleInitialize(
    gateway: Gateway,
    _params: any,
    _rpcId: string | number,
  ): Promise<Record<string, any>> {
    return {
      protocolVersion: '1.0.0',
      capabilities: {
        streaming: true,
        sessions: true,
      },
      gatewayId: gateway.id,
      agentId: gateway.agentId,
    };
  }

  // --- session/new ------------------------------------------------------

  /**
   * Create a new session by starting a fresh agent run.
   */
  private async handleSessionNew(
    gateway: Gateway,
    params: any,
    _rpcId: string | number,
  ): Promise<SessionUpdate> {
    if (!params?.message?.parts) {
      throw Object.assign(new Error('Missing message.parts in params'), {
        code: ACP_ERROR_CODES.INVALID_PARAMS,
      });
    }

    const { text } = acpPartsToAgentInput(params.message.parts);

    const run = await this.agentRuntimeService.startRun(
      gateway.agentId,
      gateway.organizationId,
      null, // no user context in ACP calls
      text,
      // Runs in the gateway's scope: an ACP gateway serves its agent only
      // when its own visibility covers it, re-checked on every session.
      { principal: gatewayPrincipal(gateway) },
    );

    return this.pollForCompletion(run.id, gateway.organizationId);
  }

  // --- session/prompt ---------------------------------------------------

  /**
   * Send a prompt to an existing session or start a new one.
   */
  private async handleSessionPrompt(
    gateway: Gateway,
    params: any,
    _rpcId: string | number,
  ): Promise<SessionUpdate> {
    if (!params?.message?.parts) {
      throw Object.assign(new Error('Missing message.parts in params'), {
        code: ACP_ERROR_CODES.INVALID_PARAMS,
      });
    }

    const { text } = acpPartsToAgentInput(params.message.parts);

    // If sessionId is provided, look for an existing conversation/run
    if (params.sessionId) {
      const existingRun = await this.findSessionRun(params.sessionId, gateway);

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

        // Run exists but is still processing -- just return current state
        if (!existingRun.isDone()) {
          return this.pollForCompletion(existingRun.id, gateway.organizationId);
        }
      }
    }

    // Start a new run
    const run = await this.agentRuntimeService.startRun(
      gateway.agentId,
      gateway.organizationId,
      null,
      text,
      { principal: gatewayPrincipal(gateway) },
    );

    return this.pollForCompletion(run.id, gateway.organizationId);
  }

  // --- session/stream ---------------------------------------------------

  private async handleSessionStream(
    gateway: Gateway,
    params: any,
    rpcId: string | number,
    req: Request,
    res: Response,
  ): Promise<void> {
    if (!params?.message?.parts) {
      const error = this.jsonRpcError(rpcId, ACP_ERROR_CODES.INVALID_PARAMS, 'Missing message.parts in params');
      res.json(error);
      return;
    }

    const { text } = acpPartsToAgentInput(params.message.parts);

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let run: AgentRun;

    // Resume or start a new run
    if (params.sessionId) {
      const existingRun = await this.findSessionRun(params.sessionId, gateway);
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
          { principal: gatewayPrincipal(gateway) },
        );
      }
    } else {
      run = await this.agentRuntimeService.startRun(
        gateway.agentId,
        gateway.organizationId,
        null,
        text,
        { principal: gatewayPrincipal(gateway) },
      );
    }

    // Stream events from the run emitter
    const emitter = this.agentRuntimeService.getRunEmitter(run.id);
    if (!emitter) {
      // No emitter means the run already completed synchronously
      const finalRun = await this.runRepository.findOne({ where: { id: run.id } });
      if (finalRun) {
        const messages = await this.getRunMessages(finalRun);
        const update = agentRunToSessionUpdate(finalRun, messages);
        this.writeSseEvent(res, 'session.update', {
          type: 'session.update',
          ...update,
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
      const update = agentRunToSessionUpdate(updatedRun, messages);
      const isFinal = ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type);

      this.writeSseEvent(res, 'session.update', {
        type: 'session.update',
        ...update,
        final: isFinal,
      });

      // If the run completed with an artifact, send it as well
      if (isFinal && update.artifacts?.length) {
        for (const artifact of update.artifacts) {
          this.writeSseEvent(res, 'session.artifact', {
            type: 'session.artifact',
            sessionId: update.sessionId,
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

  // --- session/get ------------------------------------------------------

  private async handleSessionGet(
    gateway: Gateway,
    params: any,
    _rpcId: string | number,
  ): Promise<SessionUpdate> {
    if (!params?.sessionId) {
      throw Object.assign(new Error('Missing sessionId'), {
        code: ACP_ERROR_CODES.INVALID_PARAMS,
      });
    }

    const run = await this.ownRunOrNotFound(gateway, params.sessionId);

    const messages = await this.getRunMessages(run);
    return agentRunToSessionUpdate(run, messages);
  }

  // --- session/cancel ---------------------------------------------------

  private async handleSessionCancel(
    gateway: Gateway,
    params: any,
    _rpcId: string | number,
  ): Promise<SessionUpdate> {
    if (!params?.sessionId) {
      throw Object.assign(new Error('Missing sessionId'), {
        code: ACP_ERROR_CODES.INVALID_PARAMS,
      });
    }

    // Cancel only a run of this gateway's agent. An unknown id and another
    // agent's run are the same "not found".
    const existing = await this.ownRunOrNotFound(gateway, params.sessionId);

    try {
      const run = await this.agentRuntimeService.cancelRun(
        existing.id,
        gateway.organizationId,
      );
      const messages = await this.getRunMessages(run);
      return agentRunToSessionUpdate(run, messages);
    } catch (error: any) {
      if (error.message?.includes('already completed')) {
        throw Object.assign(new Error('Session is not cancelable'), {
          code: ACP_ERROR_CODES.SESSION_NOT_CANCELABLE,
        });
      }
      throw error;
    }
  }

  // --- Helpers ----------------------------------------------------------

  /**
   * Poll the run until it reaches a terminal state or timeout.
   */
  private async pollForCompletion(
    runId: string,
    organizationId: string,
  ): Promise<SessionUpdate> {
    const maxAttempts = Math.ceil(PROMPT_POLL_TIMEOUT_MS / PROMPT_POLL_INTERVAL_MS);

    for (let i = 0; i < maxAttempts; i++) {
      const run = await this.runRepository.findOne({
        where: { id: runId, organizationId },
      });
      if (!run) {
        throw Object.assign(new Error('Session not found'), {
          code: ACP_ERROR_CODES.SESSION_NOT_FOUND,
        });
      }

      if (run.isDone() || run.status === AgentRunStatus.WAITING_INPUT) {
        const messages = await this.getRunMessages(run);
        return agentRunToSessionUpdate(run, messages);
      }

      await this.sleep(PROMPT_POLL_INTERVAL_MS);
    }

    // Timed out waiting. The run row can also disappear underneath us
    // (the run reaper), and passing a null run into the mapper used to
    // throw a bare TypeError that surfaced as an opaque INTERNAL_ERROR.
    const run = await this.runRepository.findOne({
      where: { id: runId, organizationId },
    });
    if (!run) {
      throw Object.assign(new Error('Session not found'), {
        code: ACP_ERROR_CODES.SESSION_NOT_FOUND,
      });
    }
    const messages = await this.getRunMessages(run);
    return agentRunToSessionUpdate(run, messages);
  }

  /**
   * Resolve the AgentRun behind an ACP `sessionId`.
   *
   * Every SessionUpdate we hand a client carries `sessionId: run.id`
   * (see `agentRunToSessionUpdate`), so a client echoing that value back
   * on session/prompt or session/stream means the RUN id. This used to
   * look the value up only as a `conversationId`, which a run id never
   * is — the lookup always missed, both resume paths fell through to
   * "start a new run", and no ACP session could ever be continued. The
   * caller got a perfectly valid SessionUpdate back, so the dropped
   * session was invisible.
   *
   * The conversationId lookup is kept as a fallback for a client that
   * passes a conversation id. Both columns are uuid, so a non-uuid
   * sessionId is rejected here rather than reaching Postgres (which
   * would turn a bad id into a 500 instead of "start a new run").
   */
  private async findSessionRun(
    sessionId: string,
    gateway: Gateway,
  ): Promise<AgentRun | null> {
    if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) return null;

    // Only a run of this gateway's own agent: another agent's session id
    // reads as one never seen, so it is neither resumed nor reported.
    const byRunId = await findGatewayRun(this.runRepository, gateway, { id: sessionId });
    if (byRunId) return byRunId;

    return findGatewayRun(this.runRepository, gateway, { conversationId: sessionId });
  }

  /** A run of this gateway's agent by run id, or the not-found an unknown id gets. */
  private async ownRunOrNotFound(gateway: Gateway, sessionId: unknown): Promise<AgentRun> {
    const run =
      typeof sessionId === 'string' && UUID_RE.test(sessionId)
        ? await findGatewayRun(this.runRepository, gateway, { id: sessionId })
        : null;
    if (!run) {
      throw Object.assign(new Error('Session not found'), {
        code: ACP_ERROR_CODES.SESSION_NOT_FOUND,
      });
    }
    return run;
  }

  /**
   * Conversation history for a session update. Bounded: `pollForCompletion`
   * re-reads it on every tick (up to 60 per session/prompt) and the stream
   * handler re-reads it on every run event, so an unbounded find grows with
   * the conversation and is re-serialized into every frame. Keep the most
   * recent MAX_HISTORY_MESSAGES, returned oldest-first.
   */
  private async getRunMessages(run: AgentRun): Promise<Message[]> {
    if (!run?.conversationId) return [];
    const recent = await this.messageRepository.find({
      where: { conversationId: run.conversationId },
      order: { createdAt: 'DESC' },
      take: MAX_HISTORY_MESSAGES,
    });
    return [...recent].reverse();
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
