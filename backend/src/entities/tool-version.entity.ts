import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Tool } from './tool.entity';

@Entity('tool_versions')
export class ToolVersion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  toolId: string;

  @Column()
  version: string;

  @Column({ type: 'json' })
  definition: Record<string, any>; // Complete tool definition at this version

  @Column({ type: 'json', nullable: true })
  parameters: Record<string, any>; // Parameters schema at this version

  @Column({ type: 'text', nullable: true })
  changelog: string;

  @Column({ type: 'json', nullable: true })
  metadata: Record<string, any>;

  @Column({ default: false })
  isBreakingChange: boolean;

  @Column({ nullable: true })
  createdBy: string;

  @CreateDateColumn()
  createdAt: Date;

  @ManyToOne(() => Tool, tool => tool.versions, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'toolId' })
  tool: Tool;

  // Methods
  compareWith(otherVersion: ToolVersion): {
    isCompatible: boolean;
    changes: Array<{
      type: 'added' | 'removed' | 'modified';
      field: string;
      description: string;
    }>;
  } {
    const changes: Array<any> = [];
    
    // Compare parameters
    const currentParams = this.parameters?.properties || {};
    const otherParams = otherVersion.parameters?.properties || {};
    
    // Check for removed parameters
    for (const param in otherParams) {
      if (!(param in currentParams)) {
        changes.push({
          type: 'removed',
          field: `parameter.${param}`,
          description: `Parameter '${param}' was removed`,
        });
      }
    }
    
    // Check for added parameters
    for (const param in currentParams) {
      if (!(param in otherParams)) {
        changes.push({
          type: 'added',
          field: `parameter.${param}`,
          description: `Parameter '${param}' was added`,
        });
      } else if (JSON.stringify(currentParams[param]) !== JSON.stringify(otherParams[param])) {
        changes.push({
          type: 'modified',
          field: `parameter.${param}`,
          description: `Parameter '${param}' was modified`,
        });
      }
    }

    // Check if changes are breaking
    const hasBreakingChanges = changes.some(change => 
      change.type === 'removed' || 
      (change.type === 'modified' && change.field.includes('required'))
    );

    return {
      isCompatible: !hasBreakingChanges,
      changes,
    };
  }

  isNewerThan(otherVersion: string): boolean {
    const [major1, minor1, patch1] = this.version.split('.').map(Number);
    const [major2, minor2, patch2] = otherVersion.split('.').map(Number);

    if (major1 !== major2) return major1 > major2;
    if (minor1 !== minor2) return minor1 > minor2;
    return patch1 > patch2;
  }
}