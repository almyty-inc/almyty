import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Conversation } from './conversation.entity';

export enum MessageRole {
  SYSTEM = 'system',
  USER = 'user',
  ASSISTANT = 'assistant',
  TOOL = 'tool',
  FUNCTION = 'function',
}

export enum MessageType {
  TEXT = 'text',
  TOOL_CALL = 'tool_call',
  TOOL_RESULT = 'tool_result',
  FUNCTION_CALL = 'function_call',
  FUNCTION_RESULT = 'function_result',
  IMAGE = 'image',
  AUDIO = 'audio',
  ERROR = 'error',
}

export enum MessageStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export interface ToolCall {
  id: string;
  name: string;
  parameters: Record<string, any>;
  result?: any;
  error?: string;
  executionTime?: number;
  cached?: boolean;
}

export interface FunctionCall {
  name: string;
  arguments: string;
  result?: string;
  error?: string;
}

export interface MessageContent {
  type: 'text' | 'image' | 'audio';
  text?: string;
  imageUrl?: string;
  audioUrl?: string;
  mimeType?: string;
  size?: number;
}

@Entity('messages')
@Index(['conversationId', 'createdAt'])
@Index(['role', 'type'])
@Index(['status', 'createdAt'])
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  conversationId: string;

  @Column({ nullable: true })
  runId: string;

  @Column({
    type: 'varchar',
  })
  role: MessageRole;

  @Column({
    type: 'varchar',
    default: MessageType.TEXT,
  })
  type: MessageType;

  @Column({
    type: 'varchar',
    default: MessageStatus.COMPLETED,
  })
  status: MessageStatus;

  @Column({ type: 'text', nullable: true })
  content: string;

  @Column({ type: 'json', nullable: true })
  contentParts: MessageContent[];

  @Column({ type: 'json', nullable: true })
  toolCalls: ToolCall[];

  @Column({ type: 'json', nullable: true })
  functionCall: FunctionCall;

  @Column({ nullable: true })
  toolCallId: string;

  @Column({ nullable: true })
  functionName: string;

  @Column({ default: 0 })
  inputTokens: number;

  @Column({ default: 0 })
  outputTokens: number;

  @Column({ type: 'float', default: 0 })
  cost: number;

  @Column({ nullable: true })
  responseTime: number;

  @Column({ nullable: true })
  model: string;

  @Column({ type: 'json', nullable: true })
  parameters: {
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    topK?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    stopSequences?: string[];
  };

  @Column({ nullable: true })
  finishReason: string;

  @Column({ nullable: true })
  error: string;

  @Column({ nullable: true })
  externalMessageId: string;

  @Column({ type: 'json', nullable: true })
  parts: any[];

  @Column({ type: 'json', nullable: true })
  metadata: {
    messageId?: string;
    requestId?: string;
    cached?: boolean;
    streamed?: boolean;
    retryCount?: number;
    processingTime?: number;
    queueTime?: number;
    providerMetadata?: Record<string, any>;
  };

  @CreateDateColumn()
  createdAt: Date;

  @ManyToOne(() => Conversation, conversation => conversation.messages, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'conversationId' })
  conversation: Conversation;

  // Methods
  getTotalTokens(): number {
    return this.inputTokens + this.outputTokens;
  }

  isToolCall(): boolean {
    return this.type === MessageType.TOOL_CALL && (this.toolCalls?.length > 0 || this.functionCall !== null);
  }

  isToolResult(): boolean {
    return this.type === MessageType.TOOL_RESULT || this.type === MessageType.FUNCTION_RESULT;
  }

  hasError(): boolean {
    return this.status === MessageStatus.FAILED || this.error !== null;
  }

  isMultimodal(): boolean {
    return this.contentParts && this.contentParts.length > 0;
  }

  getTextContent(): string {
    if (this.content) {
      return this.content;
    }

    if (this.contentParts) {
      return this.contentParts
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .join(' ');
    }

    return '';
  }

  getImageUrls(): string[] {
    if (!this.contentParts) return [];

    return this.contentParts
      .filter(part => part.type === 'image')
      .map(part => part.imageUrl)
      .filter(Boolean);
  }

  getAudioUrls(): string[] {
    if (!this.contentParts) return [];

    return this.contentParts
      .filter(part => part.type === 'audio')
      .map(part => part.audioUrl)
      .filter(Boolean);
  }

  getToolCallResults(): Array<{ name: string; result: any; error?: string }> {
    if (!this.toolCalls) return [];

    return this.toolCalls.map(call => ({
      name: call.name,
      result: call.result,
      error: call.error,
    }));
  }

  updateStatus(status: MessageStatus, error?: string): void {
    this.status = status;
    if (error) {
      this.error = error;
    }
  }

  addTokenUsage(inputTokens: number, outputTokens: number, cost: number): void {
    this.inputTokens += inputTokens;
    this.outputTokens += outputTokens;
    this.cost += cost;
  }

  setResponseTime(startTime: number): void {
    this.responseTime = Date.now() - startTime;
  }

  updateMetadata(updates: Partial<Message['metadata']>): void {
    this.metadata = {
      ...this.metadata,
      ...updates,
    };
  }

  // Factory methods
  static createUserMessage(conversationId: string, content: string | MessageContent[]): Message {
    const message = new Message();
    message.conversationId = conversationId;
    message.role = MessageRole.USER;
    message.type = MessageType.TEXT;
    message.status = MessageStatus.COMPLETED;

    if (typeof content === 'string') {
      message.content = content;
    } else {
      message.contentParts = content;
      message.content = content
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .join(' ');
    }

    return message;
  }

  static createAssistantMessage(conversationId: string, content: string): Message {
    const message = new Message();
    message.conversationId = conversationId;
    message.role = MessageRole.ASSISTANT;
    message.type = MessageType.TEXT;
    message.status = MessageStatus.COMPLETED;
    message.content = content;
    return message;
  }

  static createToolCallMessage(conversationId: string, toolCalls: ToolCall[]): Message {
    const message = new Message();
    message.conversationId = conversationId;
    message.role = MessageRole.ASSISTANT;
    message.type = MessageType.TOOL_CALL;
    message.status = MessageStatus.PROCESSING;
    message.toolCalls = toolCalls;
    return message;
  }

  static createToolResultMessage(conversationId: string, toolCallId: string, result: any, error?: string): Message {
    const message = new Message();
    message.conversationId = conversationId;
    message.role = MessageRole.TOOL;
    message.type = MessageType.TOOL_RESULT;
    message.status = error ? MessageStatus.FAILED : MessageStatus.COMPLETED;
    message.toolCallId = toolCallId;
    message.content = typeof result === 'string' ? result : JSON.stringify(result);
    message.error = error;
    return message;
  }

  static createFunctionCallMessage(conversationId: string, functionCall: FunctionCall): Message {
    const message = new Message();
    message.conversationId = conversationId;
    message.role = MessageRole.ASSISTANT;
    message.type = MessageType.FUNCTION_CALL;
    message.status = MessageStatus.PROCESSING;
    message.functionCall = functionCall;
    return message;
  }

  static createFunctionResultMessage(conversationId: string, functionName: string, result: string, error?: string): Message {
    const message = new Message();
    message.conversationId = conversationId;
    message.role = MessageRole.FUNCTION;
    message.type = MessageType.FUNCTION_RESULT;
    message.status = error ? MessageStatus.FAILED : MessageStatus.COMPLETED;
    message.functionName = functionName;
    message.content = result;
    message.error = error;
    return message;
  }

  static createSystemMessage(conversationId: string, content: string): Message {
    const message = new Message();
    message.conversationId = conversationId;
    message.role = MessageRole.SYSTEM;
    message.type = MessageType.TEXT;
    message.status = MessageStatus.COMPLETED;
    message.content = content;
    return message;
  }

  static createErrorMessage(conversationId: string, error: string): Message {
    const message = new Message();
    message.conversationId = conversationId;
    message.role = MessageRole.ASSISTANT;
    message.type = MessageType.ERROR;
    message.status = MessageStatus.FAILED;
    message.error = error;
    message.content = `Error: ${error}`;
    return message;
  }

  // Conversion methods for different LLM provider formats
  toOpenAIFormat(): any {
    const message: any = {
      role: this.role,
      content: this.content,
    };

    if (this.toolCalls && this.toolCalls.length > 0) {
      message.tool_calls = this.toolCalls.map(call => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          arguments: JSON.stringify(call.parameters),
        },
      }));
    }

    if (this.functionCall) {
      message.function_call = {
        name: this.functionCall.name,
        arguments: this.functionCall.arguments,
      };
    }

    if (this.toolCallId) {
      message.tool_call_id = this.toolCallId;
    }

    if (this.functionName) {
      message.name = this.functionName;
    }

    if (this.contentParts && this.contentParts.length > 0) {
      message.content = this.contentParts.map(part => {
        if (part.type === 'text') {
          return { type: 'text', text: part.text };
        } else if (part.type === 'image') {
          return {
            type: 'image_url',
            image_url: { url: part.imageUrl },
          };
        }
        return part;
      });
    }

    return message;
  }

  toAnthropicFormat(): any {
    const message: any = {
      role: this.role === MessageRole.ASSISTANT ? 'assistant' : 'user',
      content: this.content,
    };

    if (this.contentParts && this.contentParts.length > 0) {
      message.content = this.contentParts.map(part => {
        if (part.type === 'text') {
          return { type: 'text', text: part.text };
        } else if (part.type === 'image') {
          return {
            type: 'image',
            source: {
              type: 'base64',
              media_type: part.mimeType || 'image/jpeg',
              data: part.imageUrl,
            },
          };
        }
        return part;
      });
    }

    return message;
  }

  getCostInDollars(): number {
    return this.cost / 100;
  }

  getCostPerToken(): number {
    const totalTokens = this.getTotalTokens();
    return totalTokens > 0 ? this.cost / totalTokens : 0;
  }

  getTokensPerSecond(): number {
    if (!this.responseTime || this.responseTime === 0) return 0;
    return (this.getTotalTokens() / this.responseTime) * 1000;
  }

  getProcessingEfficiency(): {
    tokensPerSecond: number;
    costPerToken: number;
    responseTimeCategory: 'fast' | 'medium' | 'slow' | 'very_slow';
  } {
    const tokensPerSecond = this.getTokensPerSecond();
    const costPerToken = this.getCostPerToken();

    let responseTimeCategory: 'fast' | 'medium' | 'slow' | 'very_slow' = 'fast';
    if (this.responseTime) {
      if (this.responseTime > 10000) responseTimeCategory = 'very_slow';
      else if (this.responseTime > 5000) responseTimeCategory = 'slow';
      else if (this.responseTime > 2000) responseTimeCategory = 'medium';
    }

    return {
      tokensPerSecond: Math.round(tokensPerSecond * 100) / 100,
      costPerToken: Math.round(costPerToken * 10000) / 10000,
      responseTimeCategory,
    };
  }
}
