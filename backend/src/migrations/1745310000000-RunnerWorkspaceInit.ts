import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Runner + Workspace v1.0 schema. Three tables:
 *   - runners              one row per long-running daemon a user has registered
 *   - runner_sessions      audit trail of Streamable HTTP connections per runner
 *   - workspaces           a (runner, cwd) reservation with a TTL
 *
 * Everything below maps 1:1 to the entity files (runner.entity.ts,
 * runner-session.entity.ts, workspace.entity.ts). State and isolation
 * enums are stored as TEXT with CHECK constraints rather than Postgres
 * ENUM types so adding new values later doesn't need a migration plus
 * an enum-alter dance; matches how the gateway and agent tables
 * already do it.
 */
export class RunnerWorkspaceInit1745310000000 implements MigrationInterface {
  name = 'RunnerWorkspaceInit1745310000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE runners (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name TEXT NOT NULL,
        "ownerUserId" UUID NOT NULL,
        "organizationId" UUID NOT NULL,
        state TEXT NOT NULL DEFAULT 'registered'
          CHECK (state IN ('registered','online','busy','draining','stale','offline')),
        labels JSON NOT NULL DEFAULT '{}'::json,
        "runtimeInfo" JSON,
        config JSON,
        "lastHeartbeatAt" TIMESTAMPTZ,
        "registeredAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT runners_owner_org_name_unique UNIQUE ("ownerUserId", "organizationId", name),
        FOREIGN KEY ("ownerUserId") REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY ("organizationId") REFERENCES organizations(id) ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX runners_owner_idx ON runners("ownerUserId")`);
    await queryRunner.query(`CREATE INDEX runners_org_idx ON runners("organizationId")`);
    await queryRunner.query(`CREATE INDEX runners_state_idx ON runners(state)`);

    await queryRunner.query(`
      CREATE TABLE runner_sessions (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "runnerId" UUID NOT NULL,
        "streamableSessionId" TEXT NOT NULL,
        "remoteAddress" TEXT,
        "connectedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "disconnectedAt" TIMESTAMPTZ,
        FOREIGN KEY ("runnerId") REFERENCES runners(id) ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX runner_sessions_runner_idx ON runner_sessions("runnerId")`);
    await queryRunner.query(`CREATE INDEX runner_sessions_streamable_idx ON runner_sessions("streamableSessionId")`);
    // Composite for "current connection" lookups: (runnerId, disconnectedAt IS NULL).
    await queryRunner.query(`
      CREATE INDEX runner_sessions_active_idx
        ON runner_sessions("runnerId")
        WHERE "disconnectedAt" IS NULL
    `);

    await queryRunner.query(`
      CREATE TABLE workspaces (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "runnerId" UUID NOT NULL,
        "ownerUserId" UUID NOT NULL,
        "organizationId" UUID NOT NULL,
        cwd TEXT NOT NULL,
        isolation TEXT NOT NULL CHECK (isolation IN ('container','host')),
        "ttlAt" TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active','released','expired','stranded')),
        "closeReason" JSON,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "closedAt" TIMESTAMPTZ,
        FOREIGN KEY ("runnerId") REFERENCES runners(id) ON DELETE CASCADE,
        FOREIGN KEY ("ownerUserId") REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY ("organizationId") REFERENCES organizations(id) ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX workspaces_runner_idx ON workspaces("runnerId")`);
    await queryRunner.query(`CREATE INDEX workspaces_owner_idx ON workspaces("ownerUserId")`);
    await queryRunner.query(`CREATE INDEX workspaces_org_idx ON workspaces("organizationId")`);
    await queryRunner.query(`CREATE INDEX workspaces_status_idx ON workspaces(status)`);
    // Partial index for the expiry sweep: only active workspaces with
    // a TTL participate, and we only query by ttlAt < now().
    await queryRunner.query(`
      CREATE INDEX workspaces_ttl_sweep_idx
        ON workspaces("ttlAt")
        WHERE status = 'active' AND "ttlAt" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS workspaces`);
    await queryRunner.query(`DROP TABLE IF EXISTS runner_sessions`);
    await queryRunner.query(`DROP TABLE IF EXISTS runners`);
  }
}
