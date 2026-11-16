import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One row per runner tool.
 *
 * Before publishing matched a runner's rows correctly, every daemon restart
 * inserted another set of `runner.<name>.<method>` rows. CheckThenInsert-
 * Uniqueness retired the extra copies as `deleted` rather than removing
 * them, and the tool list showed all of them (a runner restarted eleven
 * times listed each tool eleven times).
 *
 * For each (organization, name) among the tools of a runner or hosted
 * environment that has more than one row, one row is kept: the one agents
 * and gateways refer to most, then a live one, then the oldest. Every
 * reference to another row of the group is moved to the kept row -- the
 * agent's tool list, its pipeline and settings, gateway attachments (one
 * per gateway), approval rules, and the run history -- and the other rows
 * are deleted. The kept row takes the status the live row of the group
 * had, so a group with a live copy stays live.
 */
export class CollapseRunnerToolCopies1791001100000 implements MigrationInterface {
  name = 'CollapseRunnerToolCopies1791001100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TEMP TABLE runner_tool_merge AS
      WITH runner_tools AS (
        SELECT t.id, t."organizationId" AS org, t.name, t.status, t."createdAt",
               (SELECT count(*) FROM agents a WHERE t.id = ANY(a."toolIds"))
             + (SELECT count(*) FROM gateway_tools g WHERE g."toolId" = t.id) AS refs
          FROM tools t
         WHERE t."runnerConfig"->>'runnerId' IS NOT NULL
            OR t."runnerConfig"->>'environmentId' IS NOT NULL
      ), ranked AS (
        SELECT id, status,
               first_value(id) OVER (
                 PARTITION BY org, name
                 ORDER BY refs DESC, (status <> 'deleted') DESC, "createdAt", id
               ) AS keeper,
               max(CASE WHEN status <> 'deleted' THEN status END) OVER (PARTITION BY org, name) AS live_status,
               count(*) OVER (PARTITION BY org, name) AS n
          FROM runner_tools
      )
      SELECT id AS loser, keeper, live_status FROM ranked WHERE n > 1 AND id <> keeper
    `);

    // Nothing to merge: stop here. Every statement below would change no
    // row, but the history updates still scan usage_metrics and
    // request_logs, which have no toolId index and run to millions of rows
    // (over three minutes on staging, past the deploy's migration wait).
    const [{ copies }] = await queryRunner.query(`SELECT count(*)::int AS copies FROM runner_tool_merge`);
    if (!copies) {
      await queryRunner.query(`DROP TABLE runner_tool_merge`);
      return;
    }

    // The agent's tool list: each copy becomes the kept row, once, in place.
    await queryRunner.query(`
      UPDATE agents a
         SET "toolIds" = (
           SELECT coalesce(array_agg(d.id ORDER BY d.ord), '{}')
             FROM (
               SELECT DISTINCT ON (s.id) s.id, s.ord
                 FROM (
                   SELECT coalesce(m.keeper, u.x) AS id, u.ord
                     FROM unnest(a."toolIds") WITH ORDINALITY AS u(x, ord)
                     LEFT JOIN runner_tool_merge m ON m.loser = u.x
                 ) s
                ORDER BY s.id, s.ord
             ) d
         )
       WHERE a."toolIds" && ARRAY(SELECT loser FROM runner_tool_merge)
    `);

    // Ids written into json: a tool step's toolId, approval rules.
    await queryRunner.query(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN SELECT loser::text AS loser, keeper::text AS keeper FROM runner_tool_merge LOOP
          UPDATE agents SET pipeline = replace(pipeline::text, r.loser, r.keeper)::json
           WHERE pipeline::text LIKE '%' || r.loser || '%';
          UPDATE agents SET "agentConfig" = replace("agentConfig"::text, r.loser, r.keeper)::json
           WHERE "agentConfig"::text LIKE '%' || r.loser || '%';
          UPDATE approval_policies SET "trigger" = replace("trigger"::text, r.loser, r.keeper)::jsonb
           WHERE "trigger"::text LIKE '%' || r.loser || '%';
        END LOOP;
      END $$
    `);

    // Gateway attachments are unique per (gateway, tool): drop a copy's
    // attachment when the gateway already has the kept row, or an earlier
    // attachment of another copy of it; move the rest.
    await queryRunner.query(`
      DELETE FROM gateway_tools g
       USING runner_tool_merge m
       WHERE g."toolId" = m.loser
         AND EXISTS (
           SELECT 1
             FROM gateway_tools o
             LEFT JOIN runner_tool_merge om ON om.loser = o."toolId"
            WHERE o."gatewayId" = g."gatewayId"
              AND o.id <> g.id
              AND coalesce(om.keeper, o."toolId") = m.keeper
              AND (om.loser IS NULL OR o.id < g.id)
         )
    `);
    await queryRunner.query(`
      UPDATE gateway_tools g SET "toolId" = m.keeper
        FROM runner_tool_merge m
       WHERE g."toolId" = m.loser
    `);

    // History stays, attributed to the kept row.
    for (const table of ['tool_executions', 'usage_metrics', 'request_logs', 'approval_requests']) {
      await queryRunner.query(`
      UPDATE ${table} h SET "toolId" = m.keeper
        FROM runner_tool_merge m
       WHERE h."toolId" = m.loser
    `);
    }

    await queryRunner.query(`
      DELETE FROM tools WHERE id IN (SELECT loser FROM runner_tool_merge)
    `);
    // After the deletes, so the live copy is gone before the kept row
    // takes its status (tools_org_name_uq allows one live row per name).
    await queryRunner.query(`
      UPDATE tools t SET status = k.live_status
        FROM (SELECT DISTINCT keeper, live_status FROM runner_tool_merge) k
       WHERE t.id = k.keeper
         AND k.live_status IS NOT NULL
         AND t.status <> k.live_status
    `);
    await queryRunner.query(`
      DROP TABLE runner_tool_merge
    `);
  }

  public async down(): Promise<void> {
    // The deleted copies are not restored.
  }
}
