import { callOpenAI, callOpenAIStream } from '../providers/openai.provider';
import { callAnthropic, callAnthropicStream } from '../providers/anthropic.provider';
import { callGoogle, callCustomProvider } from '../providers/google.provider';
import { buildPerplexityInput } from '../providers/perplexity.provider';
import * as safeRequest from '../providers/safe-request';
import { LlmProviderType } from '../../../entities/llm-provider.entity';
import { contentAsText, fileFallbackText, toAnthropicContent, toGeminiParts, toOpenAIContent } from '../content-parts';

/**
 * Files in a user message, in each vendor's wire shape.
 *
 * The resolver (message-attachments.resolver.ts) has already turned file
 * references into `image` / `document` parts with base64 bytes, or into
 * text. What goes on the wire is read off the request each provider module
 * hands the HTTP layer, which is faked here; nothing leaves the process.
 */
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
const PDF_B64 = Buffer.from('%PDF-1.7').toString('base64');

const withFiles = () => [
  { role: 'system', content: 'You are helpful.' },
  {
    role: 'user',
    content: [
      { type: 'text', text: 'Is this damaged?\n\n[Attachment: box.png (image/png, 2 KB)]' },
      { type: 'image', mimeType: 'image/png', name: 'box.png', data: PNG_B64 },
      { type: 'document', mimeType: 'application/pdf', name: 'invoice.pdf', data: PDF_B64 },
    ],
  },
];

const conversation: any = { id: 'c1', context: {} };

function openAiProvider(): any {
  return {
    type: LlmProviderType.OPENAI,
    getApiUrl: () => 'https://api.openai.com/v1',
    getAuthHeaders: () => ({ Authorization: 'Bearer sk-test' }),
    configuration: { model: 'gpt-5' },
  };
}

function anthropicProvider(): any {
  return {
    type: LlmProviderType.ANTHROPIC,
    getApiUrl: () => 'https://api.anthropic.com/v1',
    getAuthHeaders: () => ({ 'x-api-key': 'sk-ant-test' }),
    configuration: { model: 'claude-sonnet-5' },
  };
}

describe('files on the wire, per vendor', () => {
  let sent: any[];
  beforeEach(() => {
    sent = [];
    jest.spyOn(safeRequest, 'callLlmProviderHttp').mockImplementation(async (cfg: any) => {
      sent.push(cfg.data);
      if (String(cfg.url).includes('generateContent')) {
        return { data: { candidates: [{ content: { parts: [{ text: 'ok' }] } }], usageMetadata: {} } } as any;
      }
      if (String(cfg.url).includes('anthropic')) {
        return { data: { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 }, model: 'claude-sonnet-5' } } as any;
      }
      return {
        data: { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, model: 'gpt-5' },
      } as any;
    });
    jest.spyOn(safeRequest, 'callLlmProviderHttpStream').mockImplementation(async (cfg: any) => {
      sent.push(cfg.data);
      throw new Error('stop here: the body is what this test reads');
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('OpenAI chat completions: an image_url data URL and a file part', async () => {
    await callOpenAI(openAiProvider(), { messages: withFiles() } as any, conversation, [], Date.now(), () => 0);
    const user = sent[0].messages[1];
    expect(user.content).toEqual([
      { type: 'text', text: 'Is this damaged?\n\n[Attachment: box.png (image/png, 2 KB)]' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } },
      { type: 'file', file: { filename: 'invoice.pdf', file_data: `data:application/pdf;base64,${PDF_B64}` } },
    ]);
    // A plain turn keeps its plain string.
    expect(sent[0].messages[0].content).toBe('You are helpful.');
  });

  it('OpenAI streaming builds the same parts', async () => {
    await expect(
      callOpenAIStream(openAiProvider(), { messages: withFiles() } as any, conversation, [], Date.now(), () => 0, () => undefined),
    ).rejects.toThrow('stop here');
    expect(sent[0].messages[1].content[1]).toEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } });
  });

  it('Anthropic Messages: image and document blocks with a base64 source, system kept apart', async () => {
    await callAnthropic(anthropicProvider(), { messages: withFiles() } as any, conversation, [], Date.now(), () => 0);
    expect(sent[0].system).toBe('You are helpful.');
    expect(sent[0].messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Is this damaged?\n\n[Attachment: box.png (image/png, 2 KB)]' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF_B64 } },
        ],
      },
    ]);
  });

  it('Anthropic streaming builds the same blocks', async () => {
    await expect(
      callAnthropicStream(anthropicProvider(), { messages: withFiles() } as any, conversation, [], Date.now(), () => 0, () => undefined),
    ).rejects.toThrow('stop here');
    expect(sent[0].messages[0].content[2]).toEqual({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF_B64 } });
  });

  it('Gemini generateContent: inline_data parts', async () => {
    const provider: any = {
      getApiUrl: () => 'https://generativelanguage.googleapis.com/v1beta',
      getDecryptedApiKey: () => 'k',
      configuration: { model: 'gemini-2.5-flash' },
    };
    await callGoogle(provider, { messages: withFiles() } as any, conversation, [], Date.now(), () => 0);
    expect(sent[0].contents[1].parts).toEqual([
      { text: 'Is this damaged?\n\n[Attachment: box.png (image/png, 2 KB)]' },
      { inline_data: { mime_type: 'image/png', data: PNG_B64 } },
      { inline_data: { mime_type: 'application/pdf', data: PDF_B64 } },
    ]);
  });

  it('Perplexity takes text alone: a file reference becomes its fallback, never an object', () => {
    const { input } = buildPerplexityInput({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Summarise' },
            { type: 'file', fileId: 'f1', mimeType: 'text/plain', name: 'notes.txt', text: 'Ship Monday.' },
          ],
        },
      ],
    } as any);
    expect(input[0].content).toBe('Summarise\nContents of notes.txt:\nShip Monday.');
  });

  it('a custom endpoint in its own format gets text: the fallback, not the bytes', async () => {
    const provider: any = {
      getApiUrl: () => 'https://llm.example/generate',
      getAuthHeaders: () => ({}),
      configuration: { model: 'm', custom: { requestFormat: 'custom' } },
    };
    await callCustomProvider(
      provider,
      {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'file', fileId: 'f1', mimeType: 'image/png', name: 'box.png' }] },
        ],
      } as any,
      conversation,
      [],
      Date.now(),
    ).catch(() => undefined);
    expect(sent[0].prompt).toBe('Look\n\n(box.png is an image; the model answering cannot view images.)');
    expect(JSON.stringify(sent[0])).not.toContain('fileId');
  });
});

describe('content parts', () => {
  it('a file reference no resolver saw becomes its text fallback on every vendor shape', () => {
    const content = [{ type: 'text' as const, text: 'See' }, { type: 'file' as const, fileId: 'f1', mimeType: 'application/pdf', name: 'a.pdf' }];
    const fallback = '(a.pdf is a PDF; the model answering cannot read PDF files.)';
    expect(toOpenAIContent(content)).toBe(`See\n\n${fallback}`);
    expect(toAnthropicContent(content)).toBe(`See\n\n${fallback}`);
    expect(toGeminiParts(content)).toEqual([{ text: `See\n\n${fallback}` }]);
  });

  it('the fallback reads a file\'s text when it has one, else says what it is', () => {
    expect(fileFallbackText({ type: 'file', name: 'n.txt', mimeType: 'text/plain', text: 'hello' })).toBe('Contents of n.txt:\nhello');
    expect(fileFallbackText({ type: 'file', name: 'p.png', mimeType: 'image/png' })).toBe('(p.png is an image; the model answering cannot view images.)');
    expect(fileFallbackText({ type: 'file', name: 'x.bin', mimeType: 'application/octet-stream' })).toBe('(x.bin was attached; its contents are not readable here.)');
    // A name is one line.
    expect(fileFallbackText({ type: 'file', name: 'a\nb.png', mimeType: 'image/png' })).toContain('(a b.png is');
  });

  it('keeps strings strings, and flattens text-only part lists', () => {
    expect(toOpenAIContent('hi')).toBe('hi');
    expect(toAnthropicContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\n\nb');
    expect(contentAsText(null)).toBe('');
  });

  it('an image link (no bytes) goes as a link where the vendor takes one, and as text on Gemini', () => {
    const content = [{ type: 'image' as const, imageUrl: 'https://cdn.example/a.png', mimeType: 'image/png' }];
    expect(toOpenAIContent(content)).toEqual([{ type: 'image_url', image_url: { url: 'https://cdn.example/a.png' } }]);
    expect(toAnthropicContent(content)).toEqual([{ type: 'image', source: { type: 'url', url: 'https://cdn.example/a.png' } }]);
    expect(toGeminiParts(content)).toEqual([{ text: '[image]' }]);
  });
});
