import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ProviderUsageSnapshot } from '../../entities/provider-usage-snapshot.entity';
import { Conversation } from '../../entities/conversation.entity';
import {
  LlmProvider,
  LlmProviderType,
} from '../../entities/llm-provider.entity';
import {
  ProviderUsageCapability,
  providerUsageCapability,
} from './provider-usage.capability';

/** One normalized daily usage/cost bucket, provider-agnostic. */
export interface NormalizedUsageBucket {
  /** UTC start of the day bucket. */
  periodStart: Date;
  /** Exclusive end (periodStart + 1 day). */
  periodEnd: Date;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Provider-reported cost, integer cents. */
  costCents: number;
  currency: string;
  raw?: Record<string, any>;
}

export interface FetchUsageResult {
  supported: boolean;
  capability: ProviderUsageCapability;
  buckets: NormalizedUsageBucket[];
  /** Set when a supported fetch failed (network / auth / parse). */
  error?: string;
}

export interface ReconciliationRow {
  llmProviderId: string;
  providerName: string;
  providerType: string;
  capabilitySupported: boolean;
  /** Our internal estimate for the window, integer cents. */
  estimateCents: number;
  estimateTokens: number;
  /** Provider-actual for the window (null when no snapshots / unsupported). */
  actualCents: number | null;
  actualTokens: number | null;
  /** actualCents - estimateCents, null when no actual. */
  deltaCents: number | null;
  /** delta as a percentage of the estimate, null when not computable. */
  deltaPct: number | null;
  note?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function toUtcMidnight(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}

function dollarsToCents(value: number | string | null | undefined): number {
  return Math.round(parseFloat(String(value ?? '0')) * 100);
}

/**
 * External provider usage/cost ingestion (P7). Fetches the provider's
 * OWN authoritative usage from its usage/cost API, normalizes it into
 * daily buckets, upserts them as ProviderUsageSnapshot rows, and
 * reconciles provider-actual against our internal estimate (Conversation
 * spend) for the Cost tab.
 *
 * Only OpenAI and Anthropic have real fetchers; every other provider
 * type is capability-flagged (supported:false) and triggers NO network
 * call. See provider-usage.capability.ts for the credential-scope caveat
 * (usage APIs need an admin/org key, not the inference key).
 */
@Injectable()
export class ProviderUsageService {
  private readonly logger = new Logger(ProviderUsageService.name);

  constructor(
    @InjectRepository(ProviderUsageSnapshot)
    private readonly snapshotRepo: Repository<ProviderUsageSnapshot>,
    @InjectRepository(LlmProvider)
    private readonly providerRepo: Repository<LlmProvider>,
    @InjectRepository(Conversation)
    private readonly conversationRepo: Repository<Conversation>,
  ) {}

  getCapability(type: LlmProviderType | string): ProviderUsageCapability {
    return providerUsageCapability(type);
  }

  /**
   * The credential used against the usage/cost API. Prefers the
   * dedicated (encrypted) `usageApiKey` admin key and only falls back to
   * the inference key — which will 401 on most usage endpoints.
   */
  private usageCredential(provider: LlmProvider): string | undefined {
    return (
      provider.getDecryptedUsageApiKey?.() ?? provider.getDecryptedApiKey()
    );
  }

  /** Thin wrapper around global fetch — the single seam tests mock. */
  protected async fetchJson(
    url: string,
    headers: Record<string, string>,
  ): Promise<any> {
    const res = await fetch(url, { method: 'GET', headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `HTTP ${res.status} from ${url}: ${body.slice(0, 300)}`,
      );
    }
    return res.json();
  }

  // ── Dispatch ───────────────────────────────────────────────────────

  async fetchProviderUsage(
    provider: LlmProvider,
    from: Date,
    to: Date,
  ): Promise<FetchUsageResult> {
    const capability = this.getCapability(provider.type);
    if (!capability.supported) {
      return { supported: false, capability, buckets: [] };
    }

    const key = this.usageCredential(provider);
    if (!key) {
      return {
        supported: true,
        capability,
        buckets: [],
        error: 'No usage/admin API key configured for this provider.',
      };
    }

    try {
      let buckets: NormalizedUsageBucket[];
      switch (provider.type) {
        case LlmProviderType.OPENAI:
          buckets = await this.fetchOpenAiUsage(provider, key, from, to);
          break;
        case LlmProviderType.ANTHROPIC:
          buckets = await this.fetchAnthropicUsage(provider, key, from, to);
          break;
        default:
          return { supported: false, capability, buckets: [] };
      }
      return { supported: true, capability, buckets };
    } catch (err: any) {
      this.logger.warn(
        `Provider usage fetch failed for ${provider.id} (${provider.type}): ${err?.message}`,
      );
      return {
        supported: true,
        capability,
        buckets: [],
        error: err?.message ?? 'fetch failed',
      };
    }
  }

  // ── OpenAI ─────────────────────────────────────────────────────────
  // Usage/Costs API (org-scoped, needs an Admin key):
  //   GET /v1/organization/usage/completions?start_time&end_time&bucket_width=1d
  //   GET /v1/organization/costs?start_time&end_time&bucket_width=1d
  // Both return { data: [ { start_time, end_time, results: [...] } ] };
  // start_time/end_time are unix seconds. Cost amount is in dollars.

  private async fetchOpenAiUsage(
    provider: LlmProvider,
    key: string,
    from: Date,
    to: Date,
  ): Promise<NormalizedUsageBucket[]> {
    const base = provider.configuration.apiUrl?.replace(/\/v1\/?$/, '') ??
      'https://api.openai.com';
    const headers = {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    };
    const start = Math.floor(from.getTime() / 1000);
    const end = Math.floor(to.getTime() / 1000);

    const [usage, costs] = await Promise.all([
      this.fetchJson(
        `${base}/v1/organization/usage/completions?start_time=${start}&end_time=${end}&bucket_width=1d`,
        headers,
      ),
      this.fetchJson(
        `${base}/v1/organization/costs?start_time=${start}&end_time=${end}&bucket_width=1d`,
        headers,
      ),
    ]);

    return this.parseOpenAiBuckets(usage, costs);
  }

  /** Merge the OpenAI usage (tokens) and costs payloads by bucket start. */
  parseOpenAiBuckets(usage: any, costs: any): NormalizedUsageBucket[] {
    const byStart = new Map<number, NormalizedUsageBucket>();

    const ensure = (startSec: number, endSec: number) => {
      let b = byStart.get(startSec);
      if (!b) {
        const periodStart = toUtcMidnight(new Date(startSec * 1000));
        b = {
          periodStart,
          periodEnd: endSec
            ? new Date(endSec * 1000)
            : new Date(periodStart.getTime() + DAY_MS),
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          costCents: 0,
          currency: 'usd',
          raw: {},
        };
        byStart.set(startSec, b);
      }
      return b;
    };

    for (const bucket of usage?.data ?? []) {
      const b = ensure(bucket.start_time, bucket.end_time);
      for (const r of bucket.results ?? []) {
        b.inputTokens += Number(r.input_tokens ?? 0);
        b.outputTokens += Number(r.output_tokens ?? 0);
      }
      b.totalTokens = b.inputTokens + b.outputTokens;
      (b.raw as any).usage = bucket.results;
    }

    for (const bucket of costs?.data ?? []) {
      const b = ensure(bucket.start_time, bucket.end_time);
      for (const r of bucket.results ?? []) {
        const amount = r.amount?.value ?? r.amount ?? 0;
        b.costCents += dollarsToCents(amount);
        if (r.amount?.currency) b.currency = String(r.amount.currency).toLowerCase();
      }
      (b.raw as any).cost = bucket.results;
    }

    return [...byStart.values()].sort(
      (a, b) => a.periodStart.getTime() - b.periodStart.getTime(),
    );
  }

  // ── Anthropic ──────────────────────────────────────────────────────
  // Admin Usage & Cost API (needs an Admin key):
  //   GET /v1/organizations/usage_report/messages?starting_at&ending_at&bucket_width=1d
  //   GET /v1/organizations/cost_report?starting_at&ending_at&bucket_width=1d
  // starting_at/ending_at are ISO 8601. Cost amount is a decimal string
  // in USD. Token fields are split (uncached/cached input, output).

  private async fetchAnthropicUsage(
    provider: LlmProvider,
    key: string,
    from: Date,
    to: Date,
  ): Promise<NormalizedUsageBucket[]> {
    const base = provider.configuration.apiUrl?.replace(/\/v1\/?$/, '') ??
      'https://api.anthropic.com';
    const headers = {
      'x-api-key': key,
      'anthropic-version': provider.configuration.apiVersion ?? '2023-06-01',
      'Content-Type': 'application/json',
    };
    const start = from.toISOString();
    const end = to.toISOString();

    const [usage, costs] = await Promise.all([
      this.fetchJson(
        `${base}/v1/organizations/usage_report/messages?starting_at=${encodeURIComponent(start)}&ending_at=${encodeURIComponent(end)}&bucket_width=1d`,
        headers,
      ),
      this.fetchJson(
        `${base}/v1/organizations/cost_report?starting_at=${encodeURIComponent(start)}&ending_at=${encodeURIComponent(end)}&bucket_width=1d`,
        headers,
      ),
    ]);

    return this.parseAnthropicBuckets(usage, costs);
  }

  parseAnthropicBuckets(usage: any, costs: any): NormalizedUsageBucket[] {
    const byStart = new Map<string, NormalizedUsageBucket>();

    const ensure = (startIso: string, endIso?: string) => {
      const startDate = toUtcMidnight(new Date(startIso));
      const keyStr = startDate.toISOString();
      let b = byStart.get(keyStr);
      if (!b) {
        b = {
          periodStart: startDate,
          periodEnd: endIso
            ? new Date(endIso)
            : new Date(startDate.getTime() + DAY_MS),
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          costCents: 0,
          currency: 'usd',
          raw: {},
        };
        byStart.set(keyStr, b);
      }
      return b;
    };

    for (const bucket of usage?.data ?? []) {
      const b = ensure(bucket.starting_at, bucket.ending_at);
      for (const r of bucket.results ?? []) {
        b.inputTokens +=
          Number(r.uncached_input_tokens ?? r.input_tokens ?? 0) +
          Number(r.cache_creation_input_tokens ?? 0) +
          Number(r.cache_read_input_tokens ?? 0);
        b.outputTokens += Number(r.output_tokens ?? 0);
      }
      b.totalTokens = b.inputTokens + b.outputTokens;
      (b.raw as any).usage = bucket.results;
    }

    for (const bucket of costs?.data ?? []) {
      const b = ensure(bucket.starting_at, bucket.ending_at);
      for (const r of bucket.results ?? []) {
        const amount = r.amount ?? r.cost ?? 0;
        b.costCents += dollarsToCents(amount);
        if (r.currency) b.currency = String(r.currency).toLowerCase();
      }
      (b.raw as any).cost = bucket.results;
    }

    return [...byStart.values()].sort(
      (a, b) => a.periodStart.getTime() - b.periodStart.getTime(),
    );
  }

  // ── Ingestion / upsert ─────────────────────────────────────────────

  /**
   * Fetch a provider's usage for [from,to) and upsert one snapshot per
   * day bucket. Idempotent: re-running the same window overwrites via the
   * (organizationId, llmProviderId, periodStart) unique index. Returns the
   * number of buckets written, or a not-supported / error result.
   */
  async syncProvider(
    provider: LlmProvider,
    from: Date,
    to: Date,
  ): Promise<{ supported: boolean; written: number; error?: string }> {
    const result = await this.fetchProviderUsage(provider, from, to);
    if (!result.supported) return { supported: false, written: 0 };
    if (result.error) {
      return { supported: true, written: 0, error: result.error };
    }

    const rows = result.buckets.map((b) => ({
      organizationId: provider.organizationId,
      llmProviderId: provider.id,
      providerType: provider.type,
      periodStart: b.periodStart,
      periodEnd: b.periodEnd,
      inputTokens: b.inputTokens,
      outputTokens: b.outputTokens,
      totalTokens: b.totalTokens,
      costCents: b.costCents,
      currency: b.currency,
      source: 'provider',
      raw: b.raw ?? null,
    }));

    if (rows.length > 0) {
      await this.snapshotRepo.upsert(rows, {
        conflictPaths: ['organizationId', 'llmProviderId', 'periodStart'],
        skipUpdateIfNoValuesChanged: false,
      });
    }
    return { supported: true, written: rows.length };
  }

  /** Sync every supported provider in the org. */
  async syncOrganization(
    organizationId: string,
    from: Date,
    to: Date,
    providerId?: string,
  ): Promise<Array<{ llmProviderId: string; providerType: string } & {
    supported: boolean;
    written: number;
    error?: string;
  }>> {
    const where: any = { organizationId };
    if (providerId) where.id = providerId;
    const providers = await this.providerRepo.find({ where });

    const out = [];
    for (const p of providers) {
      const res = await this.syncProvider(p, from, to);
      out.push({ llmProviderId: p.id, providerType: p.type, ...res });
    }
    return out;
  }

  // ── Reconciliation ─────────────────────────────────────────────────

  /**
   * Per-provider: our internal estimate (summed Conversation.totalCost,
   * stored in dollars → *100 cents, mirroring SpendService) vs the
   * provider-actual (summed snapshots) over [from,to), plus the delta.
   */
  async getReconciliation(
    organizationId: string,
    opts: { from: Date; to?: Date },
  ): Promise<ReconciliationRow[]> {
    const providers = await this.providerRepo.find({
      where: { organizationId },
    });

    const [estimates, actuals] = await Promise.all([
      this.estimateByProvider(organizationId, opts.from, opts.to),
      this.actualByProvider(organizationId, opts.from, opts.to),
    ]);

    return providers.map((p) => {
      const est = estimates.get(p.id) ?? { cents: 0, tokens: 0 };
      const act = actuals.get(p.id);
      const capability = this.getCapability(p.type);
      const actualCents = act ? act.cents : null;
      const actualTokens = act ? act.tokens : null;
      const deltaCents = actualCents === null ? null : actualCents - est.cents;
      const deltaPct =
        deltaCents === null || est.cents === 0
          ? null
          : Math.round((deltaCents / est.cents) * 1000) / 10;

      return {
        llmProviderId: p.id,
        providerName: p.name,
        providerType: p.type,
        capabilitySupported: capability.supported,
        estimateCents: est.cents,
        estimateTokens: est.tokens,
        actualCents,
        actualTokens,
        deltaCents,
        deltaPct,
        note: capability.supported
          ? act
            ? undefined
            : 'No provider snapshots yet — run a sync.'
          : capability.note,
      };
    });
  }

  private async estimateByProvider(
    organizationId: string,
    from: Date,
    to: Date | undefined,
  ): Promise<Map<string, { cents: number; tokens: number }>> {
    const qb = this.conversationRepo
      .createQueryBuilder('c')
      .select('c.providerId', 'providerId')
      .addSelect('COALESCE(SUM(c.totalCost), 0)', 'cost')
      .addSelect(
        'COALESCE(SUM(c.totalInputTokens + c.totalOutputTokens), 0)',
        'tokens',
      )
      .where('c.organizationId = :orgId', { orgId: organizationId })
      .andWhere('c.providerId IS NOT NULL')
      .andWhere('c.createdAt >= :from', { from })
      .groupBy('c.providerId');
    if (to) qb.andWhere('c.createdAt < :to', { to });

    const rows = await qb.getRawMany<{
      providerId: string;
      cost: string;
      tokens: string;
    }>();
    const map = new Map<string, { cents: number; tokens: number }>();
    for (const r of rows) {
      map.set(r.providerId, {
        cents: dollarsToCents(r.cost),
        tokens: parseInt(r.tokens, 10) || 0,
      });
    }
    return map;
  }

  private async actualByProvider(
    organizationId: string,
    from: Date,
    to: Date | undefined,
  ): Promise<Map<string, { cents: number; tokens: number }>> {
    const qb = this.snapshotRepo
      .createQueryBuilder('s')
      .select('s.llmProviderId', 'providerId')
      .addSelect('COALESCE(SUM(s.costCents), 0)', 'cents')
      .addSelect('COALESCE(SUM(s.totalTokens), 0)', 'tokens')
      .where('s.organizationId = :orgId', { orgId: organizationId })
      .andWhere('s.periodStart >= :from', { from })
      .groupBy('s.llmProviderId');
    if (to) qb.andWhere('s.periodStart < :to', { to });

    const rows = await qb.getRawMany<{
      providerId: string;
      cents: string;
      tokens: string;
    }>();
    const map = new Map<string, { cents: number; tokens: number }>();
    for (const r of rows) {
      map.set(r.providerId, {
        cents: parseInt(r.cents, 10) || 0,
        tokens: parseInt(r.tokens, 10) || 0,
      });
    }
    return map;
  }
}
