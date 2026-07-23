import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Request, Response } from 'express';
import * as crypto from 'crypto';

import { Agent, AgentStatus } from '../../entities/agent.entity';
import { ApiKey } from '../../entities/api-key.entity';
import { Organization } from '../../entities/organization.entity';
import { Tool } from '../../entities/tool.entity';
import { AgentExecutionEngine, StreamEvent } from '../agents/agent-execution.engine';
import { AgentRuntimeService } from '../agents/agent-runtime.service';

/**
 * Agent-side endpoint logic for the unified `/:orgSlug/:resourceSlug` controller:
 * authentication, invoke / stream, autonomous runs, and conversation history.
 *
 * Lives in its own class so the controller stays a thin dispatcher.
 */
@Injectable()
export class UnifiedAgentHelper {
  private readonly logger = new Logger(UnifiedAgentHelper.name);

  constructor(
    @InjectRepository(Agent)
    private readonly agentRepository: Repository<Agent>,
    @InjectRepository(ApiKey)
    private readonly apiKeyRepository: Repository<ApiKey>,
    private readonly executionEngine: AgentExecutionEngine,
    private readonly runtimeService: AgentRuntimeService,
    private readonly jwtService: JwtService,
  ) {}

  async handleAgentRequest(
    agent: Agent,
    organization: Organization,
    req: Request,
    res: Response,
    body: any,
  ) {
    const apiKey = await this.authenticate(req, agent);

    const pathParts = req.path.split('/').filter(Boolean);
    const action = pathParts.slice(2).join('/') || '';

    if (req.method === 'GET' && !action) {
      let tools: Array<{ id: string; name: string; description?: string }> = [];
      if (agent.toolIds?.length) {
        const toolRepo = this.agentRepository.manager.getRepository(Tool);
        const toolEntities = await toolRepo
          .find({ where: { id: In(agent.toolIds) }, select: { id: true, name: true, description: true } })
          .catch(() => []);
        tools = toolEntities.map(t => ({ id: t.id, name: t.name, description: t.description }));
      }
      return res.json({
        success: true,
        data: {
          id: agent.id,
          name: agent.name,
          description: agent.description,
          mode: agent.mode,
          status: agent.status,
          tools,
        },
      });
    }

    if (req.method === 'POST' && (!action || action === 'invoke')) {
      return this.invokeAgent(agent, organization, body, res, apiKey);
    }

    if (req.method === 'POST' && action === 'stream') {
      return this.streamAgent(agent, organization, body, res, apiKey);
    }

    if (action === 'runs' || action.startsWith('runs/')) {
      return this.handleAgentRuns(agent, organization, body, req, res, apiKey, action);
    }

    if (req.method === 'GET' && action.startsWith('conversations/')) {
      const parts = action.split('/');
      const convId = parts[1];
      const sub = parts[2];
      if (convId && (!sub || sub === 'messages')) {
        return this.getConversationMessages(convId, organization.id, res);
      }
    }

    throw new HttpException(`Unknown agent action: ${action}`, HttpStatus.NOT_FOUND);
  }

  /**
   * Authenticate an agent request via API key or JWT.
   *
   * Tries API key first (SHA-256 hash lookup). If that fails,
   * falls back to JWT verification — this lets CLI users
   * authenticated via `npx @almyty/auth login` use the unified
   * endpoint without a separate API key.
   *
   * Returns an ApiKey object for API key auth, or a synthetic
   * ApiKey-like object for JWT auth with the user's ID and org.
   */
  async authenticate(req: Request, agent: Agent): Promise<ApiKey> {
    const authHeader = (req.headers?.authorization as string) || '';
    if (!authHeader.startsWith('Bearer ')) {
      throw new HttpException(
        {
          success: false,
          message: 'Authentication required. Send `Authorization: Bearer <key-or-jwt>`.',
          error: 'AGENT_AUTH_REQUIRED',
        },
        HttpStatus.UNAUTHORIZED,
      );
    }
    const rawToken = authHeader.slice(7).trim();
    if (!rawToken) {
      throw new HttpException(
        { success: false, message: 'Empty token', error: 'AGENT_AUTH_REQUIRED' },
        HttpStatus.UNAUTHORIZED,
      );
    }

    const keyHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const apiKey = await this.apiKeyRepository.findOne({
      where: { keyHash, organizationId: agent.organizationId, isActive: true },
    });

    if (apiKey) {
      if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
        throw new HttpException(
          { success: false, message: 'API key expired', error: 'AGENT_AUTH_EXPIRED' },
          HttpStatus.UNAUTHORIZED,
        );
      }
      return apiKey;
    }

    try {
      const payload = this.jwtService.verify(rawToken);
      const userId = payload.sub;
      const userOrgs: Array<{ id: string }> = payload.organizations || [];
      const hasAccess = userOrgs.some(o => o.id === agent.organizationId);

      if (!hasAccess) {
        this.logger.warn(
          `JWT org mismatch: agent.orgId=${agent.organizationId}, JWT orgs=${JSON.stringify(userOrgs.map(o => o.id))}`,
        );
        throw new HttpException(
          { success: false, message: `No access to this agent's organization`, error: 'AGENT_AUTH_FORBIDDEN' },
          HttpStatus.FORBIDDEN,
        );
      }

      return { userId, organizationId: agent.organizationId } as ApiKey;
    } catch (err) {
      if (err instanceof HttpException) throw err;
      throw new HttpException(
        { success: false, message: 'Invalid API key or JWT', error: 'AGENT_AUTH_INVALID' },
        HttpStatus.UNAUTHORIZED,
      );
    }
  }

  private async invokeAgent(
    agent: Agent,
    organization: Organization,
    body: any,
    res: Response,
    apiKey: ApiKey,
  ) {
    if (agent.status !== AgentStatus.ACTIVE) {
      throw new HttpException(
        { success: false, message: 'Agent must be active to invoke', error: 'AGENT_NOT_ACTIVE' },
        HttpStatus.BAD_REQUEST,
      );
    }

    const execution = await this.executionEngine.execute(
      agent,
      organization.id,
      apiKey.userId ?? null,
      {
        input: body.input || body,
        variables: body.variables,
        metadata: body.metadata,
      },
    );

    return res.json({
      success: execution.status === 'completed',
      data: execution,
      message:
        execution.status === 'completed'
          ? 'Agent executed successfully'
          : `Agent execution ${execution.status}: ${execution.error || ''}`,
    });
  }

  private async streamAgent(
    agent: Agent,
    organization: Organization,
    body: any,
    res: Response,
    apiKey: ApiKey,
  ) {
    if (agent.status !== AgentStatus.ACTIVE) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        success: false,
        message: 'Agent must be active to invoke',
        error: 'AGENT_NOT_ACTIVE',
      });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const onEvent = (event: StreamEvent) => {
      const data = JSON.stringify(event);
      res.write(`event: ${event.type}\ndata: ${data}\n\n`);
    };

    const execution = await this.executionEngine.execute(
      agent,
      organization.id,
      apiKey.userId ?? null,
      {
        input: body.input || body,
        variables: body.variables,
        metadata: body.metadata,
      },
      onEvent,
    );

    res.write(
      `event: done\ndata: ${JSON.stringify({ executionId: execution.id, status: execution.status })}\n\n`,
    );
    res.end();
  }

  private async handleAgentRuns(
    agent: Agent,
    organization: Organization,
    body: any,
    req: Request,
    res: Response,
    apiKey: ApiKey,
    action: string,
  ) {
    const userId = apiKey.userId ?? null;
    const parts = action.split('/');
    const runId = parts[1];
    const subAction = parts[2];

    if (req.method === 'POST' && !runId) {
      if (agent.mode !== 'autonomous') {
        throw new HttpException('Agent is not autonomous. Use /invoke or /stream.', HttpStatus.BAD_REQUEST);
      }
      const run = await this.runtimeService.startRun(
        agent.id,
        organization.id,
        userId,
        body.input,
        { conversationId: body.conversationId },
      );
      return res.status(201).json({ success: true, data: run });
    }

    if (!runId) {
      const runs = await this.runtimeService.listRuns(agent.id, organization.id);
      return res.json({ success: true, data: runs });
    }

    if (req.method === 'GET' && !subAction) {
      const run = await this.runtimeService.getRun(runId, organization.id);
      return res.json({ success: true, data: run });
    }

    if (req.method === 'GET' && subAction === 'stream') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const abortController = new AbortController();
      req.on('close', () => abortController.abort());

      try {
        await this.runtimeService.subscribeRunEvents(
          runId,
          (event) => {
            res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            if (['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)) {
              res.end();
            }
          },
          abortController.signal,
        );
      } catch {
        // stream ended or aborted
      }

      if (!res.writableEnded) res.end();
      return;
    }

    if (req.method === 'POST' && subAction === 'input') {
      await this.runtimeService.sendInput(runId, organization.id, body.input || body.message);
      return res.json({ success: true });
    }

    if (req.method === 'POST' && subAction === 'cancel') {
      await this.runtimeService.cancelRun(runId, organization.id);
      return res.json({ success: true });
    }

    throw new HttpException(`Unknown runs action: ${subAction}`, HttpStatus.NOT_FOUND);
  }

  private async getConversationMessages(convId: string, organizationId: string, res: Response) {
    const Conversation = (await import('../../entities/conversation.entity')).Conversation;
    const Message = (await import('../../entities/message.entity')).Message;
    const convRepo = this.agentRepository.manager.getRepository(Conversation);
    const msgRepo = this.agentRepository.manager.getRepository(Message);

    const conv = await convRepo.findOne({ where: { id: convId, organizationId } as any });
    if (!conv) {
      throw new HttpException('Conversation not found', HttpStatus.NOT_FOUND);
    }

    const messages = await msgRepo.find({
      where: { conversationId: convId },
      order: { createdAt: 'ASC' },
      select: { id: true, role: true, content: true, createdAt: true },
    });

    return res.json({
      success: true,
      data: messages.map(m => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
      })),
    });
  }
}
