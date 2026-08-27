import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Who started a run, when it was not a dashboard user.
 *
 * A run from a published surface belongs to a visitor with no account
 * here. Attributing it through `userId` put a value in that column no
 * `users` row matches, which the conversations foreign key rejected —
 * so every message sent to a hosted chat or a channel failed at the
 * first model call.
 */
export class AgentRunEndUser1750755000000 implements MigrationInterface {
  name = 'AgentRunEndUser1750755000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('agent_runs');
    if (!table) return;
    if (table.findColumnByName('endUserId')) return;

    await queryRunner.addColumn(
      'agent_runs',
      new TableColumn({ name: 'endUserId', type: 'uuid', isNullable: true }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('agent_runs');
    if (table?.findColumnByName('endUserId')) {
      await queryRunner.dropColumn('agent_runs', 'endUserId');
    }
  }
}
