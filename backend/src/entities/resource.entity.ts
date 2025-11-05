import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
import { Api } from './api.entity';
import { Operation } from './operation.entity';

interface PropertyDefinition {
  name: string;
  description?: string;
  type: Record<string, any>; // JSON Schema type definition
  defaultValue?: any;
  required: boolean;
  nullable: boolean;
  format?: string;
  enum?: any[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  items?: PropertyDefinition; // For array types
  properties?: Record<string, PropertyDefinition>; // For object types
}

export enum ResourceType {
  MODEL = 'model',
  ENUM = 'enum',
  INPUT = 'input',
  OUTPUT = 'output',
  INTERFACE = 'interface',
}

@Entity('resources')
export class Resource {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ nullable: true })
  description: string;

  @Column()
  apiId: string;

  @Column({
    type: 'varchar',
    default: 'model',
  })
  type: ResourceType;

  @Column({ type: 'json', nullable: true })
  properties: Record<string, PropertyDefinition>;

  @Column({ type: 'json', nullable: true })
  schema: Record<string, any>; // Full JSON Schema representation

  @Column({ type: 'json', nullable: true })
  examples: any[];

  @Column({ type: 'json', nullable: true })
  validationRules: Record<string, any>;

  @Column({ type: 'json', nullable: true })
  relationships: Array<{
    type: 'oneToOne' | 'oneToMany' | 'manyToOne' | 'manyToMany';
    target: string;
    foreignKey?: string;
    description?: string;
  }>;

  @Column({ type: 'json', nullable: true })
  metadata: Record<string, any>;

  @Column({ default: true })
  isActive: boolean;

  @Column({ default: false })
  deprecated: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Api, api => api.resources, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'apiId' })
  api: Api;

  @OneToMany(() => Operation, operation => operation.resource)
  operations: Operation[];

  // Methods
  getRequiredProperties(): string[] {
    if (!this.properties) return [];
    
    return Object.entries(this.properties)
      .filter(([_, prop]) => prop.required)
      .map(([name, _]) => name);
  }

  getOptionalProperties(): string[] {
    if (!this.properties) return [];
    
    return Object.entries(this.properties)
      .filter(([_, prop]) => !prop.required)
      .map(([name, _]) => name);
  }

  hasProperty(propertyName: string): boolean {
    return this.properties && propertyName in this.properties;
  }

  getProperty(propertyName: string): PropertyDefinition | undefined {
    return this.properties?.[propertyName];
  }

  getPropertyType(propertyName: string): string | undefined {
    const property = this.getProperty(propertyName);
    return property?.type?.type;
  }

  validate(data: any): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!data || typeof data !== 'object') {
      errors.push('Data must be an object');
      return { isValid: false, errors };
    }

    // Check required properties
    const requiredProps = this.getRequiredProperties();
    for (const prop of requiredProps) {
      if (!(prop in data)) {
        errors.push(`Missing required property: ${prop}`);
      }
    }

    // Validate property types (basic validation)
    if (this.properties) {
      for (const [propName, propDef] of Object.entries(this.properties)) {
        if (propName in data) {
          const value = data[propName];
          const expectedType = propDef.type.type;

          if (value !== null && typeof value !== expectedType) {
            errors.push(`Property ${propName} should be ${expectedType}, got ${typeof value}`);
          }
        }
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  toJsonSchema(): Record<string, any> {
    if (this.schema) return this.schema;

    const jsonSchema: any = {
      type: 'object',
      title: this.name,
      description: this.description,
      properties: {},
      required: this.getRequiredProperties(),
    };

    if (this.properties) {
      for (const [name, prop] of Object.entries(this.properties)) {
        jsonSchema.properties[name] = {
          ...prop.type,
          description: prop.description,
        };
      }
    }

    return jsonSchema;
  }
}