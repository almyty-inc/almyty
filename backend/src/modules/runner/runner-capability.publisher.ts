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
   * Make the runner's Tool rows match its capabilities. Idempotent: a
   * re-registration (every daemon restart) updates the rows already
   * there in place, so their ids survive. Agents hold tools by id
   * (`agents.toolIds`) and gateways through `gateway_tools`, which
   * cascades on delete; minting fresh rows on each restart silently
   * dropped the runner's tools from every agent and gateway using them.
   */
  async publish(runner: Runner): Promise<Tool[]> {
    const rows = await this.tools.manager.transaction((mgr) =>
      this.sync(mgr, {
        organizationId: runner.organizationId,
        ownerKey: 'runnerId',
        ownerId: runner.id,
        build: (cap) => ({
          name: `runner.${runner.name}.${cap.method}`,
          description: cap.description,
          // The tools inherit the runner's visibility and owner. They
          // used to be minted with the column defaults -- org-wide, no
          // owner -- so every member of the organization saw and could
          // call `runner.<name>.shell.exec` on a runner whose owner had
          // scoped it to a team.
          visibility: runner.visibility ?? 'org',
          teamId: runner.visibility === 'team' ? runner.teamId : null,
          createdBy: runner.ownerUserId,
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
        }),
      }),
    );
    this.logger.log(
      `published ${rows.length} capabilities for runner ${runner.name} (${runner.id})`,
    );
    return rows;
  }

  /**
   * The upsert behind publish and publishEnvironment, in one transaction.
   *
   * Each capability keeps one live row: the owner's own row for that
   * method (renamed if the runner was renamed), else a live row already
   * holding the name (a replaced or reaped runner's -- the newest
   * registration owns the name). Every other row the owner or the names
   * hold is deleted: leftovers of an earlier bug, retired copies, and the
   * rows of a method no longer published.
   */
  private async sync(
    mgr: EntityManager,
    opts: {
      organizationId: string;
      ownerKey: 'runnerId' | 'environmentId';
      ownerId: string;
      build: (cap: CapabilityDef) => Partial<Tool>;
    },
  ): Promise<Tool[]> {
    const repo = mgr.getRepository(Tool);
    const wanted = RunnerCapabilityPublisher.CAPABILITIES.map((cap) => ({ cap, fields: opts.build(cap) }));
    const names = wanted.map((w) => w.fields.name as string);
    // `runnerConfig` is a json column, so a criteria object cannot reach
    // into it; the owner is matched with ->> in SQL.
    const held = await repo
      .createQueryBuilder('t')
      .where(
        `t."organizationId" = :organizationId AND (t."runnerConfig"->>'${opts.ownerKey}' = :ownerId OR t.name IN (:...names))`,
        { organizationId: opts.organizationId, ownerId: opts.ownerId, names },
      )
      .getMany();

    const live = held.filter((t) => t.status !== ToolStatus.DELETED);
    const kept = new Map<string, Tool>();
    const taken = new Set<string>();
    const pick = (match: (t: Tool) => boolean) => live.find((t) => !taken.has(t.id) && match(t));
    for (const { cap, fields } of wanted) {
      const ours = (t: Tool) => (t.runnerConfig as any)?.[opts.ownerKey] === opts.ownerId && t.runnerConfig?.method === cap.method;
      const row = pick((t) => ours(t) && t.name === fields.name) ?? pick(ours) ?? pick((t) => t.name === fields.name);
      if (row) {
        kept.set(cap.method, row);
        taken.add(row.id);
      }
    }

    const drop = held.filter((t) => !taken.has(t.id)).map((t) => t.id);
    if (drop.length > 0) {
      await repo.createQueryBuilder().delete().from(Tool).where('id IN (:...ids)', { ids: drop }).execute();
    }
    // Counted after the deletes and on the same transaction: only the
    // capabilities with no row yet take a slot.
    await assertToolQuota(mgr, opts.organizationId, wanted.length - kept.size);

    const rows: Tool[] = [];
    for (const { cap, fields } of wanted) {
      const values = {
        ...fields,
        type: ToolType.FUNCTION,
        status: ToolStatus.ACTIVE,
        version: '1.0.0',
        organizationId: opts.organizationId,
        parameters: cap.parameters,
      } as Partial<Tool>;
      const existing = kept.get(cap.method);
      rows.push(await repo.save(existing ? Object.assign(existing, values) : repo.create(values)));
    }
    return rows;
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
    return this.tools.manager.transaction((mgr) =>
      this.sync(mgr, {
        organizationId: env.organizationId,
        ownerKey: 'environmentId',
        ownerId: env.id,
        build: (cap) => ({
          name: `env.${env.name}.${cap.method}`,
          description: `${cap.description} Runs on the hosted environment ${env.name}, in your own workspace there.`,
          visibility: env.visibility ?? 'private',
          teamId: env.visibility === 'team' ? env.teamId : null,
          createdBy: env.ownerUserId,
          runnerConfig: {
            environmentId: env.id,
            environmentName: env.name,
            method: cap.method,
            requiresWorkspace: cap.requiresWorkspace,
          },
          metadata: { source: `environment:${env.name}`, ownerUserId: env.ownerUserId },
        }),
      }),
    );
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
