import { MessageAttachmentResolver } from '../message-attachments.resolver';
import { LlmChatRunnerHelper } from '../llm-chat-runner.helper';
import { LlmProviderType } from '../../../entities/llm-provider.entity';

/**
 * A file a message refers to becomes what the answering model can read:
 * the image or PDF itself when the model's catalog card says it takes
 * them, its text or a sentence otherwise. Cards, file rows and stored
 * bytes are fakes that answer only what they are asked, scoped the way
 * the real queries are.
 */
const ORG = 'org-1';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1)]);
const PDF = Buffer.from('%PDF-1.7\n%%EOF');

function harness(opts: { capabilities?: Record<string, boolean> | null; files?: any[]; bytes?: Record<string, Buffer> } = {}) {
  const cardQueries: any[] = [];
  const fileQueries: any[] = [];
  const downloads: string[] = [];
  const models = {
    findOne: jest.fn(async (q: any) => {
      cardQueries.push(q.where);
      return opts.capabilities === null ? null : { id: 'card-1', capabilities: opts.capabilities ?? {} };
    }),
  };
  const files = {
    findOne: jest.fn(async (q: any) => {
      fileQueries.push(q.where);
      return (opts.files ?? []).find((f) => f.id === q.where.id && f.organizationId === q.where.organizationId) ?? null;
    }),
  };
  const storage = {
    download: jest.fn(async (key: string) => {
      downloads.push(key);
      return opts.bytes?.[key] ?? Buffer.alloc(0);
    }),
  };
  const resolver = new MessageAttachmentResolver(models as any, files as any, storage as any);
  return { resolver, cardQueries, fileQueries, downloads, models, files, storage };
}

const provider = (type = LlmProviderType.ANTHROPIC, configuration: any = {}): any => ({ id: 'prov-1', type, organizationId: ORG, configuration });
const fileRow = (id: string, mimeType: string, size: number, organizationId = ORG) => ({ id, organizationId, name: `${id}.bin`, mimeType, size, storageKey: `key/${id}` });
const ask = (...parts: any[]) => ({
  model: 'claude-sonnet-5',
  messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: [{ type: 'text', text: 'Look' }, ...parts] }],
});
const parts = (request: { messages: any[] }): any[] => request.messages[1].content;
const ref = (fileId: string, mimeType: string, extra: any = {}) => ({ type: 'file', fileId, mimeType, name: `${fileId}.bin`, ...extra });

describe('MessageAttachmentResolver', () => {
  it('leaves a request without files alone and asks nothing', async () => {
    const h = harness();
    const request: any = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
    await expect(h.resolver.resolve(ORG, provider(), request)).resolves.toBe(request);
    expect(h.models.findOne).not.toHaveBeenCalled();
  });

  it('gives a vision model the image, read from storage within the organization', async () => {
    const h = harness({ capabilities: { vision: true }, files: [fileRow('f1', 'image/png', PNG.length)], bytes: { 'key/f1': PNG } });
    const out = await h.resolver.resolve(ORG, provider(), ask(ref('f1', 'image/png')) as any);
    expect(parts(out)).toEqual([
      { type: 'text', text: 'Look' },
      { type: 'image', mimeType: 'image/png', name: 'f1.bin', data: PNG.toString('base64') },
    ]);
    // The card is the one for this provider and model; the file is the org's.
    expect(h.cardQueries).toEqual([{ organizationId: ORG, providerId: 'prov-1', vendorModelId: 'claude-sonnet-5' }]);
    expect(h.fileQueries).toEqual([{ id: 'f1', organizationId: ORG }]);
    // The system message is untouched.
    expect(out.messages[0]).toEqual({ role: 'system', content: 'sys' });
  });

  it('gives a model whose card does not say vision the text fallback, and reads no bytes', async () => {
    const h = harness({ capabilities: { tools: true }, files: [fileRow('f1', 'image/png', PNG.length)], bytes: { 'key/f1': PNG } });
    const out = await h.resolver.resolve(ORG, provider(), ask(ref('f1', 'image/png')) as any);
    expect(parts(out)[1]).toEqual({ type: 'text', text: '(f1.bin is an image; the model answering cannot view images.)' });
    expect(h.storage.download).not.toHaveBeenCalled();
  });

  it('treats a model with no card as text-only', async () => {
    const h = harness({ capabilities: null });
    const out = await h.resolver.resolve(ORG, provider(), ask(ref('f1', 'image/png')) as any);
    expect(parts(out)[1].type).toBe('text');
  });

  it('gives a PDF to a model that takes PDFs, and its text fallback to one that only sees images', async () => {
    const files = [fileRow('d1', 'application/pdf', PDF.length)];
    const pdfModel = harness({ capabilities: { vision: true, pdfInput: true }, files, bytes: { 'key/d1': PDF } });
    const out = await pdfModel.resolver.resolve(ORG, provider(), ask(ref('d1', 'application/pdf')) as any);
    expect(parts(out)[1]).toEqual({ type: 'document', mimeType: 'application/pdf', name: 'd1.bin', data: PDF.toString('base64') });

    const imageModel = harness({ capabilities: { vision: true }, files, bytes: { 'key/d1': PDF } });
    const text = await imageModel.resolver.resolve(ORG, provider(), ask(ref('d1', 'application/pdf')) as any);
    expect(parts(text)[1]).toEqual({ type: 'text', text: '(d1.bin is a PDF; the model answering cannot read PDF files.)' });
  });

  it('sends a PDF as a document only over a format that carries one; another OpenAI-compatible server gets the text', async () => {
    const files = [fileRow('d1', 'application/pdf', PDF.length)];
    const openrouter = harness({ capabilities: { pdfInput: true }, files, bytes: { 'key/d1': PDF } });
    const viaRouter = await openrouter.resolver.resolve(ORG, provider(LlmProviderType.OPENROUTER), ask(ref('d1', 'application/pdf')) as any);
    expect(parts(viaRouter)[1].type).toBe('document');

    const groq = harness({ capabilities: { pdfInput: true, vision: true }, files, bytes: { 'key/d1': PDF } });
    const viaGroq = await groq.resolver.resolve(ORG, provider(LlmProviderType.GROQ), ask(ref('d1', 'application/pdf')) as any);
    expect(parts(viaGroq)[1]).toEqual({ type: 'text', text: '(d1.bin is a PDF; the model answering cannot read PDF files.)' });
    expect(groq.storage.download).not.toHaveBeenCalled();
  });

  it('a text file is read as its text by every model', async () => {
    const h = harness({ capabilities: { vision: true, pdfInput: true } });
    const out = await h.resolver.resolve(ORG, provider(), ask(ref('t1', 'text/plain', { text: 'Ship Monday.' })) as any);
    expect(parts(out)[1]).toEqual({ type: 'text', text: 'Contents of t1.bin:\nShip Monday.' });
  });

  it('checks the bytes, not the stored type: an "image" that is not one goes as text', async () => {
    const h = harness({ capabilities: { vision: true }, files: [fileRow('f1', 'image/png', 12)], bytes: { 'key/f1': Buffer.from('not an image') } });
    const out = await h.resolver.resolve(ORG, provider(), ask(ref('f1', 'image/png')) as any);
    expect(parts(out)[1].type).toBe('text');
  });

  it('does not reach another organization\'s file', async () => {
    const h = harness({ capabilities: { vision: true }, files: [fileRow('f1', 'image/png', PNG.length, 'org-2')], bytes: { 'key/f1': PNG } });
    const out = await h.resolver.resolve(ORG, provider(), ask(ref('f1', 'image/png')) as any);
    expect(parts(out)[1]).toEqual({ type: 'text', text: '(f1.bin is no longer available.)' });
    expect(h.storage.download).not.toHaveBeenCalled();
  });

  it('sends an image over the per-image cap as text, without reading it', async () => {
    const big = MessageAttachmentResolver.MAX_IMAGE_BYTES + 1;
    const h = harness({ capabilities: { vision: true }, files: [fileRow('f1', 'image/png', big)] });
    const out = await h.resolver.resolve(ORG, provider(), ask(ref('f1', 'image/png')) as any);
    expect(parts(out)[1].type).toBe('text');
    expect(h.storage.download).not.toHaveBeenCalled();
  });

  it('keeps one request under its total: files past it go as text', async () => {
    const pdf = Buffer.concat([PDF, Buffer.alloc(9 * 1024 * 1024)]);
    const files = ['a', 'b', 'c'].map((id) => fileRow(id, 'application/pdf', pdf.length));
    const h = harness({ capabilities: { pdfInput: true }, files, bytes: { 'key/a': pdf, 'key/b': pdf, 'key/c': pdf } });
    const out = await h.resolver.resolve(ORG, provider(), ask(ref('a', 'application/pdf'), ref('b', 'application/pdf'), ref('c', 'application/pdf')) as any);
    expect(parts(out).slice(1).map((p: any) => p.type)).toEqual(['document', 'document', 'text']);
  });

  it('asks no card for a wire format that carries text alone', async () => {
    const perplexity = harness({ capabilities: { vision: true } });
    await perplexity.resolver.resolve(ORG, provider(LlmProviderType.PERPLEXITY), ask(ref('f1', 'image/png')) as any);
    expect(perplexity.models.findOne).not.toHaveBeenCalled();

    const custom = harness({ capabilities: { vision: true } });
    await custom.resolver.resolve(ORG, provider(LlmProviderType.CUSTOM, { custom: { requestFormat: 'custom' } }), ask(ref('f1', 'image/png')) as any);
    expect(custom.models.findOne).not.toHaveBeenCalled();
  });
});

describe('the runner resolves files before every dispatch', () => {
  it('hands the provider call the resolved request, for the model the call settled on', async () => {
    const h = harness({ capabilities: { vision: true }, files: [fileRow('f1', 'image/png', PNG.length)], bytes: { 'key/f1': PNG } });
    const runner = new LlmChatRunnerHelper(
      {} as any,
      {} as any,
      { calculateProviderCost: () => 0 } as any,
      { warmOrg: async () => undefined } as any,
      // The model is settled from the vendor's list when the request names none.
      { resolve: async () => 'claude-sonnet-5', invalidate: () => undefined } as any,
      undefined,
      undefined,
      h.resolver,
    );
    const dispatched: any[] = [];
    jest.spyOn(runner, 'dispatchProviderCall').mockImplementation(async (_p: any, request: any) => {
      dispatched.push(request);
      return { message: { role: 'assistant', content: 'ok' }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, cost: 0 } as any;
    });
    const { model: _unset, ...request } = ask(ref('f1', 'image/png'));
    await runner.callWithRetries(provider(), request as any, { id: 'c1', organizationId: ORG } as any, []);
    expect(dispatched[0].model).toBe('claude-sonnet-5');
    expect(dispatched[0].messages[1].content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(h.cardQueries[0].vendorModelId).toBe('claude-sonnet-5');
  });
});
