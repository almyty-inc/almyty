import { MigrationInterface, QueryRunner } from 'typeorm';

export class MergeInterfacesIntoGateways1744600000000 implements MigrationInterface {
  name = 'MergeInterfacesIntoGateways1744600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Check if the interfaces table exists (idempotent)
    const hasInterfaces = await queryRunner.hasTable('interfaces');
    if (!hasInterfaces) {
      return;
    }

    // Migrate rows from interfaces into gateways.
    // Each interface becomes a gateway with kind='agent'.
    // Endpoint is derived from the name, lowercased with spaces replaced
    // by hyphens and prefixed with '/'. A numeric suffix is appended if
    // the endpoint would collide with an existing gateway in the same org.
    //
    // We use a PL/pgSQL DO block so collision handling is done row-by-row
    // in the database rather than requiring round-trips.
    await queryRunner.query(`
      DO $$
      DECLARE
        rec RECORD;
        base_endpoint TEXT;
        candidate TEXT;
        suffix INT;
      BEGIN
        FOR rec IN SELECT * FROM interfaces
        LOOP
          base_endpoint := '/' || lower(replace(rec.name, ' ', '-'));
          candidate := base_endpoint;
          suffix := 1;

          -- Resolve endpoint collisions within the same org
          WHILE EXISTS (
            SELECT 1 FROM gateways
            WHERE "organizationId" = rec."organizationId"
              AND endpoint = candidate
          ) LOOP
            candidate := base_endpoint || '-' || suffix;
            suffix := suffix + 1;
          END LOOP;

          INSERT INTO gateways (
            id,
            name,
            description,
            kind,
            type,
            "agentId",
            status,
            "organizationId",
            endpoint,
            configuration,
            "rateLimitConfig",
            "corsConfig",
            webhooks,
            "requestTimeout",
            "maxRetries",
            "customHeaders",
            "healthCheck",
            metadata,
            "totalRequests",
            "successfulRequests",
            "lastRequestAt",
            "lastHealthCheckAt",
            "isHealthy",
            "createdAt",
            "updatedAt"
          ) VALUES (
            rec.id,
            rec.name,
            NULL,
            'agent',
            rec.type,
            rec."agentId",
            rec.status,
            rec."organizationId",
            candidate,
            rec.configuration,
            NULL,
            NULL,
            NULL,
            30000,
            3,
            NULL,
            NULL,
            rec.metadata,
            0,
            0,
            NULL,
            NULL,
            true,
            rec."createdAt",
            rec."updatedAt"
          );
        END LOOP;
      END
      $$;
    `);

    // Clean up version history that references the interfaces table.
    // The typeorm-versions table stores snapshots keyed by itemType.
    const hasVersions = await queryRunner.hasTable('versions');
    if (hasVersions) {
      await queryRunner.query(`DELETE FROM versions WHERE "itemType" = 'AgentInterface'`);
    }

    // Drop the interfaces table
    await queryRunner.query(`DROP TABLE IF EXISTS interfaces CASCADE`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Recreate the interfaces table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS interfaces (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "agentId" uuid NOT NULL,
        "organizationId" uuid NOT NULL,
        type varchar NOT NULL,
        name varchar NOT NULL,
        status varchar NOT NULL DEFAULT 'inactive',
        configuration json NOT NULL DEFAULT '{}',
        metadata json,
        "totalMessages" int NOT NULL DEFAULT 0,
        "lastMessageAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_interfaces_agentId" ON interfaces ("agentId")`);
    await queryRunner.query(`CREATE INDEX "IDX_interfaces_organizationId" ON interfaces ("organizationId")`);

    // Move channel-type gateways back to interfaces
    const channelTypes = [
      'slack', 'discord', 'telegram', 'whatsapp', 'email',
      'webhook', 'google_chat', 'microsoft_teams', 'signal',
      'matrix', 'irc', 'chat_widget',
    ];

    await queryRunner.query(`
      INSERT INTO interfaces (id, "agentId", "organizationId", type, name, status, configuration, metadata, "createdAt", "updatedAt")
      SELECT id, "agentId", "organizationId", type, name, status, configuration, metadata, "createdAt", "updatedAt"
      FROM gateways
      WHERE kind = 'agent' AND type IN (${channelTypes.map(t => `'${t}'`).join(',')})
    `);

    // Remove those rows from gateways
    await queryRunner.query(`
      DELETE FROM gateways WHERE kind = 'agent' AND type IN (${channelTypes.map(t => `'${t}'`).join(',')})
    `);
  }
}
