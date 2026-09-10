import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import { InjectRepository } from '@nestjs/typeorm';
import * as Redis from 'ioredis';
import { Repository } from 'typeorm';

import { Model, ModelPricing } from '../../../entities/model.entity';
import { LlmProviderType } from '../../../entities/llm-provider.entity';
import { AuditAction, AuditResource } from '../../../entities/audit-log.entity';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { callLlmProviderHttp } from '../../llm-providers/providers/safe-request';

/**
 * Automatic model prices for the catalog.
 *
 * Two public sources feed an in-memory map keyed by (providerType,
 * vendorModelId): the LiteLLM cost map (primary) and the OpenRouter
 * models API (cross-check). The hand table in llm-models.helper.ts is an
 * offline seed only; whenever this service has a quote it wins.
 *
 * The map is mirrored into Redis (7-day TTL) so a fresh replica prices
 * calls before its first scheduled refresh.
 */

export const LITELLM_COST_MAP_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

export const PRICE_FEED_CACHE_KEY = 'model_price_feed:v1';
export const PRICE_FEED_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Sources agree when both sides are within this fraction of LiteLLM's. */
export const PRICE_DISAGREEMENT_THRESHOLD = 0.25;

const FEED_TIMEOUT_MS = 20_000;
const MICRO = 1_000_000;

export type PriceFeedSource = 'feed:litellm' | 'feed:openrouter';

export interface FeedPrice {
  inPerMTok: number;
  outPerMTok: number;
  currency: 'USD';
  source: PriceFeedSource;
  contextLength?: number;
}

export interface PriceQuote {
  inPerMTok: number;
  outPerMTok: number;
  currency: 'USD';
  /** 'native' is only ever returned for local (Ollama) models, which are free. */
  source: PriceFeedSource | 'native';
  contextLength?: number;
  fetchedAt: Date;
  /** Set when OpenRouter prices the same model more than the threshold away. */
  disagreement?: {
    litellm: { inPerMTok: number; outPerMTok: number };
    openrouter: { inPerMTok: number; outPerMTok: number };
  };
}

export interface PriceFeedRefreshResult {
  litellm: number;
  openrouter: number;
  fetchedAt: Date;
}

export interface ApplyToCatalogResult {
  priced: number;
  unpriced: number;
  flagged: number;
}

interface ProviderFeedMapping {
  /** Values of LiteLLM's `litellm_provider` that belong to this provider type. */
  litellm: string[];
  /** OpenRouter id prefix, '' to take ids verbatim, null when OpenRouter has none. */
  openrouterPrefix: string | null;
}

/**
 * How each of our provider types shows up in the two feeds. Groq, Azure,
 * Bedrock, Together, Hugging Face and most of the OpenAI-compatible hosts
 * have no OpenRouter namespace, so only LiteLLM prices them. Ollama and
 * custom endpoints are not in any feed.
 */
export const PROVIDER_FEED_MAPPING: Record<LlmProviderType, ProviderFeedMapping | null> = {
  [LlmProviderType.OPENAI]: { litellm: ['openai'], openrouterPrefix: 'openai/' },
  [LlmProviderType.ANTHROPIC]: { litellm: ['anthropic'], openrouterPrefix: 'anthropic/' },
  [LlmProviderType.GOOGLE]: {
    litellm: ['gemini', 'vertex_ai-language-models'],
    openrouterPrefix: 'google/',
  },
  [LlmProviderType.MISTRAL]: { litellm: ['mistral'], openrouterPrefix: 'mistralai/' },
  [LlmProviderType.XAI]: { litellm: ['xai'], openrouterPrefix: 'x-ai/' },
  [LlmProviderType.DEEPSEEK]: { litellm: ['deepseek'], openrouterPrefix: 'deepseek/' },
  [LlmProviderType.GROQ]: { litellm: ['groq'], openrouterPrefix: null },
  [LlmProviderType.TOGETHER]: { litellm: ['together_ai'], openrouterPrefix: null },
  [LlmProviderType.OPENROUTER]: { litellm: ['openrouter'], openrouterPrefix: '' },
  [LlmProviderType.AZURE_OPENAI]: { litellm: ['azure'], openrouterPrefix: null },
  [LlmProviderType.AWS_BEDROCK]: {
    litellm: ['bedrock', 'bedrock_converse'],
    openrouterPrefix: null,
  },
  [LlmProviderType.COHERE]: { litellm: ['cohere', 'cohere_chat'], openrouterPrefix: 'cohere/' },
  [LlmProviderType.HUGGINGFACE]: { litellm: ['huggingface'], openrouterPrefix: null },
  // OpenAI-compatible inference hosts. LiteLLM keys are "<provider>/<vendor
  // model id>" (Fireworks: "fireworks_ai/accounts/fireworks/models/..."),
  // so stripping the first segment yields exactly the id the host's
  // /models returns. Only Perplexity and Z.ai have an OpenRouter namespace.
  [LlmProviderType.FIREWORKS]: { litellm: ['fireworks_ai'], openrouterPrefix: null },
  [LlmProviderType.CEREBRAS]: { litellm: ['cerebras'], openrouterPrefix: null },
  [LlmProviderType.DEEPINFRA]: { litellm: ['deepinfra'], openrouterPrefix: null },
  [LlmProviderType.NOVITA]: { litellm: ['novita'], openrouterPrefix: null },
  [LlmProviderType.PERPLEXITY]: { litellm: ['perplexity'], openrouterPrefix: 'perplexity/' },
  [LlmProviderType.ZAI]: { litellm: ['zai'], openrouterPrefix: 'z-ai/' },
  [LlmProviderType.BASETEN]: { litellm: ['baseten'], openrouterPrefix: null },
  [LlmProviderType.NEBIUS]: { litellm: ['nebius'], openrouterPrefix: null },
  [LlmProviderType.SAMBANOVA]: { litellm: ['sambanova'], openrouterPrefix: null },
  // First-party model families. LiteLLM keys checked against the live cost
  // map 2026-09-09: `moonshot` (24 chat entries), and `dashscope` /
  // `qwencloud` / `qwen_ai_platform` (45 each, byte-identical mirrors of one
  // catalog). `moonshot_ai` and `qwen` do not exist as feed keys.
  [LlmProviderType.MOONSHOT]: { litellm: ['moonshot'], openrouterPrefix: 'moonshotai/' },
  // Verified against the live cost map 2026-09-10: `minimax` carries six
  // chat entries under a `minimax/` prefix. Upstage and Writer are absent
  // from it entirely, so their models stay unpriced rather than borrowing
  // a number from somebody else's hosting of the same weights.
  [LlmProviderType.MINIMAX]: { litellm: ['minimax'], openrouterPrefix: 'minimax/' },
  [LlmProviderType.UPSTAGE]: null,
  [LlmProviderType.WRITER]: null,
  [LlmProviderType.QWEN]: { litellm: ['dashscope', 'qwencloud', 'qwen_ai_platform'], openrouterPrefix: 'qwen/' },
  // Cloud and serverless call targets. Vertex prices under its own
  // namespaces (the partner ones cover Model Garden). Foundry serves the
  // customer's deployments, which are priced by the underlying model, and
  // DigitalOcean / RunPod / Modal have no LiteLLM namespace at all - those
  // stay unpriced rather than borrowing another vendor's list price.
  [LlmProviderType.VERTEX_AI]: {
    litellm: ['vertex_ai-language-models', 'vertex_ai-moonshot_models', 'vertex_ai-qwen_models'],
    openrouterPrefix: null,
  },
  [LlmProviderType.AZURE_AI_FOUNDRY]: { litellm: ['azure_ai'], openrouterPrefix: null },
  [LlmProviderType.DIGITALOCEAN]: null,
  [LlmProviderType.RUNPOD]: null,
  [LlmProviderType.MODAL]: null,
  [LlmProviderType.OLLAMA]: null,
  [LlmProviderType.CUSTOM]: null,
};

interface NormalisedFeed {
  map: Map<string, FeedPrice>;
  count: number;
}

interface CachedFeed {
  fetchedAt: string;
  counts?: { litellm: number; openrouter: number };
  litellm: Array<[string, FeedPrice]>;
  openrouter: Array<[string, FeedPrice]>;
}

/**
 * Snapshot alias rule: trailing dash-separated segments of two or more
 * digits are a date or build stamp, not a version, so
 * "claude-sonnet-4-20250514" and "gpt-4o-2024-08-06" alias to
 * "claude-sonnet-4" and "gpt-4o". A single-digit segment ("-4", "-1") is a
 * version and stops the strip, so "claude-opus-4-1" keeps its "-1".
 * Returns null when the id carries no snapshot suffix.
 */
export function snapshotAlias(id: string): string | null {
  const parts = id.split('-');
  let end = parts.length;
  while (end > 1 && /^\d{2,}$/.test(parts[end - 1])) end -= 1;
  if (end === parts.length) return null;
  return parts.slice(0, end).join('-');
}

function feedKey(providerType: string, vendorModelId: string): string {
  return `${providerType}::${vendorModelId.toLowerCase()}`;
}

function perTokenToPerMTok(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  // Round to a millionth of a dollar per million tokens so equal feed values compare equal.
  return Math.round(n * MICRO * MICRO) / MICRO;
}

function relativeGap(reference: number, other: number): number {
  if (reference === 0 && other === 0) return 0;
  if (reference === 0) return Infinity;
  return Math.abs(other - reference) / reference;
}

@Injectable()
export class PriceFeedService implements OnModuleInit {
  private readonly logger = new Logger(PriceFeedService.name);

  private litellm = new Map<string, FeedPrice>();
  private openrouter = new Map<string, FeedPrice>();
  private fetchedAt: Date | null = null;
  /** Distinct models per source, as opposed to index entries (bare, stripped and alias keys). */
  private sourceCounts = { litellm: 0, openrouter: 0 };

  constructor(
    @InjectRepository(Model)
    private readonly modelRepository: Repository<Model>,
    @Optional()
    @InjectRedis()
    private readonly redis?: Redis.Redis,
    @Optional()
    @Inject(AuditLogService)
    private readonly auditLog?: AuditLogService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.loadFromCache();
  }

  /** True once either source has been loaded, from the network or from Redis. */
  hasData(): boolean {
    return this.litellm.size > 0 || this.openrouter.size > 0;
  }

  isDisabled(): boolean {
    return process.env.MODEL_PRICE_FEED_DISABLED?.trim().toLowerCase() === 'true';
  }

  /**
   * Fetch both sources. Each is independent: a failed source keeps its
   * previous entries so one outage never wipes the other's prices. Throws
   * only when neither source produced anything and nothing was loaded before.
   */
  async refresh(): Promise<PriceFeedRefreshResult> {
    if (this.isDisabled()) {
      this.logger.log('Model price feed disabled (MODEL_PRICE_FEED_DISABLED=true), skipping network');
      return this.counts();
    }

    const [litellmResult, openrouterResult] = await Promise.allSettled([
      this.fetchLiteLlm(),
      this.fetchOpenRouter(),
    ]);

    const errors: string[] = [];
    if (litellmResult.status === 'fulfilled') {
      this.litellm = litellmResult.value.map;
      this.sourceCounts.litellm = litellmResult.value.count;
    } else {
      errors.push(`litellm: ${litellmResult.reason?.message ?? litellmResult.reason}`);
    }
    if (openrouterResult.status === 'fulfilled') {
      this.openrouter = openrouterResult.value.map;
      this.sourceCounts.openrouter = openrouterResult.value.count;
    } else {
      errors.push(`openrouter: ${openrouterResult.reason?.message ?? openrouterResult.reason}`);
    }

    if (errors.length === 2 && !this.hasData()) {
      throw new Error(`Model price feed refresh failed: ${errors.join('; ')}`);
    }
    for (const err of errors) this.logger.warn(`Model price feed source failed, keeping previous entries (${err})`);

    this.fetchedAt = new Date();
    await this.saveToCache();

    const result = this.counts();
    this.logger.log(
      `Model price feed refreshed: ${result.litellm} litellm, ${result.openrouter} openrouter entries`,
    );
    return result;
  }

  /**
   * LiteLLM first; when OpenRouter also prices the model and either side
   * differs by more than the threshold, the quote carries a disagreement
   * but still returns LiteLLM's numbers.
   */
  lookup(providerType: string, vendorModelId: string): PriceQuote | null {
    if (!providerType || !vendorModelId) return null;
    const fetchedAt = this.fetchedAt ?? new Date(0);

    if (providerType === LlmProviderType.OLLAMA) {
      return { inPerMTok: 0, outPerMTok: 0, currency: 'USD', source: 'native', fetchedAt };
    }

    const primary = this.find(this.litellm, providerType, vendorModelId);
    const secondary = this.find(this.openrouter, providerType, vendorModelId);
    const hit = primary ?? secondary;
    if (!hit) return null;

    const quote: PriceQuote = { ...hit, fetchedAt };
    if (primary && secondary) {
      const inGap = relativeGap(primary.inPerMTok, secondary.inPerMTok);
      const outGap = relativeGap(primary.outPerMTok, secondary.outPerMTok);
      if (inGap > PRICE_DISAGREEMENT_THRESHOLD || outGap > PRICE_DISAGREEMENT_THRESHOLD) {
        quote.disagreement = {
          litellm: { inPerMTok: primary.inPerMTok, outPerMTok: primary.outPerMTok },
          openrouter: { inPerMTok: secondary.inPerMTok, outPerMTok: secondary.outPerMTok },
        };
      }
    }
    return quote;
  }

  /**
   * Write feed prices onto every card that has a provider type and no
   * operator override. Cards the feed cannot price become 'unpriced' so a
   * missing price is visible, never a silent zero.
   */
  async applyToCatalog(organizationId?: string): Promise<ApplyToCatalogResult> {
    const rows = await this.modelRepository.find({
      where: organizationId ? { organizationId } : {},
    });

    const totals: ApplyToCatalogResult = { priced: 0, unpriced: 0, flagged: 0 };
    const perOrg = new Map<string, ApplyToCatalogResult>();
    const fetchedAt = this.fetchedAt ?? new Date();

    for (const row of rows) {
      // An override is the operator's word; the feed never touches it.
      if (row.pricingOverride || !row.providerType) continue;

      const orgCounts = perOrg.get(row.organizationId) ?? { priced: 0, unpriced: 0, flagged: 0 };
      perOrg.set(row.organizationId, orgCounts);

      const quote = this.lookup(row.providerType, row.vendorModelId);
      const next: Partial<Model> = {};

      if (quote) {
        next.pricing = {
          inPerMTok: quote.inPerMTok,
          outPerMTok: quote.outPerMTok,
          currency: quote.currency,
        };
        next.pricingSource = quote.source;
        next.pricingFetchedAt = quote.fetchedAt;
        if (row.contextLength == null && quote.contextLength) {
          next.contextLength = quote.contextLength;
        }
        orgCounts.priced += 1;
        totals.priced += 1;
        if (quote.disagreement) {
          orgCounts.flagged += 1;
          totals.flagged += 1;
        }
      } else {
        next.pricing = null;
        next.pricingSource = 'unpriced';
        next.pricingFetchedAt = fetchedAt;
        orgCounts.unpriced += 1;
        totals.unpriced += 1;
      }

      const metadata = { ...(row.metadata ?? {}) };
      if (quote?.disagreement) {
        metadata.pricingDisagreement = quote.disagreement;
      } else {
        delete metadata.pricingDisagreement;
      }
      next.metadata = Object.keys(metadata).length > 0 ? metadata : null;

      if (this.cardChanged(row, next)) {
        Object.assign(row, next);
        await this.modelRepository.save(row);
      }
    }

    for (const [orgId, counts] of perOrg) {
      // Fire-and-forget: the audit trail must never fail the refresh.
      void this.auditLog
        ?.log({
          organizationId: orgId,
          action: AuditAction.MODEL_PRICE_UPDATED,
          resourceType: AuditResource.MODEL,
          resourceId: 'feed',
          resourceName: 'model price feed',
          details: { ...counts, fetchedAt: fetchedAt.toISOString() },
        })
        .catch(() => undefined);
    }

    return totals;
  }

  private counts(): PriceFeedRefreshResult {
    return {
      litellm: this.sourceCounts.litellm,
      openrouter: this.sourceCounts.openrouter,
      fetchedAt: this.fetchedAt ?? new Date(0),
    };
  }

  /** Save only when a field actually moved, so versioned rows do not churn. */
  private cardChanged(row: Model, next: Partial<Model>): boolean {
    const samePricing = (a: ModelPricing | null, b: ModelPricing | null) =>
      (a == null && b == null) ||
      (!!a && !!b && a.inPerMTok === b.inPerMTok && a.outPerMTok === b.outPerMTok && a.currency === b.currency);
    if (row.pricingSource !== next.pricingSource) return true;
    if (!samePricing(row.pricing, next.pricing ?? null)) return true;
    if (next.contextLength !== undefined && row.contextLength !== next.contextLength) return true;
    if (JSON.stringify(row.metadata ?? null) !== JSON.stringify(next.metadata ?? null)) return true;
    const previous = row.pricingFetchedAt ? new Date(row.pricingFetchedAt).getTime() : null;
    if (next.pricingSource === 'unpriced') {
      // Record the first time the feed looked; later misses leave the row alone.
      return previous === null;
    }
    // A fresh fetch stamps a new fetchedAt on every priced row.
    return previous !== (next.pricingFetchedAt as Date).getTime();
  }

  /**
   * Exact id, then the id's snapshot alias. Maps are built so that the
   * alias of every feed key is indexed too, which covers the reverse
   * direction (card says "claude-sonnet-4", feed only has the dated id).
   */
  private find(map: Map<string, FeedPrice>, providerType: string, vendorModelId: string): FeedPrice | null {
    const exact = map.get(feedKey(providerType, vendorModelId));
    if (exact) return exact;
    const alias = snapshotAlias(vendorModelId);
    if (alias) {
      const aliased = map.get(feedKey(providerType, alias));
      if (aliased) return aliased;
    }
    return null;
  }

  private litellmProviderIndex(): Map<string, LlmProviderType> {
    const index = new Map<string, LlmProviderType>();
    for (const [type, mapping] of Object.entries(PROVIDER_FEED_MAPPING)) {
      for (const name of mapping?.litellm ?? []) index.set(name, type as LlmProviderType);
    }
    return index;
  }

  private async fetchLiteLlm(): Promise<NormalisedFeed> {
    const url = process.env.MODEL_PRICE_FEED_LITELLM_URL?.trim() || LITELLM_COST_MAP_URL;
    const response = await callLlmProviderHttp<Record<string, any>>({
      method: 'GET',
      url,
      timeout: FEED_TIMEOUT_MS,
    });
    return this.normaliseLiteLlm(response.data ?? {});
  }

  /**
   * LiteLLM keys are "model", "provider/model" or even
   * "openrouter/vendor/model". Both the bare key and the key minus its
   * first path segment are indexed so a card's vendorModelId matches
   * whichever form the vendor uses. Bare keys are inserted first and win
   * over a stripped key that collides with them.
   */
  normaliseLiteLlm(data: Record<string, any>): NormalisedFeed {
    const providerIndex = this.litellmProviderIndex();
    const map = new Map<string, FeedPrice>();
    const entries: Array<{ type: LlmProviderType; id: string; price: FeedPrice }> = [];

    for (const [key, raw] of Object.entries(data)) {
      if (!raw || typeof raw !== 'object' || key === 'sample_spec') continue;
      const type = providerIndex.get(String(raw.litellm_provider ?? ''));
      if (!type) continue;
      const inPerMTok = perTokenToPerMTok(raw.input_cost_per_token);
      const outPerMTok = perTokenToPerMTok(raw.output_cost_per_token);
      if (inPerMTok === null || outPerMTok === null) continue;
      const price: FeedPrice = { inPerMTok, outPerMTok, currency: 'USD', source: 'feed:litellm' };
      const contextLength = Number(raw.max_input_tokens);
      if (Number.isFinite(contextLength) && contextLength > 0) price.contextLength = contextLength;
      entries.push({ type, id: key, price });
    }

    const count = entries.length;
    for (const { type, id, price } of entries) map.set(feedKey(type, id), price);
    for (const { type, id, price } of entries) {
      const slash = id.indexOf('/');
      if (slash > 0) this.setIfAbsent(map, feedKey(type, id.slice(slash + 1)), price);
    }
    this.indexAliases(map);
    return { map, count };
  }

  private async fetchOpenRouter(): Promise<NormalisedFeed> {
    const url = process.env.MODEL_PRICE_FEED_OPENROUTER_URL?.trim() || OPENROUTER_MODELS_URL;
    const response = await callLlmProviderHttp<{ data?: any[] }>({
      method: 'GET',
      url,
      timeout: FEED_TIMEOUT_MS,
    });
    return this.normaliseOpenRouter(response.data?.data ?? []);
  }

  /**
   * OpenRouter ids are "vendor/model". They are indexed verbatim for our
   * OpenRouter provider type and, minus the vendor prefix, for the vendor's
   * own provider type as a cross-check against LiteLLM.
   */
  normaliseOpenRouter(models: any[]): NormalisedFeed {
    const map = new Map<string, FeedPrice>();
    let count = 0;
    for (const model of models) {
      const id = typeof model?.id === 'string' ? model.id : null;
      if (!id) continue;
      const inPerMTok = perTokenToPerMTok(model.pricing?.prompt);
      const outPerMTok = perTokenToPerMTok(model.pricing?.completion);
      if (inPerMTok === null || outPerMTok === null) continue;
      const price: FeedPrice = { inPerMTok, outPerMTok, currency: 'USD', source: 'feed:openrouter' };
      const contextLength = Number(model.context_length);
      if (Number.isFinite(contextLength) && contextLength > 0) price.contextLength = contextLength;
      count += 1;

      for (const [type, mapping] of Object.entries(PROVIDER_FEED_MAPPING)) {
        const prefix = mapping?.openrouterPrefix;
        if (prefix === null || prefix === undefined) continue;
        if (prefix === '') {
          map.set(feedKey(type, id), price);
        } else if (id.toLowerCase().startsWith(prefix)) {
          map.set(feedKey(type, id.slice(prefix.length)), price);
        }
      }
    }
    this.indexAliases(map);
    return { map, count };
  }

  /**
   * Register every key's snapshot alias so a card without a date matches
   * a dated feed entry. When several snapshots share an alias the greatest
   * key wins, which for date stamps is the newest.
   */
  private indexAliases(map: Map<string, FeedPrice>): void {
    const aliases = new Map<string, { key: string; price: FeedPrice }>();
    for (const [key, price] of map) {
      const sep = key.indexOf('::');
      const alias = snapshotAlias(key.slice(sep + 2));
      if (!alias) continue;
      const aliasKey = `${key.slice(0, sep)}::${alias}`;
      if (map.has(aliasKey)) continue;
      const current = aliases.get(aliasKey);
      if (!current || key > current.key) aliases.set(aliasKey, { key, price });
    }
    for (const [aliasKey, { price }] of aliases) map.set(aliasKey, price);
  }

  private setIfAbsent(map: Map<string, FeedPrice>, key: string, price: FeedPrice): void {
    if (!map.has(key)) map.set(key, price);
  }

  private async loadFromCache(): Promise<void> {
    if (!this.redis) return;
    try {
      const raw = await this.redis.get(PRICE_FEED_CACHE_KEY);
      if (!raw) return;
      const cached = JSON.parse(raw) as CachedFeed;
      this.litellm = new Map(cached.litellm ?? []);
      this.openrouter = new Map(cached.openrouter ?? []);
      this.sourceCounts = cached.counts ?? { litellm: this.litellm.size, openrouter: this.openrouter.size };
      this.fetchedAt = cached.fetchedAt ? new Date(cached.fetchedAt) : null;
      this.logger.log(
        `Model price feed loaded from cache: ${this.litellm.size} litellm, ${this.openrouter.size} openrouter entries`,
      );
    } catch (error: any) {
      // A cold start without prices is recoverable; a crash at boot is not.
      this.logger.warn(`Model price feed cache unreadable: ${error.message}`);
    }
  }

  private async saveToCache(): Promise<void> {
    if (!this.redis) return;
    const payload: CachedFeed = {
      fetchedAt: (this.fetchedAt ?? new Date()).toISOString(),
      counts: { ...this.sourceCounts },
      litellm: Array.from(this.litellm.entries()),
      openrouter: Array.from(this.openrouter.entries()),
    };
    try {
      await this.redis.setex(PRICE_FEED_CACHE_KEY, PRICE_FEED_CACHE_TTL_SECONDS, JSON.stringify(payload));
    } catch (error: any) {
      this.logger.warn(`Model price feed cache write failed: ${error.message}`);
    }
  }
}
