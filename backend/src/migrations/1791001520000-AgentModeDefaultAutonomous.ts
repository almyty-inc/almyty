import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A new agent starts autonomous: give it a goal, tools and a model, and it
 * works out the steps. A workflow is one click away in the builder. The
 * column default follows what AgentsService.createAgent picks, so a row
 * written without a mode gets the same.
 */
export class AgentModeDefaultAutonomous1791001520000 implements MigrationInterface {
  name = 'AgentModeDefaultAutonomous1791001520000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "agents" ALTER COLUMN "mode" SET DEFAULT 'autonomous'`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "agents" ALTER COLUMN "mode" SET DEFAULT 'workflow'`);
  }
}
