import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { Request, Response } from 'express';

import { ApiKey } from '../../entities/api-key.entity';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';
import { HostedModelCall, HostedModelCallProtocol } from '../../entities/hosted-model-call.entity';
import { LlmProvider, LlmProviderStatus } from '../../entities/llm-provider.entity';
import { LlmProviderType } from '../../entities/llm-provider-type';
import { Model } from '../../entities/model.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { BudgetsService } from '../budgets/budgets.service';
import { BudgetExceededException } from '../budgets/budget-exceeded.exception';
import { providerAllowsModel } from '../llm-providers/allowed-models';
import { LlmProviderSecretsHelper } from '../llm-providers/llm-provider-secrets.helper';
import { Protocol, ProtocolBinding, bindingAuthHeaders, bindingBaseUrl, bindingFor, providerProfile } from '../llm-providers/provider-profile';
import { callLlmProviderHttp, callLlmProviderHttpStream, llmCallOptionsFor } from '../llm-providers/providers/safe-request';
import { ModelRouterService } from '../model-catalog/routing/model-router.service';
import { HostedRunnerSettingsService } from '../hosted-runners/hosted-runner-settings';
import { hostedAttributionHeaders, hostedAttributionOf } from '../hosted-runners/hosted-model-token.contract';

/** Which provider protocol each pass-through route forwards to. */
const UPSTREAM_PROTOCOL: Record<HostedModelCallProtocol, Protocol> = {
  anthropic_messages: 'anthropic_messages',
  openai_chat: 'chat_completions',
  openai_responses: 'responses',
};

/** Where Anthropic's token counter lives, beside the messages path. */
const COUNT_TOKENS_SUFFIX = '/count_tokens';

/** Request headers a client may pass on to the vendor (protocol versions and betas, never auth). */
const FORWARDED_HEADERS = ['anthropic-version', 'anthropic-beta', 'openai-beta'];

/** A pass-through call that cannot be made, with the status and words the client gets. */
export class PassThroughRefused extends Error {
  constructor(readonly status: number, message: string, readonly kind: 'not_found' | 'invalid' | 'budget' | 'upstream') {
    super(message);
    this.name = 'PassThroughRefused';
  }
}

interface Resolved {
  card: Model;
  provider: LlmProvider;
  binding: ProtocolBinding;
}

interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * The model pass-through for coding CLIs in hosted pods (Decision 6).
 *
 * A CLI's own request (its tools, its streaming, its thinking settings)
 * goes to the model it names, unchanged, through an organization-wide
 * provider of the organization's catalog: no almyty agent runs. Around the
 * forwarded call almyty does what it does for every model call: the
 * organization's budgets are checked first, the call is recorded as spend
 * (`hosted_model_calls`), its route is audited (`model_routed`) with the
 * pod's attribution (`hosted_model_call`), and the response says which
 * machine, model and provider answered.
 *
 * Only a pod model token reaches this (the compat controllers hand a pod
 * token here and nothing else). Providers are organization-wide only: a
 * member's private provider, or a team's, is never a candidate, whatever
 * the workspace owner may use themselves.
 */
@Injectable()
export class ModelPassThroughService {
  private readonly logger = new Logger(ModelPassThroughService.name);

  constructor(
    @InjectRepository(Model) private readonly models: Repository<Model>,
    @InjectRepository(LlmProvider) private readonly providers: Repository<LlmProvider>,
    @InjectRepository(HostedModelCall) private readonly calls: Repository<HostedModelCall>,
    private readonly secrets: LlmProviderSecretsHelper,
    @Optional() private readonly budgets?: BudgetsService,
    @Optional() private readonly router?: ModelRouterService,
    @Optional() private readonly auditLog?: AuditLogService,
    @Optional() private readonly settings?: HostedRunnerSettingsService,
  ) {}

  /** The organization-wide providers' models a pod may name, as `/v1/models` lists them. */
  async listModels(organizationId: string): Promise<Array<{ id: string; created: number; ownedBy: string }>> {
    const providers = await this.orgWideProviders(organizationId);
    if (providers.length === 0) return [];
    const cards = await this.models.find({ where: { organizationId, providerId: In(providers.map((p) => p.id)) }, order: { createdAt: 'ASC' } });
    const byId = new Map(providers.map((p) => [p.id, p]));
    const seen = new Set<string>();
    const out: Array<{ id: string; created: number; ownedBy: string }> = [];
    for (const card of cards) {
      const provider = byId.get(card.providerId as string);
      if (!provider || !card.isSelectable() || !providerAllowsModel(provider, card.vendorModelId) || seen.has(card.vendorModelId)) continue;
      seen.add(card.vendorModelId);
      out.push({ id: card.vendorModelId, created: Math.floor(new Date(card.createdAt as any).getTime() / 1000), ownedBy: provider.type });
    }
    return out;
  }

  /**
   * The card and organization-wide provider that answer `model` on this
   * protocol: the first selectable card in catalog order whose vendor model
   * id (or name) is `model`, on an active provider that speaks the protocol.
   */
  async resolve(organizationId: string, protocol: HostedModelCallProtocol, model: unknown): Promise<Resolved> {
    if (typeof model !== 'string' || !model.trim()) throw new PassThroughRefused(400, 'model is required', 'invalid');
    const providers = await this.orgWideProviders(organizationId);
    const byId = new Map(providers.map((p) => [p.id, p]));
    const cards = providers.length
      ? await this.models.find({
          where: [
            { organizationId, vendorModelId: model, providerId: In([...byId.keys()]) },
            { organizationId, name: model, providerId: In([...byId.keys()]) },
          ],
          order: { createdAt: 'ASC' },
        })
      : [];
    for (const card of cards) {
      const provider = byId.get(card.providerId as string);
      if (!provider || !card.isSelectable() || !providerAllowsModel(provider, card.vendorModelId)) continue;
      const binding = upstreamBinding(provider, UPSTREAM_PROTOCOL[protocol]);
      if (binding) return { card, provider, binding };
    }
    throw new PassThroughRefused(
      404,
      `No organization-wide model provider serves ${model} on this API. Pods use the organization's shared providers; ask an admin to add the model, or name one GET /v1/models lists.`,
      'not_found',
    );
  }

  /**
   * Forward one call and answer the client with the vendor's own answer,
   * streamed when the client asked for a stream. Records spend, route and
   * attribution when the vendor answered; a refusal before the call
   * (unknown model, used-up budget) is the client's to read, in its
   * protocol's error shape.
   */
  async forward(apiKey: ApiKey, protocol: HostedModelCallProtocol, body: any, req: Request, res: Response, opts: { countTokens?: boolean } = {}): Promise<void> {
    const started = Date.now();
    const attribution = hostedAttributionOf(apiKey);
    if (!attribution) return this.refuse(res, protocol, new PassThroughRefused(401, 'Only a hosted pod model token may use the model pass-through', 'invalid'));
    let resolved: Resolved;
    try {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PassThroughRefused(400, 'The request body must be a JSON object', 'invalid');
      resolved = await this.resolve(apiKey.organizationId, protocol, body.model);
      // A token counter costs nothing; every other call is spend.
      if (!opts.countTokens) await this.enforceBudgets(apiKey.organizationId);
    } catch (err) {
      return this.refuse(res, protocol, err);
    }
    const { card, provider, binding } = resolved;
    const withKey = await this.secrets.withResolvedSecrets(provider, {
      principal: null,
      context: { purpose: 'llm_call', resourceType: 'hosted_runner', resourceId: attribution.hostedRunnerId },
    });
    const url = `${bindingBaseUrl(binding, withKey.configuration ?? {}).replace(/(?<!\/)\/+$/, '')}${binding.path}${opts.countTokens ? COUNT_TOKENS_SUFFIX : ''}`;
    const headers: Record<string, string> = { ...bindingAuthHeaders(binding, withKey.getDecryptedApiKey(), withKey.configuration ?? {}) };
    for (const name of FORWARDED_HEADERS) {
      const value = req.headers?.[name];
      if (typeof value === 'string' && value) headers[name] = value;
    }
    const stream = body.stream === true && !opts.countTokens;
    const data = { ...body, model: card.vendorModelId };
    // The usage of a streamed chat completion arrives only when asked for.
    if (stream && protocol === 'openai_chat') data.stream_options = { ...(body.stream_options ?? {}), include_usage: true };
    const timeout = (this.settings?.current.modelAccess.upstreamTimeoutSeconds ?? 0) * 1000 || undefined;
    for (const [name, value] of Object.entries({
      ...hostedAttributionHeaders(apiKey),
      'X-Almyty-Route-Model': card.id,
      'X-Almyty-Route-Provider': provider.id,
    })) res.setHeader(name, value);

    const abort = new AbortController();
    const onClose = () => abort.abort();
    req.on?.('close', onClose);
    let status = 0;
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    try {
      const config = { method: 'POST' as const, url, headers, data, timeout, signal: abort.signal, validateStatus: () => true };
      if (stream) {
        const upstream = await callLlmProviderHttpStream(config, llmCallOptionsFor(withKey));
        status = upstream.status;
        res.status(status);
        res.setHeader('Content-Type', String(upstream.headers?.['content-type'] ?? 'text/event-stream'));
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Accel-Buffering', 'no');
        usage = await relay(upstream.data as NodeJS.ReadableStream, res, protocol, status < 300);
      } else {
        const upstream = await callLlmProviderHttp(config, llmCallOptionsFor(withKey));
        status = upstream.status;
        if (status < 300 && !opts.countTokens) usage = usageOf(protocol, upstream.data);
        res.status(status).json(upstream.data);
      }
    } catch (err: any) {
      if (abort.signal.aborted) {
        status = status || 499;
        if (!res.headersSent) res.status(499).end();
        else res.end();
      } else {
        this.logger.warn(`pass-through to ${provider.type} failed: ${err?.message ?? err}`);
        status = status || 502;
        if (!res.headersSent) this.refuse(res, protocol, new PassThroughRefused(502, 'The model provider could not be reached', 'upstream'));
        else res.end();
      }
    } finally {
      req.off?.('close', onClose);
    }
    if (opts.countTokens) return;
    await this.record(apiKey, protocol, resolved, status, stream, usage, Date.now() - started);
  }

  /** Spend, route and attribution for one forwarded call. Never throws. */
  private async record(apiKey: ApiKey, protocol: HostedModelCallProtocol, r: Resolved, status: number, stream: boolean, usage: Usage, durationMs: number): Promise<void> {
    const a = hostedAttributionOf(apiKey)!;
    const pricing = r.card.effectivePricing();
    const cost = pricing ? (usage.inputTokens * pricing.inPerMTok + usage.outputTokens * pricing.outPerMTok) / 1_000_000 : 0;
    try {
      await this.calls.insert({
        organizationId: apiKey.organizationId,
        agentId: null,
        userId: apiKey.userId ?? null,
        hostedRunnerId: a.hostedRunnerId,
        environmentId: a.environmentId,
        workspaceId: a.workspaceId,
        providerId: r.provider.id,
        modelId: r.card.id,
        vendorModelId: r.card.vendorModelId,
        protocol,
        status,
        stream,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalCost: cost,
        durationMs,
      });
    } catch (err: any) {
      this.logger.warn(`could not record a pod's model call: ${err?.message ?? err}`);
    }
    this.router?.recordRoute(
      apiKey.organizationId,
      {
        modelId: r.card.id,
        modelVersionId: r.card.modelVersionId ?? null,
        vendorModelId: r.card.vendorModelId,
        providerId: r.provider.id,
        rationale: 'named by a hosted pod (model pass-through)',
        attempt: 1,
        tried: [],
        rejected: [],
      },
      { userId: apiKey.userId ?? undefined, cost, tokens: usage.inputTokens + usage.outputTokens },
    );
    if (status > 0 && status < 300) void this.router?.recordLatency(r.card, durationMs);
    void this.auditLog
      ?.log({
        organizationId: apiKey.organizationId,
        userId: apiKey.userId ?? undefined,
        action: AuditAction.HOSTED_MODEL_CALL,
        resourceType: AuditResource.HOSTED_RUNNER,
        resourceId: a.hostedRunnerId,
        cost,
        details: {
          tokenId: a.tokenId,
          environmentId: a.environmentId,
          workspaceId: a.workspaceId,
          protocol,
          modelId: r.card.id,
          vendorModelId: r.card.vendorModelId,
          providerId: r.provider.id,
          status,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        },
      } as any)
      .catch(() => undefined);
  }

  private async enforceBudgets(organizationId: string): Promise<void> {
    try {
      await this.budgets?.enforceForOrganization(organizationId);
    } catch (err) {
      if (err instanceof BudgetExceededException) throw new PassThroughRefused(429, err.message, 'budget');
      throw err;
    }
  }

  private orgWideProviders(organizationId: string): Promise<LlmProvider[]> {
    return this.providers.find({ where: { organizationId, visibility: 'org', status: LlmProviderStatus.ACTIVE } });
  }

  /** A refusal in the client's protocol, so its SDK raises it as what it is. */
  private refuse(res: Response, protocol: HostedModelCallProtocol, err: unknown): void {
    const refused = err instanceof PassThroughRefused ? err : null;
    if (!refused) {
      this.logger.error(`pass-through failed: ${(err as any)?.message ?? err}`);
    }
    const status = refused?.status ?? 500;
    const message = refused?.message ?? 'Internal server error';
    if (protocol === 'anthropic_messages') {
      // Anthropic answers an exhausted balance with a 400 its SDKs do not retry.
      const anthropicStatus = refused?.kind === 'budget' ? 400 : status;
      const type = refused?.kind === 'not_found' ? 'not_found_error' : status === 401 ? 'authentication_error' : status >= 500 ? 'api_error' : 'invalid_request_error';
      res.status(anthropicStatus).json({ type: 'error', error: { type, message } });
      return;
    }
    const type = refused?.kind === 'budget' ? 'insufficient_quota' : status === 401 ? 'authentication_error' : status >= 500 ? 'api_error' : 'invalid_request_error';
    const code = refused?.kind === 'not_found' ? 'model_not_found' : refused?.kind === 'budget' ? 'insufficient_quota' : null;
    res.status(status).json({ error: { message, type, code, param: refused?.kind === 'not_found' ? 'model' : null } });
  }
}

/**
 * The provider's binding for a protocol. OpenAI serves the Responses API
 * on its chat base without a binding of its own in the profiles.
 */
export function upstreamBinding(provider: Pick<LlmProvider, 'type'>, protocol: Protocol): ProtocolBinding | undefined {
  const profile = providerProfile(provider.type);
  if (!profile) return undefined;
  const binding = bindingFor(profile, protocol);
  if (binding) return binding;
  if (protocol === 'responses' && provider.type === LlmProviderType.OPENAI) {
    const chat = bindingFor(profile, 'chat_completions');
    return chat ? { ...chat, protocol: 'responses', path: '/responses' } : undefined;
  }
  return undefined;
}

/** Tokens a non-streamed answer reports, in each protocol's own fields. */
export function usageOf(protocol: HostedModelCallProtocol, body: any): Usage {
  const u = body?.usage ?? {};
  if (protocol === 'openai_chat') return { inputTokens: num(u.prompt_tokens), outputTokens: num(u.completion_tokens) };
  return {
    inputTokens: num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens),
    outputTokens: num(u.output_tokens),
  };
}

/** The usage carried by one server-sent event of a stream, if any. */
export function usageOfEvent(protocol: HostedModelCallProtocol, event: any): Partial<Usage> {
  if (!event || typeof event !== 'object') return {};
  if (protocol === 'anthropic_messages') {
    if (event.type === 'message_start') {
      const u = event.message?.usage ?? {};
      return { inputTokens: num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens), outputTokens: num(u.output_tokens) };
    }
    if (event.type === 'message_delta') return { outputTokens: num(event.usage?.output_tokens) };
    return {};
  }
  if (protocol === 'openai_chat') {
    return event.usage ? { inputTokens: num(event.usage.prompt_tokens), outputTokens: num(event.usage.completion_tokens) } : {};
  }
  if (event.type === 'response.completed' && event.response?.usage) {
    return { inputTokens: num(event.response.usage.input_tokens), outputTokens: num(event.response.usage.output_tokens) };
  }
  return {};
}

/**
 * Copy a vendor's event stream to the client byte for byte, reading the
 * usage from its events on the way. Resolves when the stream ends.
 */
function relay(source: NodeJS.ReadableStream, res: Response, protocol: HostedModelCallProtocol, parse: boolean): Promise<Usage> {
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let pending = '';
  return new Promise((resolve, reject) => {
    source.on('data', (chunk: Buffer | string) => {
      res.write(chunk);
      if (!parse) return;
      pending += chunk.toString();
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice('data:'.length).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const found = usageOfEvent(protocol, JSON.parse(payload));
          if (found.inputTokens !== undefined) usage.inputTokens = found.inputTokens;
          if (found.outputTokens !== undefined) usage.outputTokens = found.outputTokens;
        } catch {
          // Not JSON: forwarded all the same.
        }
      }
    });
    source.on('end', () => {
      res.end();
      resolve(usage);
    });
    source.on('error', (err) => reject(err));
  });
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}
