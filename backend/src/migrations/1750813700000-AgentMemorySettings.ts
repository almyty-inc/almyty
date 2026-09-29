import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Agent memory settings.
 *
 * 1. `memories.scope_type` takes `agent`: one agent's own memory, for an
 *    agent whose memory is "per agent" (scope_id `<org>:agent:<agentId>`).
 * 2. `memory_expiries`: when almyty deletes a memory it saved in an outside
 *    memory account that cannot expire memories itself (Mem0, Zep,
 *    Supermemory, the Claude memory tool). One row per saved memory, with
 *    the id that service knows it by; the hourly sweep deletes each one
 *    through the service's API once `expires_at` has passed. almyty's own
 *    store expires memories through `ttl_seconds` instead and has no rows
 *    here.
 * 3. `tools.apiId` filled in from the tool's operation, for tools
 *    generated from an API before generation set it.
 */
export class AgentMemorySettings1750813700000 implements MigrationInterface {
  name = 'AgentMemorySettings1750813700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_scope_type_check`);
    await queryRunner.query(
      `ALTER TABLE memories ADD CONSTRAINT memories_scope_type_check CHECK (scope_type IN ('user','workspace','project','collab','agent'))`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS memory_expiries (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        organization_id UUID NOT NULL,
        agent_id UUID,
        backend_id TEXT NOT NULL,
        scope_type TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        native_id TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS memory_expiries_due ON memory_expiries (expires_at) WHERE expires_at IS NOT NULL`,
    );
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS memory_expiries_agent ON memory_expiries (organization_id, agent_id)`);
    // 3. A tool generated from an API names that API, so an agent given the
    //    whole API (agentConfig.apiIds) gets every tool of it. Generation
    //    set only the operation until now.
    await queryRunner.query(
      `UPDATE tools SET "apiId" = o."apiId" FROM operations o WHERE tools."operationId" = o.id AND tools."apiId" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS memory_expiries`);
    await queryRunner.query(`DELETE FROM memories WHERE scope_type = 'agent'`);
    await queryRunner.query(`ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_scope_type_check`);
    await queryRunner.query(
      `ALTER TABLE memories ADD CONSTRAINT memories_scope_type_check CHECK (scope_type IN ('user','workspace','project','collab'))`,
    );
  }
}
