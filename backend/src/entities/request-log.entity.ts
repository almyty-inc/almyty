import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Gateway } from './gateway.entity';
import { Tool } from './tool.entity';
import { User } from './user.entity';

@Entity('request_logs')
@Index(['timestamp'])
@Index(['gatewayId', 'timestamp'])
@Index(['statusCode'])
export class RequestLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  method: string;

  @Column()
  path: string;

  @Column({ nullable: true })
  userAgent: string;

  @Column({ nullable: true })
  ipAddress: string;

  @Column()
  statusCode: number;

  @Column()
  responseTime: number; // in milliseconds

  @Column({ nullable: true })
  gatewayId: string;

  @Column({ nullable: true })
  toolId: string;

  @Column({ nullable: true })
  userId: string;

  @Column({ type: 'json', nullable: true })
  requestHeaders: Record<string, any>;

  @Column({ type: 'json', nullable: true })
  responseHeaders: Record<string, any>;

  @Column({ type: 'text', nullable: true })
  requestBody: string;

  @Column({ type: 'text', nullable: true })
  responseBody: string;

  @Column({ nullable: true })
  errorMessage: string;

  @Column({ nullable: true })
  requestId: string;

  @Column({ default: 0 })
  requestSize: number; // in bytes

  @Column({ default: 0 })
  responseSize: number; // in bytes

  @Column({ type: 'json', nullable: true })
  metadata: Record<string, any>;

  @Column({ type: 'timestamp' })
  timestamp: Date;

  @CreateDateColumn()
  createdAt: Date;

  @ManyToOne(() => Gateway, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'gatewayId' })
  gateway: Gateway;

  @ManyToOne(() => Tool, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'toolId' })
  tool: Tool;

  @ManyToOne(() => User, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'userId' })
  user: User;

  // Methods
  isSuccess(): boolean {
    return this.statusCode >= 200 && this.statusCode < 300;
  }

  isClientError(): boolean {
    return this.statusCode >= 400 && this.statusCode < 500;
  }

  isServerError(): boolean {
    return this.statusCode >= 500;
  }

  getResponseTimeCategory(): 'fast' | 'medium' | 'slow' | 'very_slow' {
    if (this.responseTime < 200) return 'fast';
    if (this.responseTime < 1000) return 'medium';
    if (this.responseTime < 5000) return 'slow';
    return 'very_slow';
  }

  getSizeCategory(): 'small' | 'medium' | 'large' | 'very_large' {
    const totalSize = this.requestSize + this.responseSize;
    if (totalSize < 1024) return 'small'; // < 1KB
    if (totalSize < 10240) return 'medium'; // < 10KB
    if (totalSize < 102400) return 'large'; // < 100KB
    return 'very_large';
  }

  getFullUrl(baseUrl: string): string {
    return `${baseUrl}${this.path}`;
  }

  sanitizeForStorage(): void {
    // Remove sensitive data before storing
    if (this.requestHeaders) {
      delete this.requestHeaders.authorization;
      delete this.requestHeaders.Authorization;
      delete this.requestHeaders['x-api-key'];
      delete this.requestHeaders['X-API-Key'];
    }

    // Truncate large bodies
    const maxBodySize = 10000; // 10KB
    
    if (this.requestBody && this.requestBody.length > maxBodySize) {
      this.requestBody = this.requestBody.substring(0, maxBodySize) + '... [truncated]';
    }
    
    if (this.responseBody && this.responseBody.length > maxBodySize) {
      this.responseBody = this.responseBody.substring(0, maxBodySize) + '... [truncated]';
    }
  }

  static fromHttpRequest(request: any, response: any, startTime: number): RequestLog {
    const log = new RequestLog();
    log.method = request.method;
    log.path = request.path;
    log.userAgent = request.headers['user-agent'];
    log.ipAddress = request.ip || request.connection.remoteAddress;
    log.statusCode = response.statusCode;
    log.responseTime = Date.now() - startTime;
    log.requestHeaders = { ...request.headers };
    log.responseHeaders = response.getHeaders ? response.getHeaders() : {};
    log.requestBody = JSON.stringify(request.body);
    log.requestId = request.id;
    log.timestamp = new Date();
    
    // Calculate sizes
    log.requestSize = Buffer.byteLength(log.requestBody || '', 'utf8');
    log.responseSize = Buffer.byteLength(response.body || '', 'utf8');
    
    log.sanitizeForStorage();
    
    return log;
  }
}