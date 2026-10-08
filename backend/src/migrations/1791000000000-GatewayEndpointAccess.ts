import { MigrationInterface, QueryRunner } from 'typeorm';

/** Marks the gateway_auth rows this migration deactivated, so down() can bring them back. */
const DEDUPED_BY = 'GatewayEndpointAccess1791000000000';

/** A json column read as a jsonb object, or an empty object when it holds anything else. */
const obj = (column: string) => `CASE WHEN jsonb_typeof(${column}::jsonb) = 'object' THEN ${column}::jsonb ELSE '{}'::jsonb END`;
/** A jsonb value as an array, or an empty array when it is anything else. */
const arr = (value: string) => `CASE WHEN jsonb_typeof(${value}) = 'array' THEN ${value} ELSE '[]'::jsonb END`;

export class GatewayEndpointAccess1791000000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE agents ADD COLUMN "apiGatewayId" uuid NULL REFERENCES gateways(id) ON DELETE SET NULL, ADD COLUMN "apiAccessScope" varchar(24) NOT NULL DEFAULT 'org', ADD COLUMN "apiAccessTeamId" uuid NULL`);
    await q.query(`ALTER TABLE agents ADD CONSTRAINT agent_api_access CHECK (("apiAccessScope"='team' AND "apiAccessTeamId" IS NOT NULL) OR ("apiAccessScope" IN ('private','org','external_open','external_protected') AND "apiAccessTeamId" IS NULL))`);
    await q.query(`ALTER TABLE gateways ADD COLUMN "accessScope" varchar(24) NOT NULL DEFAULT 'org', ADD COLUMN "accessTeamId" uuid NULL`);
    // gateways_visibility_team_chk (1750808000000) already holds a 'team'
    // gateway to a teamId, so every row satisfies gateway_endpoint_access below.
    await q.query(`UPDATE gateways SET "accessScope" = CASE WHEN visibility IN ('private','team') THEN visibility WHEN EXISTS (SELECT 1 FROM gateway_auth a WHERE a."gatewayId"=gateways.id AND a."isActive"=true AND a.type='none') THEN 'external_open' ELSE 'external_protected' END, "accessTeamId" = CASE WHEN visibility='team' THEN "teamId" ELSE NULL END`);
    await q.query(`ALTER TABLE oauth_authorization_codes ADD COLUMN "companyGrant" json NULL`);
    await q.query(`ALTER TABLE oauth_access_tokens ADD COLUMN "companyGrant" json NULL`);
    await this.collapseDuplicateActiveAuths(q);
    await q.query(`CREATE UNIQUE INDEX gateway_active_auth_type ON gateway_auth ("gatewayId", type) WHERE "isActive"=true`);
    await q.query(`ALTER TABLE gateways ADD CONSTRAINT gateway_endpoint_access CHECK (("accessScope"='team' AND "accessTeamId" IS NOT NULL) OR ("accessScope" IN ('private','org','external_open','external_protected') AND "accessTeamId" IS NULL))`);
  }

  /**
   * One active auth row per gateway and type, without locking anyone out.
   *
   * Nothing stopped a gateway from holding two active rows of one type
   * (createGatewayAuth only started refusing it later), and the unique
   * index above aborts the whole deploy on the first such pair. A request
   * passes a gateway when ANY of its active required rows accepts it, so
   * the newest row of each group is kept and widened until it accepts
   * everything the group accepted, and the others are deactivated (not
   * deleted) with a marker down() reads:
   *
   * - every type: required if any row was; validationRules keep only the
   *   restrictions all rows shared (same keyFormat, smallest min length,
   *   largest max length, union of IP ranges when every row had some,
   *   headers every row required).
   * - api_key: the keys themselves are api_keys rows found by gateway, not
   *   by auth row, so they keep working as long as the survivor reads them
   *   from the same place; the other rows' header and query names become
   *   additionalKeyHeaders / additionalKeyQueries.
   * - basic_auth with managed usernames: the users lists are concatenated.
   * - custom: the validTokens lists are joined.
   * - jwt, oauth2, bearer_token, company_signin, none: nothing to merge (a
   *   secret, an issuer, or no configuration at all); the newest one wins.
   */
  private async collapseDuplicateActiveAuths(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS gateway_auth_dupes`);
    await q.query(`
      CREATE TEMP TABLE gateway_auth_dupes AS
      SELECT id, type, first_value(id) OVER w AS "survivorId", row_number() OVER w AS rank
        FROM gateway_auth
       WHERE "isActive" = true
      WINDOW w AS (PARTITION BY "gatewayId", type ORDER BY "createdAt" DESC, id DESC)`);
    await q.query(`
      DELETE FROM gateway_auth_dupes d
       WHERE NOT EXISTS (SELECT 1 FROM gateway_auth_dupes o WHERE o."survivorId" = d."survivorId" AND o.id <> d.id)`);

    await q.query(`
      UPDATE gateway_auth s SET "isRequired" = true
       WHERE s.id IN (SELECT d."survivorId" FROM gateway_auth_dupes d JOIN gateway_auth a ON a.id = d.id WHERE a."isRequired")`);

    await q.query(`
      WITH g AS (
        SELECT sid, id, r,
               CASE WHEN r->>'minKeyLength' ~ '^[0-9]+([.][0-9]+)?$' THEN (r->>'minKeyLength')::numeric ELSE 0 END AS min_len,
               CASE WHEN r->>'maxKeyLength' ~ '^[0-9]+([.][0-9]+)?$' THEN (r->>'maxKeyLength')::numeric ELSE 0 END AS max_len,
               ${arr(`r->'allowedIpRanges'`)} AS ips,
               ${arr(`r->'requiredHeaders'`)} AS hdrs
          FROM (SELECT d."survivorId" AS sid, d.id, ${obj('a."validationRules"')} AS r
                  FROM gateway_auth_dupes d JOIN gateway_auth a ON a.id = d.id) x
      ), m AS (
        SELECT sid, count(*) AS n,
               (array_agg(r) FILTER (WHERE id = sid))[1] AS own,
               CASE WHEN bool_and(COALESCE(r->>'keyFormat', '') <> '') AND count(DISTINCT r->>'keyFormat') = 1 THEN min(r->>'keyFormat') END AS key_format,
               CASE WHEN bool_and(min_len > 0) THEN min(min_len) END AS min_len,
               CASE WHEN bool_and(max_len > 0) THEN max(max_len) END AS max_len,
               bool_and(jsonb_array_length(ips) > 0) AS ip_restricted
          FROM g GROUP BY sid
      ), ips AS (
        SELECT g.sid, jsonb_agg(DISTINCT e) AS list FROM g CROSS JOIN LATERAL jsonb_array_elements(g.ips) e GROUP BY g.sid
      ), hdrs AS (
        SELECT x.sid, jsonb_agg(x.h ORDER BY x.h) AS list
          FROM (SELECT g.sid, lower(e #>> '{}') AS h, count(DISTINCT g.id) AS k
                  FROM g CROSS JOIN LATERAL jsonb_array_elements(g.hdrs) e GROUP BY g.sid, lower(e #>> '{}')) x
          JOIN m ON m.sid = x.sid
         WHERE x.k = m.n
         GROUP BY x.sid
      )
      UPDATE gateway_auth s SET "validationRules" = (
               (m.own - 'keyFormat' - 'minKeyLength' - 'maxKeyLength' - 'allowedIpRanges' - 'requiredHeaders')
               || jsonb_strip_nulls(jsonb_build_object(
                    'keyFormat', m.key_format,
                    'minKeyLength', m.min_len,
                    'maxKeyLength', m.max_len,
                    'allowedIpRanges', CASE WHEN m.ip_restricted THEN ips.list END,
                    'requiredHeaders', hdrs.list))
             )::json
        FROM m LEFT JOIN ips ON ips.sid = m.sid LEFT JOIN hdrs ON hdrs.sid = m.sid
       WHERE s.id = m.sid`);

    await q.query(`
      WITH g AS (
        SELECT d."survivorId" AS sid, d.id, cfg.c,
               lower(COALESCE(NULLIF(cfg.c->>'keyHeader', ''), 'x-api-key')) AS hdr,
               COALESCE(NULLIF(cfg.c->>'keyQuery', ''), 'api_key') AS qry
          FROM gateway_auth_dupes d
          JOIN gateway_auth a ON a.id = d.id
          CROSS JOIN LATERAL (SELECT ${obj('a.configuration')} AS c) cfg
         WHERE d.type = 'api_key'
      ), cand AS (
        SELECT sid, 'h' AS kind, hdr AS v FROM g
        UNION SELECT g.sid, 'h', lower(e #>> '{}') FROM g CROSS JOIN LATERAL jsonb_array_elements(${arr(`g.c->'additionalKeyHeaders'`)}) e
        UNION SELECT sid, 'q', qry FROM g
        UNION SELECT g.sid, 'q', e #>> '{}' FROM g CROSS JOIN LATERAL jsonb_array_elements(${arr(`g.c->'additionalKeyQueries'`)}) e
      ), m AS (
        SELECT sv.sid, sv.c,
               jsonb_agg(DISTINCT cand.v) FILTER (WHERE cand.kind = 'h' AND cand.v <> sv.hdr) AS hs,
               jsonb_agg(DISTINCT cand.v) FILTER (WHERE cand.kind = 'q' AND cand.v <> sv.qry) AS qs
          FROM g sv JOIN cand ON cand.sid = sv.sid
         WHERE sv.id = sv.sid
         GROUP BY sv.sid, sv.c, sv.hdr, sv.qry
      )
      UPDATE gateway_auth s SET configuration = (
               (m.c - 'additionalKeyHeaders' - 'additionalKeyQueries')
               || jsonb_strip_nulls(jsonb_build_object('additionalKeyHeaders', m.hs, 'additionalKeyQueries', m.qs))
             )::json
        FROM m
       WHERE s.id = m.sid`);

    await q.query(`
      WITH u AS (
        SELECT d."survivorId" AS sid, t.e, min(d.rank * 100000 + t.o) AS pos
          FROM gateway_auth_dupes d
          JOIN gateway_auth a ON a.id = d.id
          CROSS JOIN LATERAL jsonb_array_elements(${arr(`a.configuration::jsonb->'users'`)}) WITH ORDINALITY AS t(e, o)
         WHERE d.type = 'basic_auth'
         GROUP BY d."survivorId", t.e
      ), m AS (
        SELECT sid, jsonb_agg(e ORDER BY pos) AS users FROM u GROUP BY sid
      )
      UPDATE gateway_auth s SET configuration = jsonb_set(s.configuration::jsonb, '{users}', m.users)::json
        FROM m
       WHERE s.id = m.sid AND jsonb_typeof(s.configuration::jsonb->'users') = 'array'`);

    await q.query(`
      WITH t AS (
        SELECT d."survivorId" AS sid, jsonb_agg(DISTINCT e) AS list
          FROM gateway_auth_dupes d
          JOIN gateway_auth a ON a.id = d.id
          CROSS JOIN LATERAL jsonb_array_elements(${arr(`a.configuration::jsonb->'validTokens'`)}) e
         WHERE d.type = 'custom'
         GROUP BY d."survivorId"
      )
      UPDATE gateway_auth s SET configuration = jsonb_set(${obj('s.configuration')}, '{validTokens}', t.list)::json
        FROM t
       WHERE s.id = t.sid`);

    await q.query(
      `UPDATE gateway_auth a SET "isActive" = false,
              metadata = (${obj('a.metadata')} || jsonb_build_object('deduplicatedInto', d."survivorId", 'deduplicatedBy', $1::text))::json
         FROM gateway_auth_dupes d
        WHERE a.id = d.id AND d.id <> d."survivorId"`,
      [DEDUPED_BY],
    );
    await q.query(`DROP TABLE gateway_auth_dupes`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE agents DROP CONSTRAINT agent_api_access, DROP COLUMN "apiGatewayId", DROP COLUMN "apiAccessScope", DROP COLUMN "apiAccessTeamId"`);
    await q.query(`DROP INDEX gateway_active_auth_type`);
    // The rows up() folded into a survivor come back. The survivor keeps its
    // widened settings, which accept everything the group accepted anyway.
    await q.query(
      `UPDATE gateway_auth SET "isActive" = true, metadata = (metadata::jsonb - 'deduplicatedInto' - 'deduplicatedBy')::json
        WHERE metadata::jsonb->>'deduplicatedBy' = $1`,
      [DEDUPED_BY],
    );
    await q.query(`ALTER TABLE oauth_authorization_codes DROP COLUMN "companyGrant"`);
    await q.query(`ALTER TABLE oauth_access_tokens DROP COLUMN "companyGrant"`);
    await q.query(`ALTER TABLE gateways DROP CONSTRAINT gateway_endpoint_access, DROP COLUMN "accessTeamId", DROP COLUMN "accessScope"`);
  }
}
