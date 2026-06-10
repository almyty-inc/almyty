import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Gateway } from './gateway.entity';

export enum GatewayAuthType {
  NONE = 'none',
  API_KEY = 'api_key',
  BEARER_TOKEN = 'bearer_token',
  BASIC_AUTH = 'basic_auth',
  OAUTH2 = 'oauth2',
  JWT = 'jwt',
  CUSTOM = 'custom',
}

@Entity('gateway_auth')
export class GatewayAuth {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  gatewayId: string;

  @Column({
    type: 'varchar',
    default: GatewayAuthType.API_KEY,
  })
  type: GatewayAuthType;

  @Column({ default: true })
  isRequired: boolean;

  @Column({ default: true })
  isActive: boolean;

  @Column({ type: 'json' })
  configuration: Record<string, any>;

  @Column({ type: 'json', nullable: true })
  validationRules: {
    keyFormat?: string; // Regex pattern
    minKeyLength?: number;
    maxKeyLength?: number;
    allowedIpRanges?: string[];
    requiredHeaders?: string[];
    rateLimiting?: {
      enabled: boolean;
      requestsPerMinute?: number;
      requestsPerHour?: number;
    };
  };

  @Column({ type: 'json', nullable: true })
  errorResponses: {
    unauthorized?: {
      code: number;
      message: string;
      details?: Record<string, any>;
    };
    forbidden?: {
      code: number;
      message: string;
      details?: Record<string, any>;
    };
    invalid?: {
      code: number;
      message: string;
      details?: Record<string, any>;
    };
  };

  @Column({ type: 'json', nullable: true })
  metadata: Record<string, any>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Gateway, gateway => gateway.authConfigs, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'gatewayId' })
  gateway: Gateway;
}