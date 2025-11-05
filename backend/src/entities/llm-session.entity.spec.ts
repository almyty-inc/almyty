import {
  LlmSession,
  SessionStatus,
  SessionType,
} from './llm-session.entity';
import { LlmMessage } from './llm-message.entity';

describe('LlmSession Entity', () => {
  let session: LlmSession;

  beforeEach(() => {
    session = new LlmSession();
    session.id = 'session-1';
    session.providerId = 'provider-1';
    session.organizationId = 'org-1';
    session.type = SessionType.CHAT;
    session.status = SessionStatus.ACTIVE;
    session.messageCount = 0;
    session.totalInputTokens = 0;
    session.totalOutputTokens = 0;
    session.totalCost = 0;
    session.toolCalls = 0;
    session.successfulToolCalls = 0;
    session.createdAt = new Date();
  });

  describe('isActive', () => {
    it('should return true when status is ACTIVE', () => {
      expect(session.isActive()).toBe(true);
    });

    it('should return false when status is COMPLETED', () => {
      session.status = SessionStatus.COMPLETED;

      expect(session.isActive()).toBe(false);
    });

    it('should return false when status is FAILED', () => {
      session.status = SessionStatus.FAILED;

      expect(session.isActive()).toBe(false);
    });
  });

  describe('isCompleted', () => {
    it('should return false when status is ACTIVE', () => {
      expect(session.isCompleted()).toBe(false);
    });

    it('should return true when status is COMPLETED', () => {
      session.status = SessionStatus.COMPLETED;

      expect(session.isCompleted()).toBe(true);
    });

    it('should return true when status is FAILED', () => {
      session.status = SessionStatus.FAILED;

      expect(session.isCompleted()).toBe(true);
    });

    it('should return true when status is TIMEOUT', () => {
      session.status = SessionStatus.TIMEOUT;

      expect(session.isCompleted()).toBe(true);
    });

    it('should return true when status is CANCELLED', () => {
      session.status = SessionStatus.CANCELLED;

      expect(session.isCompleted()).toBe(true);
    });
  });

  describe('getTotalTokens', () => {
    it('should return sum of input and output tokens', () => {
      session.totalInputTokens = 100;
      session.totalOutputTokens = 200;

      expect(session.getTotalTokens()).toBe(300);
    });

    it('should return 0 when no tokens', () => {
      expect(session.getTotalTokens()).toBe(0);
    });
  });

  describe('getAverageCostPerMessage', () => {
    it('should return 0 when no messages', () => {
      expect(session.getAverageCostPerMessage()).toBe(0);
    });

    it('should calculate average cost correctly', () => {
      session.messageCount = 10;
      session.totalCost = 100;

      expect(session.getAverageCostPerMessage()).toBe(10);
    });
  });

  describe('getAverageTokensPerMessage', () => {
    it('should return 0 when no messages', () => {
      expect(session.getAverageTokensPerMessage()).toBe(0);
    });

    it('should calculate average tokens correctly', () => {
      session.messageCount = 5;
      session.totalInputTokens = 250;
      session.totalOutputTokens = 250;

      expect(session.getAverageTokensPerMessage()).toBe(100);
    });
  });

  describe('getToolCallSuccessRate', () => {
    it('should return 0 when no tool calls', () => {
      expect(session.getToolCallSuccessRate()).toBe(0);
    });

    it('should calculate success rate correctly', () => {
      session.toolCalls = 20;
      session.successfulToolCalls = 18;

      expect(session.getToolCallSuccessRate()).toBe(90);
    });

    it('should return 100 when all successful', () => {
      session.toolCalls = 10;
      session.successfulToolCalls = 10;

      expect(session.getToolCallSuccessRate()).toBe(100);
    });

    it('should return 0 when all failed', () => {
      session.toolCalls = 5;
      session.successfulToolCalls = 0;

      expect(session.getToolCallSuccessRate()).toBe(0);
    });
  });

  describe('getSessionDuration', () => {
    it('should calculate duration from creation to completion', () => {
      session.createdAt = new Date('2024-01-01T10:00:00Z');
      session.completedAt = new Date('2024-01-01T10:05:00Z');

      expect(session.getSessionDuration()).toBe(5 * 60 * 1000); // 5 minutes
    });

    it('should calculate duration from creation to now when not completed', () => {
      const now = Date.now();
      session.createdAt = new Date(now - 10000); // 10 seconds ago

      const duration = session.getSessionDuration();

      expect(duration).toBeGreaterThanOrEqual(10000);
      expect(duration).toBeLessThan(11000);
    });
  });

  describe('getAverageResponseTime', () => {
    it('should return 0 when no metadata', () => {
      expect(session.getAverageResponseTime()).toBe(0);
    });

    it('should return average response time from metadata', () => {
      session.metadata = { averageResponseTime: 250 };

      expect(session.getAverageResponseTime()).toBe(250);
    });
  });

  describe('addMessage', () => {
    it('should increment counters and add tokens/cost', () => {
      session.addMessage(10, 20, 5);

      expect(session.messageCount).toBe(1);
      expect(session.totalInputTokens).toBe(10);
      expect(session.totalOutputTokens).toBe(20);
      expect(session.totalCost).toBe(5);
      expect(session.lastActivityAt).toBeDefined();
    });

    it('should accumulate over multiple calls', () => {
      session.addMessage(10, 20, 5);
      session.addMessage(15, 25, 8);
      session.addMessage(5, 10, 2);

      expect(session.messageCount).toBe(3);
      expect(session.totalInputTokens).toBe(30);
      expect(session.totalOutputTokens).toBe(55);
      expect(session.totalCost).toBe(15);
    });
  });

  describe('addToolCall', () => {
    it('should increment tool call counter on successful call', () => {
      session.addToolCall(true);

      expect(session.toolCalls).toBe(1);
      expect(session.successfulToolCalls).toBe(1);
    });

    it('should increment tool call counter on failed call', () => {
      session.addToolCall(false);

      expect(session.toolCalls).toBe(1);
      expect(session.successfulToolCalls).toBe(0);
    });

    it('should default to successful', () => {
      session.addToolCall();

      expect(session.toolCalls).toBe(1);
      expect(session.successfulToolCalls).toBe(1);
    });

    it('should accumulate both successful and failed', () => {
      session.addToolCall(true);
      session.addToolCall(true);
      session.addToolCall(false);
      session.addToolCall(true);

      expect(session.toolCalls).toBe(4);
      expect(session.successfulToolCalls).toBe(3);
    });
  });

  describe('updateStatus', () => {
    it('should update status to COMPLETED', () => {
      session.updateStatus(SessionStatus.COMPLETED);

      expect(session.status).toBe(SessionStatus.COMPLETED);
      expect(session.completedAt).toBeDefined();
      expect(session.metadata.sessionDuration).toBeDefined();
    });

    it('should update status with failure reason', () => {
      session.updateStatus(SessionStatus.FAILED, 'API timeout');

      expect(session.status).toBe(SessionStatus.FAILED);
      expect(session.failureReason).toBe('API timeout');
      expect(session.completedAt).toBeDefined();
    });

    it('should not set completedAt when updating to ACTIVE', () => {
      session.updateStatus(SessionStatus.ACTIVE);

      expect(session.completedAt).toBeUndefined();
    });
  });

  describe('updateMetadata', () => {
    it('should merge metadata updates', () => {
      session.metadata = { requestCount: 5 };

      session.updateMetadata({ errorCount: 2, retryCount: 1 });

      expect(session.metadata).toEqual({
        requestCount: 5,
        errorCount: 2,
        retryCount: 1,
      });
    });

    it('should initialize metadata when undefined', () => {
      session.metadata = undefined;

      session.updateMetadata({ userAgent: 'test' });

      expect(session.metadata).toEqual({ userAgent: 'test' });
    });
  });

  describe('calculateAverageResponseTime', () => {
    it('should return 0 when no messages', () => {
      expect(session.calculateAverageResponseTime()).toBe(0);
    });

    it('should calculate average from message response times', () => {
      const msg1 = new LlmMessage();
      msg1.responseTime = 100;

      const msg2 = new LlmMessage();
      msg2.responseTime = 200;

      const msg3 = new LlmMessage();
      msg3.responseTime = 300;

      session.messages = [msg1, msg2, msg3];

      const average = session.calculateAverageResponseTime();

      expect(average).toBe(200);
      expect(session.metadata.averageResponseTime).toBe(200);
    });

    it('should filter out messages without response times', () => {
      const msg1 = new LlmMessage();
      msg1.responseTime = 100;

      const msg2 = new LlmMessage();
      msg2.responseTime = null;

      const msg3 = new LlmMessage();
      msg3.responseTime = 200;

      session.messages = [msg1, msg2, msg3];

      expect(session.calculateAverageResponseTime()).toBe(150);
    });
  });

  describe('Tool Management', () => {
    describe('hasToolsEnabled', () => {
      it('should return false when no context', () => {
        expect(session.hasToolsEnabled()).toBe(false);
      });

      it('should return true when tools enabled', () => {
        session.context = { toolsEnabled: true };

        expect(session.hasToolsEnabled()).toBe(true);
      });

      it('should return false when tools explicitly disabled', () => {
        session.context = { toolsEnabled: false };

        expect(session.hasToolsEnabled()).toBe(false);
      });
    });

    describe('getAvailableTools', () => {
      it('should return empty array when no tools', () => {
        expect(session.getAvailableTools()).toEqual([]);
      });

      it('should return available tools from context', () => {
        session.context = { availableTools: ['tool-1', 'tool-2'] };

        expect(session.getAvailableTools()).toEqual(['tool-1', 'tool-2']);
      });
    });

    describe('addAvailableTool', () => {
      it('should add tool to available tools', () => {
        session.addAvailableTool('tool-1');

        expect(session.getAvailableTools()).toContain('tool-1');
      });

      it('should not add duplicate tools', () => {
        session.context = { availableTools: ['tool-1'] };

        session.addAvailableTool('tool-1');

        expect(session.getAvailableTools()).toEqual(['tool-1']);
      });

      it('should initialize context if undefined', () => {
        session.context = undefined;

        session.addAvailableTool('tool-1');

        expect(session.getAvailableTools()).toEqual(['tool-1']);
      });

      it('should add multiple tools', () => {
        session.addAvailableTool('tool-1');
        session.addAvailableTool('tool-2');
        session.addAvailableTool('tool-3');

        expect(session.getAvailableTools()).toEqual(['tool-1', 'tool-2', 'tool-3']);
      });
    });

    describe('removeAvailableTool', () => {
      it('should remove tool from available tools', () => {
        session.context = { availableTools: ['tool-1', 'tool-2', 'tool-3'] };

        session.removeAvailableTool('tool-2');

        expect(session.getAvailableTools()).toEqual(['tool-1', 'tool-3']);
      });

      it('should handle removing non-existent tool', () => {
        session.context = { availableTools: ['tool-1'] };

        session.removeAvailableTool('tool-2');

        expect(session.getAvailableTools()).toEqual(['tool-1']);
      });
    });
  });

  describe('toSummary', () => {
    it('should return session summary', () => {
      session.id = 'session-12345678';
      session.title = 'Test Session';
      session.messageCount = 10;
      session.totalInputTokens = 100;
      session.totalOutputTokens = 200;
      session.totalCost = 50;
      session.toolCalls = 5;

      const summary = session.toSummary();

      expect(summary).toEqual({
        id: 'session-12345678',
        title: 'Test Session',
        type: SessionType.CHAT,
        status: SessionStatus.ACTIVE,
        messageCount: 10,
        totalTokens: 300,
        totalCost: 50,
        toolCalls: 5,
        duration: expect.any(Number),
        createdAt: session.createdAt,
        completedAt: undefined,
        lastActivityAt: undefined,
      });
    });

    it('should generate title from ID when none provided', () => {
      session.id = 'abcdef12';
      session.title = null;

      const summary = session.toSummary();

      expect(summary.title).toBe('Session abcdef12');
    });
  });

  describe('createSession', () => {
    it('should create session with required fields', () => {
      const created = LlmSession.createSession({
        providerId: 'provider-1',
        organizationId: 'org-1',
      });

      expect(created.providerId).toBe('provider-1');
      expect(created.organizationId).toBe('org-1');
      expect(created.type).toBe(SessionType.CHAT);
      expect(created.status).toBe(SessionStatus.ACTIVE);
      expect(created.lastActivityAt).toBeDefined();
    });

    it('should create session with optional fields', () => {
      const created = LlmSession.createSession({
        providerId: 'provider-1',
        organizationId: 'org-1',
        gatewayId: 'gateway-1',
        userId: 'user-1',
        type: SessionType.TOOL_USE,
        title: 'Custom Session',
        context: { toolsEnabled: true },
        metadata: { userAgent: 'test' },
      });

      expect(created.gatewayId).toBe('gateway-1');
      expect(created.userId).toBe('user-1');
      expect(created.type).toBe(SessionType.TOOL_USE);
      expect(created.title).toBe('Custom Session');
      expect(created.context.toolsEnabled).toBe(true);
      expect(created.metadata.userAgent).toBe('test');
    });
  });

  describe('Cost Tracking', () => {
    describe('addInputTokens', () => {
      it('should add input tokens without cost', () => {
        session.addInputTokens(100);

        expect(session.totalInputTokens).toBe(100);
        expect(session.totalCost).toBe(0);
      });

      it('should add input tokens with cost', () => {
        session.addInputTokens(1000, 0.01);

        expect(session.totalInputTokens).toBe(1000);
        expect(session.totalCost).toBe(10);
      });
    });

    describe('addOutputTokens', () => {
      it('should add output tokens without cost', () => {
        session.addOutputTokens(200);

        expect(session.totalOutputTokens).toBe(200);
        expect(session.totalCost).toBe(0);
      });

      it('should add output tokens with cost', () => {
        session.addOutputTokens(1000, 0.02);

        expect(session.totalOutputTokens).toBe(1000);
        expect(session.totalCost).toBe(20);
      });
    });

    describe('estimateRemainingBudget', () => {
      it('should calculate remaining budget', () => {
        session.totalCost = 30;

        const result = session.estimateRemainingBudget(100);

        expect(result.remaining).toBe(70);
        expect(result.percentage).toBe(70);
        expect(result.canContinue).toBe(true);
      });

      it('should return 0 remaining when over budget', () => {
        session.totalCost = 150;

        const result = session.estimateRemainingBudget(100);

        expect(result.remaining).toBe(0);
        expect(result.percentage).toBe(0);
        expect(result.canContinue).toBe(false);
      });

      it('should handle zero budget limit', () => {
        session.totalCost = 50;

        const result = session.estimateRemainingBudget(0);

        expect(result.remaining).toBe(0);
        expect(result.percentage).toBe(0);
        expect(result.canContinue).toBe(false);
      });

      it('should round values to 2 decimal places', () => {
        session.totalCost = 33.3333;

        const result = session.estimateRemainingBudget(100);

        expect(result.remaining).toBe(66.67);
        expect(result.percentage).toBe(66.67);
      });
    });
  });
});
