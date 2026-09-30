import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Moving memories between memory accounts (MemoryMoveService).
 *
 * `memory_moves` is one move: from which account to which, what it covers
 * (scope, mode), where it stands and what it did. `memory_move_items` is
 * each memory's step (copied, moved, failed), unique per move and source
 * id, so a move that stopped part way resumes without copying a memory
 * twice. No secret is stored: an account is named by its credential id.
 */
export class MemoryMoves1750813762000 implements MigrationInterface {
  name = 'MemoryMoves1750813762000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS memory_moves (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        organization_id UUID NOT NULL,
        source_service TEXT NOT NULL,
        source_credential_id UUID,
        target_service TEXT NOT NULL,
        target_credential_id UUID,
        scope_type TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'memory',
        status TEXT NOT NULL DEFAULT 'queued',
        moved INT NOT NULL DEFAULT 0,
        failed INT NOT NULL DEFAULT 0,
        total INT,
        last_error TEXT,
        warnings JSONB NOT NULL DEFAULT '[]',
        created_by UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at TIMESTAMPTZ,
        CONSTRAINT memory_moves_status_check CHECK (status IN ('queued','running','completed','failed'))
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS memory_moves_org ON memory_moves (organization_id, created_at)`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS memory_move_items (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        move_id UUID NOT NULL REFERENCES memory_moves(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL,
        target_id TEXT,
        state TEXT NOT NULL,
        error TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT memory_move_items_state_check CHECK (state IN ('copied','moved','failed'))
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS memory_move_items_source ON memory_move_items (move_id, source_id)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS memory_move_items`);
    await queryRunner.query(`DROP TABLE IF EXISTS memory_moves`);
  }
}
