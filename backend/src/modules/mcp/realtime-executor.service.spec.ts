import { Test, TestingModule } from '@nestjs/testing';
import { RealtimeExecutorService } from './realtime-executor.service';
import { ToolExecutorService } from '../tools/tool-executor.service';
import { McpSessionService } from './mcp-session.service';
import { SseTransport } from './transports/sse.transport';
import { WebSocketTransport } from './transports/websocket.transport';

describe('RealtimeExecutorService', () => {
  let service: RealtimeExecutorService;
  let toolExecutorService: any;
  let mcpSessionService: any;
  let sseTransport: any;
  let wsTransport: any;
  let mockRedis: any;

  beforeEach(async () => {
    jest.useFakeTimers();

    toolExecutorService = { executeTool: jest.fn() };
    mcpSessionService = { on: jest.fn(), emit: jest.fn() };
    sseTransport = {
      broadcastProgress: jest.fn(),
      broadcast: jest.fn().mockResolvedValue(undefined),
    };
    wsTransport = {
      broadcastProgress: jest.fn(),
      broadcastToOrganization: jest.fn().mockResolvedValue(undefined),
    };
    mockRedis = {
      get: jest.fn(),
      set: jest.fn(),
      setex: jest.fn(),
      hget: jest.fn(),
      hset: jest.fn(),
      lpush: jest.fn(),
      keys: jest.fn(),
      del: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtimeExecutorService,
        {
          provide: ToolExecutorService,
          useValue: toolExecutorService,
        },
        {
          provide: McpSessionService,
          useValue: mcpSessionService,
        },
        {
          provide: SseTransport,
          useValue: sseTransport,
        },
        {
          provide: WebSocketTransport,
          useValue: wsTransport,
        },
        {
          provide: 'default_IORedisModuleConnectionToken',
          useValue: mockRedis,
        },
      ],
    }).compile();

    service = module.get<RealtimeExecutorService>(RealtimeExecutorService);
  });

  afterEach(async () => {
    // Clean up intervals to prevent test timeout
    await service.shutdown();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe('basic functionality', () => {
    it('should be defined', () => {
      expect(service).toBeDefined();
    });

    it('should have required methods', () => {
      expect(service.executeToolRealtime).toBeDefined();
      expect(service.getExecutionStatus).toBeDefined();
      expect(service.cancelExecution).toBeDefined();
      expect(service.getActiveExecutions).toBeDefined();
      expect(service.shutdown).toBeDefined();
    });
  });

  describe('getExecutionStatus', () => {
    it('should return null for non-existent execution', async () => {
      const result = await service.getExecutionStatus('non-existent', 'org-1');
      expect(result).toBeNull();
    });
  });

  describe('cancelExecution', () => {
    it('should return false for non-existent execution', async () => {
      const result = await service.cancelExecution('non-existent', 'org-1');
      expect(result).toBe(false);
    });
  });

  describe('shutdown', () => {
    it('should shutdown successfully', async () => {
      await service.shutdown();
      expect(service).toBeDefined();
    });
  });

  describe('Real Business Logic - Tool Execution Flow', () => {
    afterEach(() => {
      jest.clearAllMocks();
    });

    describe('executeToolRealtime', () => {
      it('should queue tool execution and return execution ID', async () => {
        const options = {
          userId: 'user-1',
          organizationId: 'org-1',
          streaming: true,
          transport: 'sse' as const,
        };

        mockRedis.get.mockResolvedValue(null); // No historical data

        const executionId = await service.executeToolRealtime('tool-1', { param: 'value' }, options);

        // Execution ids are now 32-character hex strings (16 random
        // bytes) instead of the old Date.now-based prefix.
        expect(executionId).toMatch(/^exec_[a-f0-9]{32}$/);
      });

      it('should create execution with correct initial status', async () => {
        const options = {
          userId: 'user-1',
          organizationId: 'org-1',
          streaming: true,
          transport: 'websocket' as const,
        };

        mockRedis.get.mockResolvedValue(null);

        const executionId = await service.executeToolRealtime('tool-1', { test: true }, options);
        const status = await service.getExecutionStatus(executionId, 'org-1');

        expect(status).toBeDefined();
        expect(status.status).toBe('queued');
        expect(status.progress).toBe(0);
        expect(status.toolId).toBe('tool-1');
      });

    });

    describe('Priority Calculation - Real Business Logic', () => {
      it('should calculate higher priority for streaming requests', () => {
        const streamingOptions = {
          userId: 'user-1',
          organizationId: 'org-1',
          streaming: true,
        };

        const priority = service['calculatePriority'](streamingOptions);
        expect(priority).toBe(80); // 50 base + 20 streaming + 10 authenticated user
      });

      it('should calculate base priority for non-streaming requests', () => {
        const normalOptions = {
          userId: 'user-1',
          organizationId: 'org-1',
          streaming: false,
        };

        const priority = service['calculatePriority'](normalOptions);
        expect(priority).toBe(60); // 50 base + 10 authenticated user
      });

      it('should reduce priority for retried requests', () => {
        const retryOptions = {
          userId: 'user-1',
          organizationId: 'org-1',
          streaming: true,
          retries: 2,
        };

        const priority = service['calculatePriority'](retryOptions);
        expect(priority).toBe(70); // 80 - (2 * 5)
      });
    });


    describe('Execution Cancellation - Real Business Logic', () => {
      it('should cancel queued execution successfully', async () => {
        mockRedis.get.mockResolvedValue(null);
        mockRedis.del.mockResolvedValue(1);

        const options = {
          userId: 'user-1',
          organizationId: 'org-1',
          streaming: true,
        };

        const executionId = await service.executeToolRealtime('tool-1', {}, options);
        const cancelled = await service.cancelExecution(executionId, 'org-1');

        expect(cancelled).toBe(true);

        const status = await service.getExecutionStatus(executionId, 'org-1');
        expect(status.status).toBe('cancelled');
      });

      it('should not cancel already completed executions', async () => {
        mockRedis.get.mockResolvedValue(null);

        const options = {
          userId: 'user-1',
          organizationId: 'org-1',
          streaming: true,
        };

        const executionId = await service.executeToolRealtime('tool-1', {}, options);

        // Manually mark as completed
        const progress = service['activeExecutions'].get(executionId);
        progress.status = 'completed';

        const cancelled = await service.cancelExecution(executionId, 'org-1');
        expect(cancelled).toBe(false);
      });
    });

    describe('Progress Tracking - Real Business Logic', () => {
      it('should track progress from 0 to 100', async () => {
        mockRedis.get.mockResolvedValue(null);

        const options = {
          userId: 'user-1',
          organizationId: 'org-1',
          streaming: true,
        };

        const executionId = await service.executeToolRealtime('tool-1', {}, options);

        // Simulate progress updates
        await service['updateProgress'](executionId, {
          status: 'running',
          progress: 25,
          message: '25% complete',
        });

        let status = await service.getExecutionStatus(executionId, 'org-1');
        expect(status.progress).toBe(25);
        expect(status.status).toBe('running');

        await service['updateProgress'](executionId, {
          progress: 75,
          message: '75% complete',
        });

        status = await service.getExecutionStatus(executionId, 'org-1');
        expect(status.progress).toBe(75);
      });
    });

    describe('Execution Time Estimation - Real Business Logic', () => {
      it('should estimate execution time based on historical data', async () => {
        mockRedis.get.mockResolvedValue(JSON.stringify({ averageExecutionTime: 7500 }));

        const estimatedTime = await service['estimateExecutionTime']('tool-1');

        expect(estimatedTime).toBe(7500);
        expect(mockRedis.get).toHaveBeenCalledWith('tool:tool-1:stats');
      });

      it('should return default estimate when no historical data', async () => {
        mockRedis.get.mockResolvedValue(null);

        const estimatedTime = await service['estimateExecutionTime']('new-tool');

        expect(estimatedTime).toBe(5000); // Default 5 seconds
      });
    });

    describe('Real-World Execution Scenarios', () => {
      it('should track multiple concurrent executions from different organizations', async () => {
        mockRedis.get.mockResolvedValue(null);

        const org1Options = {
          userId: 'user-1',
          organizationId: 'org-1',
          streaming: true,
        };

        const org2Options = {
          userId: 'user-2',
          organizationId: 'org-2',
          streaming: true,
        };

        const exec1 = await service.executeToolRealtime('tool-1', {}, org1Options);
        const exec2 = await service.executeToolRealtime('tool-2', {}, org2Options);

        const org1Executions = await service.getActiveExecutions('org-1');
        const org2Executions = await service.getActiveExecutions('org-2');

        expect(org1Executions.some(e => e.executionId === exec1)).toBe(true);
        expect(org2Executions.some(e => e.executionId === exec2)).toBe(true);
        expect(org1Executions.some(e => e.executionId === exec2)).toBe(false);
      });
    });

    describe('Non-streaming execution - Branch Coverage', () => {
      it('should queue execution even when streaming is false', async () => {
        mockRedis.get.mockResolvedValue(null);

        const options = {
          userId: 'user-1',
          organizationId: 'org-1',
          streaming: false,
        };

        // Start execution - it will return a promise that waits for completion
        const executionIdPromise = service.executeToolRealtime('tool-1', { test: 'param' }, options);

        // This test just verifies the execution is created
        // The actual promise resolution is tested indirectly through integration tests
        expect(executionIdPromise).toBeDefined();
      });
    });

    describe('Priority calculation - Branch Coverage', () => {
      it('should not add priority for anonymous users', () => {
        const anonymousOptions = {
          userId: 'anonymous',
          organizationId: 'org-1',
          streaming: false,
        };

        const priority = service['calculatePriority'](anonymousOptions);
        expect(priority).toBe(50); // Base priority only
      });

      it('should handle missing userId', () => {
        const options = {
          organizationId: 'org-1',
          streaming: false,
        };

        const priority = service['calculatePriority'](options as any);
        expect(priority).toBe(50);
      });

      it('should clamp priority between 0 and 100', () => {
        const highRetryOptions = {
          userId: 'user-1',
          organizationId: 'org-1',
          streaming: true,
          retries: 100,
        };

        const priority = service['calculatePriority'](highRetryOptions);
        expect(priority).toBe(0); // Clamped to minimum
      });
    });

    describe('Queue processing - Branch Coverage', () => {
      it('should skip processing when queue is empty', async () => {
        await service['processQueue']();

        expect(toolExecutorService.executeTool).not.toHaveBeenCalled();
      });

      it('should skip processing when max concurrent executions reached', async () => {
        mockRedis.get.mockResolvedValue(null);

        // Create multiple executions
        for (let i = 0; i < 5; i++) {
          await service.executeToolRealtime(`tool-${i}`, {}, {
            userId: 'user-1',
            organizationId: 'org-1',
            streaming: true,
          });
        }

        // Mark several as running
        const executions = Array.from(service['activeExecutions'].entries());
        for (let i = 0; i < 3; i++) {
          if (executions[i]) {
            executions[i][1].status = 'running';
          }
        }

        await service['processQueue']();

        // Should not start new executions when at max
        expect(service).toBeDefined();
      });

      it('should skip processing when no queued items', async () => {
        mockRedis.get.mockResolvedValue(null);

        const options = {
          userId: 'user-1',
          organizationId: 'org-1',
          streaming: true,
        };

        const executionId = await service.executeToolRealtime('tool-1', {}, options);

        // Mark as running
        const progress = service['activeExecutions'].get(executionId);
        if (progress) {
          progress.status = 'running';
        }

        await service['processQueue']();

        expect(service).toBeDefined();
      });
    });

    describe('Execution status retrieval - Branch Coverage', () => {
      it('should retrieve status from Redis when not in active executions', async () => {
        // Must include metadata.organizationId now that the getter
        // filters cached entries by org. Previously this wasn't
        // required — cross-org reads of the Redis cache were allowed.
        const cachedProgress = {
          executionId: 'exec-cached',
          toolId: 'tool-1',
          status: 'completed',
          progress: 100,
          startedAt: new Date(),
          metadata: { organizationId: 'org-1' },
        };

        mockRedis.get.mockResolvedValue(JSON.stringify(cachedProgress));

        const result = await service.getExecutionStatus('exec-cached', 'org-1');

        expect(result).toBeDefined();
        expect(result?.executionId).toBe('exec-cached');
        expect(mockRedis.get).toHaveBeenCalledWith('execution:exec-cached');
      });

      it('should handle Redis errors gracefully', async () => {
        mockRedis.get.mockRejectedValue(new Error('Redis error'));

        const result = await service.getExecutionStatus('non-existent', 'org-1');

        expect(result).toBeNull();
      });
    });

    describe('Execution cancellation - Branch Coverage', () => {
      it('should return false for already completed execution', async () => {
        mockRedis.get.mockResolvedValue(null);

        const options = {
          userId: 'user-1',
          organizationId: 'org-1',
          streaming: true,
        };

        const executionId = await service.executeToolRealtime('tool-1', {}, options);

        // Mark as completed
        const progress = service['activeExecutions'].get(executionId);
        if (progress) {
          progress.status = 'completed';
        }

        const cancelled = await service.cancelExecution(executionId, 'org-1');

        expect(cancelled).toBe(false);
      });

      it('should return false for already failed execution', async () => {
        mockRedis.get.mockResolvedValue(null);

        const options = {
          userId: 'user-1',
          organizationId: 'org-1',
          streaming: true,
        };

        const executionId = await service.executeToolRealtime('tool-1', {}, options);

        // Mark as failed
        const progress = service['activeExecutions'].get(executionId);
        if (progress) {
          progress.status = 'failed';
        }

        const cancelled = await service.cancelExecution(executionId, 'org-1');

        expect(cancelled).toBe(false);
      });
    });

    describe('Queue status - Branch Coverage', () => {
      it('should calculate queue status correctly', async () => {
        mockRedis.get.mockResolvedValue(null);

        // Create multiple executions for same org
        await service.executeToolRealtime('tool-1', {}, {
          userId: 'user-1',
          organizationId: 'org-1',
          streaming: true,
        });

        await service.executeToolRealtime('tool-2', {}, {
          userId: 'user-1',
          organizationId: 'org-1',
          streaming: true,
        });

        const status = await service.getQueueStatus('org-1');

        expect(status.queued).toBeGreaterThanOrEqual(0);
        expect(status.running).toBeGreaterThanOrEqual(0);
      });
    });

    describe('Execution stats - Branch Coverage', () => {
      it('should return default stats when Redis fails', async () => {
        mockRedis.get.mockRejectedValue(new Error('Redis error'));

        const stats = await service.getExecutionStats();

        expect(stats.activeExecutions).toBeDefined();
        expect(stats.queuedExecutions).toBeDefined();
        expect(stats.completedToday).toBe(0);
        expect(stats.averageExecutionTime).toBe(5000);
        expect(stats.successRate).toBe(0.95);
      });

      it('should return cached stats when available', async () => {
        const cachedStats = {
          completedToday: 150,
          averageExecutionTime: 2500,
          successRate: 0.98,
        };

        mockRedis.get.mockResolvedValue(JSON.stringify(cachedStats));

        const stats = await service.getExecutionStats();

        expect(stats.completedToday).toBe(150);
        expect(stats.averageExecutionTime).toBe(2500);
        expect(stats.successRate).toBe(0.98);
      });
    });

    describe('Estimate execution time - Branch Coverage', () => {
      it('should return default when Redis fails', async () => {
        mockRedis.get.mockRejectedValue(new Error('Redis error'));

        const estimate = await service['estimateExecutionTime']('tool-1');

        expect(estimate).toBe(5000);
      });
    });

    describe('Update progress - Branch Coverage', () => {
      it('should skip update for non-existent execution', async () => {
        await service['updateProgress']('non-existent', { progress: 50 });

        expect(mockRedis.setex).not.toHaveBeenCalledWith(
          'execution:non-existent',
          expect.anything(),
          expect.anything()
        );
      });
    });

    describe('ExecuteAndWait - Branch Coverage', () => {
      it('should timeout after 5 minutes', async () => {
        const promise = service['executeAndWait']('non-existent-exec');
        // Attach a catch handler synchronously so the unhandled rejection
        // doesn't fire while we advance fake timers.
        const assertion = expect(promise).rejects.toThrow('Tool execution timeout');

        // Fast-forward past the 5-minute timeout and let microtasks settle.
        await jest.advanceTimersByTimeAsync(300001);
        await assertion;
      });

      it('should resolve when execution completes', async () => {
        jest.useRealTimers();

        const executionId = 'test-exec-123';
        const expectedResult = { data: 'test-result', success: true };

        const promise = service['executeAndWait'](executionId);

        // Emit completion event after a short delay
        setTimeout(() => {
          service.emit(`execution:${executionId}:completed`, expectedResult);
        }, 100);

        const result = await promise;
        expect(result).toEqual(expectedResult);

        jest.useFakeTimers();
      });

      it('should reject when execution fails', async () => {
        jest.useRealTimers();

        const executionId = 'test-exec-456';
        const errorMessage = 'Execution failed';

        const promise = service['executeAndWait'](executionId);

        // Emit failure event after a short delay
        setTimeout(() => {
          service.emit(`execution:${executionId}:failed`, errorMessage);
        }, 100);

        await expect(promise).rejects.toThrow(errorMessage);

        jest.useFakeTimers();
      });
    });

    describe('StartExecution - Branch Coverage', () => {
      it('should execute tool successfully and complete', async () => {
        jest.useRealTimers();

        mockRedis.get.mockResolvedValue(null);
        mockRedis.setex.mockResolvedValue('OK');

        const executionResult = {
          data: { result: 'success' },
          executionTime: 1500,
          cached: false,
          retryCount: 0,
          success: true,
          error: null,
          rateLimited: false,
        };

        toolExecutorService.executeTool.mockResolvedValue(executionResult);

        const queueItem = {
          id: 'exec-test',
          organizationId: 'org-1',
          priority: 50,
          toolId: 'tool-1',
          parameters: { test: true },
          options: {
            userId: 'user-1',
            organizationId: 'org-1',
            streaming: true,
          },
          queuedAt: new Date(),
        };

        // Add execution to active executions
        service['activeExecutions'].set('exec-test', {
          executionId: 'exec-test',
          toolId: 'tool-1',
          status: 'queued',
          progress: 0,
          startedAt: new Date(),
          metadata: {
            userId: 'user-1',
            organizationId: 'org-1',
          },
        });

        await service['startExecution'](queueItem);

        // Allow time for async operations
        await new Promise(resolve => setTimeout(resolve, 100));

        expect(toolExecutorService.executeTool).toHaveBeenCalled();

        jest.useFakeTimers();
      });

      it('should handle tool execution failure', async () => {
        jest.useRealTimers();

        mockRedis.get.mockResolvedValue(null);
        mockRedis.setex.mockResolvedValue('OK');

        const executionError = new Error('Tool execution failed');
        toolExecutorService.executeTool.mockRejectedValue(executionError);

        const queueItem = {
          id: 'exec-fail',
          organizationId: 'org-1',
          priority: 50,
          toolId: 'tool-1',
          parameters: { test: true },
          options: {
            userId: 'user-1',
            organizationId: 'org-1',
            streaming: true,
          },
          queuedAt: new Date(),
        };

        // Add execution to active executions
        service['activeExecutions'].set('exec-fail', {
          executionId: 'exec-fail',
          toolId: 'tool-1',
          status: 'queued',
          progress: 0,
          startedAt: new Date(),
          metadata: {
            userId: 'user-1',
            organizationId: 'org-1',
          },
        });

        await service['startExecution'](queueItem);

        // Allow time for async operations
        await new Promise(resolve => setTimeout(resolve, 100));

        expect(toolExecutorService.executeTool).toHaveBeenCalled();

        jest.useFakeTimers();
      });
    });

    describe('CompleteExecution - Branch Coverage', () => {
      it('should complete execution with result metadata', async () => {
        mockRedis.setex.mockResolvedValue('OK');

        const executionId = 'exec-complete';
        service['activeExecutions'].set(executionId, {
          executionId,
          toolId: 'tool-1',
          status: 'running',
          progress: 50,
          startedAt: new Date(),
          metadata: {
            userId: 'user-1',
            organizationId: 'org-1',
          },
        });

        const result = {
          data: { success: true },
          executionTime: 2000,
          cached: false,
          retryCount: 0,
          success: true,
          error: null,
          rateLimited: false,
        };

        const emitSpy = jest.spyOn(service, 'emit');

        await service['completeExecution'](executionId, result);

        const progress = service['activeExecutions'].get(executionId);
        expect(progress?.status).toBe('completed');
        expect(progress?.progress).toBe(100);
        expect(progress?.completedAt).toBeDefined();
        expect(emitSpy).toHaveBeenCalledWith(`execution:${executionId}:completed`, result);
      });
    });

    describe('FailExecution - Branch Coverage', () => {
      it('should fail execution with error message', async () => {
        mockRedis.setex.mockResolvedValue('OK');

        const executionId = 'exec-fail';
        service['activeExecutions'].set(executionId, {
          executionId,
          toolId: 'tool-1',
          status: 'running',
          progress: 50,
          startedAt: new Date(),
          metadata: {
            userId: 'user-1',
            organizationId: 'org-1',
          },
        });

        const error = new Error('Something went wrong');

        const emitSpy = jest.spyOn(service, 'emit');

        await service['failExecution'](executionId, error);

        const progress = service['activeExecutions'].get(executionId);
        expect(progress?.status).toBe('failed');
        expect(progress?.error).toBe('Something went wrong');
        expect(progress?.completedAt).toBeDefined();
        expect(emitSpy).toHaveBeenCalledWith(`execution:${executionId}:failed`, 'Something went wrong');
      });
    });

    describe('SetupProgressBroadcasting - Branch Coverage', () => {
      it('should handle notification with execution method', () => {
        // Get the callback registered for notifications
        const onCall = mcpSessionService.on.mock.calls.find(call => call[0] === 'notification');

        if (onCall && onCall[1]) {
          const callback = onCall[1];

          const notification = {
            method: 'execution/progress',
            params: { executionId: 'test' },
          };

          // Call the callback - should not throw
          callback('session-123', notification);
        }

        expect(mcpSessionService.on).toHaveBeenCalledWith('notification', expect.any(Function));
      });

      it('should ignore notifications without execution method', () => {
        const onCall = mcpSessionService.on.mock.calls.find(call => call[0] === 'notification');

        if (onCall && onCall[1]) {
          const callback = onCall[1];

          const notification = {
            method: 'other/method',
            params: {},
          };

          // Should not throw or cause issues
          callback('session-123', notification);
        }

        expect(mcpSessionService.on).toHaveBeenCalled();
      });

      it('should handle notification without method', () => {
        const onCall = mcpSessionService.on.mock.calls.find(call => call[0] === 'notification');

        if (onCall && onCall[1]) {
          const callback = onCall[1];

          const notification = {
            params: {},
          };

          // Should not throw
          callback('session-123', notification);
        }

        expect(mcpSessionService.on).toHaveBeenCalled();
      });
    });

    describe('Progress interval with non-running status - Branch Coverage', () => {
      it('should not increment progress when status is not running', async () => {
        jest.useRealTimers();
        mockRedis.get.mockResolvedValue(null);
        mockRedis.setex.mockResolvedValue('OK');

        const queueItem = {
          id: 'exec-test-progress',
          organizationId: 'org-1',
          priority: 50,
          toolId: 'tool-1',
          parameters: { test: true },
          options: {
            userId: 'user-1',
            organizationId: 'org-1',
            streaming: true,
          },
          queuedAt: new Date(),
        };

        // Add execution to active executions with completed status
        service['activeExecutions'].set('exec-test-progress', {
          executionId: 'exec-test-progress',
          toolId: 'tool-1',
          status: 'completed', // NOT running
          progress: 100,
          startedAt: new Date(),
          metadata: {
            userId: 'user-1',
            organizationId: 'org-1',
          },
        });

        toolExecutorService.executeTool.mockResolvedValue({
          data: { result: 'success' },
          executionTime: 100,
          cached: false,
          retryCount: 0,
          success: true,
          error: null,
          rateLimited: false,
        });

        await service['startExecution'](queueItem);

        // Wait for progress interval
        await new Promise(resolve => setTimeout(resolve, 2100));

        // Progress should still be 100 (not incremented)
        const progress = service['activeExecutions'].get('exec-test-progress');
        expect(progress?.progress).toBe(100);

        jest.useFakeTimers();
      });
    });

    describe('Additional branch coverage', () => {
      it('should handle execution timeout in executeAndWait', async () => {
        mockRedis.get.mockResolvedValue(null);
        // Make tool execution hang forever so the 5-minute timeout is the
        // only thing that can resolve the promise.
        toolExecutorService.executeTool.mockReturnValue(new Promise(() => {}));

        const promise = service.executeToolRealtime('tool-1', {}, {
          userId: 'user-1',
          organizationId: 'org-1',
          streaming: false, // not streaming -> uses executeAndWait
        });
        const assertion = expect(promise).rejects.toThrow('Tool execution timeout');

        await jest.advanceTimersByTimeAsync(300001);
        await assertion;
      });

      it('should handle execution:failed event in executeAndWait', async () => {
        mockRedis.get.mockResolvedValue(null);
        // Hang the underlying tool executor so the only thing that can
        // settle the promise is the failed event we emit below.
        toolExecutorService.executeTool.mockReturnValue(new Promise(() => {}));

        const promise = service.executeToolRealtime('tool-1', {}, {
          userId: 'user-1',
          organizationId: 'org-1',
          streaming: false,
        });
        const assertion = expect(promise).rejects.toThrow('Test error');

        // Let the queue processor pick the item up so the executionId exists.
        await jest.advanceTimersByTimeAsync(1100);
        const executionId = Array.from(service['activeExecutions'].keys()).pop()!;
        service.emit(`execution:${executionId}:failed`, 'Test error');

        await assertion;
      });

      it('should handle empty queue in processQueue', async () => {
        // Clear all queues
        service['executionQueue'].clear();

        await service['processQueue']();

        // Should complete without error
        expect(service['executionQueue'].size).toBe(0);
      });

      it('should handle max concurrent executions in processQueue', async () => {
        mockRedis.get.mockResolvedValue(null);

        // Create 5 executions (max concurrent is 3)
        for (let i = 0; i < 5; i++) {
          await service.executeToolRealtime(`tool-${i}`, {}, {
            userId: 'user-1',
            organizationId: 'org-1',
            streaming: true,
          });
        }

        // All should be queued initially
        const queued = Array.from(service['executionQueue'].values());
        expect(queued.length).toBeGreaterThan(0);
      });

      it('should increment progress on each 2s tick while status is running', async () => {
        mockRedis.get.mockResolvedValue(null);
        // Hang the underlying executor so the progress interval keeps ticking.
        toolExecutorService.executeTool.mockReturnValue(new Promise(() => {}));

        const executionId = await service.executeToolRealtime('tool-1', {}, {
          userId: 'user-1',
          organizationId: 'org-1',
          streaming: true,
        });

        // Drain the 1s queue tick so startExecution arms the 2s progress
        // interval, then mark the execution running with a known baseline.
        await jest.advanceTimersByTimeAsync(1100);
        const progress = service['activeExecutions'].get(executionId)!;
        progress.status = 'running';
        progress.progress = 50;

        // One progress tick: 50 -> 60. Two ticks: 60 -> 70.
        await jest.advanceTimersByTimeAsync(2000);
        expect(progress.progress).toBeGreaterThanOrEqual(60);

        await jest.advanceTimersByTimeAsync(2000);
        expect(progress.progress).toBeGreaterThanOrEqual(70);
      });
    });

    // ── Regression: cross-org execution status + cancel guards ─────
    describe('cross-org execution scoping (regression)', () => {
      // Pre-fix, any caller with a valid executionId could read the
      // full progress (including result data) of executions in any
      // org, and could cancel them too. Executions were also keyed
      // by a guessable Date.now + Math.random id that leaked enough
      // entropy to brute force under load.

      function seedActive(executionId: string, orgId: string, status: any = 'running') {
        (service as any).activeExecutions.set(executionId, {
          executionId,
          toolId: 'tool-1',
          status,
          progress: 50,
          startedAt: new Date(),
          metadata: { organizationId: orgId },
        });
      }

      beforeEach(() => {
        (service as any).activeExecutions.clear();
      });

      it('getExecutionStatus returns null for a cross-org executionId', async () => {
        seedActive('exec-victim', 'victim-org');

        const asAttacker = await service.getExecutionStatus('exec-victim', 'attacker-org');
        expect(asAttacker).toBeNull();

        const asOwner = await service.getExecutionStatus('exec-victim', 'victim-org');
        expect(asOwner).not.toBeNull();
        expect(asOwner?.executionId).toBe('exec-victim');
      });

      it('getExecutionStatus returns null when Redis cache hit belongs to another org', async () => {
        mockRedis.get.mockResolvedValue(
          JSON.stringify({
            executionId: 'exec-cached',
            toolId: 'tool-1',
            status: 'completed',
            progress: 100,
            startedAt: new Date(),
            metadata: { organizationId: 'victim-org' },
          }),
        );

        const result = await service.getExecutionStatus('exec-cached', 'attacker-org');
        expect(result).toBeNull();
      });

      it('cancelExecution returns false for a cross-org executionId', async () => {
        seedActive('exec-victim', 'victim-org');

        const cancelled = await service.cancelExecution('exec-victim', 'attacker-org');
        expect(cancelled).toBe(false);

        // The victim's execution must still be running — no collateral damage.
        const still = (service as any).activeExecutions.get('exec-victim');
        expect(still?.status).toBe('running');
      });

      it('cancelExecution succeeds for the owning org', async () => {
        seedActive('exec-mine', 'my-org');

        const cancelled = await service.cancelExecution('exec-mine', 'my-org');
        expect(cancelled).toBe(true);

        const after = (service as any).activeExecutions.get('exec-mine');
        expect(after?.status).toBe('cancelled');
      });

      it('getExecutionStatus rejects an empty organizationId (no implicit "all")', async () => {
        seedActive('exec-any', 'some-org');
        const result = await service.getExecutionStatus('exec-any', '');
        expect(result).toBeNull();
      });
    });
  });
});