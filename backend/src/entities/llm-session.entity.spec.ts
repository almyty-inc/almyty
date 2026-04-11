import {
  Conversation,
  ConversationStatus,
} from './conversation.entity';
import { Message } from './message.entity';

describe('Conversation Entity', () => {
  let conversation: Conversation;

  beforeEach(() => {
    conversation = new Conversation();
    conversation.id = 'conversation-1';
    conversation.providerId = 'provider-1';
    conversation.organizationId = 'org-1';
    conversation.status = ConversationStatus.ACTIVE;
    conversation.messageCount = 0;
    conversation.totalInputTokens = 0;
    conversation.totalOutputTokens = 0;
    conversation.totalCost = 0;
    conversation.toolCalls = 0;
    conversation.successfulToolCalls = 0;
    conversation.createdAt = new Date();
  });

  describe('isActive', () => {
    it('should return true when status is ACTIVE', () => {
      expect(conversation.isActive()).toBe(true);
    });

    it('should return false when status is ARCHIVED', () => {
      conversation.status = ConversationStatus.ARCHIVED;

      expect(conversation.isActive()).toBe(false);
    });

    it('should return false when status is FAILED', () => {
      conversation.status = ConversationStatus.FAILED;

      expect(conversation.isActive()).toBe(false);
    });
  });

  describe('isCompleted', () => {
    it('should return false when status is ACTIVE', () => {
      expect(conversation.isCompleted()).toBe(false);
    });

    it('should return true when status is FAILED', () => {
      conversation.status = ConversationStatus.FAILED;

      expect(conversation.isCompleted()).toBe(true);
    });

    it('should return true when status is CANCELLED', () => {
      conversation.status = ConversationStatus.CANCELLED;

      expect(conversation.isCompleted()).toBe(true);
    });

    it('should return true when status is ARCHIVED', () => {
      conversation.status = ConversationStatus.ARCHIVED;

      expect(conversation.isCompleted()).toBe(true);
    });
  });

  describe('getTotalTokens', () => {
    it('should return sum of input and output tokens', () => {
      conversation.totalInputTokens = 100;
      conversation.totalOutputTokens = 200;

      expect(conversation.getTotalTokens()).toBe(300);
    });

    it('should return 0 when no tokens', () => {
      expect(conversation.getTotalTokens()).toBe(0);
    });
  });

  describe('getAverageCostPerMessage', () => {
    it('should return 0 when no messages', () => {
      expect(conversation.getAverageCostPerMessage()).toBe(0);
    });

    it('should calculate average cost correctly', () => {
      conversation.messageCount = 10;
      conversation.totalCost = 100;

      expect(conversation.getAverageCostPerMessage()).toBe(10);
    });
  });

  describe('getAverageTokensPerMessage', () => {
    it('should return 0 when no messages', () => {
      expect(conversation.getAverageTokensPerMessage()).toBe(0);
    });

    it('should calculate average tokens correctly', () => {
      conversation.messageCount = 5;
      conversation.totalInputTokens = 250;
      conversation.totalOutputTokens = 250;

      expect(conversation.getAverageTokensPerMessage()).toBe(100);
    });
  });

  describe('getToolCallSuccessRate', () => {
    it('should return 0 when no tool calls', () => {
      expect(conversation.getToolCallSuccessRate()).toBe(0);
    });

    it('should calculate success rate correctly', () => {
      conversation.toolCalls = 20;
      conversation.successfulToolCalls = 18;

      expect(conversation.getToolCallSuccessRate()).toBe(90);
    });

    it('should return 100 when all successful', () => {
      conversation.toolCalls = 10;
      conversation.successfulToolCalls = 10;

      expect(conversation.getToolCallSuccessRate()).toBe(100);
    });

    it('should return 0 when all failed', () => {
      conversation.toolCalls = 5;
      conversation.successfulToolCalls = 0;

      expect(conversation.getToolCallSuccessRate()).toBe(0);
    });
  });

  describe('getSessionDuration', () => {
    it('should calculate duration from creation to completion', () => {
      conversation.createdAt = new Date('2024-01-01T10:00:00Z');
      conversation.completedAt = new Date('2024-01-01T10:05:00Z');

      expect(conversation.getSessionDuration()).toBe(5 * 60 * 1000); // 5 minutes
    });

    it('should calculate duration from creation to now when not completed', () => {
      const now = Date.now();
      conversation.createdAt = new Date(now - 10000); // 10 seconds ago

      const duration = conversation.getSessionDuration();

      expect(duration).toBeGreaterThanOrEqual(10000);
      expect(duration).toBeLessThan(11000);
    });
  });

  describe('getAverageResponseTime', () => {
    it('should return 0 when no metadata', () => {
      expect(conversation.getAverageResponseTime()).toBe(0);
    });

    it('should return average response time from metadata', () => {
      conversation.metadata = { averageResponseTime: 250 };

      expect(conversation.getAverageResponseTime()).toBe(250);
    });
  });

  describe('addMessage', () => {
    it('should increment counters and add tokens/cost', () => {
      conversation.addMessage(10, 20, 5);

      expect(conversation.messageCount).toBe(1);
      expect(conversation.totalInputTokens).toBe(10);
      expect(conversation.totalOutputTokens).toBe(20);
      expect(conversation.totalCost).toBe(5);
      expect(conversation.lastActivityAt).toBeDefined();
    });

    it('should accumulate over multiple calls', () => {
      conversation.addMessage(10, 20, 5);
      conversation.addMessage(15, 25, 8);
      conversation.addMessage(5, 10, 2);

      expect(conversation.messageCount).toBe(3);
      expect(conversation.totalInputTokens).toBe(30);
      expect(conversation.totalOutputTokens).toBe(55);
      expect(conversation.totalCost).toBe(15);
    });
  });

  describe('addToolCall', () => {
    it('should increment tool call counter on successful call', () => {
      conversation.addToolCall(true);

      expect(conversation.toolCalls).toBe(1);
      expect(conversation.successfulToolCalls).toBe(1);
    });

    it('should increment tool call counter on failed call', () => {
      conversation.addToolCall(false);

      expect(conversation.toolCalls).toBe(1);
      expect(conversation.successfulToolCalls).toBe(0);
    });

    it('should default to successful', () => {
      conversation.addToolCall();

      expect(conversation.toolCalls).toBe(1);
      expect(conversation.successfulToolCalls).toBe(1);
    });

    it('should accumulate both successful and failed', () => {
      conversation.addToolCall(true);
      conversation.addToolCall(true);
      conversation.addToolCall(false);
      conversation.addToolCall(true);

      expect(conversation.toolCalls).toBe(4);
      expect(conversation.successfulToolCalls).toBe(3);
    });
  });

  describe('updateStatus', () => {
    it('should update status to ARCHIVED', () => {
      conversation.updateStatus(ConversationStatus.ARCHIVED);

      expect(conversation.status).toBe(ConversationStatus.ARCHIVED);
      expect(conversation.completedAt).toBeDefined();
      expect(conversation.metadata.sessionDuration).toBeDefined();
    });

    it('should update status with failure reason', () => {
      conversation.updateStatus(ConversationStatus.FAILED, 'API timeout');

      expect(conversation.status).toBe(ConversationStatus.FAILED);
      expect(conversation.failureReason).toBe('API timeout');
      expect(conversation.completedAt).toBeDefined();
    });

    it('should not set completedAt when updating to ACTIVE', () => {
      conversation.updateStatus(ConversationStatus.ACTIVE);

      expect(conversation.completedAt).toBeUndefined();
    });
  });

  describe('updateMetadata', () => {
    it('should merge metadata updates', () => {
      conversation.metadata = { requestCount: 5 };

      conversation.updateMetadata({ errorCount: 2, retryCount: 1 });

      expect(conversation.metadata).toEqual({
        requestCount: 5,
        errorCount: 2,
        retryCount: 1,
      });
    });

    it('should initialize metadata when undefined', () => {
      conversation.metadata = undefined;

      conversation.updateMetadata({ userAgent: 'test' });

      expect(conversation.metadata).toEqual({ userAgent: 'test' });
    });
  });

  describe('calculateAverageResponseTime', () => {
    it('should return 0 when no messages', () => {
      expect(conversation.calculateAverageResponseTime()).toBe(0);
    });

    it('should calculate average from message response times', () => {
      const msg1 = new Message();
      msg1.responseTime = 100;

      const msg2 = new Message();
      msg2.responseTime = 200;

      const msg3 = new Message();
      msg3.responseTime = 300;

      conversation.messages = [msg1, msg2, msg3];

      const average = conversation.calculateAverageResponseTime();

      expect(average).toBe(200);
      expect(conversation.metadata.averageResponseTime).toBe(200);
    });

    it('should filter out messages without response times', () => {
      const msg1 = new Message();
      msg1.responseTime = 100;

      const msg2 = new Message();
      msg2.responseTime = null;

      const msg3 = new Message();
      msg3.responseTime = 200;

      conversation.messages = [msg1, msg2, msg3];

      expect(conversation.calculateAverageResponseTime()).toBe(150);
    });
  });

  describe('Tool Management', () => {
    describe('hasToolsEnabled', () => {
      it('should return false when no context', () => {
        expect(conversation.hasToolsEnabled()).toBe(false);
      });

      it('should return true when tools enabled', () => {
        conversation.context = { toolsEnabled: true };

        expect(conversation.hasToolsEnabled()).toBe(true);
      });

      it('should return false when tools explicitly disabled', () => {
        conversation.context = { toolsEnabled: false };

        expect(conversation.hasToolsEnabled()).toBe(false);
      });
    });

    describe('getAvailableTools', () => {
      it('should return empty array when no tools', () => {
        expect(conversation.getAvailableTools()).toEqual([]);
      });

      it('should return available tools from context', () => {
        conversation.context = { availableTools: ['tool-1', 'tool-2'] };

        expect(conversation.getAvailableTools()).toEqual(['tool-1', 'tool-2']);
      });
    });

    describe('addAvailableTool', () => {
      it('should add tool to available tools', () => {
        conversation.addAvailableTool('tool-1');

        expect(conversation.getAvailableTools()).toContain('tool-1');
      });

      it('should not add duplicate tools', () => {
        conversation.context = { availableTools: ['tool-1'] };

        conversation.addAvailableTool('tool-1');

        expect(conversation.getAvailableTools()).toEqual(['tool-1']);
      });

      it('should initialize context if undefined', () => {
        conversation.context = undefined;

        conversation.addAvailableTool('tool-1');

        expect(conversation.getAvailableTools()).toEqual(['tool-1']);
      });

      it('should add multiple tools', () => {
        conversation.addAvailableTool('tool-1');
        conversation.addAvailableTool('tool-2');
        conversation.addAvailableTool('tool-3');

        expect(conversation.getAvailableTools()).toEqual(['tool-1', 'tool-2', 'tool-3']);
      });
    });

    describe('removeAvailableTool', () => {
      it('should remove tool from available tools', () => {
        conversation.context = { availableTools: ['tool-1', 'tool-2', 'tool-3'] };

        conversation.removeAvailableTool('tool-2');

        expect(conversation.getAvailableTools()).toEqual(['tool-1', 'tool-3']);
      });

      it('should handle removing non-existent tool', () => {
        conversation.context = { availableTools: ['tool-1'] };

        conversation.removeAvailableTool('tool-2');

        expect(conversation.getAvailableTools()).toEqual(['tool-1']);
      });
    });
  });

  describe('toSummary', () => {
    it('should return conversation summary', () => {
      conversation.id = 'conv-12345678';
      conversation.title = 'Test Conversation';
      conversation.messageCount = 10;
      conversation.totalInputTokens = 100;
      conversation.totalOutputTokens = 200;
      conversation.totalCost = 50;
      conversation.toolCalls = 5;

      const summary = conversation.toSummary();

      expect(summary).toEqual({
        id: 'conv-12345678',
        title: 'Test Conversation',
        status: ConversationStatus.ACTIVE,
        messageCount: 10,
        totalTokens: 300,
        totalCost: 50,
        toolCalls: 5,
        duration: expect.any(Number),
        createdAt: conversation.createdAt,
        completedAt: undefined,
        lastActivityAt: undefined,
      });
    });

    it('should generate title from ID when none provided', () => {
      conversation.id = 'abcdef12';
      conversation.title = null;

      const summary = conversation.toSummary();

      expect(summary.title).toBe('Conversation abcdef12');
    });
  });

  describe('createConversation', () => {
    it('should create conversation with required fields', () => {
      const created = Conversation.createConversation({
        providerId: 'provider-1',
        organizationId: 'org-1',
      });

      expect(created.providerId).toBe('provider-1');
      expect(created.organizationId).toBe('org-1');
      expect(created.status).toBe(ConversationStatus.ACTIVE);
      expect(created.lastActivityAt).toBeDefined();
    });

    it('should create conversation with optional fields', () => {
      const created = Conversation.createConversation({
        providerId: 'provider-1',
        organizationId: 'org-1',
        gatewayId: 'gateway-1',
        userId: 'user-1',
        title: 'Custom Conversation',
        context: { toolsEnabled: true },
        metadata: { userAgent: 'test' },
      });

      expect(created.gatewayId).toBe('gateway-1');
      expect(created.userId).toBe('user-1');
      expect(created.title).toBe('Custom Conversation');
      expect(created.context.toolsEnabled).toBe(true);
      expect(created.metadata.userAgent).toBe('test');
    });
  });

  describe('Cost Tracking', () => {
    describe('addInputTokens', () => {
      it('should add input tokens without cost', () => {
        conversation.addInputTokens(100);

        expect(conversation.totalInputTokens).toBe(100);
        expect(conversation.totalCost).toBe(0);
      });

      it('should add input tokens with cost', () => {
        conversation.addInputTokens(1000, 0.01);

        expect(conversation.totalInputTokens).toBe(1000);
        expect(conversation.totalCost).toBe(10);
      });
    });

    describe('addOutputTokens', () => {
      it('should add output tokens without cost', () => {
        conversation.addOutputTokens(200);

        expect(conversation.totalOutputTokens).toBe(200);
        expect(conversation.totalCost).toBe(0);
      });

      it('should add output tokens with cost', () => {
        conversation.addOutputTokens(1000, 0.02);

        expect(conversation.totalOutputTokens).toBe(1000);
        expect(conversation.totalCost).toBe(20);
      });
    });

    describe('estimateRemainingBudget', () => {
      it('should calculate remaining budget', () => {
        conversation.totalCost = 30;

        const result = conversation.estimateRemainingBudget(100);

        expect(result.remaining).toBe(70);
        expect(result.percentage).toBe(70);
        expect(result.canContinue).toBe(true);
      });

      it('should return 0 remaining when over budget', () => {
        conversation.totalCost = 150;

        const result = conversation.estimateRemainingBudget(100);

        expect(result.remaining).toBe(0);
        expect(result.percentage).toBe(0);
        expect(result.canContinue).toBe(false);
      });

      it('should handle zero budget limit', () => {
        conversation.totalCost = 50;

        const result = conversation.estimateRemainingBudget(0);

        expect(result.remaining).toBe(0);
        expect(result.percentage).toBe(0);
        expect(result.canContinue).toBe(false);
      });

      it('should round values to 2 decimal places', () => {
        conversation.totalCost = 33.3333;

        const result = conversation.estimateRemainingBudget(100);

        expect(result.remaining).toBe(66.67);
        expect(result.percentage).toBe(66.67);
      });
    });
  });
});
