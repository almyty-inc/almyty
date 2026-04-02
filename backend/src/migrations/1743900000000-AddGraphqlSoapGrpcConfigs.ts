import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddGraphqlSoapGrpcConfigs1743900000000 implements MigrationInterface {
  name = 'AddGraphqlSoapGrpcConfigs1743900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE tools ADD COLUMN IF NOT EXISTS "graphqlConfig" JSON NULL`);
    await queryRunner.query(`ALTER TABLE tools ADD COLUMN IF NOT EXISTS "soapConfig" JSON NULL`);
    await queryRunner.query(`ALTER TABLE tools ADD COLUMN IF NOT EXISTS "grpcConfig" JSON NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE tools DROP COLUMN IF EXISTS "grpcConfig"`);
    await queryRunner.query(`ALTER TABLE tools DROP COLUMN IF EXISTS "soapConfig"`);
    await queryRunner.query(`ALTER TABLE tools DROP COLUMN IF EXISTS "graphqlConfig"`);
  }
}
