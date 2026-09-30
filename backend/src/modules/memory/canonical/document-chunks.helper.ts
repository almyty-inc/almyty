import { v7 as uuidv7 } from 'uuid';

import { LIMITS } from './canonical.constants';
import type { MemoryItem } from './canonical.types';

/**
 * Documents are searched by their chunks (spec §7: chunks are leaves). A
 * whole document -- one written in one piece, as the Memory page's
 * "Document" does -- is kept as the parent row, with its full text for
 * reading, and split into chunk rows that are embedded and looked up.
 * The parent is a container: `chunk_total` set, `chunk_index` and
 * `chunk_of` NULL; search leaves it out (documentContainerSql).
 */

/** An item that is a document in one piece: not a chunk, not yet split. */
export function isWholeDocument(item: Pick<MemoryItem, 'mode' | 'chunk_of' | 'chunk_index' | 'chunk_total'>): boolean {
  return item.mode === 'document' && item.chunk_of == null && item.chunk_index == null && item.chunk_total == null;
}

/**
 * SQL for "this row is a document container" on the `memories` alias
 * `alias`: a parent whose chunks carry its text. Search excludes these,
 * so a document is found by the chunk that matches, once.
 */
export function documentContainerSql(alias: string): string {
  return `(${alias}.mode = 'document' AND ${alias}.chunk_of IS NULL AND ${alias}.chunk_index IS NULL AND ${alias}.chunk_total IS NOT NULL)`;
}

/**
 * The chunk rows of `parent`, a whole document: same scope, source,
 * tags, provenance and format, each pointing at the parent. Embedding is
 * pending on every one. [] when the text has nothing to chunk.
 */
export function chunkLeavesOf(parent: MemoryItem, now: Date, chunkTokens: number = LIMITS.CHUNK_DEFAULT_TOKENS): MemoryItem[] {
  const texts = chunkText(parent.content, chunkTokens);
  return texts.map((text, idx) => ({
    ...parent,
    id: uuidv7(),
    content: text,
    content_bytes: Buffer.byteLength(text, 'utf8'),
    embedding: null,
    embedding_dim: null,
    embedding_model: null,
    embedding_status: 'pending' as const,
    embedding_error: null,
    metadata: {},
    chunk_index: idx,
    chunk_total: texts.length,
    chunk_of: parent.id,
    created_at: now,
    updated_at: now,
    accessed_at: null,
    access_count: 0,
  }));
}

/**
 * Split `content` into chunks of approximately `tokens` tokens
 * each. We use a 4-chars-per-token rule of thumb (close enough for
 * English text + code; the backend doesn't see the exact tokenizer
 * any embedding model uses) plus a hard byte cap so a single chunk
 * never exceeds `LIMITS.CHUNK_HARD_CAP_BYTES`.
 *
 * Strategy:
 *  1. Split on paragraph (`\n\n`) boundaries first — keeps related
 *     sentences together.
 *  2. Greedily pack paragraphs into a chunk until the byte budget
 *     would be exceeded; flush and start a new chunk.
 *  3. A paragraph that on its own exceeds the budget is force-split
 *     on sentence boundaries; if it still exceeds, it's hard-split
 *     by character count.
 *  4. Apply `CHUNK_DEFAULT_OVERLAP_TOKENS` worth of trailing context
 *     from the previous chunk to the next, so retrieval over a
 *     boundary doesn't lose recall.
 */
export function chunkText(content: string, targetTokens: number): string[] {
  const targetBytes = Math.min(targetTokens * 4, LIMITS.CHUNK_HARD_CAP_BYTES);
  const overlapBytes = LIMITS.CHUNK_DEFAULT_OVERLAP_TOKENS * 4;

  if (!content || content.length === 0) return [];

  // First split on blank lines.
  const paragraphs = content.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
  if (paragraphs.length === 0) return [];

  const chunks: string[] = [];
  let buf = '';

  const flush = () => {
    if (buf.length > 0) {
      chunks.push(buf);
      buf = '';
    }
  };

  for (const para of paragraphs) {
    const paraBytes = Buffer.byteLength(para, 'utf8');
    if (paraBytes > targetBytes) {
      // Paragraph alone exceeds the budget — force-split.
      flush();
      const parts = splitOversized(para, targetBytes);
      for (const part of parts) chunks.push(part);
      continue;
    }
    if (Buffer.byteLength(buf, 'utf8') + 2 + paraBytes > targetBytes) {
      flush();
    }
    buf = buf ? `${buf}\n\n${para}` : para;
  }
  flush();

  // Apply overlap: prepend the last `overlapBytes` of chunk i-1 to chunk i.
  if (overlapBytes > 0 && chunks.length > 1) {
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1];
      const tail = prev.slice(Math.max(0, prev.length - Math.floor(overlapBytes / 2)));
      // Cut at a whitespace boundary so the overlap is readable.
      const ws = tail.indexOf(' ');
      const overlap = ws > 0 ? tail.slice(ws + 1) : tail;
      if (overlap.length > 0) {
        chunks[i] = `…${overlap}\n\n${chunks[i]}`;
      }
    }
  }

  return chunks;
}

function splitOversized(para: string, maxBytes: number): string[] {
  // Try sentence boundaries first.
  const sentences = para.split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  let buf = '';
  for (const s of sentences) {
    if (Buffer.byteLength(buf, 'utf8') + 1 + Buffer.byteLength(s, 'utf8') > maxBytes) {
      if (buf.length > 0) out.push(buf);
      // If s alone is still too big, hard-split by chars.
      if (Buffer.byteLength(s, 'utf8') > maxBytes) {
        for (let i = 0; i < s.length; i += maxBytes) {
          out.push(s.slice(i, i + maxBytes));
        }
        buf = '';
      } else {
        buf = s;
      }
    } else {
      buf = buf ? `${buf} ${s}` : s;
    }
  }
  if (buf.length > 0) out.push(buf);
  return out;
}

