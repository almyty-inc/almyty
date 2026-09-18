import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..');
const SRC = join(__dirname, '..', '..');

const allMigrations = readdirSync(MIGRATIONS)
  .filter(f => f.endsWith('.ts'))
  .map(f => readFileSync(join(MIGRATIONS, f), 'utf8'))
  .join('\n');

const src = (...parts: string[]) => readFileSync(join(SRC, ...parts), 'utf8');

/**
 * Indexes and foreign keys the running queries depend on.
 *
 * `synchronize` is off, so an `@Index` or `onDelete` in an entity is a
 * description and never a change: the only thing that puts an index in
 * the database is a migration. These guards read the migration text
 * next to the query that needs it, so a query moving away from the
 * indexed shape — or an index being dropped from under a query — fails
 * here instead of turning into a sequential scan in production.
 */
describe('indexes the queries need', () => {
  describe('version (typeorm-versions)', () => {
    // The table is created with nothing but a primary key, and the
    // library's own entity declares no index, so these two are the only
    // thing standing between the Change History panel / the hourly
    // retention prune and a full scan of the fastest-growing table in
    // the schema.
    it('indexes (itemType, itemId, timestamp DESC) for the Change History read', () => {
      expect(allMigrations).toContain('IDX_version_itemType_itemId_timestamp');
      expect(allMigrations).toMatch(
        /ON "version" \("itemType", "itemId", "timestamp" DESC\)/,
      );

      // The reader this index exists for.
      const versions = src('modules', 'versions', 'versions.service.ts');
      expect(versions).toContain('where: { itemType: entityType, itemId: entityId }');
      expect(versions).toContain("order: { timestamp: 'DESC' }");
    });

    it('indexes timestamp for the retention prune', () => {
      expect(allMigrations).toContain('IDX_version_timestamp');
      expect(allMigrations).toMatch(/ON "version" \("timestamp"\)/);

      const sweep = src('modules', 'retention', 'retention-sweep.service.ts');
      expect(sweep).toContain('FROM "version" WHERE "timestamp" < $1');
    });
  });

  describe('ON DELETE SET NULL referrers of conversations', () => {
    // Postgres does not index a foreign key's referencing column. The
    // retention sweep deletes conversations 1000 ids at a time and every
    // deleted row makes Postgres find the referencing rows to null them.
    it('indexes agent_runs.conversationId', () => {
      expect(allMigrations).toContain('IDX_agent_runs_conversationId');
      expect(allMigrations).toMatch(/ON "agent_runs" \("conversationId"\)/);
      expect(src('entities', 'agent-run.entity.ts')).toContain(
        "@Index('IDX_agent_runs_conversationId', ['conversationId'])",
      );
      expect(allMigrations).toMatch(
        /FK_agent_runs_conversationId[\s\S]{0,160}ON DELETE SET NULL/,
      );
    });

    it('indexes conversations.parentConversationId', () => {
      expect(allMigrations).toContain('IDX_conversations_parentConversationId');
      expect(allMigrations).toMatch(/ON "conversations" \("parentConversationId"\)/);
      expect(src('entities', 'conversation.entity.ts')).toContain(
        "@Index('IDX_conversations_parentConversationId', ['parentConversationId'])",
      );
    });
  });

  describe('request_logs belong to an organization, not to a gateway', () => {
    // gatewayId is ON DELETE SET NULL, so a gateway deletion used to
    // detach every log it wrote and leave it unreachable by any
    // retention policy in the highest-volume table in the schema.
    it('has an organizationId column backed by a cascading foreign key', () => {
      expect(allMigrations).toMatch(
        /ALTER TABLE "request_logs"\s*\n\s*ADD COLUMN IF NOT EXISTS "organizationId" uuid/,
      );
      expect(allMigrations).toContain('FK_request_logs_organizationId');
      expect(allMigrations).toMatch(
        /FK_request_logs_organizationId[\s\S]{0,200}REFERENCES "organizations"\("id"\) ON DELETE CASCADE/,
      );
      expect(src('entities', 'request-log.entity.ts')).toContain(
        "@Column({ type: 'uuid', nullable: true })\n  organizationId: string;",
      );
    });

    it('indexes (organizationId, timestamp), which is what the sweep deletes by', () => {
      expect(allMigrations).toContain('IDX_request_logs_organizationId_timestamp');
      expect(allMigrations).toMatch(
        /ON "request_logs" \("organizationId", "timestamp"\)/,
      );
    });

    it('is populated by the interceptor that writes the rows', () => {
      expect(src('common', 'interceptors', 'request-logging.interceptor.ts')).toContain(
        'log.organizationId = organizationId;',
      );
    });

    it('is what the retention sweep filters on', () => {
      const sweep = src('modules', 'retention', 'retention-sweep.service.ts');
      expect(sweep).toMatch(
        /private async sweepRequestLogs\([\s\S]{0,400}organizationId,\s*\n\s*timestamp: LessThan\(cutoff\)/,
      );
      // No hop through the gateways: that was the bug.
      expect(sweep).not.toMatch(
        /private async sweepRequestLogs\([\s\S]{0,400}gatewayRepository/,
      );
    });

    it('lets a deleted organization take its usage metrics with it', () => {
      // usage_metrics.organizationId is the column the sweep filters on,
      // so SET NULL stranded the rows the same way.
      expect(allMigrations).toMatch(
        /ADD CONSTRAINT "FK_usage_metrics_organizationId"\s*\n\s*FOREIGN KEY \("organizationId"\) REFERENCES "organizations"\("id"\) ON DELETE CASCADE/,
      );
      expect(src('entities', 'usage-metric.entity.ts')).toMatch(
        /@ManyToOne\(\(\) => Organization, \{\s*\n\s*nullable: true,\s*\n\s*onDelete: 'CASCADE',\s*\n\s*\}\)\s*\n\s*@JoinColumn\(\{ name: 'organizationId' \}\)/,
      );
    });
  });

  describe('hosted-chat slug is a global public address', () => {
    it('reserves it with a partial unique index, not a SELECT before an INSERT', () => {
      expect(allMigrations).toContain('UQ_gateways_hosted_chat_slug');
      expect(allMigrations).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "UQ_gateways_hosted_chat_slug"/);
      expect(allMigrations).toMatch(
        /ON "gateways" \(\(\("configuration" -> 'hostedChat' ->> 'slug'\)\)\)/,
      );
      expect(allMigrations).toMatch(/WHERE "type" = 'hosted_chat'/);
    });

    it('indexes the expression the public reader actually queries', () => {
      // A different JSON path here would index nothing the lookup uses
      // and reserve nothing the writer claims.
      expect(src('modules', 'gateways', 'channels', 'hosted-chat.service.ts')).toContain(
        "gateway.configuration -> 'hostedChat' ->> 'slug' = :slug",
      );
      expect(src('modules', 'gateways', 'gateways.service.ts')).toContain(
        "gateway.configuration -> 'hostedChat' ->> 'slug' = :slug",
      );
    });

    it('turns the index violation into a conflict the caller can act on', () => {
      const gateways = src('modules', 'gateways', 'gateways.service.ts');
      expect(gateways).toContain(
        "export const HOSTED_CHAT_SLUG_INDEX = 'UQ_gateways_hosted_chat_slug'",
      );
      expect(gateways).toContain("if (code !== '23505') return null;");
      expect(gateways).toContain('const conflict = this.hostedChatSlugConflict(error, createGatewayDto.configuration);');
      expect(gateways).toContain('const conflict = this.hostedChatSlugConflict(error, updateGatewayDto.configuration);');
    });

    it('keeps jsonb-only operators away from the json configuration column', () => {
      // gateways.configuration is plain json. -> and ->> work; @> does not.
      const initial = readFileSync(
        join(MIGRATIONS, '1700000000000-InitialSchema.ts'),
        'utf8',
      );
      expect(initial).not.toMatch(/CREATE TABLE IF NOT EXISTS "gateways"[\s\S]*?"configuration" jsonb/);
      const hostedChat = src('modules', 'gateways', 'channels', 'hosted-chat.service.ts');
      // A containment query against a json column is a run-time error.
      expect(hostedChat).not.toMatch(/@>\s*:/);
      expect(hostedChat).not.toContain('configuration` jsonb');
    });
  });

  describe('tool_categories tenancy', () => {
    it('backs organizationId with a real cascading foreign key', () => {
      expect(allMigrations).toContain('FK_tool_categories_organizationId');
      expect(allMigrations).toMatch(
        /FK_tool_categories_organizationId[\s\S]{0,200}REFERENCES "organizations"\("id"\) ON DELETE CASCADE/,
      );
      expect(allMigrations).toMatch(
        /ALTER COLUMN "organizationId" TYPE uuid USING "organizationId"::uuid/,
      );
      const entity = src('entities', 'tool-category.entity.ts');
      expect(entity).toContain("@Column({ type: 'uuid' })\n  organizationId: string;");
      expect(entity).toContain("@ManyToOne(() => Organization, { onDelete: 'CASCADE' })");
    });

    it('makes the slug unique per organization rather than per install', () => {
      // `UQ_tool_categories_slug` was unique across the whole table, so
      // the first tenant to create a "web" category took that name from
      // every other organization on the deployment — on a column whose
      // only purpose is to be a short name a human chose.
      expect(allMigrations).toMatch(
        /DROP CONSTRAINT IF EXISTS "UQ_tool_categories_slug"/,
      );
      expect(allMigrations).toMatch(
        /CREATE UNIQUE INDEX IF NOT EXISTS "UQ_tool_categories_org_slug"[\s\S]{0,120}\("organizationId", "slug"\)/,
      );
      const entity = src('entities', 'tool-category.entity.ts');
      expect(entity).toContain("@Unique('UQ_tool_categories_org_slug', ['organizationId', 'slug'])");
      // And the column no longer declares its own global uniqueness,
      // which would put the old constraint back on a fresh sync.
      expect(entity).not.toContain('@Column({ unique: true })');
    });

    it('scopes every category lookup to the organization', () => {
      const tools = src('modules', 'tools', 'tools.service.ts');
      const lookups = tools.match(/toolCategoryRepository\.find\(\{[\s\S]*?\}\)/g) ?? [];
      expect(lookups.length).toBeGreaterThan(0);
      for (const lookup of lookups) {
        expect(lookup).toContain('organizationId');
      }
    });
  });
});

/**
 * A named index declared on an entity has a migration that creates it.
 *
 * The describes above justify a hand-picked index against the query that
 * needs it. This one is the sweep behind them: every explicitly named
 * index in every entity, checked for a migration that mentions it, so a
 * new `@Index('...')` cannot ship as decoration.
 *
 * `synchronize` is off, so an entity decorator is documentation and
 * nothing more -- the index it describes does not exist in the database
 * until a migration writes it. Several idempotency defects were exactly
 * that mistake: a check-then-insert path written as if a unique index
 * stood behind it, with only a non-unique one in the schema.
 *
 * Only explicitly named indexes are checked. TypeORM derives a hashed
 * name for the unnamed ones, which is not something a migration can be
 * matched against by reading it.
 */
const ENTITIES = join(SRC, 'entities');

const NAMED_INDEX = /@Index\(\s*'([A-Za-z0-9_]+)'/g;

function namedIndexesByEntity(): Array<{ file: string; name: string }> {
  const found: Array<{ file: string; name: string }> = [];
  for (const entry of readdirSync(ENTITIES)) {
    if (!entry.endsWith('.entity.ts')) continue;
    const source = readFileSync(join(ENTITIES, entry), 'utf8');
    for (const match of source.matchAll(NAMED_INDEX)) {
      found.push({ file: entry, name: match[1] });
    }
  }
  return found;
}

describe('entity indexes exist in the database', () => {
  const declared = namedIndexesByEntity();

  it('finds named indexes to check, so an empty sweep cannot pass', () => {
    expect(declared.length).toBeGreaterThanOrEqual(10);
  });

  it.each(declared)('$name (declared in $file) is created by a migration', ({ name }) => {
    expect(allMigrations).toContain(name);
  });
});

/**
 * Two guarantees the application code now leans on, asserted over the
 * migration SQL because that is where they actually live. A
 * service-level test passes whether or not the database agrees, which
 * is exactly how the races these migrations close survived: an entity
 * decorator with no migration behind it is not an index.
 *
 * These read one migration at a time and split it, because the claim
 * includes `down()` reversing what `up()` wrote -- which the
 * whole-directory `allMigrations` blob above cannot express.
 */
const readMigration = (file: string) => readFileSync(join(MIGRATIONS, file), 'utf8');
const halves = (sql: string) => ({
  up: sql.slice(sql.indexOf('async up('), sql.indexOf('async down(')),
  down: sql.slice(sql.indexOf('async down(')),
});

describe('one inbound delivery, one run', () => {
  const { up, down } = halves(readMigration('1750799000000-ChannelDeliveryDedupe.ts'));

  it('adds the deliveryId column channel_events records the platform id in', () => {
    expect(up).toMatch(/ALTER TABLE channel_events[\s\S]*ADD COLUMN IF NOT EXISTS "deliveryId"/);
  });

  it('makes (gatewayId, deliveryId) unique, so the database refuses a redelivery', () => {
    expect(up).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "UQ_channel_events_gateway_delivery"[\s\S]*"gatewayId", "deliveryId"/,
    );
  });

  it('keeps the index partial, so the NULL every other event row carries stays repeatable', () => {
    expect(up).toMatch(/WHERE "deliveryId" IS NOT NULL/);
  });

  it('reverses in down()', () => {
    expect(down).toMatch(/DROP INDEX IF EXISTS "UQ_channel_events_gateway_delivery"/);
    expect(down).toMatch(/DROP COLUMN IF EXISTS "deliveryId"/);
  });

  it('the entity declares the same index, so the two cannot drift apart unnoticed', () => {
    const entity = src('entities', 'channel-event.entity.ts');
    expect(entity).toMatch(/UQ_channel_events_gateway_delivery/);
    expect(entity).toMatch(/\['gatewayId', 'deliveryId'\]/);
    expect(entity).toMatch(/unique: true/);
    expect(entity).toMatch(/deliveryId" IS NOT NULL/);
    expect(entity).toMatch(/deliveryId: string \| null/);
  });
});

describe('a quorum cannot lose an approver', () => {
  const { up, down } = halves(readMigration('1750800000000-ApprovalPolicyApprovals.ts'));

  it('gives each collected approval its own row', () => {
    expect(up).toMatch(/CREATE TABLE IF NOT EXISTS approval_policy_approvals/);
    expect(up).toMatch(/"requestId" uuid NOT NULL/);
    expect(up).toMatch(/"approverId" uuid NOT NULL/);
    expect(up).toMatch(/"roles" jsonb NOT NULL/);
  });

  it('makes (requestId, approverId) unique, so a repeat approver is refused by the database', () => {
    expect(up).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "UQ_approval_policy_approvals_request_approver"[\s\S]*"requestId", "approverId"/,
    );
  });

  it('reverses in down()', () => {
    expect(down).toMatch(/DROP INDEX IF EXISTS "UQ_approval_policy_approvals_request_approver"/);
    expect(down).toMatch(/DROP TABLE IF EXISTS approval_policy_approvals/);
  });

  it('the entity declares the same unique index', () => {
    const entity = src('entities', 'approval-policy-approval.entity.ts');
    expect(entity).toMatch(/UQ_approval_policy_approvals_request_approver/);
    expect(entity).toMatch(/\['requestId', 'approverId'\]/);
    expect(entity).toMatch(/unique: true/);
    expect(entity).toMatch(/@Entity\('approval_policy_approvals'\)/);
  });
});
