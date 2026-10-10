import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { Runner } from '../../entities/runner.entity';
import {
  Tool,
  ToolStatus,
  ToolType,
} from '../../entities/tool.entity';
import { assertToolQuota } from '../tools/tool-quota';
import { CapabilityDef, RUNNER_CAPABILITIES } from './runner-capabilities';

/**
 * Publishes Tool rows for the methods a runner exposes. The rest of
 * the platform discovers runner-backed methods through the normal
 * tool catalog: MCP gateways list them, OpenAI-compat translates
 * them to function-calling, the agent builder shows them in the
 * tool picker. The Tool row's `runnerConfig` column tells the
 * executor to dispatch via RunnerCallService rather than HTTP.
 *
 * v1.0 surface: shell.exec and runner.info. process.* methods stay
 * unpublished until we have a stable schema for spawn/write/read
 * sequences (they're not single-call, they're a session, and a
 * single Tool row doesn't model that well).
 *
 * Naming: `runner.<runner-name>.<method>` keeps namespacing explicit
 * without colliding with org-scoped tool names. The runner name is
 * already validated `[a-zA-Z0-9_-]{1,64}`.
 */
@Injectable()
export class RunnerCapabilityPublisher {
  private readonly logger = new Logger(RunnerCapabilityPublisher.name);

  private static readonly CAPABILITIES: CapabilityDef[] = RUNNER_CAPABILITIES;
  constructor(
    @InjectRepository(Tool)
    private readonly tools: Repository<Tool>,
  ) {}

  /**
   * Mint Tool rows for every published capability. Idempotent —
   * re-registration of the same runner upserts on (organizationId,
   * runnerId, method) by deleting and re-inserting in one transaction.
   * Cheaper than reconciling field-by-field and lets us pick up
   * description / schema changes without a migration.
   */
  async publish(runner: Runner): Promise<Tool[]> {
    const names = RunnerCapabilityPublisher.CAPABILITIES.map(
      (cap) => `runner.${runner.name}.${cap.method}`,
    );
    return this.tools.manager.transaction(async (mgr) => {
      const repo = mgr.getRepository(Tool);
      // Two deletes, because two different things can hold these rows.
      //
      // By runnerId: `runnerConfig` is a json column, so a criteria object
      // cannot reach into it -- `repo.delete({ runnerConfig: { runnerId } })`
      // matched nothing, the previous rows survived, and republishing
      // re-inserted the same names. That produced duplicate tools silently
      // until tools_org_name_uq existed.
      //
      // By name: a runner that was replaced, renamed or reaped can leave a
      // row still holding `runner.<name>.<method>` under a DIFFERENT runner
      // id, which the first delete cannot see and the unique index refuses
      // on insert. Publishing is meant to be idempotent -- the newest
      // registration owns the name.
      await repo
        .createQueryBuilder()
        .delete()
        .from(Tool)
        .where(`"runnerConfig"->>'runnerId' = :runnerId`, { runnerId: runner.id })
        .execute();
      await repo
        .createQueryBuilder()
        .delete()
        .from(Tool)
        .where('"organizationId" = :organizationId AND name IN (:...names)', {
          organizationId: runner.organizationId,
          names,
        })
        .execute();
      // Counted after the deletes and on the same transaction, so a
      // re-registration that only replaces its own rows needs no slots.
      await assertToolQuota(
        mgr,
        runner.organizationId,
        RunnerCapabilityPublisher.CAPABILITIES.length,
      );
      const rows: Tool[] = [];
      for (const cap of RunnerCapabilityPublisher.CAPABILITIES) {
        const row = repo.create({
          name: `runner.${runner.name}.${cap.method}`,
          description: cap.description,
          type: ToolType.FUNCTION,
          status: ToolStatus.ACTIVE,
          version: '1.0.0',
          organizationId: runner.organizationId,
          // The tools inherit the runner's visibility and owner. They
          // used to be minted with the column defaults -- org-wide, no
          // owner -- so every member of the organization saw and could
          // call `runner.<name>.shell.exec` on a runner whose owner had
          // scoped it to a team.
          visibility: runner.visibility ?? 'org',
          teamId: runner.visibility === 'team' ? runner.teamId : null,
          createdBy: runner.ownerUserId,
          parameters: cap.parameters,
          runnerConfig: {
            runnerId: runner.id,
            runnerName: runner.name,
            method: cap.method,
            requiresWorkspace: cap.requiresWorkspace,
          },
          metadata: {
            source: `runner:${runner.name}`,
            ownerUserId: runner.ownerUserId,
          },
        } as Partial<Tool>);
        rows.push(await repo.save(row));
      }
      this.logger.log(
        `published ${rows.length} capabilities for runner ${runner.name} (${runner.id})`,
      );
      return rows;
    });
  }

  /**
   * Drop every Tool row that points at this runner. Called on
   * unregister and on runner deletion. Uses the partial index from
   * the migration (tools_runner_id_idx) for the lookup. Pass the
   * caller's EntityManager to delete inside its transaction.
   */
  async unpublish(runnerId: string, manager?: EntityManager): Promise<number> {
    const qb = manager ? manager.createQueryBuilder() : this.tools.createQueryBuilder();
    const result = await qb
      .delete()
      .from(Tool)
      .where(`"runnerConfig"->>'runnerId' = :runnerId`, { runnerId })
      .execute();
    const affected = result.affected ?? 0;
    if (affected > 0) {
      this.logger.log(`unpublished ${affected} capabilities for runner ${runnerId}`);
    }
    return affected;
  }

  /**
   * Tool rows for a hosted environment: the same methods, named
   * `env.<environment>.<method>`, with `runnerConfig.environmentId`
   * instead of a runner. One set per environment however many pods it
   * runs (a pod per workspace would flood the catalog); a call goes to
   * the caller's own workspace on the environment, woken if parked
   * (ToolExecutorService, HOSTED_DISPATCH). The rows carry the
   * environment's visibility and owner. Idempotent, like publish.
   */
  async publishEnvironment(env: {
    id: string;
    name: string;
    organizationId: string;
    ownerUserId: string;
    visibility: 'private' | 'team' | 'org';
    teamId: string | null;
  }): Promise<Tool[]> {
    const names = RunnerCapabilityPublisher.CAPABILITIES.map((cap) => `env.${env.name}.${cap.method}`);
    return this.tools.manager.transaction(async (mgr) => {
      const repo = mgr.getRepository(Tool);
      await repo
        .createQueryBuilder()
        .delete()
        .from(Tool)
        .where(`"runnerConfig"->>'environmentId' = :environmentId`, { environmentId: env.id })
        .execute();
      await repo
        .createQueryBuilder()
        .delete()
        .from(Tool)
        .where('"organizationId" = :organizationId AND name IN (:...names)', { organizationId: env.organizationId, names })
        .execute();
      await assertToolQuota(mgr, env.organizationId, RunnerCapabilityPublisher.CAPABILITIES.length);
      const rows: Tool[] = [];
      for (const cap of RunnerCapabilityPublisher.CAPABILITIES) {
        const row = repo.create({
          name: `env.${env.name}.${cap.method}`,
          description: `${cap.description} Runs on the hosted environment ${env.name}, in your own workspace there.`,
          type: ToolType.FUNCTION,
          status: ToolStatus.ACTIVE,
          version: '1.0.0',
          organizationId: env.organizationId,
          visibility: env.visibility ?? 'private',
          teamId: env.visibility === 'team' ? env.teamId : null,
          createdBy: env.ownerUserId,
          parameters: cap.parameters,
          runnerConfig: {
            environmentId: env.id,
            environmentName: env.name,
            method: cap.method,
            requiresWorkspace: cap.requiresWorkspace,
          },
          metadata: { source: `environment:${env.name}`, ownerUserId: env.ownerUserId },
        } as Partial<Tool>);
        rows.push(await repo.save(row));
      }
      return rows;
    });
  }

  /** Drop an environment's tool rows (the environment was deleted). */
  async unpublishEnvironment(environmentId: string): Promise<number> {
    const result = await this.tools
      .createQueryBuilder()
      .delete()
      .from(Tool)
      .where(`"runnerConfig"->>'environmentId' = :environmentId`, { environmentId })
      .execute();
    return result.affected ?? 0;
  }

  /**
   * Test/inspection helper.
   */
  async listForRunner(runnerId: string): Promise<Tool[]> {
    return this.tools
      .createQueryBuilder('t')
      .where(`t."runnerConfig"->>'runnerId' = :runnerId`, { runnerId })
      .getMany();
  }
}
