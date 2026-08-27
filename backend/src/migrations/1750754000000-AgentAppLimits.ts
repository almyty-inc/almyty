import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * What a stranger is allowed to cost.
 *
 * `checkApp` refuses to publish a product open to anyone without a cost
 * cap and rate limits, and until now there was nowhere to put them: the
 * rule was correct and permanently unsatisfiable.
 */
export class AgentAppLimits1750754000000 implements MigrationInterface {
  name = 'AgentAppLimits1750754000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('agent_apps');
    if (!table) return;
    if (table.findColumnByName('limits')) return;

    await queryRunner.addColumn(
      'agent_apps',
      new TableColumn({ name: 'limits', type: 'json', isNullable: true }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('agent_apps');
    if (table?.findColumnByName('limits')) {
      await queryRunner.dropColumn('agent_apps', 'limits');
    }
  }
}
