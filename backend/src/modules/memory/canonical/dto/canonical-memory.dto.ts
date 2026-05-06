import { Mode, Provenance, ScopeRef, Tier } from '../canonical.types';

export interface PutInput {
  mode: Mode;
  scope: ScopeRef;
  content: string;
  content_format?: 'text' | 'markdown' | 'json';
  tags?: string[];
  metadata?: Record<string, unknown>;
  file_refs?: string[];
  // memory mode
  tier?: Tier;
  ttl_seconds?: number | null;
  // document mode
  source_uri?: string;
  source_version?: number;
  source_checksum?: string;
  chunk_index?: number;
  chunk_total?: number;
  chunk_of?: string;
  // common
  confidence?: number;
  provenance: Provenance;
  /** Optional explicit id — bypasses the v7 generator (used by transfer/sync). */
  id?: string;
}

