import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `agents.collaboration` lists `participants`, each tagged with a `kind`
 * ('agent' or 'model'), and names its judge as a participant too.
 *
 * Rows written with the agent-only keys are rewritten in place: every
 * element of `agents` becomes `{ kind: 'agent', ...element }` under
 * `participants`, and `judgeAgentId` becomes `judge: { kind: 'agent',
 * agentId }`. Only rows that still carry an old key are touched, so running
 * it twice changes nothing. The column is `json`, so each statement goes
 * through `jsonb` and back.
 *
 * `down()` restores the agent-only keys from agent participants. A model
 * participant (or model judge) has no representation there and is dropped.
 */
export class CollaborationParticipants1750808000000 implements MigrationInterface {
  name = 'CollaborationParticipants1750808000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "agents"
      SET "collaboration" = (
        ("collaboration"::jsonb - 'agents')
        || jsonb_build_object(
          'participants',
          COALESCE(
            (
              SELECT jsonb_agg(jsonb_build_object('kind', 'agent') || elem ORDER BY ord)
              FROM jsonb_array_elements(
                CASE WHEN jsonb_typeof("collaboration"::jsonb -> 'agents') = 'array'
                  THEN "collaboration"::jsonb -> 'agents'
                  ELSE '[]'::jsonb END
              ) WITH ORDINALITY AS a(elem, ord)
              WHERE jsonb_typeof(elem) = 'object'
            ),
            '[]'::jsonb
          )
        )
      )::json
      WHERE "collaboration" IS NOT NULL
        AND jsonb_typeof("collaboration"::jsonb) = 'object'
        AND ("collaboration"::jsonb) ? 'agents'
    `);
    await queryRunner.query(`
      UPDATE "agents"
      SET "collaboration" = (
        ("collaboration"::jsonb - 'judgeAgentId')
        || CASE
          WHEN jsonb_typeof("collaboration"::jsonb -> 'judgeAgentId') = 'string'
            AND "collaboration"::jsonb ->> 'judgeAgentId' <> ''
          THEN jsonb_build_object(
            'judge',
            jsonb_build_object('kind', 'agent', 'agentId', "collaboration"::jsonb ->> 'judgeAgentId')
          )
          ELSE '{}'::jsonb
        END
      )::json
      WHERE "collaboration" IS NOT NULL
        AND jsonb_typeof("collaboration"::jsonb) = 'object'
        AND ("collaboration"::jsonb) ? 'judgeAgentId'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "agents"
      SET "collaboration" = (
        ("collaboration"::jsonb - 'participants')
        || jsonb_build_object(
          'agents',
          COALESCE(
            (
              SELECT jsonb_agg(elem - 'kind' ORDER BY ord)
              FROM jsonb_array_elements(
                CASE WHEN jsonb_typeof("collaboration"::jsonb -> 'participants') = 'array'
                  THEN "collaboration"::jsonb -> 'participants'
                  ELSE '[]'::jsonb END
              ) WITH ORDINALITY AS p(elem, ord)
              WHERE jsonb_typeof(elem) = 'object' AND elem ->> 'kind' = 'agent'
            ),
            '[]'::jsonb
          )
        )
      )::json
      WHERE "collaboration" IS NOT NULL
        AND jsonb_typeof("collaboration"::jsonb) = 'object'
        AND ("collaboration"::jsonb) ? 'participants'
    `);
    await queryRunner.query(`
      UPDATE "agents"
      SET "collaboration" = (
        ("collaboration"::jsonb - 'judge')
        || CASE
          WHEN "collaboration"::jsonb -> 'judge' ->> 'kind' = 'agent'
            AND COALESCE("collaboration"::jsonb -> 'judge' ->> 'agentId', '') <> ''
          THEN jsonb_build_object('judgeAgentId', "collaboration"::jsonb -> 'judge' ->> 'agentId')
          ELSE '{}'::jsonb
        END
      )::json
      WHERE "collaboration" IS NOT NULL
        AND jsonb_typeof("collaboration"::jsonb) = 'object'
        AND ("collaboration"::jsonb) ? 'judge'
    `);
  }
}
