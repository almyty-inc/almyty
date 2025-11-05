import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  BeforeInsert,
  BeforeUpdate,
} from 'typeorm';
import { ApiSchema } from './api-schema.entity';
import { Tool } from './tool.entity';
import * as crypto from 'crypto';

export enum JsonSchemaType {
  INPUT = 'input',
  OUTPUT = 'output',
  PARAMETER = 'parameter',
  RESOURCE = 'resource',
}

@Entity('json_schemas')
export class JsonSchema {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ type: 'json' })
  schema: Record<string, any>; // JSON Schema definition

  @Column()
  schemaHash: string;

  @Column({ nullable: true })
  description: string;

  @Column({
    type: 'varchar',
    default: JsonSchemaType.PARAMETER,
  })
  type: JsonSchemaType;

  @Column({ nullable: true })
  sourceSchemaId: string;

  @Column({ default: '1.0.0' })
  version: string;

  @Column({ type: 'json', nullable: true })
  examples: any[];

  @Column({ type: 'json', nullable: true })
  validationRules: Record<string, any>;

  @Column({ type: 'json', nullable: true })
  metadata: Record<string, any>;

  @Column({ default: true })
  isActive: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => ApiSchema, apiSchema => apiSchema.jsonSchemas, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'sourceSchemaId' })
  sourceSchema: ApiSchema;

  @OneToMany(() => Tool, tool => tool.inputSchema)
  toolsUsingAsInput: Tool[];

  @OneToMany(() => Tool, tool => tool.outputSchema)
  toolsUsingAsOutput: Tool[];

  @BeforeInsert()
  @BeforeUpdate()
  generateHash() {
    if (this.schema) {
      this.schemaHash = crypto
        .createHash('sha256')
        .update(JSON.stringify(this.schema))
        .digest('hex');
    }
  }

  // Methods
  validate(data: any): { isValid: boolean; errors: string[] } {
    // This would use a JSON Schema validator like ajv
    // For now, simplified validation
    try {
      // Basic type checking based on schema
      const errors: string[] = [];
      
      if (this.schema.type === 'object' && typeof data !== 'object') {
        errors.push(`Expected object, got ${typeof data}`);
      }
      
      if (this.schema.required && Array.isArray(this.schema.required)) {
        for (const field of this.schema.required) {
          if (!(field in data)) {
            errors.push(`Missing required field: ${field}`);
          }
        }
      }

      return {
        isValid: errors.length === 0,
        errors,
      };
    } catch (error) {
      return {
        isValid: false,
        errors: [`Validation error: ${error.message}`],
      };
    }
  }

  getRequiredFields(): string[] {
    return this.schema.required || [];
  }

  getOptionalFields(): string[] {
    if (!this.schema.properties) return [];
    
    const allFields = Object.keys(this.schema.properties);
    const required = this.getRequiredFields();
    return allFields.filter(field => !required.includes(field));
  }

  hasField(fieldName: string): boolean {
    return this.schema.properties && fieldName in this.schema.properties;
  }
}