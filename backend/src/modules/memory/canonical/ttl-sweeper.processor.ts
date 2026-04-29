import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { Job } from 'bull';

import { CanonicalMemory } from './canonical-memory.entity';

export const TTL_SWEEPER_QUEUE_NAME = 'canonical-memory-ttl-sweeper';

/**
 * TTL sweeper. Runs on a repeating BullMQ schedule (configured at
 * module bootstrap; see CanonicalMemoryModule). For every memory-mode
 * row whose `created_at + ttl_seconds` is now in the past AND whose
 * `valid_until` is still null, we set `valid_until = now()`. The
 * row is bi-temporally closed but not deleted — `as_of` queries still
 * see it for the duration of its valid period, and the soft-delete
 * sweep (separate job, future) decides when to fully retire it.
 *
 * Spec §7.5: "TTL sets `valid_until` automatically when
 * `created_at + ttl_seconds < now()`. A background sweeper updates rows."
 *
 * Implementation note: we use raw SQL because TypeORM's query builder
 * can't express `created_at + (ttl_seconds * INTERVAL '1 second')`
 * cleanly. The set is bounded per pass (10k rows) so a backlog never
 * blows the worker's transaction; the sweeper runs every 60s so
 * any backlog drains over a few minutes.
 */
@Processor(TTL_SWEEPER_QUEUE_NAME)
export class CanonicalMemoryTtlSweeperProcessor {
  private readonly logger = new Logger(CanonicalMemoryTtlSweeperProcessor.name);
  /** Per-pass cap so a backlog can't hold the worker indefinitely. */
  private static readonly BATCH_SIZE = 10_000;

  constructor(
    @InjectRepository(CanonicalMemory)
    private readonly repo: Repository<CanonicalMemory>,
  ) {}

  @Process('sweep')
  async handle(_job: Job): Promise<{ closed: number }> {
    const result = await this.repo.query(
      `
      WITH expired AS (
        SELECT id
        FROM memories
        WHERE mode = 'memory'
          AND ttl_seconds IS NOT NULL
          AND valid_until IS NULL
          AND deleted_at IS NULL
          AND created_at + (ttl_seconds * INTERVAL '1 second') < now()
        ORDER BY created_at ASC
        LIMIT $1
      )
      UPDATE memories m
        SET valid_until = now(),
            updated_at = now()
        FROM expired
        WHERE m.id = expired.id
        RETURNING m.id
      `,
      [CanonicalMemoryTtlSweeperProcessor.BATCH_SIZE],
    );
    const closed = Array.isArray(result) ? (Array.isArray(result[0]) ? result[0].length : result.length) : 0;
    if (closed > 0) {
      this.logger.log(`TTL sweeper closed ${closed} expired memories`);
    }
    return { closed };
  }
}
