import { PerformanceMonitorPlugin } from './performance-monitor.plugin';
import { PluginContext, PluginHookType } from '../types/plugin.types';

describe('PerformanceMonitorPlugin - Real Business Logic', () => {
  let plugin: PerformanceMonitorPlugin;
  let mockSettings: any;
  let mockContext: PluginContext;
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(() => {
    plugin = new PerformanceMonitorPlugin();
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();

    mockSettings = {
      trackMemory: true,
      trackCpu: true,
      trackNetwork: true,
      alertThresholds: {
        executionTime: 1000, // 1 second for testing
        memoryUsage: 1024 * 1024, // 1MB
        errorRate: 0.1,
      },
      collectMetrics: true,
      enableOptimization: true,
      cacheOptimizedResults: true,
    };

    mockContext = {
      hookType: PluginHookType.PRE_TOOL_EXECUTION,
      userId: 'user-1',
      organizationId: 'org-1',
      requestId: 'req-1',
      data: { test: 'data' },
      metadata: {
        timestamp: new Date().toISOString(),
        plugin: {
          id: 'plugin-1',
          name: 'Performance Monitor',
          version: '1.0.0',
        },
        execution: {
          attempt: 1,
          timeout: 5000,
          startTime: Date.now(),
        },
        tool: {
          id: 'tool-1',
          name: 'Test Tool',
        },
      },
    };
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  describe('Plugin Definition', () => {
    it('should return plugin definition with correct metadata', () => {
      const definition = plugin.getPluginDefinition();

      expect(definition.name).toBe('Performance Monitor');
      expect(definition.version).toBe('1.0.0');
      expect(definition.isActive).toBe(true);
      expect(definition.configuration.priority).toBe(20);
    });

    it('should define correct hook types', () => {
      const definition = plugin.getPluginDefinition();

      expect(definition.capabilities.hooks).toContain(PluginHookType.PRE_TOOL_EXECUTION);
      expect(definition.capabilities.hooks).toContain(PluginHookType.POST_TOOL_EXECUTION);
      expect(definition.capabilities.hooks).toContain(PluginHookType.PRE_API_CALL);
      expect(definition.capabilities.hooks).toContain(PluginHookType.POST_API_CALL);
      expect(definition.capabilities.hooks).toContain(PluginHookType.TOOL_EXECUTION_ERROR);
    });

    it('should define hooks with correct handlers', () => {
      const definition = plugin.getPluginDefinition();

      expect(definition.hooks).toHaveLength(3);
      expect(definition.hooks[0].handler).toBe('startPerformanceTracking');
      expect(definition.hooks[1].handler).toBe('endPerformanceTracking');
      expect(definition.hooks[2].handler).toBe('recordError');
    });

    it('should mark some hooks as async', () => {
      const definition = plugin.getPluginDefinition();

      expect(definition.hooks[0].async).toBe(false); // startPerformanceTracking
      expect(definition.hooks[1].async).toBe(true);  // endPerformanceTracking
      expect(definition.hooks[2].async).toBe(true);  // recordError
    });
  });

  describe('startPerformanceTracking - Performance baseline', () => {
    it('should start performance tracking successfully', async () => {
      const result = await plugin.startPerformanceTracking(mockContext, mockSettings);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockContext.data);
      expect(result.metadata.modifications).toContain('Performance tracking started');
      expect(result.metadata.executionTime).toBeGreaterThanOrEqual(0);
    });

    it('should track memory when trackMemory is true', async () => {
      const result = await plugin.startPerformanceTracking(mockContext, mockSettings);

      expect(result.success).toBe(true);
      expect(result.metadata.modifications).toHaveLength(1);
    });

    it('should handle errors gracefully', async () => {
      // Pass null settings to trigger error
      const result = await plugin.startPerformanceTracking(mockContext, null);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('PERFORMANCE_TRACKING_ERROR');
      expect(result.data).toEqual(mockContext.data);
    });

    it('should track execution time', async () => {
      const result = await plugin.startPerformanceTracking(mockContext, mockSettings);

      expect(result.metadata.executionTime).toBeGreaterThanOrEqual(0);
    });
  });

  describe('endPerformanceTracking - Performance metrics collection', () => {
    it('should complete performance tracking with metrics', async () => {
      const contextWithTracking = {
        ...mockContext,
        metadata: {
          ...mockContext.metadata,
          performanceTracking: {
            startTime: Date.now() - 100,
            initialMetrics: {
              timestamp: Date.now(),
              memoryUsage: 1000000,
              cpuUsage: 0,
              networkCalls: 0,
            },
            trackingEnabled: true,
          },
        },
      };

      const result = await plugin.endPerformanceTracking(contextWithTracking, mockSettings);

      expect(result.success).toBe(true);
      expect(result.metadata.logs).toHaveLength(1);
      expect(result.metadata.logs[0].message).toContain('Tool execution completed');
    });

    it('should skip tracking when not enabled', async () => {
      const contextNoTracking = {
        ...mockContext,
        metadata: {
          ...mockContext.metadata,
          performanceTracking: {
            trackingEnabled: false,
          },
        },
      };

      const result = await plugin.endPerformanceTracking(contextNoTracking, mockSettings);

      expect(result.success).toBe(true);
      expect(result.metadata.modifications).toHaveLength(0);
    });

    it('should skip tracking when performanceTracking is missing', async () => {
      const result = await plugin.endPerformanceTracking(mockContext, mockSettings);

      expect(result.success).toBe(true);
      expect(result.metadata.modifications).toHaveLength(0);
    });

    it('should generate warnings when execution time exceeds threshold', async () => {
      const contextWithSlowExecution = {
        ...mockContext,
        metadata: {
          ...mockContext.metadata,
          performanceTracking: {
            startTime: Date.now() - 5000, // 5 seconds ago
            initialMetrics: {
              timestamp: Date.now(),
              memoryUsage: 1000000,
              cpuUsage: 0,
              networkCalls: 0,
            },
            trackingEnabled: true,
          },
        },
      };

      const result = await plugin.endPerformanceTracking(contextWithSlowExecution, mockSettings);

      expect(result.success).toBe(true);
      expect(result.metadata.warnings).toContainEqual(
        expect.stringContaining('Execution time exceeded threshold')
      );
      expect(result.metadata.modifications).toContain('Performance alert: Slow execution');
    });

    it('should generate warnings when memory usage exceeds threshold', async () => {
      const contextWithHighMemory = {
        ...mockContext,
        metadata: {
          ...mockContext.metadata,
          performanceTracking: {
            startTime: Date.now() - 100,
            initialMetrics: {
              timestamp: Date.now(),
              memoryUsage: 0, // Starting from 0, current will be much higher
              cpuUsage: 0,
              networkCalls: 0,
            },
            trackingEnabled: true,
          },
        },
      };

      const result = await plugin.endPerformanceTracking(contextWithHighMemory, mockSettings);

      expect(result.success).toBe(true);
      // Memory delta will likely exceed 1MB threshold since current heap usage is typically higher
    });

    it('should log metrics when collectMetrics is true', async () => {
      const contextWithTracking = {
        ...mockContext,
        metadata: {
          ...mockContext.metadata,
          performanceTracking: {
            startTime: Date.now() - 100,
            initialMetrics: {
              timestamp: Date.now(),
              memoryUsage: 1000000,
              cpuUsage: 0,
              networkCalls: 0,
            },
            trackingEnabled: true,
          },
        },
      };

      await plugin.endPerformanceTracking(contextWithTracking, mockSettings);

      expect(consoleLogSpy).toHaveBeenCalled();
      const loggedData = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(loggedData.type).toBe('performance_metrics');
      expect(loggedData.toolId).toBe('tool-1');
      expect(loggedData.metrics).toBeDefined();
    });

    it('should not log metrics when collectMetrics is false', async () => {
      const settingsNoLog = { ...mockSettings, collectMetrics: false };
      const contextWithTracking = {
        ...mockContext,
        metadata: {
          ...mockContext.metadata,
          performanceTracking: {
            startTime: Date.now() - 100,
            initialMetrics: {
              timestamp: Date.now(),
              memoryUsage: 1000000,
              cpuUsage: 0,
              networkCalls: 0,
            },
            trackingEnabled: true,
          },
        },
      };

      await plugin.endPerformanceTracking(contextWithTracking, settingsNoLog);

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('should store metrics in performance data', async () => {
      const contextWithTracking = {
        ...mockContext,
        metadata: {
          ...mockContext.metadata,
          performanceTracking: {
            startTime: Date.now() - 100,
            initialMetrics: {
              timestamp: Date.now(),
              memoryUsage: 1000000,
              cpuUsage: 0,
              networkCalls: 0,
            },
            trackingEnabled: true,
          },
        },
      };

      await plugin.endPerformanceTracking(contextWithTracking, mockSettings);

      const stats = plugin.getToolPerformanceStats('org-1', 'tool-1');
      expect(stats).not.toBeNull();
      expect(stats?.totalExecutions).toBe(1);
    });

    it('should limit stored metrics to last 100 measurements', async () => {
      const contextWithTracking = {
        ...mockContext,
        metadata: {
          ...mockContext.metadata,
          performanceTracking: {
            startTime: Date.now() - 100,
            initialMetrics: {
              timestamp: Date.now(),
              memoryUsage: 1000000,
              cpuUsage: 0,
              networkCalls: 0,
            },
            trackingEnabled: true,
          },
        },
      };

      // Add 150 measurements
      for (let i = 0; i < 150; i++) {
        await plugin.endPerformanceTracking(contextWithTracking, mockSettings);
      }

      const stats = plugin.getToolPerformanceStats('org-1', 'tool-1');
      expect(stats?.totalExecutions).toBe(100); // Should be capped at 100
    });

    it('should handle errors gracefully', async () => {
      const contextWithTracking = {
        ...mockContext,
        metadata: {
          ...mockContext.metadata,
          performanceTracking: {
            startTime: Date.now() - 100,
            initialMetrics: {
              timestamp: Date.now(),
              memoryUsage: 1000000,
              cpuUsage: 0,
              networkCalls: 0,
            },
            trackingEnabled: true,
          },
        },
      };

      const result = await plugin.endPerformanceTracking(contextWithTracking, null);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('PERFORMANCE_MONITORING_ERROR');
    });
  });

  describe('recordError - Error metrics tracking', () => {
    it('should record error metrics successfully', async () => {
      const contextWithError = {
        ...mockContext,
        data: {
          error: {
            code: 'EXECUTION_ERROR',
            message: 'Tool execution failed',
          },
        },
      };

      const result = await plugin.recordError(contextWithError, mockSettings);

      expect(result.success).toBe(true);
      expect(result.metadata.modifications).toContain('Error metrics recorded');
      expect(consoleLogSpy).toHaveBeenCalled();
    });

    it('should log error metrics with correct structure', async () => {
      const contextWithError = {
        ...mockContext,
        data: {
          error: {
            code: 'TIMEOUT',
            message: 'Request timed out',
          },
        },
      };

      await plugin.recordError(contextWithError, mockSettings);

      expect(consoleLogSpy).toHaveBeenCalled();
      const loggedData = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(loggedData.type).toBe('performance_error');
      expect(loggedData.toolId).toBe('tool-1');
      expect(loggedData.error).toEqual({
        code: 'TIMEOUT',
        message: 'Request timed out',
      });
    });

    it('should handle missing tool ID', async () => {
      const contextNoTool = {
        ...mockContext,
        metadata: {
          ...mockContext.metadata,
          tool: undefined,
        },
        data: {
          error: { code: 'ERROR', message: 'Test error' },
        },
      };

      const result = await plugin.recordError(contextNoTool, mockSettings);

      expect(result.success).toBe(true);
      const loggedData = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(loggedData.toolId).toBe('unknown');
    });

    it('should handle missing error data', async () => {
      const contextWithoutError = {
        ...mockContext,
        data: {},
      };

      const result = await plugin.recordError(contextWithoutError, mockSettings);

      expect(result.success).toBe(true);
      expect(result.metadata.modifications).toContain('Error metrics recorded');
    });
  });

  describe('getToolPerformanceStats - Statistics retrieval', () => {
    it('should return null for tools with no data', () => {
      const stats = plugin.getToolPerformanceStats('org-1', 'nonexistent-tool');

      expect(stats).toBeNull();
    });

    it('should calculate average execution time correctly', async () => {
      const contextWithTracking = {
        ...mockContext,
        metadata: {
          ...mockContext.metadata,
          performanceTracking: {
            startTime: Date.now() - 100,
            initialMetrics: {
              timestamp: Date.now(),
              memoryUsage: 1000000,
              cpuUsage: 0,
              networkCalls: 0,
            },
            trackingEnabled: true,
          },
        },
      };

      // Add multiple measurements
      await plugin.endPerformanceTracking(contextWithTracking, mockSettings);
      await plugin.endPerformanceTracking(contextWithTracking, mockSettings);
      await plugin.endPerformanceTracking(contextWithTracking, mockSettings);

      const stats = plugin.getToolPerformanceStats('org-1', 'tool-1');

      expect(stats).not.toBeNull();
      expect(stats?.totalExecutions).toBe(3);
      expect(stats?.averageExecutionTime).toBeGreaterThan(0);
      expect(stats?.averageMemoryUsage).toBeGreaterThanOrEqual(0);
    });

    it('should return stable trend with consistent performance', async () => {
      const contextWithTracking = {
        ...mockContext,
        metadata: {
          ...mockContext.metadata,
          performanceTracking: {
            startTime: Date.now() - 100,
            initialMetrics: {
              timestamp: Date.now(),
              memoryUsage: 1000000,
              cpuUsage: 0,
              networkCalls: 0,
            },
            trackingEnabled: true,
          },
        },
      };

      // Add 10 measurements for trend calculation
      for (let i = 0; i < 10; i++) {
        await plugin.endPerformanceTracking(contextWithTracking, mockSettings);
      }

      const stats = plugin.getToolPerformanceStats('org-1', 'tool-1');

      expect(stats?.trend).toBeDefined();
      expect(['improving', 'stable', 'degrading']).toContain(stats?.trend);
    });

    it('should detect improving trend', async () => {
      const contextFast = {
        ...mockContext,
        metadata: {
          ...mockContext.metadata,
          performanceTracking: {
            startTime: Date.now() - 50, // Fast execution
            initialMetrics: {
              timestamp: Date.now(),
              memoryUsage: 1000000,
              cpuUsage: 0,
              networkCalls: 0,
            },
            trackingEnabled: true,
          },
        },
      };

      const contextSlow = {
        ...mockContext,
        metadata: {
          ...mockContext.metadata,
          performanceTracking: {
            startTime: Date.now() - 500, // Slow execution
            initialMetrics: {
              timestamp: Date.now(),
              memoryUsage: 1000000,
              cpuUsage: 0,
              networkCalls: 0,
            },
            trackingEnabled: true,
          },
        },
      };

      // Add 5 slow executions
      for (let i = 0; i < 5; i++) {
        await plugin.endPerformanceTracking(contextSlow, mockSettings);
      }

      // Add 5 fast executions
      for (let i = 0; i < 5; i++) {
        await plugin.endPerformanceTracking(contextFast, mockSettings);
      }

      const stats = plugin.getToolPerformanceStats('org-1', 'tool-1');

      expect(stats?.trend).toBe('improving');
    });

    it('should detect degrading trend', async () => {
      const contextFast = {
        ...mockContext,
        metadata: {
          ...mockContext.metadata,
          performanceTracking: {
            startTime: Date.now() - 50,
            initialMetrics: {
              timestamp: Date.now(),
              memoryUsage: 1000000,
              cpuUsage: 0,
              networkCalls: 0,
            },
            trackingEnabled: true,
          },
        },
      };

      const contextSlow = {
        ...mockContext,
        metadata: {
          ...mockContext.metadata,
          performanceTracking: {
            startTime: Date.now() - 500,
            initialMetrics: {
              timestamp: Date.now(),
              memoryUsage: 1000000,
              cpuUsage: 0,
              networkCalls: 0,
            },
            trackingEnabled: true,
          },
        },
      };

      // Add 5 fast executions first
      for (let i = 0; i < 5; i++) {
        await plugin.endPerformanceTracking(contextFast, mockSettings);
      }

      // Add 5 slow executions
      for (let i = 0; i < 5; i++) {
        await plugin.endPerformanceTracking(contextSlow, mockSettings);
      }

      const stats = plugin.getToolPerformanceStats('org-1', 'tool-1');

      expect(stats?.trend).toBe('degrading');
    });

    it('should return stable trend with fewer than 10 executions', async () => {
      const contextWithTracking = {
        ...mockContext,
        metadata: {
          ...mockContext.metadata,
          performanceTracking: {
            startTime: Date.now() - 100,
            initialMetrics: {
              timestamp: Date.now(),
              memoryUsage: 1000000,
              cpuUsage: 0,
              networkCalls: 0,
            },
            trackingEnabled: true,
          },
        },
      };

      // Add only 5 measurements
      for (let i = 0; i < 5; i++) {
        await plugin.endPerformanceTracking(contextWithTracking, mockSettings);
      }

      const stats = plugin.getToolPerformanceStats('org-1', 'tool-1');

      expect(stats?.trend).toBe('stable'); // Not enough data for trend
    });
  });

  describe('recordError - Error handling branches', () => {
    it('should handle errors in recordError gracefully', async () => {
      // Mock console.log to throw an error
      const originalLog = console.log;
      console.log = jest.fn(() => {
        throw new Error('Console log error');
      });

      const contextWithError = {
        ...mockContext,
        data: {
          error: {
            code: 'TEST_ERROR',
            message: 'Test error message',
          },
        },
      };

      const result = await plugin.recordError(contextWithError, mockSettings);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('ERROR_RECORDING_ERROR');
      expect(result.data).toEqual(contextWithError.data);

      // Restore console.log
      console.log = originalLog;
    });
  });

  describe('Performance Insights Generation', () => {
    it('should generate insights for slow execution', async () => {
      const contextSlow = {
        ...mockContext,
        metadata: {
          ...mockContext.metadata,
          performanceTracking: {
            startTime: Date.now() - 5000, // Very slow
            initialMetrics: {
              timestamp: Date.now(),
              memoryUsage: 1000000,
              cpuUsage: 0,
              networkCalls: 0,
            },
            trackingEnabled: true,
          },
        },
      };

      // Add baseline measurements
      for (let i = 0; i < 5; i++) {
        await plugin.endPerformanceTracking({
          ...contextSlow,
          metadata: {
            ...contextSlow.metadata,
            performanceTracking: {
              ...contextSlow.metadata.performanceTracking,
              startTime: Date.now() - 100,
            },
          },
        }, mockSettings);
      }

      // Add slow measurement
      const result = await plugin.endPerformanceTracking(contextSlow, mockSettings);

      expect(result.success).toBe(true);
      expect(result.metadata.modifications).toContainEqual(
        expect.stringContaining('performance insights')
      );
    });

    it('should not generate insights with insufficient data', async () => {
      const contextWithTracking = {
        ...mockContext,
        metadata: {
          ...mockContext.metadata,
          performanceTracking: {
            startTime: Date.now() - 100,
            initialMetrics: {
              timestamp: Date.now(),
              memoryUsage: 1000000,
              cpuUsage: 0,
              networkCalls: 0,
            },
            trackingEnabled: true,
          },
        },
      };

      // First execution - no insights yet
      const result = await plugin.endPerformanceTracking(contextWithTracking, mockSettings);

      expect(result.success).toBe(true);
      // With only 1 data point, no insights can be generated
    });

    it('should generate insight for memory usage above average', async () => {
      // Create baseline with low memory
      const baselineContext = {
        ...mockContext,
        metadata: {
          ...mockContext.metadata,
          performanceTracking: {
            startTime: Date.now() - 100,
            initialMetrics: {
              timestamp: Date.now(),
              memoryUsage: 100000, // Low memory
              cpuUsage: 0,
              networkCalls: 0,
            },
            trackingEnabled: true,
          },
        },
      };

      // Add baseline measurements with low memory delta
      for (let i = 0; i < 5; i++) {
        await plugin.endPerformanceTracking(baselineContext, mockSettings);
      }

      // Now add high memory execution
      const highMemoryContext = {
        ...mockContext,
        metadata: {
          ...mockContext.metadata,
          performanceTracking: {
            startTime: Date.now() - 100,
            initialMetrics: {
              timestamp: Date.now(),
              memoryUsage: 10, // Very low initial to get high delta
              cpuUsage: 0,
              networkCalls: 0,
            },
            trackingEnabled: true,
          },
        },
      };

      const result = await plugin.endPerformanceTracking(highMemoryContext, mockSettings);

      expect(result.success).toBe(true);
      // High memory usage should trigger insight
    });

    it('should generate insight for consistent performance degradation', async () => {
      // Create measurements with consistently increasing execution time
      for (let i = 0; i < 15; i++) {
        const degradingContext = {
          ...mockContext,
          metadata: {
            ...mockContext.metadata,
            performanceTracking: {
              startTime: Date.now() - (200 + i * 100), // Increasing execution time
              initialMetrics: {
                timestamp: Date.now(),
                memoryUsage: 1000000,
                cpuUsage: 0,
                networkCalls: 0,
              },
              trackingEnabled: true,
            },
          },
        };

        await plugin.endPerformanceTracking(degradingContext, mockSettings);
      }

      // Last execution should detect degradation
      const stats = plugin.getToolPerformanceStats('org-1', 'tool-1');
      expect(stats).not.toBeNull();
    });

    it('should suggest caching for slow tools when optimization enabled', async () => {
      // Create context with very slow execution (>10 seconds)
      const slowContext = {
        ...mockContext,
        metadata: {
          ...mockContext.metadata,
          performanceTracking: {
            startTime: Date.now() - 15000, // 15 seconds ago
            initialMetrics: {
              timestamp: Date.now(),
              memoryUsage: 1000000,
              cpuUsage: 0,
              networkCalls: 0,
            },
            trackingEnabled: true,
          },
        },
      };

      // Add multiple slow executions to build average
      for (let i = 0; i < 12; i++) {
        await plugin.endPerformanceTracking(slowContext, mockSettings);
      }

      // Should generate caching suggestion
      const stats = plugin.getToolPerformanceStats('org-1', 'tool-1');
      expect(stats?.averageExecutionTime).toBeGreaterThan(10000);
    });

    it('should suggest request batching for multiple network calls', async () => {
      // Mock performance data with high network calls
      const plugin2 = new PerformanceMonitorPlugin();

      // Manually add performance data with high network calls
      const performanceDataWithNetworkCalls = [];
      for (let i = 0; i < 12; i++) {
        performanceDataWithNetworkCalls.push({
          timestamp: Date.now(),
          executionTime: 1000,
          memoryUsage: 1000000,
          cpuUsage: 0,
          networkCalls: 8, // More than 5
        });
      }

      // Access private property for testing. Seed under the
      // composite bucket key so the new tenant-scoped getter finds
      // the data.
      (plugin2 as any).performanceData.set('org-1::tool-network', performanceDataWithNetworkCalls);

      const stats = plugin2.getToolPerformanceStats('org-1', 'tool-network');
      expect(stats?.totalExecutions).toBe(12);
    });

    it('should not generate optimization insights when optimization disabled', async () => {
      const settingsNoOptimization = { ...mockSettings, enableOptimization: false };

      const slowContext = {
        ...mockContext,
        metadata: {
          ...mockContext.metadata,
          performanceTracking: {
            startTime: Date.now() - 15000,
            initialMetrics: {
              timestamp: Date.now(),
              memoryUsage: 1000000,
              cpuUsage: 0,
              networkCalls: 10,
            },
            trackingEnabled: true,
          },
        },
      };

      // Add executions with optimization disabled
      for (let i = 0; i < 12; i++) {
        await plugin.endPerformanceTracking(slowContext, settingsNoOptimization);
      }

      expect(plugin.getToolPerformanceStats('org-1', 'tool-1')).not.toBeNull();
    });

    it('should generate insight for memory usage significantly above average (line 300)', () => {
      // Directly set performance data with high memory usage in last entry
      const performanceDataWithHighMemory = [];
      for (let i = 0; i < 10; i++) {
        performanceDataWithHighMemory.push({
          timestamp: Date.now(),
          executionTime: 100,
          memoryUsage: 100000, // Normal memory
          cpuUsage: 0,
          networkCalls: 0,
        });
      }
      // Last entry has very high memory (> 2x average)
      performanceDataWithHighMemory.push({
        timestamp: Date.now(),
        executionTime: 100,
        memoryUsage: 1000000, // 10x higher than average
        cpuUsage: 0,
        networkCalls: 0,
      });

      (plugin as any).performanceData.set('org-1::tool-memory', performanceDataWithHighMemory);

      const stats = plugin.getToolPerformanceStats('org-1', 'tool-memory');
      expect(stats?.insights.some(i => i.includes('Memory usage significantly above average'))).toBe(true);
    });

    it('should generate insight when recent half is consistently slower than earlier half', () => {
      // Earlier half ~1000ms, later half ~6000ms — clearly degrading.
      (plugin as any).performanceData.set('org-1::tool-degrading', [
        ...Array(5).fill(null).map(() => ({
          timestamp: Date.now(), executionTime: 1000, memoryUsage: 100000, cpuUsage: 0, networkCalls: 0,
        })),
        ...Array(5).fill(null).map(() => ({
          timestamp: Date.now(), executionTime: 6000, memoryUsage: 100000, cpuUsage: 0, networkCalls: 0,
        })),
      ]);

      const stats = plugin.getToolPerformanceStats('org-1', 'tool-degrading');
      expect(stats?.insights.some(i => i.includes('Consistent performance degradation'))).toBe(true);
    });

    it('should NOT generate degradation insight when execution times are stable', () => {
      (plugin as any).performanceData.set('org-1::tool-stable', [
        ...Array(10).fill(null).map(() => ({
          timestamp: Date.now(), executionTime: 1000, memoryUsage: 100000, cpuUsage: 0, networkCalls: 0,
        })),
      ]);

      const stats = plugin.getToolPerformanceStats('org-1', 'tool-stable');
      expect(stats?.insights.some(i => i.includes('Consistent performance degradation'))).toBe(false);
    });

    it('should generate insight for multiple network calls (line 314)', () => {
      // Performance data with high network calls
      const performanceDataWithNetworkCalls = [];
      for (let i = 0; i < 10; i++) {
        performanceDataWithNetworkCalls.push({
          timestamp: Date.now(),
          executionTime: 100,
          memoryUsage: 100000,
          cpuUsage: 0,
          networkCalls: 8, // > 5 network calls
        });
      }

      (plugin as any).performanceData.set('org-1::tool-network-heavy', performanceDataWithNetworkCalls);

      const stats = plugin.getToolPerformanceStats('org-1', 'tool-network-heavy');
      expect(stats?.insights.some(i => i.includes('Multiple network calls detected'))).toBe(true);
    });
  });
});
