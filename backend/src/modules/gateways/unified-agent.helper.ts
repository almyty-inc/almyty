import { HttpException, HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Request, Response } from 'express';
import * as crypto from 'crypto';

import { Agent } from '../../entities/agent.entity';
import { ApiKey } from '../../entities/api-key.entity';
import { Organization } from '../../entities/organization.entity';
import { Tool } from '../../entities/tool.entity';
import { Gateway, GatewayStatus } from '../../entities/gateway.entity';
import { AgentExecutionEngine, StreamEvent } from '../agents/agent-execution.engine';
import { AgentRuntimeService } from '../agents/agent-runtime.service';
import { AgentExecutionCancellationService } from '../agents/agent-execution-cancellation.service';

/**
 * Agent-side endpoint logic for the unified `/:orgSlug/:resourceSlug` controller:
 * authentication, invoke / stream, autonomous runs, and conversation history.
 *
 * Lives in its own class so the controller stays a thin dispatcher.
 */
import { AgentNotActive, agentIsInvokable, runsOnAutonomousRuntime } from '../agents/agent-invocation';
import { ExecutionPrincipal, userPrincipal } from '../../common/authorization/execution-access.service';

/** Whose scope a unified-endpoint agent request runs in: the key's or JWT's user. */
export function unifiedPrincipal(apiKey: Pick<ApiKey, 'userId'>): ExecutionPrincipal {
  return userPrincipal(apiKey.userId ?? null, 'api_key');
}
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
    // Appended last and @Optional(): a spec constructs this helper
    // positionally, so a required parameter inserted anywhere above would
    // silently shift the ones after it.
    @Optional()
    private readonly cancellations?: AgentExecutionCancellationService,
  ) {}

  async handleAgentRequest(
    agent: Agent,
    organization: Organization,
    req: Request,
    res: Response,
    body: any,
  ) {
    const apiKey = await this.authenticate(req, agent);

    // The key's (or JWT's) user is who this request runs as, for every
    // action below -- invoke, stream, runs, executions. A team agent the
    // user is not a member for, or somebody else's private agent, answers
    // as the controller answers a slug that matches nothing. So does an
    // agent the key was not minted for: a gateway's key reaches only the
    // agent that gateway publishes, and an agent's key only that agent.
    const allowed =
      (await this.keyReachesAgent(apiKey, agent)) &&
      (await this.runtimeService.executionAccess.canExecute(unifiedPrincipal(apiKey), agent)).allowed;
    if (!allowed) {
      const [orgSlug, resourceSlug] = req.path.split('/').filter(Boolean);
      throw new HttpException(`Resource not found: ${orgSlug}/${resourceSlug}`, HttpStatus.NOT_FOUND);
    }

    const pathParts = req.path.split('/').filter(Boolean);
    const action = pathParts.slice(2).join('/') || '';

    if (req.method === 'GET' && !action) {
      let tools: Array<{ id: string; name: string; description?: string }> = [];
      if (agent.toolIds?.length) {
        const toolRepo = this.agentRepository.manager.getRepository(Tool);
        const toolEntities = await toolRepo
          // Org-scoped. `agent.toolIds` is a plain string array with no
          // referential integrity, so an id belonging to another tenant
          // survives in it — and this response is served to a gateway
          // client. The MCP equivalents scope by organization for the
          // same reason.
          .find({
            where: { id: In(agent.toolIds), organizationId: agent.organizationId },
            select: { id: true, name: true, description: true },
          })
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

    if (action === 'executions' || action.startsWith('executions/')) {
      return this.handleAgentExecutions(agent, organization, req, res, action, apiKey);
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
   * May this key address `agent` at all?
   *
   * A platform key (no gatewayId, no agentId) acts as its user across the
   * organization. A key minted for one agent reaches that agent only (the
   * compat endpoints apply the same rule). A gateway's key is a credential
   * for what that gateway publishes: here, the one agent of an agent
   * gateway, and nothing on a tool gateway. Without this a gateway key handed
   * to a third-party client ran every agent its minting user could run.
   */
  private async keyReachesAgent(apiKey: ApiKey, agent: Agent): Promise<boolean> {
    if (apiKey.agentId && apiKey.agentId !== agent.id) return false;
    if (!apiKey.gatewayId) return true;
    const gateway = await this.agentRepository.manager.getRepository(Gateway).findOne({
      where: { id: apiKey.gatewayId, organizationId: agent.organizationId, status: GatewayStatus.ACTIVE },
      select: { id: true, agentId: true },
    });
    return !!gateway?.agentId && gateway.agentId === agent.id;
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
    if (!agentIsInvokable(agent)) {
      const refusal = new AgentNotActive(String(agent.status));
      throw new HttpException(
        { success: false, message: refusal.message, error: refusal.code },
        HttpStatus.BAD_REQUEST,
      );
    }

    // An autonomous agent has no pipeline graph. Handing it to the
    // pipeline engine returns a "completed" execution with zero node
    // results and a null output — which reads to the caller as an agent
    // that ran and had nothing to say. The dashboard's invoke path
    // dispatches on mode for exactly this reason; this one did not, so
    // every autonomous agent published behind a gateway answered
    // silently with nothing. `/runs` still exists for a caller that
    // wants the run object directly, but nobody should have to know the
    // agent's mode to invoke it.
    if (runsOnAutonomousRuntime(agent)) {
      const run = await this.runtimeService.startRun(
        agent.id,
        organization.id,
        apiKey.userId ?? null,
        body.input || body,
        { principal: unifiedPrincipal(apiKey) },
      );
      return res.json({ success: true, data: run, message: 'Autonomous agent run started' });
    }

    const execution = await this.executionEngine.execute(
      agent,
      organization.id,
      apiKey.userId ?? null,
      {
        input: body.input || body,
        variables: body.variables,
        metadata: body.metadata,
        principal: unifiedPrincipal(apiKey),
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
    if (!agentIsInvokable(agent)) {
      const refusal = new AgentNotActive(String(agent.status));
      return res.status(HttpStatus.BAD_REQUEST).json({
        success: false,
        message: refusal.message,
        error: refusal.code,
      });
    }

    // Streaming is a pipeline-engine feature: the autonomous runtime
    // publishes its events on the run event stream instead. Say that,
    // rather than streaming an empty execution.
    if (runsOnAutonomousRuntime(agent)) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        success: false,
        message:
          'This agent runs on the autonomous runtime, which streams its events per run. ' +
          'Start a run with POST /invoke and subscribe to it.',
        error: 'AGENT_IS_AUTONOMOUS',
      });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // The engine cancels cooperatively on options.signal, and
    // agent-execution.controller has always wired one to the request. This
    // path never did: a client that walked away -- Ctrl-C in the chat REPL,
    // a dropped connection -- left the pipeline running to completion,
    // writing every event into a dead socket and spending the whole way,
    // with nobody left to read the answer.
    const abort = new AbortController();
    let clientAlive = true;
    const markClosed = () => {
      clientAlive = false;
      if (!abort.signal.aborted) abort.abort();
    };
    res.req?.on('close', markClosed);
    res.req?.on('aborted', markClosed);

    const onEvent = (event: StreamEvent) => {
      if (!clientAlive) return;
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
        signal: abort.signal,
        principal: unifiedPrincipal(apiKey),
      },
      onEvent,
    );

    if (!clientAlive) return;

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
        { conversationId: body.conversationId, principal: unifiedPrincipal(apiKey) },
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

  /**
   * POST /:orgSlug/:agentSlug/executions/:executionId/cancel
   *
   * The workflow counterpart of /runs/:id/cancel. A workflow run is an
   * AgentExecution, not an AgentRun, so the runs route could never stop
   * one: a client that cancelled without dropping its connection left the
   * pipeline running and billing.
   *
   * Same authentication (already done by the caller), same org scoping and
   * the same "wrong org reads as not found" answer as the runs route;
   * additionally asserts the execution belongs to the agent this URL names.
   */
  private async handleAgentExecutions(
    agent: Agent,
    organization: Organization,
    req: Request,
    res: Response,
    action: string,
    // Appended last, and only so the cancel below can name who did it on
    // the audit row.
    apiKey?: ApiKey,
  ) {
    const parts = action.split('/');
    const executionId = parts[1];
    const subAction = parts[2];

    if (req.method === 'POST' && executionId && subAction === 'cancel') {
      if (!this.cancellations) {
        throw new HttpException('Execution cancellation is unavailable', HttpStatus.SERVICE_UNAVAILABLE);
      }
      const execution = await this.cancellations.cancel(
        executionId,
        organization.id,
        agent.id,
        apiKey?.userId,
      );
      return res.json({
        success: true,
        data: { id: execution.id, status: execution.status },
      });
    }

    throw new HttpException(
      `Unknown executions action: ${subAction ?? ''}`,
      HttpStatus.NOT_FOUND,
    );
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
