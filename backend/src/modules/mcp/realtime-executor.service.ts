import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter } from 'events';
import { InjectRedis } from '@nestjs-modules/ioredis';
import * as Redis from 'ioredis';
import * as crypto from 'crypto';

import { ToolExecutorService, ToolExecutionResult, ToolExecutionOptions } from '../tools/tool-executor.service';
import { McpSessionService } from './mcp-session.service';
import { SseTransport } from './transports/sse.transport';
import { WebSocketTransport } from './transports/websocket.transport';

export interface StreamingExecutionOptions extends ToolExecutionOptions {
  streaming?: boolean;
  sessionId?: string;
  connectionId?: string;
  transport?: 'http' | 'sse' | 'websocket';
}

export interface ExecutionProgress {
  executionId: string;
  toolId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number; // 0-100
  message?: string;
  result?: any;
  error?: string;
  startedAt: Date;
  completedAt?: Date;
  metadata?: Record<string, any>;
}

export interface ExecutionQueue {
  id: string;
  organizationId: string;
  priority: number;
  toolId: string;
  parameters: Record<string, any>;
  options: StreamingExecutionOptions;
  queuedAt: Date;
  estimatedDuration?: number;
}

@Injectable()
export class RealtimeExecutorService extends EventEmitter {
  private readonly logger = new Logger(RealtimeExecutorService.name);
  private readonly activeExecutions = new Map<string, ExecutionProgress>();
  private readonly executionQueue = new Map<string, ExecutionQueue>();
  private processingInterval?: NodeJS.Timeout;

  constructor(
    private readonly toolExecutorService: ToolExecutorService,
    private readonly mcpSessionService: McpSessionService,
    private readonly sseTransport: SseTransport,
    private readonly wsTransport: WebSocketTransport,
    @InjectRedis() private readonly redis: Redis.Redis,
  ) {
    super();
    this.startQueueProcessor();
    this.setupProgressBroadcasting();
  }

  // Enhanced tool execution with real-time updates
  async executeToolRealtime(
    toolId: string,
    parameters: Record<string, any>,
    options: StreamingExecutionOptions,
  ): Promise<string> {
    // Execution IDs are used as the ONLY authorisation key by
    // getExecutionStatus / cancelExecution callers that hold one. The
    // previous shape was `exec_${Date.now()}_${Math.random().toString(36).substr(2,9)}`
    // — 9 base36 characters plus a guessable millisecond prefix, so an
    // attacker who knew roughly when an execution started could brute-
    // force the random tail (~46 bits) and impersonate it. Use
    // crypto.randomBytes for unguessable ids.
    const executionId = `exec_${crypto.randomBytes(16).toString('hex')}`;
    
    // Create execution progress tracking
    const progress: ExecutionProgress = {
      executionId,
      toolId,
      status: 'queued',
      progress: 0,
      message: 'Tool execution queued',
      startedAt: new Date(),
      metadata: {
        userId: options.userId,
        organizationId: options.organizationId,
        streaming: options.streaming,
        transport: options.transport,
      },
    };

    this.activeExecutions.set(executionId, progress);

    // Add to execution queue
    const queueItem: ExecutionQueue = {
      id: executionId,
      organizationId: options.organizationId,
      priority: this.calculatePriority(options),
      toolId,
      parameters,
      options,
      queuedAt: new Date(),
      estimatedDuration: await this.estimateExecutionTime(toolId),
    };

    this.executionQueue.set(executionId, queueItem);

    this.logger.debug(`Tool execution queued: ${executionId} for tool: ${toolId}`);

    // Emit initial progress
    await this.broadcastProgress(progress);

    // If streaming is disabled, execute synchronously
    if (!options.streaming) {
      return this.executeAndWait(executionId);
    }

    return executionId;
  }

  // Execute tool and wait for completion (non-streaming mode)
  private async executeAndWait(executionId: string): Promise<any> {
    return new Promise((resolve, reject) => {
      // .unref() so the pending timeout doesn't keep the Node process
      // alive past shutdown. Same class of timer leak as the other
      // setTimeout fixes in this module.
      const timeout = setTimeout(() => {
        reject(new Error('Tool execution timeout'));
      }, 300000); // 5 minutes
      timeout.unref?.();

      this.once(`execution:${executionId}:completed`, (result) => {
        clearTimeout(timeout);
        resolve(result);
      });

      this.once(`execution:${executionId}:failed`, (error) => {
        clearTimeout(timeout);
        reject(new Error(error));
      });
    });
  }

  // Process execution queue
  private startQueueProcessor(): void {
    this.processingInterval = setInterval(async () => {
      await this.processQueue();
    }, 1000); // Process every second
    // .unref() so the poll timer doesn't keep the Node process alive
    // during graceful shutdown or in test environments. shutdown()
    // still clearInterval's the handle explicitly.
    this.processingInterval.unref?.();
  }

  private async processQueue(): Promise<void> {
    // Get next item from queue (priority-based)
    const queueItems = Array.from(this.executionQueue.values())
      .sort((a, b) => b.priority - a.priority);

    if (queueItems.length === 0) {
      return;
    }

    // Process up to 3 concurrent executions
    const maxConcurrent = 3;
    const runningExecutions = Array.from(this.activeExecutions.values())
      .filter(exec => exec.status === 'running');

    if (runningExecutions.length >= maxConcurrent) {
      return;
    }

    // Take next queued item
    const nextItem = queueItems.find(item => {
      const progress = this.activeExecutions.get(item.id);
      return progress?.status === 'queued';
    });

    if (!nextItem) {
      return;
    }

    // Start execution
    await this.startExecution(nextItem);
  }

  private async startExecution(queueItem: ExecutionQueue): Promise<void> {
    const { id: executionId, toolId, parameters, options } = queueItem;

    // Update progress
    await this.updateProgress(executionId, {
      status: 'running',
      progress: 10,
      message: 'Tool execution started',
    });

    // Hoist the progress interval so the `finally` block can always
    // clear it. Previously it lived inside the `try` and was only
    // cleared on the happy path — the catch branch leaked it, so a
    // failed execution kept firing progress ticks every 2 seconds
    // forever, accumulating setInterval handles across failures.
    let progressInterval: NodeJS.Timeout | undefined;

    try {
      progressInterval = setInterval(async () => {
        const progress = this.activeExecutions.get(executionId);
        if (progress && progress.status === 'running') {
          const newProgress = Math.min(progress.progress + 10, 90);
          await this.updateProgress(executionId, {
            progress: newProgress,
            message: `Tool executing... ${newProgress}%`,
          });
        }
      }, 2000);
      progressInterval.unref?.();

      // Execute the tool
      const result: ToolExecutionResult = await this.toolExecutorService.executeTool(
        toolId,
        parameters,
        options,
      );

      // Complete execution
      await this.completeExecution(executionId, result);

    } catch (error) {
      // Fail execution
      await this.failExecution(executionId, error);
    } finally {
      if (progressInterval) clearInterval(progressInterval);
      // Remove from queue
      this.executionQueue.delete(executionId);
    }
  }

  // Update execution progress
  private async updateProgress(
    executionId: string,
    updates: Partial<ExecutionProgress>,
  ): Promise<void> {
    const progress = this.activeExecutions.get(executionId);
    if (!progress) {
      return;
    }

    Object.assign(progress, updates);
    this.activeExecutions.set(executionId, progress);

    // Broadcast progress update
    await this.broadcastProgress(progress);
    
    // Store in Redis for persistence
    await this.redis.setex(
      `execution:${executionId}`,
      3600, // 1 hour TTL
      JSON.stringify(progress)
    );
  }

  // Complete execution
  private async completeExecution(
    executionId: string,
    result: ToolExecutionResult,
  ): Promise<void> {
    await this.updateProgress(executionId, {
      status: 'completed',
      progress: 100,
      message: 'Tool execution completed successfully',
      result: result.data,
      completedAt: new Date(),
      metadata: {
        ...this.activeExecutions.get(executionId)?.metadata,
        executionTime: result.executionTime,
        cached: result.cached,
        retryCount: result.retryCount,
      },
    });

    this.emit(`execution:${executionId}:completed`, result);

    // Clean up after delay. .unref() so the pending handle doesn't
    // keep the event loop alive through graceful shutdown.
    const cleanup = setTimeout(() => {
      this.activeExecutions.delete(executionId);
    }, 60000); // Keep for 1 minute
    cleanup.unref?.();
  }

  // Fail execution
  private async failExecution(executionId: string, error: Error): Promise<void> {
    await this.updateProgress(executionId, {
      status: 'failed',
      progress: 0,
      message: `Tool execution failed: ${error.message}`,
      error: error.message,
      completedAt: new Date(),
    });

    this.emit(`execution:${executionId}:failed`, error.message);

    // Clean up after delay. .unref() — same hygiene as completeExecution.
    const cleanup = setTimeout(() => {
      this.activeExecutions.delete(executionId);
    }, 300000); // Keep failed executions longer for debugging
    cleanup.unref?.();
  }

  // Broadcast progress to clients
  private async broadcastProgress(progress: ExecutionProgress): Promise<void> {
    const message = {
      type: 'execution_progress',
      data: progress,
    };

    // Broadcast via SSE
    await this.sseTransport.broadcast(progress.metadata.organizationId, message);
    
    // Broadcast via WebSocket
    await this.wsTransport.broadcastToOrganization(progress.metadata.organizationId, message);

    // Emit for other services
    this.emit('progress', progress);
  }

  // Setup progress broadcasting
  private setupProgressBroadcasting(): void {
    // Listen for MCP session notifications
    this.mcpSessionService.on('notification', async (sessionId: string, notification: any) => {
      // Forward execution-related notifications
      if (notification.method?.startsWith('execution/')) {
        // Handle execution notifications
      }
    });
  }

  // Calculate execution priority
  private calculatePriority(options: StreamingExecutionOptions): number {
    let priority = 50; // Base priority

    // Higher priority for streaming executions
    if (options.streaming) {
      priority += 20;
    }

    // Higher priority for authenticated users
    if (options.userId && options.userId !== 'anonymous') {
      priority += 10;
    }

    // Lower priority for retries
    if (options.retries && options.retries > 0) {
      priority -= options.retries * 5;
    }

    return Math.max(0, Math.min(100, priority));
  }

  // Estimate execution time based on tool history
  private async estimateExecutionTime(toolId: string): Promise<number> {
    try {
      // Check Redis for cached statistics
      const statsKey = `tool:${toolId}:stats`;
      const cachedStats = await this.redis.get(statsKey);
      
      if (cachedStats) {
        const stats = JSON.parse(cachedStats);
        return stats.averageExecutionTime || 5000; // Default 5 seconds
      }
      
      // Default estimate
      return 5000;
    } catch (error) {
      return 5000; // Default fallback
    }
  }

  // Get execution status. Scoped to the caller's organization — the
  // previous shape returned the full ExecutionProgress (including
  // result.data) for ANY executionId, so a caller who guessed or
  // scraped an id from another org could read its full result. Now
  // a cross-org read returns null, indistinguishable from an
  // execution that never existed.
  async getExecutionStatus(
    executionId: string,
    organizationId: string,
  ): Promise<ExecutionProgress | null> {
    if (!organizationId) return null;

    const progress = this.activeExecutions.get(executionId);
    if (progress) {
      return progress.metadata?.organizationId === organizationId ? progress : null;
    }

    // Check Redis for completed executions
    try {
      const cached = await this.redis.get(`execution:${executionId}`);
      if (cached) {
        const parsed = JSON.parse(cached) as ExecutionProgress;
        return parsed.metadata?.organizationId === organizationId ? parsed : null;
      }
    } catch (error) {
      this.logger.error(`Failed to get execution status from Redis: ${error.message}`);
    }

    return null;
  }

  // Cancel execution. Also scoped — the previous shape let any caller
  // with a guessed or leaked executionId cancel foreign executions,
  // which is both a cross-org DoS and a way to grief someone's
  // in-flight tool calls.
  async cancelExecution(executionId: string, organizationId: string): Promise<boolean> {
    if (!organizationId) return false;

    const progress = this.activeExecutions.get(executionId);
    if (!progress || progress.status === 'completed' || progress.status === 'failed') {
      return false;
    }
    if (progress.metadata?.organizationId !== organizationId) {
      // Wrong org — indistinguishable from "doesn't exist".
      return false;
    }

    await this.updateProgress(executionId, {
      status: 'cancelled',
      message: 'Tool execution cancelled by user',
      completedAt: new Date(),
    });

    // Remove from queue
    this.executionQueue.delete(executionId);

    this.logger.log(`Tool execution cancelled: ${executionId}`);
    return true;
  }

  /** Internal variant for the service shutdown path, which needs to
   *  cancel every in-flight execution regardless of org. NEVER expose
   *  this via a controller — it's the admin / shutdown escape hatch. */
  private async cancelExecutionInternal(executionId: string): Promise<boolean> {
    const progress = this.activeExecutions.get(executionId);
    if (!progress || progress.status === 'completed' || progress.status === 'failed') {
      return false;
    }
    await this.updateProgress(executionId, {
      status: 'cancelled',
      message: 'Tool execution cancelled during shutdown',
      completedAt: new Date(),
    });
    this.executionQueue.delete(executionId);
    return true;
  }

  // Get all active executions for organization
  async getActiveExecutions(organizationId: string): Promise<ExecutionProgress[]> {
    return Array.from(this.activeExecutions.values())
      .filter(exec => exec.metadata?.organizationId === organizationId);
  }

  // Get queue status for organization
  async getQueueStatus(organizationId: string): Promise<{
    queued: number;
    running: number;
    position?: number;
    estimatedWait?: number;
  }> {
    const queueItems = Array.from(this.executionQueue.values())
      .filter(item => item.organizationId === organizationId);
    
    const activeExecutions = await this.getActiveExecutions(organizationId);
    const running = activeExecutions.filter(exec => exec.status === 'running').length;
    const queued = queueItems.filter(item => {
      const progress = this.activeExecutions.get(item.id);
      return progress?.status === 'queued';
    }).length;

    return {
      queued,
      running,
    };
  }

  // Cleanup and shutdown
  async shutdown(): Promise<void> {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
    }

    // Cancel all running executions via the internal helper (skips
    // the per-call org check — shutdown is inside the trust boundary).
    const executionIds = Array.from(this.activeExecutions.keys());
    for (const executionId of executionIds) {
      await this.cancelExecutionInternal(executionId);
    }

    this.logger.log('Real-time executor service shutdown complete');
  }

  // Statistics
  async getExecutionStats(): Promise<{
    activeExecutions: number;
    queuedExecutions: number;
    completedToday: number;
    averageExecutionTime: number;
    successRate: number;
  }> {
    const activeCount = this.activeExecutions.size;
    const queuedCount = this.executionQueue.size;

    // Get statistics from Redis
    try {
      const statsKey = 'global:execution:stats';
      const cachedStats = await this.redis.get(statsKey);
      
      if (cachedStats) {
        const stats = JSON.parse(cachedStats);
        return {
          activeExecutions: activeCount,
          queuedExecutions: queuedCount,
          completedToday: stats.completedToday || 0,
          averageExecutionTime: stats.averageExecutionTime || 5000,
          successRate: stats.successRate || 0.95,
        };
      }
    } catch (error) {
      this.logger.error(`Failed to get execution stats: ${error.message}`);
    }

    return {
      activeExecutions: activeCount,
      queuedExecutions: queuedCount,
      completedToday: 0,
      averageExecutionTime: 5000,
      successRate: 0.95,
    };
  }
}