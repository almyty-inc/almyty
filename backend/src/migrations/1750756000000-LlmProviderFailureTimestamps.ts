import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * When a provider last failed and last succeeded.
 *
 * `lastError` alone cannot say whether the provider is failing right
 * now or failed once a month ago, and `isHealthy` is a hard gate that
 * blocks every call, so it must not flip on a transient 429. Two
 * timestamps let the dashboard show "failing since 10:40: HTTP 429"
 * while calls keep being attempted.
 */
export class LlmProviderFailureTimestamps1750756000000 implements MigrationInterface {
  name = 'LlmProviderFailureTimestamps1750756000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('llm_providers');
    if (!table) return;
    if (!table.findColumnByName('lastErrorAt')) {
      await queryRunner.addColumn('llm_providers', new TableColumn({ name: 'lastErrorAt', type: 'timestamp', isNullable: true }));
    }
    if (!table.findColumnByName('lastSuccessAt')) {
      await queryRunner.addColumn('llm_providers', new TableColumn({ name: 'lastSuccessAt', type: 'timestamp', isNullable: true }));
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('llm_providers');
    for (const col of ['lastErrorAt', 'lastSuccessAt']) {
      if (table?.findColumnByName(col)) await queryRunner.dropColumn('llm_providers', col);
    }
  }
}
