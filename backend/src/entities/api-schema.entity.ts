import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  BeforeInsert,
  BeforeUpdate,
  Index,
} from 'typeorm';
import { Api } from './api.entity';
import { JsonSchema } from './json-schema.entity';
import * as crypto from 'crypto';

export enum SchemaFormat {
  JSON = 'json',
  YAML = 'yaml',
  XML = 'xml',
  PROTOBUF = 'protobuf',
  SDL = 'sdl', // GraphQL Schema Definition Language
}

@Entity('api_schemas')
@Index(['apiId'])
@Index(['apiId', 'version'])
export class ApiSchema {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  apiId: string;

  @Column({ type: 'text' })
  rawSchema: string;

  // `processedSchema` (the parsed-result JSON column) was removed
  // — it duplicated structural data already in operations/resources
  // and bloated each schema row by 8-15 MB on big imports for a
  // "pretty view" the UI calls maybe once per API. Callers that
  // want a parsed view now hit GET /apis/:id/schemas/:schemaId/parsed
  // which runs the parser on demand against rawSchema.

  @Column()
  schemaHash: string;

  @Column({ default: '1.0.0' })
  version: string;

  @Column({
    type: 'varchar',
    default: SchemaFormat.JSON,
  })
  format: SchemaFormat;

  @Column({ nullable: true })
  fileName: string;

  @Column({ nullable: true })
  fileSize: number;

  @Column({ type: 'json', nullable: true })
  validationResults: {
    isValid: boolean;
    errors: Array<{
      path: string;
      message: string;
      severity: 'error' | 'warning';
    }>;
    warnings: Array<{
      path: string;
      message: string;
    }>;
  };

  @Column({ type: 'json', nullable: true })
  statistics: {
    operationCount?: number;
    resourceCount?: number;
    endpointCount?: number;
    methodCounts?: Record<string, number>;
  };

  @Column({ type: 'json', nullable: true })
  metadata: Record<string, any>;

  @CreateDateColumn()
  createdAt: Date;

  @ManyToOne(() => Api, api => api.schemas, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'apiId' })
  api: Api;

  @OneToMany(() => JsonSchema, jsonSchema => jsonSchema.sourceSchema, {
    cascade: true,
  })
  jsonSchemas: JsonSchema[];

  @BeforeInsert()
  @BeforeUpdate()
  generateHash() {
    if (this.rawSchema) {
      this.schemaHash = crypto
        .createHash('sha256')
        .update(this.rawSchema)
        .digest('hex');
    }
  }

  // Methods
  isValid(): boolean {
    return this.validationResults?.isValid ?? false;
  }

  hasWarnings(): boolean {
    return (this.validationResults?.warnings?.length || 0) > 0;
  }

  hasErrors(): boolean {
    return (this.validationResults?.errors?.length || 0) > 0;
  }

  getCriticalErrors(): Array<any> {
    return this.validationResults?.errors?.filter(e => e.severity === 'error') || [];
  }

  getOperationCount(): number {
    return this.statistics?.operationCount || 0;
  }

  hasChanged(newRawSchema: string): boolean {
    const newHash = crypto.createHash('sha256').update(newRawSchema).digest('hex');
    return this.schemaHash !== newHash;
  }
}