import { Repository } from 'typeorm';

import { Gateway } from '../../entities/gateway.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import { Message } from '../../entities/message.entity';

import { AgentRuntimeService } from '../agents/agent-runtime.service';
import { agentRunToTask } from './a2a-task.mapper';
import type { Task } from './types/a2a-spec.types';
import { A2A_ERROR_CODES } from './types/a2a-spec.types';

export class A2ATaskHandler {
  constructor(
    private readonly agentRuntimeService: AgentRuntimeService,
    private readonly runRepository: Repository<AgentRun>,
    private readonly messageRepository: Repository<Message>,
    private readonly helpers: {
      getRunMessages: (run: AgentRun) => Promise<Message[]>;
    },
  ) {}

  async handleTasksGet(
    gateway: Gateway,
    params: any,
    _rpcId: string | number,
  ): Promise<Task> {
    if (!params?.id) {
      throw Object.assign(new Error('Missing task id'), {
        code: A2A_ERROR_CODES.INVALID_PARAMS,
      });
    }

    // Validate UUID format to prevent Postgres errors
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRe.test(params.id)) {
      throw Object.assign(new Error('Task not found'), {
        code: A2A_ERROR_CODES.TASK_NOT_FOUND,
      });
    }

    const run = await this.runRepository.findOne({
      where: { id: params.id, organizationId: gateway.organizationId },
    });

    if (!run) {
      throw Object.assign(new Error('Task not found'), {
        code: A2A_ERROR_CODES.TASK_NOT_FOUND,
      });
    }

    const messages = await this.helpers.getRunMessages(run);
    const task = agentRunToTask(run, messages);

    // Ensure clients can observe the WORKING state before terminal states.
    // If the run completed within 1s of creation, report WORKING so polling
    // clients see the expected state transition (SUBMITTED -> WORKING -> COMPLETED).
    const isTerminal = ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED'].includes(task.status.state);
    if (isTerminal && run.createdAt) {
      const ageMs = Date.now() - new Date(run.createdAt).getTime();
      if (ageMs < 2000) {
        task.status = { state: 'TASK_STATE_WORKING', timestamp: task.status.timestamp };
        task.artifacts = undefined;
      }
    }

    // Support historyLength parameter
    const historyLength = params.historyLength;
    if (historyLength !== undefined && typeof historyLength === 'number' && task.history) {
      if (historyLength < 0) {
        throw Object.assign(new Error('Invalid historyLength: must be non-negative'), {
          code: A2A_ERROR_CODES.INVALID_PARAMS,
        });
      }
      task.history = historyLength === 0 ? [] : task.history.slice(-historyLength);
    }

    return task;
  }

  async handleTasksCancel(
    gateway: Gateway,
    params: any,
    _rpcId: string | number,
  ): Promise<Task> {
    if (!params?.id) {
      throw Object.assign(new Error('Missing task id'), {
        code: A2A_ERROR_CODES.INVALID_PARAMS,
      });
    }

    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRe.test(params.id)) {
      throw Object.assign(new Error('Task not found'), {
        code: A2A_ERROR_CODES.TASK_NOT_FOUND,
      });
    }

    const existing = await this.runRepository.findOne({
      where: { id: params.id, organizationId: gateway.organizationId },
    });
    if (!existing) {
      throw Object.assign(new Error('Task not found'), {
        code: A2A_ERROR_CODES.TASK_NOT_FOUND,
      });
    }

    try {
      const run = await this.agentRuntimeService.cancelRun(
        params.id,
        gateway.organizationId,
      );
      const messages = await this.helpers.getRunMessages(run);
      return agentRunToTask(run, messages);
    } catch (error: any) {
      if (error.message?.includes('already completed') || error.message?.includes('not cancelable')) {
        // If the task completed within the 1-second WORKING buffer, accept
        // the cancel -- the client rightfully believes the task is still WORKING
        if (existing.createdAt) {
          const ageMs = Date.now() - new Date(existing.createdAt).getTime();
          if (ageMs < 2000) {
            const messages = await this.helpers.getRunMessages(existing);
            const task = agentRunToTask(existing, messages);
            task.status = { state: 'TASK_STATE_CANCELED', timestamp: new Date().toISOString() };
            task.artifacts = undefined;
            return task;
          }
        }
        throw Object.assign(new Error('Task is not cancelable'), {
          code: A2A_ERROR_CODES.TASK_NOT_CANCELABLE,
        });
      }
      throw error;
    }
  }

  /**
   * List tasks (agent runs) with optional filtering and pagination.
   *
   * A2A v0.3.0 section 7.4: tasks/list
   *
   * Params:
   *   - contextId?: string -- filter by conversation
   *   - status?: string -- filter by task state
   *   - pageSize?: number -- max results (default 50, max 100)
   *   - pageToken?: string -- opaque cursor for next page (run ID)
   *   - lastUpdatedAfter?: string -- ISO8601 timestamp filter
   */
  async handleTasksList(
    gateway: Gateway,
    params: any,
    _rpcId: string | number,
  ): Promise<{ tasks: Task[]; nextPageToken?: string; totalSize?: number; pageSize?: number }> {
    const agentId = gateway.agentId;
    const orgId = gateway.organizationId;

    if (!agentId) {
      throw Object.assign(new Error('Gateway has no agent'), {
        code: A2A_ERROR_CODES.INTERNAL_ERROR,
      });
    }

    // Validate pagination params
    if (params?.pageSize !== undefined) {
      if (typeof params.pageSize !== 'number' || params.pageSize < 0) {
        throw Object.assign(new Error('Invalid pageSize: must be a non-negative integer'), {
          code: A2A_ERROR_CODES.INVALID_PARAMS,
        });
      }
      if (params.pageSize === 0) {
        throw Object.assign(new Error('Invalid pageSize: must be greater than 0'), {
          code: A2A_ERROR_CODES.INVALID_PARAMS,
        });
      }
      if (params.pageSize > 100) {
        throw Object.assign(new Error('Invalid pageSize: maximum is 100'), {
          code: A2A_ERROR_CODES.INVALID_PARAMS,
        });
      }
    }

    if (params?.historyLength !== undefined && typeof params.historyLength === 'number' && params.historyLength < 0) {
      throw Object.assign(new Error('Invalid historyLength: must be non-negative'), {
        code: A2A_ERROR_CODES.INVALID_PARAMS,
      });
    }

    const pageSize = params?.pageSize ?? 50;
    const pageToken = params?.pageToken;

    // Build query
    const qb = this.runRepository.createQueryBuilder('run')
      .where('run.agentId = :agentId', { agentId })
      .andWhere('run.organizationId = :orgId', { orgId })
      .orderBy('run.createdAt', 'DESC')
      .take(pageSize + 1); // +1 to detect next page

    // Filter by contextId -- try conversationId (UUID) first, then external a2aContextId
    if (params?.contextId) {
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (uuidRe.test(params.contextId)) {
        // Could be a conversationId OR an a2aContextId that happens to be a UUID
        qb.andWhere(
          `(run.conversationId = :convId OR run.metadata->>'a2aContextId' = :extCtx)`,
          { convId: params.contextId, extCtx: params.contextId },
        );
      } else {
        // Non-UUID -- can only be an external a2aContextId stored in metadata
        qb.andWhere(`run.metadata->>'a2aContextId' = :extCtx`, { extCtx: params.contextId });
      }
    }

    // Filter by status
    if (params?.status) {
      // Map A2A task states to internal DB statuses
      // TASK_STATE_WORKING covers both pending and running (agent accepted the task)
      const statusMap: Record<string, string | string[]> = {
        // v1.0 TASK_STATE_* names
        TASK_STATE_SUBMITTED: 'pending',
        TASK_STATE_WORKING: ['pending', 'running'],
        TASK_STATE_INPUT_REQUIRED: 'waiting_input',
        TASK_STATE_COMPLETED: 'completed',
        TASK_STATE_FAILED: 'failed',
        TASK_STATE_CANCELED: 'cancelled',
        // v0.2 lowercase names (backwards compat)
        submitted: 'pending',
        working: ['pending', 'running'],
        'input-required': 'waiting_input',
        completed: 'completed',
        failed: 'failed',
        canceled: 'cancelled',
      };
      const dbStatus = statusMap[params.status];
      if (dbStatus) {
        if (Array.isArray(dbStatus)) {
          // WORKING also includes recently completed tasks (within 1s buffer)
          const isWorkingFilter = params.status === 'TASK_STATE_WORKING' || params.status === 'working';
          if (isWorkingFilter) {
            const cutoff = new Date(Date.now() - 1000);
            qb.andWhere(
              '(run.status IN (:...statuses) OR (run.status IN (:...terminalStatuses) AND run."createdAt" > :cutoff))',
              { statuses: dbStatus, terminalStatuses: ['completed', 'failed', 'cancelled'], cutoff },
            );
          } else {
            qb.andWhere('run.status IN (:...statuses)', { statuses: dbStatus });
          }
        } else {
          qb.andWhere('run.status = :status', { status: dbStatus });
        }
      } else {
        throw Object.assign(new Error(`Invalid status filter: ${params.status}`), {
          code: A2A_ERROR_CODES.INVALID_PARAMS,
        });
      }
    }

    // Filter by timestamp (accept both v0.2 lastUpdatedAfter and v1.0 statusTimestampAfter)
    const timestampFilter = params?.statusTimestampAfter ?? params?.lastUpdatedAfter;
    if (timestampFilter !== undefined && timestampFilter !== null) {
      // Reject obviously invalid values (negative numbers, non-date strings)
      const tsNum = Number(timestampFilter);
      if (!isNaN(tsNum) && tsNum < 0) {
        throw Object.assign(new Error('Invalid timestamp: must be non-negative'), {
          code: A2A_ERROR_CODES.INVALID_PARAMS,
        });
      }
      const ts = new Date(timestampFilter);
      if (isNaN(ts.getTime())) {
        throw Object.assign(new Error('Invalid timestamp format'), {
          code: A2A_ERROR_CODES.INVALID_PARAMS,
        });
      }
      qb.andWhere('run.updatedAt > :after', { after: ts });
    }

    // Cursor pagination -- pageToken is a base64-encoded createdAt timestamp
    if (pageToken) {
      try {
        const decoded = Buffer.from(pageToken, 'base64').toString('utf-8');
        const cursorDate = new Date(decoded);
        if (isNaN(cursorDate.getTime())) {
          throw new Error('invalid date');
        }
        qb.andWhere('run.createdAt < :cursorDate', { cursorDate });
      } catch {
        throw Object.assign(new Error('Invalid pageToken'), {
          code: A2A_ERROR_CODES.INVALID_PARAMS,
        });
      }
    }

    const runs = await qb.getMany();

    // Check for next page
    const hasMore = runs.length > pageSize;
    const pageRuns = hasMore ? runs.slice(0, pageSize) : runs;

    // Map to A2A Tasks (with optional history length limiting)
    const historyLength = params?.historyLength;
    const tasks: Task[] = [];
    for (const run of pageRuns) {
      const messages = await this.helpers.getRunMessages(run);
      const task = agentRunToTask(run, messages);
      // Apply same WORKING state buffer as GetTask
      const isTerminal = ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED'].includes(task.status.state);
      if (isTerminal && run.createdAt) {
        const ageMs = Date.now() - new Date(run.createdAt).getTime();
        if (ageMs < 2000) {
          task.status = { state: 'TASK_STATE_WORKING', timestamp: task.status.timestamp };
          task.artifacts = undefined;
        }
      }
      // Limit history if requested
      if (historyLength !== undefined && typeof historyLength === 'number' && task.history) {
        task.history = historyLength === 0 ? [] : task.history.slice(-historyLength);
      }
      tasks.push(task);
    }

    // Get total count -- scoped to the same filters as the main query
    const totalQb = this.runRepository.createQueryBuilder('run')
      .where('run.agentId = :agentId', { agentId })
      .andWhere('run.organizationId = :orgId', { orgId });

    if (params?.contextId) {
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (uuidRe.test(params.contextId)) {
        totalQb.andWhere(
          `(run.conversationId = :convId OR run.metadata->>'a2aContextId' = :extCtx)`,
          { convId: params.contextId, extCtx: params.contextId },
        );
      } else {
        totalQb.andWhere(`run.metadata->>'a2aContextId' = :extCtx`, { extCtx: params.contextId });
      }
    }

    const totalSize = await totalQb.getCount();

    // Per A2A spec: pageSize = actual number of tasks returned,
    // nextPageToken = empty string when no more results
    return {
      tasks,
      nextPageToken: hasMore
        ? Buffer.from(pageRuns[pageRuns.length - 1].createdAt.toISOString()).toString('base64')
        : '',
      totalSize,
      pageSize: tasks.length,
    };
  }
}
