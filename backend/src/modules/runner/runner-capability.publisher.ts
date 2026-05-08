import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Runner } from '../../entities/runner.entity';
import {
  Tool,
  ToolStatus,
  ToolType,
} from '../../entities/tool.entity';

interface CapabilityDef {
  method: string;
  description: string;
  requiresWorkspace: boolean;
  parameters: Record<string, unknown>;
}

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

  private static readonly CAPABILITIES: CapabilityDef[] = [
    {
      method: 'runner.info',
      description: 'Return runtime info (OS, arch, node version, installed binaries) for the runner host.',
      requiresWorkspace: false,
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      method: 'shell.exec',
      description: 'Execute a one-shot shell command on the runner host. Captures stdout/stderr and exit code. Workspace-scoped.',
      requiresWorkspace: true,
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Shell command to run. Interpreted by the runner\'s default shell.',
          },
          cwd: {
            type: 'string',
            description: 'Working directory relative to the workspace root. Defaults to workspace root.',
          },
          env: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'Extra environment variables for this invocation.',
          },
          timeoutMs: {
            type: 'integer',
            minimum: 1,
            description: 'Hard timeout in milliseconds. The runner kills the process if exceeded.',
          },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  ];

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
    return this.tools.manager.transaction(async (mgr) => {
      const repo = mgr.getRepository(Tool);
      await repo.delete({ runnerConfig: { runnerId: runner.id } as any });
      const rows: Tool[] = [];
      for (const cap of RunnerCapabilityPublisher.CAPABILITIES) {
        const row = repo.create({
          name: `runner.${runner.name}.${cap.method}`,
          description: cap.description,
          type: ToolType.FUNCTION,
          status: ToolStatus.ACTIVE,
          version: '1.0.0',
          organizationId: runner.organizationId,
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
   * the migration (tools_runner_id_idx) for the lookup.
   */
  async unpublish(runnerId: string): Promise<number> {
    const result = await this.tools
      .createQueryBuilder()
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
   * Test/inspection helper.
   */
  async listForRunner(runnerId: string): Promise<Tool[]> {
    return this.tools
      .createQueryBuilder('t')
      .where(`t."runnerConfig"->>'runnerId' = :runnerId`, { runnerId })
      .getMany();
  }
}
