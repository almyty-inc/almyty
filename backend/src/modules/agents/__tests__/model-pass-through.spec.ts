import { PassThrough } from 'stream';

jest.mock('../../llm-providers/providers/safe-request', () => ({
  callLlmProviderHttp: jest.fn(),
  callLlmProviderHttpStream: jest.fn(),
  llmCallOptionsFor: jest.fn(() => ({})),
}));

import { callLlmProviderHttp, callLlmProviderHttpStream } from '../../llm-providers/providers/safe-request';
import { AuditAction } from '../../../entities/audit-log.entity';
import { LlmProviderType } from '../../../entities/llm-provider-type';
import { Model } from '../../../entities/model.entity';
import { BudgetExceededException } from '../../budgets/budget-exceeded.exception';
import { ModelPassThroughService, upstreamBinding, usageOf, usageOfEvent } from '../model-pass-through.service';

/**
 * The model pass-through on its own: a coding CLI's request goes to the
 * model it names on an organization-wide provider, unchanged (tools,
 * stream and all), and the call is budgeted, recorded as spend, routed and
 * attributed. No agent runs.
 */
const ORG = '22222222-2222-4222-8222-222222222222';
const OWNER = '66666666-6666-4666-8666-666666666666';
const HR = '11111111-1111-4111-8111-111111111111';
const ENV = '33333333-3333-4333-8333-333333333333';
const WS = '44444444-4444-4444-8444-444444444444';
const FAKE_VENDOR_KEY = 'fake-vendor-key-for-tests';

const httpCall = callLlmProviderHttp as jest.Mock;
const httpStream = callLlmProviderHttpStream as jest.Mock;

function provider(id: string, type: LlmProviderType, visibility: 'org' | 'team' | 'private' = 'org', extra: Record<string, unknown> = {}): any {
  return {
    id, organizationId: ORG, type, visibility, status: 'active', configuration: {}, allowNewModels: true, hiddenModels: [], allowedModels: null, name: id,
    ownerUserId: null, hostedPodAccess: false, ...extra,
    getDecryptedApiKey: () => FAKE_VENDOR_KEY,
  };
}

function card(id: string, providerId: string, vendorModelId: string, extra: Partial<Model> = {}): Model {
  return Object.assign(new Model(), {
    id, organizationId: ORG, providerId, vendorModelId, name: vendorModelId, status: 'active', validationStatus: 'passed',
    pricing: { inPerMTok: 3, outPerMTok: 15, currency: 'USD' }, pricingOverride: null, modelVersionId: null, measuredLatencyMs: null,
    createdAt: new Date('2026-10-01T00:00:00Z'), ...extra,
  });
}

const podKey: any = {
  id: 'tok-1', organizationId: ORG, userId: OWNER,
  hostedModelToken: { tokenId: 'tok-1', hostedRunnerId: HR, environmentId: ENV, workspaceId: WS },
};

function fakeRes() {
  const res: any = { statusCode: 200, headers: {} as Record<string, string>, body: undefined, chunks: [] as string[], ended: false, headersSent: false };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; res.headersSent = true; res.ended = true; return res; };
  res.setHeader = (name: string, value: string) => { res.headers[name] = value; };
  res.write = (chunk: any) => { res.headersSent = true; res.chunks.push(chunk.toString()); return true; };
  res.end = () => { res.ended = true; };
  return res;
}

const fakeReq = (headers: Record<string, string> = {}): any => ({ headers, on: jest.fn(), off: jest.fn() });

function harness(opts: { providers?: any[]; cards?: Model[]; budget?: () => Promise<void> } = {}) {
  const providers = opts.providers ?? [provider('p-anthropic', LlmProviderType.ANTHROPIC), provider('p-openai', LlmProviderType.OPENAI)];
  const cards = opts.cards ?? [card('m-sonnet', 'p-anthropic', 'claude-sonnet-4-5'), card('m-gpt', 'p-openai', 'gpt-5')];
  // Filters by exactly what the service asks for (each clause of an OR), so a
  // query that forgot the visibility or the grant would see every provider.
  const matches = (p: any, w: any) => Object.entries(w).every(([k, v]) => p[k] === v);
  const providerRepo = { find: jest.fn(async ({ where }: any) => providers.filter((p) => (Array.isArray(where) ? where : [where]).some((w) => matches(p, w)))) };
  const ids = (cond: any) => cond?._value ?? cond?.value ?? [];
  const modelRepo = {
    find: jest.fn(async ({ where }: any) => {
      const clauses = Array.isArray(where) ? where : [where];
      return cards.filter((c) => clauses.some((w) =>
        c.organizationId === w.organizationId && ids(w.providerId).includes(c.providerId) &&
        (w.vendorModelId === undefined || c.vendorModelId === w.vendorModelId) && (w.name === undefined || c.name === w.name)));
    }),
  };
  const calls = { insert: jest.fn(async () => ({ identifiers: [{ id: 'call-1' }] })) };
  const secrets = { withResolvedSecrets: jest.fn(async (p: any) => p) };
  const budgets = { enforceForOrganization: jest.fn(opts.budget ?? (async () => undefined)) };
  const router = { recordRoute: jest.fn(), recordLatency: jest.fn(async () => undefined) };
  const audit = { log: jest.fn(async () => undefined) };
  const service = new ModelPassThroughService(modelRepo as any, providerRepo as any, calls as any, secrets as any, budgets as any, router as any, audit as any);
  return { service, calls, secrets, budgets, router, audit, modelRepo };
}

beforeEach(() => {
  httpCall.mockReset();
  httpStream.mockReset();
});

describe('the model pass-through', () => {
  const claudeRequest = {
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    tools: [{ name: 'Bash', description: 'run a command', input_schema: { type: 'object', properties: { command: { type: 'string' } } } }],
    tool_choice: { type: 'auto' },
    thinking: { type: 'enabled', budget_tokens: 2048 },
    messages: [{ role: 'user', content: 'list the files' }],
  };

  it('forwards a CLI\'s own request, tools and all, to the organization-wide provider, and answers with the vendor\'s answer', async () => {
    const t = harness();
    const answer = { id: 'msg_1', type: 'message', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }], usage: { input_tokens: 1000, output_tokens: 200 } };
    httpCall.mockResolvedValue({ status: 200, data: answer, headers: {} });
    const res = fakeRes();

    await t.service.forward(podKey, 'anthropic_messages', claudeRequest, fakeReq({ 'anthropic-version': '2023-06-01', 'anthropic-beta': 'tools-2024', authorization: 'Bearer almyty_pod_x' }), res);

    const [config] = httpCall.mock.calls[0];
    expect(config.url).toBe('https://api.anthropic.com/v1/messages');
    expect(config.data).toEqual(claudeRequest);
    expect(config.headers['x-api-key']).toBe(FAKE_VENDOR_KEY);
    expect(config.headers['anthropic-beta']).toBe('tools-2024');
    // The pod's own credential never travels on.
    expect(JSON.stringify(config.headers)).not.toContain('almyty_pod_');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(answer);
    expect(res.headers).toMatchObject({ 'X-Almyty-Hosted-Runner': HR, 'X-Almyty-Workspace': WS, 'X-Almyty-Route-Model': 'm-sonnet', 'X-Almyty-Route-Provider': 'p-anthropic' });

    // Budgeted first, then recorded as spend, routed and attributed.
    expect(t.budgets.enforceForOrganization).toHaveBeenCalledWith(ORG);
    const cost = (1000 * 3 + 200 * 15) / 1_000_000;
    expect(t.calls.insert).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: ORG, agentId: null, userId: OWNER, hostedRunnerId: HR, environmentId: ENV, workspaceId: WS,
      providerId: 'p-anthropic', modelId: 'm-sonnet', protocol: 'anthropic_messages', status: 200, inputTokens: 1000, outputTokens: 200, totalCost: cost,
    }));
    expect(t.router.recordRoute).toHaveBeenCalledWith(ORG, expect.objectContaining({ modelId: 'm-sonnet', providerId: 'p-anthropic' }), expect.objectContaining({ cost, tokens: 1200 }));
    expect(t.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.HOSTED_MODEL_CALL, resourceId: HR, cost }));
  });

  it('streams the vendor\'s events through byte for byte and reads the usage on the way', async () => {
    const t = harness();
    const upstream = new PassThrough();
    httpStream.mockResolvedValue({ status: 200, data: upstream, headers: { 'content-type': 'text/event-stream' } });
    const res = fakeRes();
    const events = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":50,"output_tokens":1}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n',
    ];
    const done = t.service.forward(podKey, 'anthropic_messages', { ...claudeRequest, stream: true }, fakeReq(), res);
    await new Promise((r) => setImmediate(r));
    for (const e of events) upstream.write(e);
    upstream.end();
    await done;
    expect(res.chunks.join('')).toBe(events.join(''));
    expect(res.ended).toBe(true);
    expect(t.calls.insert).toHaveBeenCalledWith(expect.objectContaining({ stream: true, inputTokens: 50, outputTokens: 7 }));
  });

  it('serves Codex\'s Responses API from an OpenAI provider, and asks a streamed chat completion for its usage', async () => {
    const t = harness();
    httpCall.mockResolvedValue({ status: 200, data: { id: 'resp_1', usage: { input_tokens: 10, output_tokens: 5 } }, headers: {} });
    await t.service.forward(podKey, 'openai_responses', { model: 'gpt-5', input: 'hi', tools: [{ type: 'function', name: 'shell' }] }, fakeReq(), fakeRes());
    expect(httpCall.mock.calls[0][0].url).toBe('https://api.openai.com/v1/responses');
    expect(httpCall.mock.calls[0][0].headers.Authorization).toBe(`Bearer ${FAKE_VENDOR_KEY}`);
    expect(t.calls.insert).toHaveBeenCalledWith(expect.objectContaining({ protocol: 'openai_responses', inputTokens: 10, outputTokens: 5 }));

    const upstream = new PassThrough();
    httpStream.mockResolvedValue({ status: 200, data: upstream, headers: {} });
    const done = t.service.forward(podKey, 'openai_chat', { model: 'gpt-5', stream: true, messages: [] }, fakeReq(), fakeRes());
    await new Promise((r) => setImmediate(r));
    upstream.end('data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4}}\n\ndata: [DONE]\n\n');
    await done;
    expect(httpStream.mock.calls[0][0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(httpStream.mock.calls[0][0].data.stream_options).toEqual({ include_usage: true });
    expect(t.calls.insert).toHaveBeenLastCalledWith(expect.objectContaining({ protocol: 'openai_chat', inputTokens: 3, outputTokens: 4 }));
  });

  it('never uses a team provider, another member\'s private one, or the owner\'s own private one they did not grant', async () => {
    const t = harness({
      providers: [
        provider('p-private', LlmProviderType.ANTHROPIC, 'private', { ownerUserId: OWNER, hostedPodAccess: false }),
        provider('p-other', LlmProviderType.ANTHROPIC, 'private', { ownerUserId: 'someone-else', hostedPodAccess: true }),
        provider('p-team', LlmProviderType.ANTHROPIC, 'team'),
      ],
      cards: [card('m-1', 'p-private', 'claude-sonnet-4-5'), card('m-2', 'p-team', 'claude-sonnet-4-5'), card('m-3', 'p-other', 'claude-sonnet-4-5')],
    });
    const res = fakeRes();
    await t.service.forward(podKey, 'anthropic_messages', claudeRequest, fakeReq(), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ type: 'error', error: { type: 'not_found_error' } });
    expect(httpCall).not.toHaveBeenCalled();
    expect(await t.service.listModels(ORG, OWNER)).toEqual([]);
  });

  it('uses the owner\'s private provider once they granted it to their hosted workspaces (the one-click grant)', async () => {
    const t = harness({
      providers: [provider('p-mine', LlmProviderType.ANTHROPIC, 'private', { ownerUserId: OWNER, hostedPodAccess: true })],
      cards: [card('m-mine', 'p-mine', 'claude-sonnet-4-5')],
    });
    httpCall.mockResolvedValue({ status: 200, data: { usage: { input_tokens: 1, output_tokens: 1 } }, headers: {} });
    const res = fakeRes();
    await t.service.forward(podKey, 'anthropic_messages', claudeRequest, fakeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['X-Almyty-Route-Provider']).toBe('p-mine');
    expect((await t.service.listModels(ORG, OWNER)).map((m) => m.id)).toEqual(['claude-sonnet-4-5']);
    // Another person's pod does not get it.
    expect(await t.service.listModels(ORG, 'someone-else')).toEqual([]);
  });

  it('answers only on a provider that speaks the protocol, and lists only usable models', async () => {
    const t = harness({ cards: [card('m-sonnet', 'p-anthropic', 'claude-sonnet-4-5'), card('m-gpt', 'p-openai', 'gpt-5'), card('m-unchecked', 'p-openai', 'gpt-old', { validationStatus: 'pending' as any })] });
    const res = fakeRes();
    await t.service.forward(podKey, 'openai_chat', { model: 'claude-sonnet-4-5', messages: [] }, fakeReq(), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ error: { code: 'model_not_found', param: 'model' } });
    expect((await t.service.listModels(ORG)).map((m) => m.id)).toEqual(['claude-sonnet-4-5', 'gpt-5']);
  });

  it('refuses a call over a used-up budget in each protocol\'s shape, before calling anything', async () => {
    const budget = async () => { throw new BudgetExceededException({ budgetId: 'b', organizationId: ORG, agentId: null, spentCents: 100, limitCents: 100, periodType: 'monthly' } as any); };
    const t = harness({ budget });
    const anthropic = fakeRes();
    await t.service.forward(podKey, 'anthropic_messages', claudeRequest, fakeReq(), anthropic);
    expect(anthropic.statusCode).toBe(400);
    const openai = fakeRes();
    await t.service.forward(podKey, 'openai_chat', { model: 'gpt-5', messages: [] }, fakeReq(), openai);
    expect(openai.statusCode).toBe(429);
    expect(openai.body).toMatchObject({ error: { type: 'insufficient_quota' } });
    expect(httpCall).not.toHaveBeenCalled();
    expect(t.calls.insert).not.toHaveBeenCalled();
  });

  it('takes a pod token only: anything else is a 401 and nothing is called', async () => {
    const t = harness();
    const res = fakeRes();
    await t.service.forward({ id: 'k', organizationId: ORG, userId: OWNER } as any, 'anthropic_messages', claudeRequest, fakeReq(), res);
    expect(res.statusCode).toBe(401);
    expect(httpCall).not.toHaveBeenCalled();
  });

  it('passes a vendor\'s refusal through as it came, recorded with its status', async () => {
    const t = harness();
    httpCall.mockResolvedValue({ status: 400, data: { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }, headers: {} });
    const res = fakeRes();
    await t.service.forward(podKey, 'anthropic_messages', claudeRequest, fakeReq(), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: { message: 'bad' } });
    expect(t.calls.insert).toHaveBeenCalledWith(expect.objectContaining({ status: 400, inputTokens: 0, totalCost: 0 }));
  });

  it('counts tokens without a budget check or a spend row', async () => {
    const t = harness();
    httpCall.mockResolvedValue({ status: 200, data: { input_tokens: 42 }, headers: {} });
    const res = fakeRes();
    await t.service.forward(podKey, 'anthropic_messages', claudeRequest, fakeReq(), res, { countTokens: true });
    expect(httpCall.mock.calls[0][0].url).toBe('https://api.anthropic.com/v1/messages/count_tokens');
    expect(res.body).toEqual({ input_tokens: 42 });
    expect(t.budgets.enforceForOrganization).not.toHaveBeenCalled();
    expect(t.calls.insert).not.toHaveBeenCalled();
  });

  it('reads usage in each protocol\'s fields', () => {
    expect(usageOf('anthropic_messages', { usage: { input_tokens: 5, cache_read_input_tokens: 10, output_tokens: 2 } })).toEqual({ inputTokens: 15, outputTokens: 2 });
    expect(usageOf('openai_chat', { usage: { prompt_tokens: 4, completion_tokens: 3 } })).toEqual({ inputTokens: 4, outputTokens: 3 });
    expect(usageOfEvent('openai_responses', { type: 'response.completed', response: { usage: { input_tokens: 9, output_tokens: 1 } } })).toEqual({ inputTokens: 9, outputTokens: 1 });
    expect(upstreamBinding({ type: LlmProviderType.ANTHROPIC }, 'responses')).toBeUndefined();
    expect(upstreamBinding({ type: LlmProviderType.OPENAI }, 'responses')?.path).toBe('/responses');
  });
});
