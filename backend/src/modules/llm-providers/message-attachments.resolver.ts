import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LlmProvider, LlmProviderType } from '../../entities/llm-provider.entity';
import { MessageContent } from '../../entities/message.entity';
import { Model } from '../../entities/model.entity';
import { AgentFile } from '../../entities/file.entity';
import { StorageService } from '../files/storage.service';
import { MODEL_IMAGE_TYPES, sniffMediaType } from '../files/media-type';
import { ChatRequest } from './dto/llm-providers.dto';
import { fileFallbackText, hasFileParts } from './content-parts';

/** What a model takes besides text, as its catalog card records it. */
export interface ModelInputs {
  image: boolean;
  pdf: boolean;
}

const TEXT_ONLY: ModelInputs = { image: false, pdf: false };

/**
 * Turns the files a message refers to into what the model answering can
 * read.
 *
 * A user message keeps a file as a reference (`{type: 'file', fileId}`,
 * message.entity.ts). Which model answers is only settled at dispatch --
 * a routed call picks it per candidate -- so this runs there, once the
 * provider and model are known, for the explicit and the routed path
 * alike, and for the workflow engine and the autonomous runtime alike
 * since both reach the model through the same runner.
 *
 * Whether the model takes images or PDFs is read off its catalog card
 * (`capabilities.vision`, `capabilities.pdfInput`): registry data, set by
 * the price feed or on the card, never a list of model names here. A model
 * with no card, or a card that does not say so, gets the text fallback:
 * the file's extracted text, or a sentence saying what was sent and that
 * this model cannot open it.
 *
 * Files are read from storage scoped to the call's organization, so a
 * reference can only ever reach the organization's own files. The bytes
 * are checked against their content rather than the stored type, capped
 * per file and per request, and exist only in the outgoing request.
 */
@Injectable()
export class MessageAttachmentResolver {
  private readonly logger = new Logger(MessageAttachmentResolver.name);

  /** Anthropic's per-image ceiling, the tightest of the vendors'. */
  static readonly MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  /** One PDF. */
  static readonly MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
  /** Every file one request carries, together; the rest go as text. */
  static readonly MAX_REQUEST_BYTES = 20 * 1024 * 1024;

  constructor(
    @InjectRepository(Model) private readonly models: Repository<Model>,
    @InjectRepository(AgentFile) private readonly files: Repository<AgentFile>,
    @Optional() private readonly storage?: StorageService,
  ) {}

  /**
   * The request with every file reference resolved. Unchanged (the same
   * object) when no message refers to a file, which is nearly every call,
   * so the common path costs one scan of the message list.
   */
  async resolve(organizationId: string | undefined, provider: LlmProvider, request: ChatRequest): Promise<ChatRequest> {
    if (!request.messages?.some((m) => hasFileParts(m.content))) return request;
    const inputs = organizationId ? await this.inputsFor(organizationId, provider, request.model) : TEXT_ONLY;
    const budget = { left: MessageAttachmentResolver.MAX_REQUEST_BYTES };
    const messages: ChatRequest['messages'] = [];
    for (const message of request.messages) {
      if (!hasFileParts(message.content)) {
        messages.push(message);
        continue;
      }
      const parts: MessageContent[] = [];
      for (const part of message.content as MessageContent[]) {
        parts.push(part?.type === 'file' ? await this.resolvePart(organizationId, part, inputs, budget) : part);
      }
      messages.push({ ...message, content: parts });
    }
    return { ...request, messages };
  }

  /**
   * What the model takes besides text. Only a wire format that can carry
   * a file asks the card at all: Perplexity's Agent API and a custom
   * endpoint in a non-OpenAI format take text alone, whatever the card says.
   */
  async inputsFor(organizationId: string, provider: LlmProvider, model: string | undefined): Promise<ModelInputs> {
    if (!model || !MessageAttachmentResolver.wireCarriesFiles(provider)) return TEXT_ONLY;
    try {
      const card = await this.models.findOne({
        where: { organizationId, providerId: provider.id, vendorModelId: model },
        select: { id: true, capabilities: true },
      });
      return {
        image: card?.capabilities?.vision === true,
        pdf: card?.capabilities?.pdfInput === true && MessageAttachmentResolver.wireCarriesDocuments(provider),
      };
    } catch (err: any) {
      this.logger.warn(`model card lookup failed, sending files as text: ${err?.message ?? err}`);
      return TEXT_ONLY;
    }
  }

  /**
   * Whether this provider's wire format carries a PDF as a document part.
   * The native Anthropic and Gemini formats do; on the chat-completions
   * format only OpenAI's own API, Azure OpenAI and OpenRouter document the
   * `file` part, and another OpenAI-compatible server may refuse the whole
   * request over it, so there a PDF goes as text whatever the card says.
   * Like every capability here, this is scoped to the protocol, not the
   * model (docs/models.md).
   */
  static wireCarriesDocuments(provider: LlmProvider): boolean {
    return [
      LlmProviderType.ANTHROPIC,
      LlmProviderType.GOOGLE,
      LlmProviderType.OPENAI,
      LlmProviderType.AZURE_OPENAI,
      LlmProviderType.OPENROUTER,
    ].includes(provider.type);
  }

  /** Whether this provider's wire format carries anything but text (an image, at least). */
  static wireCarriesFiles(provider: LlmProvider): boolean {
    if (provider.type === LlmProviderType.PERPLEXITY) return false;
    if (provider.type === LlmProviderType.CUSTOM) {
      return (provider.configuration?.custom?.requestFormat || 'openai') === 'openai';
    }
    return true;
  }

  private async resolvePart(
    organizationId: string | undefined,
    part: MessageContent,
    inputs: ModelInputs,
    budget: { left: number },
  ): Promise<MessageContent> {
    const fallback: MessageContent = { type: 'text', text: fileFallbackText(part) };
    const declared = part.mimeType ?? '';
    const wantsImage = inputs.image && MODEL_IMAGE_TYPES.has(declared);
    const wantsPdf = inputs.pdf && declared === 'application/pdf';
    if (!organizationId || !part.fileId || !this.storage || (!wantsImage && !wantsPdf)) return fallback;

    const cap = wantsImage ? MessageAttachmentResolver.MAX_IMAGE_BYTES : MessageAttachmentResolver.MAX_DOCUMENT_BYTES;
    try {
      const file = await this.files.findOne({ where: { id: part.fileId, organizationId } });
      if (!file) return { type: 'text', text: `(${part.name ?? 'An attachment'} is no longer available.)` };
      if (file.size > cap || file.size > budget.left) return fallback;
      const bytes = await this.storage.download(file.storageKey);
      if (bytes.length > cap || bytes.length > budget.left) return fallback;
      // The bytes decide, not the stored type: a vendor refuses an image
      // whose declared type does not match what it is.
      const actual = sniffMediaType(bytes);
      if (!actual || (wantsImage ? !MODEL_IMAGE_TYPES.has(actual) : actual !== 'application/pdf')) return fallback;
      budget.left -= bytes.length;
      return {
        type: wantsImage ? 'image' : 'document',
        mimeType: actual,
        name: part.name ?? file.name,
        data: bytes.toString('base64'),
      };
    } catch (err: any) {
      // The file id is logged, never its storage key or a link to it.
      this.logger.warn(`attachment ${part.fileId} not sent to the model: ${err?.message ?? err}`);
      return fallback;
    }
  }
}
