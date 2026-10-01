import { Injectable, Optional } from '@nestjs/common';

import { HASH_EMBEDDING_MODEL } from '../memory/embedding.service';
import { Tool } from '../../entities/tool.entity';
import { normalizeOutputSchema } from '../mcp/core/json-schema-2020';
import { keywordScore, reciprocalRankFusion } from './tool-search';
import { CodeName, codeNames, exampleCall, toolSignature } from './tool-signature';
import { ToolEmbeddingService } from './tool-embedding.service';
import { toolDiscoverySettings } from './tool-discovery.settings';

/** How a caller names its tools: MCP sanitizes, an agent uses the runtime's name. */
export type ToolNamer = (tool: Tool) => string;

export interface ToolSearchHit {
  name: string;
  title?: string;
  summary: string;
  sideEffect: Tool['sideEffect'];
  score: number;
}

export type ToolDetail = 'name' | 'description' | 'full';

/** The output schema a tool declares: its own, an LLM tool's JSON mode, or a remote MCP tool's. */
export function toolOutputSchema(tool: Tool): Record<string, any> | null {
  const llm = tool.llmConfig?.outputMode === 'json' ? tool.llmConfig.outputSchema : undefined;
  const raw = tool.outputSchema?.schema ?? llm ?? (tool.configuration?.mcp as any)?.outputSchema ?? null;
  return raw ? normalizeOutputSchema(raw) : null;
}

/** The first sentence of a description, at most 200 characters. */
export function summaryOf(description: string | null | undefined): string {
  const text = (description ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const first = /^(.+?[.!?])(\s|$)/.exec(text)?.[1] ?? text;
  return first.length > 200 ? `${first.slice(0, 197)}...` : first;
}

/**
 * search_tools and get_tool (docs/design/code-mode.md, part B), over the
 * tools a caller may use. The caller hands in its scope -- a gateway's
 * servable set, an agent's tools, a member's view of the organization --
 * already decided; nothing outside it is ranked, counted or described, so a
 * tool the caller could not list never appears.
 *
 * Ranking is hybrid: keyword matches (name, operation id, API name, tags,
 * description) and embedding similarity, merged by reciprocal rank fusion.
 * Without embeddings (none computed yet, or TOOL_EMBEDDINGS_ENABLED off)
 * the keyword half ranks alone.
 */
@Injectable()
export class ToolDiscoveryService {
  constructor(@Optional() private readonly embeddings?: ToolEmbeddingService) {}

  async search(
    candidates: Tool[],
    query: string,
    /** Internal callers that page the ranking themselves (the tools/search alias) may ask past TOOL_SEARCH_MAX_LIMIT. */
    options: { organizationId: string; limit?: number; nameOf: ToolNamer; uncapped?: boolean },
  ): Promise<{ results: ToolSearchHit[]; total: number }> {
    const settings = toolDiscoverySettings();
    const limit = options.uncapped
      ? Math.max(1, options.limit ?? settings.defaultLimit)
      : Math.max(1, Math.min(options.limit ?? settings.defaultLimit, settings.maxLimit));
    const q = String(query ?? '').trim();
    if (!q || !candidates.length) return { results: [], total: 0 };

    const keyword = candidates
      .map((tool) => ({ tool, score: keywordScore(tool, q) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || (a.tool.name < b.tool.name ? -1 : 1))
      .map((r) => r.tool.id);

    const nearest = this.embeddings
      ? await this.embeddings
          .nearest(options.organizationId, candidates.map((t) => t.id), q, settings.vectorCandidates)
          .catch(() => ({ ids: [] as string[], model: null }))
      : { ids: [] as string[], model: null };
    const vector = nearest.ids;

    // The vector half always answers with its nearest tools, related or not.
    // Without a keyword hit it is all there is; with one, a vector-only tool
    // must also be near the top of the vector ranking to be shown. Vectors
    // from the hash fallback (no embedding provider) only resemble the
    // words, so the keyword half carries the ranking then
    // (TOOL_SEARCH_FALLBACK_VECTOR_WEIGHT).
    const keywordIds = new Set(keyword);
    const vectorRanked = keyword.length ? vector.filter((id, i) => keywordIds.has(id) || i < limit) : vector;
    const vectorWeight = nearest.model === HASH_EMBEDDING_MODEL ? settings.fallbackVectorWeight : 1;
    const fused = reciprocalRankFusion([keyword, vectorRanked], settings.rrfK, [1, vectorWeight]);
    const byId = new Map(candidates.map((t) => [t.id, t]));
    const ranked = [...fused.entries()]
      .filter(([id]) => byId.has(id))
      // Equal scores: a keyword match first, then by name.
      .sort((a, b) => b[1] - a[1] || Number(keywordIds.has(b[0])) - Number(keywordIds.has(a[0])) || (byId.get(a[0])!.name < byId.get(b[0])!.name ? -1 : 1));

    return {
      total: ranked.length,
      results: ranked.slice(0, limit).map(([id, score]) => {
        const tool = byId.get(id)!;
        const title = typeof tool.metadata?.title === 'string' ? tool.metadata.title : undefined;
        return {
          name: options.nameOf(tool),
          ...(title ? { title } : {}),
          summary: summaryOf(tool.description),
          sideEffect: tool.sideEffect,
          score: Math.round(score * 10_000) / 10_000,
        };
      }),
    };
  }

  /** The tool a caller names, from its scope; null when it is not there. */
  resolve(candidates: Tool[], name: string, nameOf: ToolNamer): Tool | null {
    return candidates.find((t) => nameOf(t) === name) ?? candidates.find((t) => t.name === name) ?? null;
  }

  /** The code names of a scope (namespace and function per tool). */
  codeNames(candidates: Tool[]): Map<string, CodeName> {
    return codeNames(candidates);
  }

  /**
   * get_tool: `name` gives the name and title, `description` adds the
   * description and side-effect class, `full` adds the input and output
   * schemas, openWorld, the TypeScript signature as code mode calls it, and
   * one example call.
   */
  describe(candidates: Tool[], tool: Tool, detail: ToolDetail, nameOf: ToolNamer): Record<string, unknown> {
    const title = typeof tool.metadata?.title === 'string' ? tool.metadata.title : undefined;
    const base: Record<string, unknown> = { name: nameOf(tool), ...(title ? { title } : {}) };
    if (detail === 'name') return base;
    const withDescription = { ...base, description: tool.description ?? '', sideEffect: tool.sideEffect };
    if (detail === 'description') return withDescription;
    const code = this.codeNames(candidates).get(tool.id)!;
    const outputSchema = toolOutputSchema(tool);
    return {
      ...withDescription,
      openWorld: tool.openWorld,
      inputSchema: tool.parameters ?? { type: 'object', properties: {} },
      ...(outputSchema ? { outputSchema } : {}),
      code: { namespace: code.namespace, function: code.fn },
      signature: toolSignature(tool, code, outputSchema),
      example: exampleCall(tool, code),
    };
  }
}
