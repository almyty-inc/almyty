jest.mock('../../llm-providers/providers/safe-request', () => ({
  ...jest.requireActual('../../llm-providers/providers/safe-request'),
  callLlmProviderHttpStream: jest.fn(),
}));

import { anthropicText, mainModelConfig, openaiText, runAgent } from './autonomous-harness';
import { MessageAttachmentResolver } from '../../llm-providers/message-attachments.resolver';
import { withAttachedFiles } from '../attached-files';
import { AgentRunStatus } from '../../../entities/agent-run.entity';

/**
 * A file someone sent, through an autonomous run: the user message keeps a
 * reference to the stored file, and the model call that answers gets the
 * file itself when the model's card says it takes it, or a sentence saying
 * what was sent. Everything but the provider's socket, the catalog card,
 * the file row and the stored bytes is the production code.
 */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 3)]);
const MAIN = { key: 'main', name: 'Main', purpose: 'main', kind: 'model', providerId: 'p-strong', model: 'claude-sonnet-5' } as const;
const CHEAP_MAIN = { key: 'main', name: 'Main', purpose: 'main', kind: 'model', providerId: 'p-cheap', model: 'gpt-4o-mini' } as const;

const QUESTION = 'Is this box damaged?\n\n[Attachment: box.png (image/png, 108 B)]';
const userMessage = withAttachedFiles(QUESTION, [{ type: 'file', fileId: 'f-box', mimeType: 'image/png', name: 'box.png', size: PNG.length }]);

function resolverWith(capabilities: Record<string, boolean>) {
  const cardsAsked: any[] = [];
  const resolver = new MessageAttachmentResolver(
    { findOne: async (q: any) => (cardsAsked.push(q.where), { id: 'card', capabilities }) } as any,
    {
      findOne: async (q: any) =>
        q.where.id === 'f-box' && q.where.organizationId === 'org-1'
          ? { id: 'f-box', organizationId: 'org-1', name: 'box.png', mimeType: 'image/png', size: PNG.length, storageKey: 'org-1/agent-1/f-box/box.png' }
          : null,
    } as any,
    { download: async (key: string) => (key === 'org-1/agent-1/f-box/box.png' ? PNG : Buffer.alloc(0)) } as any,
  );
  return { resolver, cardsAsked };
}

const userTurn = (body: any) => body.messages.find((m: any) => m.role === 'user');

describe('files someone sent, at run time', () => {
  it('a model whose card says vision is sent the photo itself (Anthropic image block)', async () => {
    const { resolver, cardsAsked } = resolverWith({ vision: true });
    const seen = await runAgent({
      models: { strategy: 'single', roles: [MAIN] } as any,
      modelConfig: mainModelConfig,
      streams: { 'claude-sonnet-5': [anthropicText('claude-sonnet-5', 120, ['Yes, the corner is crushed.'], 8)] },
      userMessage,
      attachmentResolver: resolver,
    });

    expect(seen.run.status).toBe(AgentRunStatus.COMPLETED);
    expect(userTurn(seen.bodies[0].body).content).toEqual([
      { type: 'text', text: QUESTION },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } },
    ]);
    // The card asked is the answering model's, on its provider.
    expect(cardsAsked).toEqual([{ organizationId: 'org-1', providerId: 'p-strong', vendorModelId: 'claude-sonnet-5' }]);
    // The transcript keeps the text and the reference, never the bytes.
    expect(seen.visible[0]).toEqual(['user', QUESTION]);
    const stored = (await seen.runRepository.findOne({ where: { id: 'run-1' } })) as any;
    expect(JSON.stringify(stored)).not.toContain(PNG.toString('base64'));
  });

  it('a model whose card does not say vision reads what was sent, not a picture it cannot see', async () => {
    const { resolver } = resolverWith({ tools: true });
    const seen = await runAgent({
      models: { strategy: 'single', roles: [MAIN] } as any,
      modelConfig: mainModelConfig,
      streams: { 'claude-sonnet-5': [anthropicText('claude-sonnet-5', 60, ['I cannot see images here.'], 6)] },
      userMessage,
      attachmentResolver: resolver,
    });
    expect(userTurn(seen.bodies[0].body).content).toBe(
      `${QUESTION}\n\n(box.png is an image; the model answering cannot view images.)`,
    );
  });

  it('an OpenAI-shaped model with vision gets an image_url data URL', async () => {
    const { resolver } = resolverWith({ vision: true });
    const seen = await runAgent({
      models: { strategy: 'single', roles: [CHEAP_MAIN] } as any,
      modelConfig: { providerId: 'p-cheap', model: 'gpt-4o-mini' },
      streams: { 'gpt-4o-mini': [openaiText('gpt-4o-mini', 90, ['Crushed corner.'], 4)] },
      userMessage,
      attachmentResolver: resolver,
    });
    expect(userTurn(seen.bodies[0].body).content).toEqual([
      { type: 'text', text: QUESTION },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } },
    ]);
  });
});
