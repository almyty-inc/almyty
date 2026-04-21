import {
  StreamEvent,
  StreamEventType,
  PipelineStreamEvent,
  RuntimeStreamEvent,
  RuntimeLlmStarted,
  RuntimeLlmChunk,
  RuntimeLlmResponse,
  RuntimeToolStarted,
  RuntimeToolResult,
  RuntimeStepCompleted,
  RuntimeRunCompleted,
  RuntimeRunFailed,
  RuntimeRunCancelled,
} from '../stream-event.types';

// Also verify the re-export from agent-execution.engine still works
import { StreamEvent as EngineStreamEvent } from '../agent-execution.engine';

describe('StreamEvent types', () => {
  describe('type compatibility', () => {
    it('EngineStreamEvent re-export should be the same type as StreamEvent', () => {
      // Compile-time check: assigning between the two types must work
      const event: StreamEvent = {
        type: 'execution.started',
        data: { executionId: 'exec-1' },
        timestamp: Date.now(),
      };
      const engineEvent: EngineStreamEvent = event;
      expect(engineEvent.type).toBe('execution.started');
    });
  });

  describe('pipeline events', () => {
    it('should create valid execution.started events', () => {
      const event: PipelineStreamEvent = {
        type: 'execution.started',
        data: { executionId: 'exec-1', agentId: 'agent-1' },
        timestamp: Date.now(),
      };
      expect(event.type).toBe('execution.started');
      expect(event.timestamp).toBeGreaterThan(0);
    });

    it('should create valid node.started events with nodeId and nodeType', () => {
      const event: PipelineStreamEvent = {
        type: 'node.started',
        nodeId: 'node-1',
        nodeType: 'llm_call',
        timestamp: Date.now(),
      };
      expect(event.type).toBe('node.started');
      expect(event.nodeId).toBe('node-1');
      expect(event.nodeType).toBe('llm_call');
    });

    it('should create valid node.output events', () => {
      const event: PipelineStreamEvent = {
        type: 'node.output',
        nodeId: 'node-1',
        nodeType: 'llm_call',
        data: { output: 'Hello world' },
        timestamp: Date.now(),
      };
      expect(event.type).toBe('node.output');
      expect(event.data.output).toBe('Hello world');
    });

    it('should create valid node.completed events', () => {
      const event: PipelineStreamEvent = {
        type: 'node.completed',
        nodeId: 'node-1',
        nodeType: 'tool_call',
        data: { cost: 0.001, tokens: 50 },
        timestamp: Date.now(),
      };
      expect(event.type).toBe('node.completed');
    });

    it('should create valid node.skipped events', () => {
      const event: PipelineStreamEvent = {
        type: 'node.skipped',
        nodeId: 'node-2',
        nodeType: 'condition',
        timestamp: Date.now(),
      };
      expect(event.type).toBe('node.skipped');
    });

    it('should create valid execution.completed events', () => {
      const event: PipelineStreamEvent = {
        type: 'execution.completed',
        data: { executionId: 'exec-1', output: 'done', totalCost: 0.05 },
        timestamp: Date.now(),
      };
      expect(event.type).toBe('execution.completed');
    });

    it('should create valid execution.failed events', () => {
      const event: PipelineStreamEvent = {
        type: 'execution.failed',
        data: { error: 'Timeout exceeded', errorType: 'TIMEOUT' },
        timestamp: Date.now(),
      };
      expect(event.type).toBe('execution.failed');
    });
  });

  describe('runtime events', () => {
    it('should create valid llm.started events', () => {
      const event: RuntimeLlmStarted = {
        type: 'llm.started',
        data: { step: 0 },
        timestamp: Date.now(),
      };
      expect(event.type).toBe('llm.started');
      expect(event.data?.step).toBe(0);
    });

    it('should create valid llm.chunk events', () => {
      const event: RuntimeLlmChunk = {
        type: 'llm.chunk',
        data: { step: 1, content: 'Hello' },
        timestamp: Date.now(),
      };
      expect(event.type).toBe('llm.chunk');
      expect(event.data?.content).toBe('Hello');
    });

    it('should create valid llm.response events', () => {
      const event: RuntimeLlmResponse = {
        type: 'llm.response',
        data: {
          step: 1,
          content: 'Full response text',
          toolCalls: [{ id: 'tc-1', name: 'search' }],
          usage: { inputTokens: 100, outputTokens: 50 },
          cost: 0.002,
        },
        timestamp: Date.now(),
      };
      expect(event.type).toBe('llm.response');
      expect(event.data?.toolCalls).toHaveLength(1);
      expect(event.data?.usage?.inputTokens).toBe(100);
    });

    it('should create valid tool.started events', () => {
      const event: RuntimeToolStarted = {
        type: 'tool.started',
        data: { step: 1, toolCallId: 'tc-1', tool: 'web_search' },
        timestamp: Date.now(),
      };
      expect(event.type).toBe('tool.started');
      expect(event.data?.tool).toBe('web_search');
    });

    it('should create valid tool.result events', () => {
      const event: RuntimeToolResult = {
        type: 'tool.result',
        data: {
          step: 1,
          toolCallId: 'tc-1',
          tool: 'web_search',
          success: true,
          executionTime: 450,
        },
        timestamp: Date.now(),
      };
      expect(event.type).toBe('tool.result');
      expect(event.data?.success).toBe(true);
      expect(event.data?.executionTime).toBe(450);
    });

    it('should create valid step.completed events', () => {
      const event: RuntimeStepCompleted = {
        type: 'step.completed',
        data: { step: 3, total: 50 },
        timestamp: Date.now(),
      };
      expect(event.type).toBe('step.completed');
    });

    it('should create valid run.completed events', () => {
      const event: RuntimeRunCompleted = {
        type: 'run.completed',
        data: { output: 'The answer is 42' },
        timestamp: Date.now(),
      };
      expect(event.type).toBe('run.completed');
    });

    it('should create valid run.failed events', () => {
      const event: RuntimeRunFailed = {
        type: 'run.failed',
        data: { error: 'MAX_STEPS_EXCEEDED' },
        timestamp: Date.now(),
      };
      expect(event.type).toBe('run.failed');
    });

    it('should create valid run.cancelled events', () => {
      const event: RuntimeRunCancelled = {
        type: 'run.cancelled',
        data: {},
        timestamp: Date.now(),
      };
      expect(event.type).toBe('run.cancelled');
    });
  });

  describe('union type', () => {
    it('should accept both pipeline and runtime events in a StreamEvent array', () => {
      const events: StreamEvent[] = [
        { type: 'execution.started', data: {}, timestamp: 1 },
        { type: 'node.started', nodeId: 'n1', nodeType: 'llm_call', timestamp: 2 },
        { type: 'llm.started', data: { step: 0 }, timestamp: 3 },
        { type: 'llm.chunk', data: { step: 0, content: 'hi' }, timestamp: 4 },
        { type: 'tool.started', data: { step: 0, toolCallId: 'tc', tool: 'x' }, timestamp: 5 },
        { type: 'tool.result', data: { step: 0, toolCallId: 'tc', tool: 'x', success: true }, timestamp: 6 },
        { type: 'run.completed', data: { output: 'done' }, timestamp: 7 },
        { type: 'execution.completed', data: {}, timestamp: 8 },
      ];

      expect(events).toHaveLength(8);
      expect(events.map(e => e.type)).toEqual([
        'execution.started',
        'node.started',
        'llm.started',
        'llm.chunk',
        'tool.started',
        'tool.result',
        'run.completed',
        'execution.completed',
      ]);
    });

    it('should distinguish event types via discriminated union', () => {
      const event: StreamEvent = {
        type: 'llm.response',
        data: {
          step: 0,
          content: 'test',
          usage: { inputTokens: 10, outputTokens: 5 },
        },
        timestamp: Date.now(),
      };

      // Type narrowing should work
      if (event.type === 'llm.response') {
        expect(event.data?.usage?.inputTokens).toBe(10);
      }
    });
  });
});
