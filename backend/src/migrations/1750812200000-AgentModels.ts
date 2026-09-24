import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `agents.models`: an autonomous agent's roles and the strategy that says
 * how they work together (modules/agents/autonomous-models.ts).
 *
 * Every autonomous agent whose `modelConfig` names a provider or a routing
 * policy gets `{ strategy: 'single', roles: [main] }`, the main role
 * carrying the providerId, model, routing, temperature and maxTokens its
 * `modelConfig` had, so it runs exactly as before. `modelConfig` itself is
 * left as it is: it stays the mirror of the main role.
 *
 * Its collaboration participants, and its judge, become teammate roles
 * (`teammate_1`, `teammate_2`, ...; named by the participant's role, else
 * "Teammate n", or "Judge"), which the main role can hand work to, and
 * `collaboration` is cleared, so the page's Models section is the one
 * place they are configured. A participant that could not have been
 * called (an agent without an id, a model without a provider or policy)
 * is dropped.
 *
 * An autonomous agent with no model in `modelConfig` is left alone,
 * collaboration included: there is no main role to give it.
 *
 * The columns are `json`, so each statement goes through `jsonb`. Only
 * rows whose `models` is still null are touched, so running it twice
 * changes nothing.
 *
 * `down()` puts teammate roles back as collaboration participants under
 * the `parallel` strategy (the original strategy and rules are not kept)
 * and drops the column.
 */
export class AgentModels1750812200000 implements MigrationInterface {
  name = 'AgentModels1750812200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "models" json
    `);
    await queryRunner.query(`
      UPDATE "agents" a
      SET "models" = jsonb_build_object(
        'strategy', 'single',
        'roles',
        jsonb_build_array(
          jsonb_build_object('key', 'main', 'name', 'Main', 'purpose', 'main', 'kind', 'model')
          || COALESCE(
            (
              SELECT jsonb_object_agg(f.key, f.value)
              FROM jsonb_each(a."modelConfig"::jsonb) AS f(key, value)
              WHERE f.key IN ('providerId', 'model', 'routing', 'temperature', 'maxTokens')
                AND f.value <> 'null'::jsonb
            ),
            '{}'::jsonb
          )
        )
        || COALESCE(
          (
            SELECT jsonb_agg(member.role ORDER BY member.ord)
            FROM (
              SELECT
                p.ord,
                CASE
                  WHEN p.elem ->> 'kind' = 'agent' THEN
                    jsonb_build_object(
                      'key', 'teammate_' || p.ord,
                      'name', COALESCE(NULLIF(p.elem ->> 'role', ''), CASE WHEN p.is_judge THEN 'Judge' ELSE 'Teammate ' || p.ord END),
                      'purpose', 'teammate',
                      'kind', 'agent',
                      'agentId', p.elem ->> 'agentId'
                    )
                  ELSE
                    jsonb_build_object(
                      'key', 'teammate_' || p.ord,
                      'name', COALESCE(NULLIF(p.elem ->> 'role', ''), CASE WHEN p.is_judge THEN 'Judge' ELSE 'Teammate ' || p.ord END),
                      'purpose', 'teammate',
                      'kind', 'model'
                    )
                    || COALESCE(
                      (
                        SELECT jsonb_object_agg(g.key, g.value)
                        FROM jsonb_each(p.elem) AS g(key, value)
                        WHERE g.key IN ('providerId', 'model', 'routing', 'temperature', 'maxTokens', 'instructions')
                          AND g.value <> 'null'::jsonb
                      ),
                      '{}'::jsonb
                    )
                END AS role
              FROM (
                SELECT m.elem, m.is_judge, row_number() OVER (ORDER BY m.is_judge, m.n) AS ord
                FROM (
                  SELECT e.elem, false AS is_judge, e.n
                  FROM jsonb_array_elements(
                    CASE WHEN jsonb_typeof(a."collaboration"::jsonb -> 'participants') = 'array'
                      THEN a."collaboration"::jsonb -> 'participants'
                      ELSE '[]'::jsonb END
                  ) WITH ORDINALITY AS e(elem, n)
                  UNION ALL
                  SELECT a."collaboration"::jsonb -> 'judge', true, 1
                  WHERE jsonb_typeof(a."collaboration"::jsonb -> 'judge') = 'object'
                ) AS m
                WHERE jsonb_typeof(m.elem) = 'object'
                  AND (
                    (m.elem ->> 'kind' = 'agent' AND COALESCE(m.elem ->> 'agentId', '') <> '')
                    OR (
                      m.elem ->> 'kind' = 'model'
                      AND (COALESCE(m.elem ->> 'providerId', '') <> '' OR jsonb_typeof(m.elem -> 'routing') = 'object')
                    )
                  )
              ) AS p
            ) AS member
          ),
          '[]'::jsonb
        )
      )::json,
      "collaboration" = NULL
      WHERE a."mode" = 'autonomous'
        AND a."models" IS NULL
        AND a."modelConfig" IS NOT NULL
        AND jsonb_typeof(a."modelConfig"::jsonb) = 'object'
        AND (
          COALESCE(a."modelConfig"::jsonb ->> 'providerId', '') <> ''
          OR jsonb_typeof(a."modelConfig"::jsonb -> 'routing') = 'object'
        )
        AND (a."collaboration" IS NULL OR jsonb_typeof(a."collaboration"::jsonb) = 'object')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "agents" a
      SET "collaboration" = jsonb_build_object(
        'strategy', 'parallel',
        'participants',
        (
          SELECT jsonb_agg(
            CASE
              WHEN r.elem ->> 'kind' = 'agent' THEN
                jsonb_build_object('kind', 'agent', 'agentId', r.elem ->> 'agentId', 'role', r.elem ->> 'name')
              ELSE
                jsonb_build_object('kind', 'model', 'role', r.elem ->> 'name')
                || COALESCE(
                  (
                    SELECT jsonb_object_agg(g.key, g.value)
                    FROM jsonb_each(r.elem) AS g(key, value)
                    WHERE g.key IN ('providerId', 'model', 'routing', 'temperature', 'maxTokens', 'instructions')
                  ),
                  '{}'::jsonb
                )
            END
            ORDER BY r.n
          )
          FROM jsonb_array_elements(a."models"::jsonb -> 'roles') WITH ORDINALITY AS r(elem, n)
          WHERE r.elem ->> 'purpose' = 'teammate'
        )
      )::json
      WHERE a."models" IS NOT NULL
        AND a."collaboration" IS NULL
        AND jsonb_typeof(a."models"::jsonb -> 'roles') = 'array'
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(a."models"::jsonb -> 'roles') AS t(elem)
          WHERE t.elem ->> 'purpose' = 'teammate'
        )
    `);
    await queryRunner.query(`
      ALTER TABLE "agents" DROP COLUMN IF EXISTS "models"
    `);
  }
}
