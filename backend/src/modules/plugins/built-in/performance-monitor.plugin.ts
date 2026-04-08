import {
  Plugin,
  PluginHookType,
  PluginContext,
  PluginResult,
} from '../types/plugin.types';

interface PerformanceMetrics {
  executionTime: number;
  memoryUsage: number;
  cpuUsage: number;
  networkCalls: number;
}

/** Cap on how many distinct (org, tool) buckets we keep in memory. */
const MAX_TRACKED_BUCKETS = 1000;

/** Max samples retained per bucket. */
const MAX_SAMPLES_PER_BUCKET = 100;

export class PerformanceMonitorPlugin {
  /**
   * Per-(organizationId, toolId) metric buckets. Previously the map
   * was keyed by toolId alone, which meant (a) metrics from every
   * tenant ended up in the same bucket, and (b) the process-wide
   * `getToolPerformanceStats(toolId)` accessor would return data
   * from any org that had ever called a tool with the given id. The
   * composite key fixes both.
   *
   * The Map is also bounded — previously it grew one bucket per
   * unique toolId ever seen with no eviction.
   */
  private readonly performanceData = new Map<string, PerformanceMetrics[]>();

  private bucketKey(organizationId: string | undefined, toolId: string): string {
    return `${organizationId || '__global__'}::${toolId}`;
  }

  private evictIfFull(): void {
    if (this.performanceData.size < MAX_TRACKED_BUCKETS) return;
    const oldest = this.performanceData.keys().next().value;
    if (oldest !== undefined) this.performanceData.delete(oldest);
  }

  getPluginDefinition(): Omit<Plugin, 'id' | 'metadata'> {
    return {
      name: 'Performance Monitor',
      version: '1.0.0',
      description: 'Real-time performance monitoring and optimization for tool executions and API calls',
      author: 'almyty',
      isActive: true,
      configuration: {
        enabled: true,
        priority: 20,
        settings: {
          trackMemory: true,
          trackCpu: true,
          trackNetwork: true,
          alertThresholds: {
            executionTime: 30000, // 30 seconds
            memoryUsage: 100 * 1024 * 1024, // 100MB
            errorRate: 0.1, // 10%
          },
          collectMetrics: true,
          enableOptimization: true,
          cacheOptimizedResults: true,
        },
      },
      capabilities: {
        hooks: [
          PluginHookType.PRE_TOOL_EXECUTION,
          PluginHookType.POST_TOOL_EXECUTION,
          PluginHookType.PRE_API_CALL,
          PluginHookType.POST_API_CALL,
          PluginHookType.TOOL_EXECUTION_ERROR,
        ],
        protocols: ['mcp', 'utcp', 'a2a', 'http'],
        dataFormats: ['json'],
        operations: ['read', 'transform'],
      },
      hooks: [
        {
          type: PluginHookType.PRE_TOOL_EXECUTION,
          handler: 'startPerformanceTracking',
          async: false,
          timeout: 1000,
        },
        {
          type: PluginHookType.POST_TOOL_EXECUTION,
          handler: 'endPerformanceTracking',
          async: true,
          timeout: 2000,
        },
        {
          type: PluginHookType.TOOL_EXECUTION_ERROR,
          handler: 'recordError',
          async: true,
          timeout: 1000,
        },
      ],
    };
  }

  async startPerformanceTracking(context: PluginContext, settings: any): Promise<PluginResult> {
    const startTime = Date.now();

    try {
      // Record initial performance baseline
      const initialMetrics = {
        timestamp: Date.now(),
        memoryUsage: settings.trackMemory ? process.memoryUsage().heapUsed : 0,
        cpuUsage: settings.trackCpu ? process.cpuUsage().user : 0,
        networkCalls: 0, // Will be incremented during execution
      };

      // Mutate the context's metadata IN PLACE so the tracking state
      // is visible to the POST_TOOL_EXECUTION hook. The previous shape
      // built an `enhancedContext` with `{ ...context, metadata: {...} }`
      // but then returned only `enhancedContext.data` — the new metadata
      // was discarded the instant the function returned, so
      // `endPerformanceTracking` never saw `performanceTracking`
      // populated on the context and the entire plugin was a no-op.
      //
      // The plugin manager applies `pluginResult.data` to the shared
      // context but leaves the metadata alone, so the in-place mutation
      // is the only way tracking state propagates across hook phases.
      context.metadata = context.metadata || ({} as any);
      (context.metadata as any).performanceTracking = {
        startTime: Date.now(),
        initialMetrics,
        trackingEnabled: true,
      };

      return {
        success: true,
        data: context.data,
        metadata: {
          executionTime: Date.now() - startTime,
          modifications: ['Performance tracking started'],
        },
      };

    } catch (error) {
      return {
        success: false,
        data: context.data,
        error: {
          code: 'PERFORMANCE_TRACKING_ERROR',
          message: error.message,
        },
        metadata: {
          executionTime: Date.now() - startTime,
          modifications: [],
        },
      };
    }
  }

  async endPerformanceTracking(context: PluginContext, settings: any): Promise<PluginResult> {
    const startTime = Date.now();
    const modifications: string[] = [];
    const warnings: string[] = [];

    try {
      const performanceData = context.metadata.performanceTracking;
      if (!performanceData?.trackingEnabled) {
        return {
          success: true,
          data: context.data,
          metadata: {
            executionTime: Date.now() - startTime,
            modifications: [],
          },
        };
      }

      // Calculate performance metrics
      const endTime = Date.now();
      const executionTime = endTime - performanceData.startTime;
      const currentMemory = settings.trackMemory ? process.memoryUsage().heapUsed : 0;
      const memoryDelta = currentMemory - performanceData.initialMetrics.memoryUsage;

      const metrics: PerformanceMetrics = {
        executionTime,
        memoryUsage: memoryDelta,
        cpuUsage: 0, // Simplified - would need proper CPU monitoring
        networkCalls: performanceData.networkCalls || 0,
      };

      // Store metrics in a per-(org, tool) bucket so stats don't
      // bleed across tenants.
      const toolId = context.metadata.tool?.id || 'unknown';
      const key = this.bucketKey(context.organizationId, toolId);
      if (!this.performanceData.has(key)) {
        this.evictIfFull();
        this.performanceData.set(key, []);
      }
      this.performanceData.get(key)!.push(metrics);

      // Keep only the last MAX_SAMPLES_PER_BUCKET measurements per bucket
      const toolMetrics = this.performanceData.get(key)!;
      if (toolMetrics.length > MAX_SAMPLES_PER_BUCKET) {
        toolMetrics.splice(0, toolMetrics.length - MAX_SAMPLES_PER_BUCKET);
      }

      // Check performance thresholds
      if (executionTime > settings.alertThresholds.executionTime) {
        warnings.push(`Execution time exceeded threshold: ${executionTime}ms > ${settings.alertThresholds.executionTime}ms`);
        modifications.push('Performance alert: Slow execution');
      }

      if (memoryDelta > settings.alertThresholds.memoryUsage) {
        warnings.push(`Memory usage exceeded threshold: ${memoryDelta} bytes`);
        modifications.push('Performance alert: High memory usage');
      }

      // Generate performance insights
      const insights = await this.generatePerformanceInsights(key, metrics, settings);
      if (insights.length > 0) {
        modifications.push(`Generated ${insights.length} performance insights`);
      }

      // Log performance data
      if (settings.collectMetrics) {
        console.log(JSON.stringify({
          type: 'performance_metrics',
          timestamp: new Date().toISOString(),
          organizationId: context.organizationId,
          toolId,
          metrics,
          insights,
          requestId: context.requestId,
        }));
      }

      return {
        success: true,
        data: context.data,
        metadata: {
          executionTime: Date.now() - startTime,
          modifications,
          warnings,
          logs: [
            {
              level: 'info',
              message: `Tool execution completed in ${executionTime}ms (Memory: ${memoryDelta} bytes)`,
              timestamp: new Date().toISOString(),
            },
          ],
        },
      };

    } catch (error) {
      return {
        success: false,
        data: context.data,
        error: {
          code: 'PERFORMANCE_MONITORING_ERROR',
          message: error.message,
        },
        metadata: {
          executionTime: Date.now() - startTime,
          modifications,
        },
      };
    }
  }

  async recordError(context: PluginContext, settings: any): Promise<PluginResult> {
    const startTime = Date.now();

    try {
      const toolId = context.metadata.tool?.id || 'unknown';
      
      // Record error metrics
      console.log(JSON.stringify({
        type: 'performance_error',
        timestamp: new Date().toISOString(),
        organizationId: context.organizationId,
        toolId,
        error: context.data.error,
        executionTime: context.metadata.execution?.executionTime,
        requestId: context.requestId,
      }));

      return {
        success: true,
        data: context.data,
        metadata: {
          executionTime: Date.now() - startTime,
          modifications: ['Error metrics recorded'],
        },
      };

    } catch (error) {
      return {
        success: false,
        data: context.data,
        error: {
          code: 'ERROR_RECORDING_ERROR',
          message: error.message,
        },
        metadata: {
          executionTime: Date.now() - startTime,
          modifications: [],
        },
      };
    }
  }

  private generatePerformanceInsights(
    /** Full bucket key (`<orgId>::<toolId>`) — not a bare toolId,
     *  after the per-tenant bucketing fix. */
    bucketKey: string,
    currentMetrics: PerformanceMetrics,
    settings: any,
  ): string[] {
    const insights: string[] = [];
    const toolMetrics = this.performanceData.get(bucketKey) || [];

    if (toolMetrics.length < 2) {
      return insights; // Need more data
    }

    // Calculate trends
    const recentMetrics = toolMetrics.slice(-10); // Last 10 executions
    const averageExecutionTime = recentMetrics.reduce((sum, m) => sum + m.executionTime, 0) / recentMetrics.length;
    const averageMemoryUsage = recentMetrics.reduce((sum, m) => sum + m.memoryUsage, 0) / recentMetrics.length;

    // Performance insights
    if (currentMetrics.executionTime > averageExecutionTime * 2) {
      insights.push('Execution time significantly above average - investigate potential bottlenecks');
    }

    if (currentMetrics.memoryUsage > averageMemoryUsage * 2) {
      insights.push('Memory usage significantly above average - check for memory leaks');
    }

    // Detect consistent performance degradation: compare the later half of
    // recent metrics to the earlier half. The previous check
    // (`every(m => m.executionTime > averageExecutionTime)`) was mathematically
    // impossible — at least one value must be ≤ its own average — so the
    // branch was never reached.
    if (recentMetrics.length >= 4) {
      const mid = Math.floor(recentMetrics.length / 2);
      const earlier = recentMetrics.slice(0, mid);
      const later = recentMetrics.slice(mid);
      const earlierAvg =
        earlier.reduce((sum, m) => sum + m.executionTime, 0) / earlier.length;
      const laterAvg =
        later.reduce((sum, m) => sum + m.executionTime, 0) / later.length;
      // Trigger when the later window is at least 25 % slower than the earlier window.
      if (earlierAvg > 0 && laterAvg > earlierAvg * 1.25) {
        insights.push('Consistent performance degradation detected - optimization recommended');
      }
    }

    // Optimization suggestions
    if (settings.enableOptimization) {
      if (averageExecutionTime > 10000) { // 10 seconds
        insights.push('Consider enabling caching for this tool to improve response times');
      }

      if (recentMetrics.some(m => m.networkCalls > 5)) {
        insights.push('Multiple network calls detected - consider request batching or caching');
      }
    }

    return insights;
  }

  // Get performance statistics for a tool in a given organization.
  // Takes an organizationId so the per-tenant bucket stays tenant-scoped
  // — the previous accessor took only a toolId, which would've returned
  // blended stats across every org that ever called the tool, once we
  // also remove the old single-keyed bucket.
  getToolPerformanceStats(
    organizationId: string,
    toolId: string,
  ): {
    totalExecutions: number;
    averageExecutionTime: number;
    averageMemoryUsage: number;
    trend: 'improving' | 'stable' | 'degrading';
    insights: string[];
  } | null {
    const key = this.bucketKey(organizationId, toolId);
    const metrics = this.performanceData.get(key);
    if (!metrics || metrics.length === 0) {
      return null;
    }

    const totalExecutions = metrics.length;
    const averageExecutionTime = metrics.reduce((sum, m) => sum + m.executionTime, 0) / totalExecutions;
    const averageMemoryUsage = metrics.reduce((sum, m) => sum + m.memoryUsage, 0) / totalExecutions;

    // Calculate trend (simplified)
    let trend: 'improving' | 'stable' | 'degrading' = 'stable';
    if (metrics.length >= 10) {
      const recent = metrics.slice(-5);
      const older = metrics.slice(-10, -5);
      
      const recentAvg = recent.reduce((sum, m) => sum + m.executionTime, 0) / recent.length;
      const olderAvg = older.reduce((sum, m) => sum + m.executionTime, 0) / older.length;
      
      if (recentAvg < olderAvg * 0.9) {
        trend = 'improving';
      } else if (recentAvg > olderAvg * 1.1) {
        trend = 'degrading';
      }
    }

    // Generate insights using the last metrics entry
    let insights: string[] = [];
    if (metrics.length >= 10) {
      const currentMetrics = metrics[metrics.length - 1];
      insights = this.generatePerformanceInsights(key, currentMetrics, {
        enableOptimization: true,
        trackingEnabled: true,
        alertThresholds: { executionTime: 5000, memoryUsage: 100000000 }
      });
    }

    return {
      totalExecutions,
      averageExecutionTime,
      averageMemoryUsage,
      trend,
      insights,
    };
  }
}