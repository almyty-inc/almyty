import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToMany,
  TreeParent,
  TreeChildren,
  Tree,
} from 'typeorm';
import { Tool } from './tool.entity';

@Entity('tool_categories')
@Tree('closure-table')
export class ToolCategory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ nullable: true })
  description: string;

  @Column({ unique: true })
  slug: string;

  @Column()
  organizationId: string;

  @Column({ nullable: true })
  icon: string; // Icon name or URL

  @Column({ nullable: true })
  color: string; // Hex color code

  @Column({ default: 0 })
  sortOrder: number;

  @Column({ default: true })
  isActive: boolean;

  @Column({ type: 'json', nullable: true })
  metadata: Record<string, any>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @TreeParent()
  parent: ToolCategory;

  @TreeChildren()
  children: ToolCategory[];

  @ManyToMany(() => Tool, tool => tool.categories)
  tools: Tool[];

  // Methods
  getFullPath(): string {
    const path: string[] = [];
    let current: ToolCategory = this;
    
    while (current) {
      path.unshift(current.name);
      current = current.parent;
    }
    
    return path.join(' > ');
  }

  isChildOf(category: ToolCategory): boolean {
    let current = this.parent;
    
    while (current) {
      if (current.id === category.id) {
        return true;
      }
      current = current.parent;
    }
    
    return false;
  }

  getDepth(): number {
    let depth = 0;
    let current = this.parent;
    
    while (current) {
      depth++;
      current = current.parent;
    }
    
    return depth;
  }

  hasTools(): boolean {
    return this.tools && this.tools.length > 0;
  }
}