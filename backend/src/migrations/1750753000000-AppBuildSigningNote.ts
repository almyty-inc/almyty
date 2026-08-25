import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Why a build came out unsigned.
 *
 * `error` already means the build failed. A build can produce a working
 * binary and still fail to sign it (no certificate selected, wrong
 * password, signing tool absent), which succeeds and needs its own
 * sentence. Until now that only reached the build log, which is not
 * shown to anyone.
 */
export class AppBuildSigningNote1750753000000 implements MigrationInterface {
  name = 'AppBuildSigningNote1750753000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('app_builds');
    if (!table) return;
    if (table.findColumnByName('signingNote')) return;

    await queryRunner.addColumn(
      'app_builds',
      new TableColumn({ name: 'signingNote', type: 'varchar', isNullable: true }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('app_builds');
    if (table?.findColumnByName('signingNote')) {
      await queryRunner.dropColumn('app_builds', 'signingNote');
    }
  }
}
