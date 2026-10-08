import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tool embeddings for search_tools (docs/design/code-mode.md, part B).
 *
 * One row per tool and embedding model: the vector of the tool's searchable
 * text (name, operation id, API name, tags, description), padded to the
 * memory store's column width, the model and its real dimensionality, and
 * a hash of the text it was computed from, so an unchanged tool is not
 * embedded again. Vectors from different models are never compared: a
 * search filters on the model its query was embedded with (the memory
 * store's rule).
 *
 * pgvector is already enabled by MemoryCanonicalInit.
 */
export class ToolEmbeddings1750813800000 implements MigrationInterface {
  name = 'ToolEmbeddings1750813800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "tool_embeddings" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "toolId" uuid NOT NULL REFERENCES "tools"("id") ON DELETE CASCADE,
        "organizationId" uuid NOT NULL,
        "model" varchar(128) NOT NULL,
        "dim" integer NOT NULL,
        "embedding" vector(1536) NOT NULL,
        "textHash" varchar(64) NOT NULL,
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "tool_embeddings_tool_model_uq" UNIQUE ("toolId", "model")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tool_embeddings_org_model" ON "tool_embeddings" ("organizationId", "model")`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tool_embeddings_hnsw" ON "tool_embeddings" USING hnsw ("embedding" vector_cosine_ops)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "tool_embeddings"`);
  }
}
