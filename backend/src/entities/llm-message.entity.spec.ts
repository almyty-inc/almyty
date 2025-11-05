import {
  LlmMessage,
  MessageRole,
  MessageType,
  MessageStatus,
  MessageContent,
  ToolCall,
  FunctionCall,
} from './llm-message.entity';

describe('LlmMessage Entity', () => {
  let message: LlmMessage;

  beforeEach(() => {
    message = new LlmMessage();
    message.id = 'msg-1';
    message.sessionId = 'session-1';
    message.role = MessageRole.ASSISTANT;
    message.type = MessageType.TEXT;
    message.status = MessageStatus.COMPLETED;
    message.content = 'Test message';
    message.inputTokens = 10;
    message.outputTokens = 20;
    message.cost = 50; // 50 cents
    message.responseTime = 1000; // 1 second
  });

  describe('getTotalTokens', () => {
    it('should return sum of input and output tokens', () => {
      expect(message.getTotalTokens()).toBe(30);
    });

    it('should handle zero tokens', () => {
      message.inputTokens = 0;
      message.outputTokens = 0;

      expect(message.getTotalTokens()).toBe(0);
    });
  });

  describe('isToolCall', () => {
    it('should return false for non-tool-call messages', () => {
      expect(message.isToolCall()).toBe(false);
    });

    it('should return true when type is TOOL_CALL and has toolCalls', () => {
      message.type = MessageType.TOOL_CALL;
      message.toolCalls = [{ id: 'tc-1', name: 'getTool', parameters: {} }];

      expect(message.isToolCall()).toBe(true);
    });

    it('should return true when type is TOOL_CALL and has functionCall', () => {
      message.type = MessageType.TOOL_CALL;
      message.functionCall = { name: 'testFunc', arguments: '{}' };

      expect(message.isToolCall()).toBe(true);
    });

    it('should return false when type is TOOL_CALL but no calls', () => {
      message.type = MessageType.TOOL_CALL;
      message.toolCalls = [];
      message.functionCall = null;

      expect(message.isToolCall()).toBe(false);
    });
  });

  describe('isToolResult', () => {
    it('should return false for non-result messages', () => {
      expect(message.isToolResult()).toBe(false);
    });

    it('should return true for TOOL_RESULT type', () => {
      message.type = MessageType.TOOL_RESULT;

      expect(message.isToolResult()).toBe(true);
    });

    it('should return true for FUNCTION_RESULT type', () => {
      message.type = MessageType.FUNCTION_RESULT;

      expect(message.isToolResult()).toBe(true);
    });
  });

  describe('hasError', () => {
    it('should return false when status is completed and no error', () => {
      message.error = null;
      expect(message.hasError()).toBe(false);
    });

    it('should return true when status is FAILED', () => {
      message.status = MessageStatus.FAILED;

      expect(message.hasError()).toBe(true);
    });

    it('should return true when error is set', () => {
      message.error = 'API timeout';

      expect(message.hasError()).toBe(true);
    });
  });

  describe('isMultimodal', () => {
    it('should return falsy when no contentParts', () => {
      expect(message.isMultimodal()).toBeFalsy();
    });

    it('should return false when contentParts is empty array', () => {
      message.contentParts = [];

      expect(message.isMultimodal()).toBe(false);
    });

    it('should return true when contentParts has items', () => {
      message.contentParts = [{ type: 'text', text: 'Hello' }];

      expect(message.isMultimodal()).toBe(true);
    });
  });

  describe('getTextContent', () => {
    it('should return content when available', () => {
      expect(message.getTextContent()).toBe('Test message');
    });

    it('should extract text from contentParts', () => {
      message.content = '';
      message.contentParts = [
        { type: 'text', text: 'Part 1' },
        { type: 'image', imageUrl: 'url' },
        { type: 'text', text: 'Part 2' },
      ];

      expect(message.getTextContent()).toBe('Part 1 Part 2');
    });

    it('should return empty string when no content', () => {
      message.content = '';
      message.contentParts = undefined;

      expect(message.getTextContent()).toBe('');
    });
  });

  describe('getImageUrls', () => {
    it('should return empty array when no contentParts', () => {
      expect(message.getImageUrls()).toEqual([]);
    });

    it('should extract image URLs from contentParts', () => {
      message.contentParts = [
        { type: 'text', text: 'Hello' },
        { type: 'image', imageUrl: 'http://example.com/img1.jpg' },
        { type: 'image', imageUrl: 'http://example.com/img2.jpg' },
        { type: 'audio', audioUrl: 'http://example.com/audio.mp3' },
      ];

      const urls = message.getImageUrls();

      expect(urls).toEqual([
        'http://example.com/img1.jpg',
        'http://example.com/img2.jpg',
      ]);
    });

    it('should filter out undefined imageUrls', () => {
      message.contentParts = [
        { type: 'image', imageUrl: 'http://example.com/img.jpg' },
        { type: 'image', imageUrl: undefined },
      ];

      const urls = message.getImageUrls();

      expect(urls).toEqual(['http://example.com/img.jpg']);
    });
  });

  describe('getAudioUrls', () => {
    it('should return empty array when no contentParts', () => {
      expect(message.getAudioUrls()).toEqual([]);
    });

    it('should extract audio URLs from contentParts', () => {
      message.contentParts = [
        { type: 'audio', audioUrl: 'http://example.com/audio1.mp3' },
        { type: 'text', text: 'Hello' },
        { type: 'audio', audioUrl: 'http://example.com/audio2.mp3' },
      ];

      const urls = message.getAudioUrls();

      expect(urls).toEqual([
        'http://example.com/audio1.mp3',
        'http://example.com/audio2.mp3',
      ]);
    });
  });

  describe('getToolCallResults', () => {
    it('should return empty array when no toolCalls', () => {
      expect(message.getToolCallResults()).toEqual([]);
    });

    it('should map tool calls to results', () => {
      message.toolCalls = [
        { id: 'tc-1', name: 'getTool', parameters: {}, result: { data: 'result1' } },
        { id: 'tc-2', name: 'postTool', parameters: {}, result: { data: 'result2' }, error: 'timeout' },
      ];

      const results = message.getToolCallResults();

      expect(results).toEqual([
        { name: 'getTool', result: { data: 'result1' }, error: undefined },
        { name: 'postTool', result: { data: 'result2' }, error: 'timeout' },
      ]);
    });
  });

  describe('updateStatus', () => {
    it('should update status', () => {
      message.updateStatus(MessageStatus.PROCESSING);

      expect(message.status).toBe(MessageStatus.PROCESSING);
    });

    it('should update status and error when error provided', () => {
      message.updateStatus(MessageStatus.FAILED, 'API error');

      expect(message.status).toBe(MessageStatus.FAILED);
      expect(message.error).toBe('API error');
    });

    it('should not set error when not provided', () => {
      message.error = undefined;
      message.updateStatus(MessageStatus.COMPLETED);

      expect(message.status).toBe(MessageStatus.COMPLETED);
      expect(message.error).toBeUndefined();
    });
  });

  describe('addTokenUsage', () => {
    it('should accumulate tokens and cost', () => {
      message.addTokenUsage(5, 10, 25);

      expect(message.inputTokens).toBe(15);
      expect(message.outputTokens).toBe(30);
      expect(message.cost).toBe(75);
    });

    it('should handle multiple additions', () => {
      message.addTokenUsage(1, 2, 3);
      message.addTokenUsage(4, 5, 6);

      expect(message.inputTokens).toBe(15);
      expect(message.outputTokens).toBe(27);
      expect(message.cost).toBe(59);
    });
  });

  describe('setResponseTime', () => {
    it('should calculate response time from start time', () => {
      const startTime = Date.now() - 2500;

      message.setResponseTime(startTime);

      expect(message.responseTime).toBeGreaterThanOrEqual(2500);
      expect(message.responseTime).toBeLessThan(2600);
    });
  });

  describe('updateMetadata', () => {
    it('should merge metadata updates', () => {
      message.metadata = { cached: false, requestId: 'req-1' };

      message.updateMetadata({ cached: true, retryCount: 2 });

      expect(message.metadata).toEqual({
        cached: true,
        requestId: 'req-1',
        retryCount: 2,
      });
    });

    it('should initialize metadata when undefined', () => {
      message.metadata = undefined;

      message.updateMetadata({ requestId: 'req-1' });

      expect(message.metadata).toEqual({ requestId: 'req-1' });
    });
  });

  describe('Static Factory Methods', () => {
    describe('createUserMessage', () => {
      it('should create user message with string content', () => {
        const msg = LlmMessage.createUserMessage('session-1', 'Hello');

        expect(msg.sessionId).toBe('session-1');
        expect(msg.role).toBe(MessageRole.USER);
        expect(msg.type).toBe(MessageType.TEXT);
        expect(msg.status).toBe(MessageStatus.COMPLETED);
        expect(msg.content).toBe('Hello');
      });

      it('should create user message with multimodal content', () => {
        const contentParts: MessageContent[] = [
          { type: 'text', text: 'What is this?' },
          { type: 'image', imageUrl: 'http://example.com/img.jpg' },
        ];

        const msg = LlmMessage.createUserMessage('session-1', contentParts);

        expect(msg.contentParts).toEqual(contentParts);
        expect(msg.content).toBe('What is this?');
      });
    });

    describe('createAssistantMessage', () => {
      it('should create assistant message', () => {
        const msg = LlmMessage.createAssistantMessage('session-1', 'Response');

        expect(msg.sessionId).toBe('session-1');
        expect(msg.role).toBe(MessageRole.ASSISTANT);
        expect(msg.type).toBe(MessageType.TEXT);
        expect(msg.status).toBe(MessageStatus.COMPLETED);
        expect(msg.content).toBe('Response');
      });
    });

    describe('createToolCallMessage', () => {
      it('should create tool call message', () => {
        const toolCalls: ToolCall[] = [
          { id: 'tc-1', name: 'getTool', parameters: { id: '123' } },
        ];

        const msg = LlmMessage.createToolCallMessage('session-1', toolCalls);

        expect(msg.sessionId).toBe('session-1');
        expect(msg.role).toBe(MessageRole.ASSISTANT);
        expect(msg.type).toBe(MessageType.TOOL_CALL);
        expect(msg.status).toBe(MessageStatus.PROCESSING);
        expect(msg.toolCalls).toEqual(toolCalls);
      });
    });

    describe('createToolResultMessage', () => {
      it('should create successful tool result message', () => {
        const result = { data: 'success' };

        const msg = LlmMessage.createToolResultMessage('session-1', 'tc-1', result);

        expect(msg.sessionId).toBe('session-1');
        expect(msg.role).toBe(MessageRole.TOOL);
        expect(msg.type).toBe(MessageType.TOOL_RESULT);
        expect(msg.status).toBe(MessageStatus.COMPLETED);
        expect(msg.toolCallId).toBe('tc-1');
        expect(msg.content).toBe(JSON.stringify(result));
        expect(msg.error).toBeUndefined();
      });

      it('should create failed tool result message', () => {
        const msg = LlmMessage.createToolResultMessage('session-1', 'tc-1', null, 'timeout');

        expect(msg.status).toBe(MessageStatus.FAILED);
        expect(msg.error).toBe('timeout');
      });

      it('should handle string result', () => {
        const msg = LlmMessage.createToolResultMessage('session-1', 'tc-1', 'string result');

        expect(msg.content).toBe('string result');
      });
    });

    describe('createFunctionCallMessage', () => {
      it('should create function call message', () => {
        const functionCall: FunctionCall = {
          name: 'testFunc',
          arguments: '{"param":"value"}',
        };

        const msg = LlmMessage.createFunctionCallMessage('session-1', functionCall);

        expect(msg.sessionId).toBe('session-1');
        expect(msg.role).toBe(MessageRole.ASSISTANT);
        expect(msg.type).toBe(MessageType.FUNCTION_CALL);
        expect(msg.status).toBe(MessageStatus.PROCESSING);
        expect(msg.functionCall).toEqual(functionCall);
      });
    });

    describe('createFunctionResultMessage', () => {
      it('should create successful function result message', () => {
        const msg = LlmMessage.createFunctionResultMessage('session-1', 'testFunc', 'result');

        expect(msg.sessionId).toBe('session-1');
        expect(msg.role).toBe(MessageRole.FUNCTION);
        expect(msg.type).toBe(MessageType.FUNCTION_RESULT);
        expect(msg.status).toBe(MessageStatus.COMPLETED);
        expect(msg.functionName).toBe('testFunc');
        expect(msg.content).toBe('result');
      });

      it('should create failed function result message', () => {
        const msg = LlmMessage.createFunctionResultMessage('session-1', 'testFunc', '', 'error');

        expect(msg.status).toBe(MessageStatus.FAILED);
        expect(msg.error).toBe('error');
      });
    });

    describe('createSystemMessage', () => {
      it('should create system message', () => {
        const msg = LlmMessage.createSystemMessage('session-1', 'System instruction');

        expect(msg.sessionId).toBe('session-1');
        expect(msg.role).toBe(MessageRole.SYSTEM);
        expect(msg.type).toBe(MessageType.TEXT);
        expect(msg.status).toBe(MessageStatus.COMPLETED);
        expect(msg.content).toBe('System instruction');
      });
    });

    describe('createErrorMessage', () => {
      it('should create error message', () => {
        const msg = LlmMessage.createErrorMessage('session-1', 'API timeout');

        expect(msg.sessionId).toBe('session-1');
        expect(msg.role).toBe(MessageRole.ASSISTANT);
        expect(msg.type).toBe(MessageType.ERROR);
        expect(msg.status).toBe(MessageStatus.FAILED);
        expect(msg.error).toBe('API timeout');
        expect(msg.content).toBe('Error: API timeout');
      });
    });
  });

  describe('toOpenAIFormat', () => {
    it('should convert basic message', () => {
      const formatted = message.toOpenAIFormat();

      expect(formatted).toEqual({
        role: MessageRole.ASSISTANT,
        content: 'Test message',
      });
    });

    it('should include tool_calls', () => {
      message.toolCalls = [
        { id: 'tc-1', name: 'getTool', parameters: { id: '123' } },
      ];

      const formatted = message.toOpenAIFormat();

      expect(formatted.tool_calls).toEqual([
        {
          id: 'tc-1',
          type: 'function',
          function: {
            name: 'getTool',
            arguments: '{"id":"123"}',
          },
        },
      ]);
    });

    it('should include function_call', () => {
      message.functionCall = { name: 'testFunc', arguments: '{"key":"value"}' };

      const formatted = message.toOpenAIFormat();

      expect(formatted.function_call).toEqual({
        name: 'testFunc',
        arguments: '{"key":"value"}',
      });
    });

    it('should include tool_call_id', () => {
      message.toolCallId = 'tc-123';

      const formatted = message.toOpenAIFormat();

      expect(formatted.tool_call_id).toBe('tc-123');
    });

    it('should include function name', () => {
      message.functionName = 'myFunction';

      const formatted = message.toOpenAIFormat();

      expect(formatted.name).toBe('myFunction');
    });

    it('should convert contentParts to OpenAI format', () => {
      message.contentParts = [
        { type: 'text', text: 'Hello' },
        { type: 'image', imageUrl: 'http://example.com/img.jpg' },
      ];

      const formatted = message.toOpenAIFormat();

      expect(formatted.content).toEqual([
        { type: 'text', text: 'Hello' },
        { type: 'image_url', image_url: { url: 'http://example.com/img.jpg' } },
      ]);
    });
  });

  describe('toAnthropicFormat', () => {
    it('should convert assistant message', () => {
      const formatted = message.toAnthropicFormat();

      expect(formatted).toEqual({
        role: 'assistant',
        content: 'Test message',
      });
    });

    it('should convert user message', () => {
      message.role = MessageRole.USER;

      const formatted = message.toAnthropicFormat();

      expect(formatted.role).toBe('user');
    });

    it('should convert contentParts to Anthropic format', () => {
      message.contentParts = [
        { type: 'text', text: 'Hello' },
        { type: 'image', imageUrl: 'base64data', mimeType: 'image/png' },
      ];

      const formatted = message.toAnthropicFormat();

      expect(formatted.content).toEqual([
        { type: 'text', text: 'Hello' },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'base64data',
          },
        },
      ]);
    });
  });

  describe('getCostInDollars', () => {
    it('should convert cents to dollars', () => {
      message.cost = 150;

      expect(message.getCostInDollars()).toBe(1.5);
    });

    it('should handle zero cost', () => {
      message.cost = 0;

      expect(message.getCostInDollars()).toBe(0);
    });
  });

  describe('getCostPerToken', () => {
    it('should calculate cost per token', () => {
      message.cost = 30;
      message.inputTokens = 10;
      message.outputTokens = 20;

      expect(message.getCostPerToken()).toBe(1);
    });

    it('should return 0 when no tokens', () => {
      message.inputTokens = 0;
      message.outputTokens = 0;

      expect(message.getCostPerToken()).toBe(0);
    });
  });

  describe('getTokensPerSecond', () => {
    it('should calculate tokens per second', () => {
      message.inputTokens = 15;
      message.outputTokens = 15;
      message.responseTime = 1000; // 1 second

      expect(message.getTokensPerSecond()).toBe(30);
    });

    it('should return 0 when no response time', () => {
      message.responseTime = 0;

      expect(message.getTokensPerSecond()).toBe(0);
    });

    it('should return 0 when response time is undefined', () => {
      message.responseTime = undefined;

      expect(message.getTokensPerSecond()).toBe(0);
    });
  });

  describe('getProcessingEfficiency', () => {
    it('should categorize as fast', () => {
      message.responseTime = 1500;

      const efficiency = message.getProcessingEfficiency();

      expect(efficiency.responseTimeCategory).toBe('fast');
    });

    it('should categorize as medium', () => {
      message.responseTime = 3000;

      const efficiency = message.getProcessingEfficiency();

      expect(efficiency.responseTimeCategory).toBe('medium');
    });

    it('should categorize as slow', () => {
      message.responseTime = 7000;

      const efficiency = message.getProcessingEfficiency();

      expect(efficiency.responseTimeCategory).toBe('slow');
    });

    it('should categorize as very_slow', () => {
      message.responseTime = 15000;

      const efficiency = message.getProcessingEfficiency();

      expect(efficiency.responseTimeCategory).toBe('very_slow');
    });

    it('should include rounded metrics', () => {
      message.inputTokens = 10;
      message.outputTokens = 20;
      message.cost = 33;
      message.responseTime = 1000;

      const efficiency = message.getProcessingEfficiency();

      expect(efficiency.tokensPerSecond).toBe(30);
      expect(efficiency.costPerToken).toBe(1.1);
    });
  });
});
