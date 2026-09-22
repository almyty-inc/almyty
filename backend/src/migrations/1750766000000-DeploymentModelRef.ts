import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A deployment can name the model as plain configuration.
 *
 * Registering a version made sense when almyty held the artifact. It does
 * not: a model that already lives on a platform, or a Hugging Face
 * repository, is a reference, and asking someone to register it first was
 * bureaucracy. The version link becomes optional and the reference lives
 * on the deployment.
 */
export class DeploymentModelRef1750766000000 implements MigrationInterface {
  name = 'DeploymentModelRef1750766000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "model_deployments" ADD COLUMN IF NOT EXISTS "modelRef" varchar`);
    await queryRunner.query(`ALTER TABLE "model_deployments" ADD COLUMN IF NOT EXISTS "modelBase" varchar`);
    await queryRunner.query(`ALTER TABLE "model_deployments" ALTER COLUMN "modelVersionId" DROP NOT NULL`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_model_deployments_model_ref" ON "model_deployments" ("organizationId", "modelRef")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_model_deployments_model_ref"`);
    await queryRunner.query(`ALTER TABLE "model_deployments" DROP COLUMN IF EXISTS "modelBase"`);
    await queryRunner.query(`ALTER TABLE "model_deployments" DROP COLUMN IF EXISTS "modelRef"`);
  }
}
