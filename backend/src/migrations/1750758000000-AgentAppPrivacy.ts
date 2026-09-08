import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * What a product lets its visitors do with their own data, and how long
 * it keeps it.
 *
 * Stored as one json column with every field optional: a missing value
 * means the default (visitors may delete and export their own
 * conversations, visitor turns stay out of shared memory, retention
 * follows the organization policy). Existing apps therefore get the
 * defaults without a backfill.
 */
export class AgentAppPrivacy1750758000000 implements MigrationInterface {
  name = 'AgentAppPrivacy1750758000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('agent_apps');
    if (!table || table.findColumnByName('privacy')) return;
    await queryRunner.addColumn('agent_apps', new TableColumn({ name: 'privacy', type: 'json', isNullable: true }));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('agent_apps');
    if (table?.findColumnByName('privacy')) await queryRunner.dropColumn('agent_apps', 'privacy');
  }
}
