/**
 * Canonical-schema-v1 limits and defaults.
 *
 * Single source of truth so coding agents and the workspace-config
 * UI both reference the same numbers. Workspace overrides land in
 * `memory_workspace_config` (JSONB extension column); these values
 * are the project-wide defaults.
 */
export const LIMITS = {
  // hard ceilings (operator-only override at deployment level)
  SYSTEM_CEILING_MEMORY_BYTES: 10 * 1024 * 1024,        // 10 MB per memory item
  SYSTEM_CEILING_DOCUMENT_BYTES: 500 * 1024 * 1024,     // 500 MB per source document

  // workspace defaults (configurable in workspace settings)
  WORKSPACE_DEFAULT_HARD_CAP_MEMORY_BYTES: 1 * 1024 * 1024,    // 1 MB
  WORKSPACE_DEFAULT_HARD_CAP_DOCUMENT_BYTES: 100 * 1024 * 1024, // 100 MB

  // per-tier soft caps (memory mode, configurable per workspace)
  SOFT_CAP_MEMORY_SHORT_BYTES: 128 * 1024,    // 128 KB
  SOFT_CAP_MEMORY_PROJECT_BYTES: 512 * 1024,  // 512 KB
  SOFT_CAP_MEMORY_LONG_BYTES: 128 * 1024,     // 128 KB
  SOFT_CAP_MEMORY_SHARED_BYTES: 512 * 1024,   // 512 KB

  // chunking (document mode)
  CHUNK_DEFAULT_TOKENS: 400,
  CHUNK_DEFAULT_OVERLAP_TOKENS: 80,
  CHUNK_HARD_CAP_BYTES: 8 * 1024,    // 8 KB per chunk; embedders fail above this

  // identifier
  ID_VERSION: 7,                     // UUID v7

  // embedding
  EMBEDDING_DEFAULT_DIM: 1536,
  EMBEDDING_DEFAULT_MODEL: 'text-embedding-3-small',
  EMBEDDING_MIN_DIM: 64,
  EMBEDDING_MAX_DIM: 4096,

  // anti-dump heuristics
  REPETITIVE_WRITE_RPM_DEFAULT: 30,                       // memory mode, per agent per session
  IMPORT_CHUNK_RPM_DEFAULT: 100,                          // document mode, per import job
  COMPRESSION_RATIO_REJECT_THRESHOLD: 0.05,               // gzip < 5% of original = reject
  AGENT_MAX_SINGLE_WRITE_BYTES_DEFAULT: 256 * 1024,       // memory mode
  AGENT_MAX_IMPORT_BYTES_DEFAULT: 50 * 1024 * 1024,       // document mode

  // recall defaults
  RECALL_TOKEN_BUDGET_MEMORY: 2_000,
  RECALL_TOKEN_BUDGET_DOCUMENT: 4_000,
  RECALL_DEFAULT_TOP_K: 10,

  // soft-cap behavior options
  SOFTCAP_BEHAVIOR_DEFAULT: 'warn_log' as 'reject' | 'warn_log' | 'silent',

  // tool description budget
  META_TOOL_DESCRIPTION_MAX_TOKENS: 350,
} as const;

export type SoftCapBehavior = 'reject' | 'warn_log' | 'silent';

import type { Tier } from './canonical.types';

/**
 * Map a memory-mode tier to its byte soft cap. Centralized so tests
 * and the validator both read from one place; workspace overrides
 * are applied on top of this in the service layer.
 */
export function softCapForTier(tier: Tier): number {
  switch (tier) {
    case 'short': return LIMITS.SOFT_CAP_MEMORY_SHORT_BYTES;
    case 'project': return LIMITS.SOFT_CAP_MEMORY_PROJECT_BYTES;
    case 'long': return LIMITS.SOFT_CAP_MEMORY_LONG_BYTES;
    case 'shared': return LIMITS.SOFT_CAP_MEMORY_SHARED_BYTES;
  }
}
