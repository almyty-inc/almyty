import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  JoinColumn,
  ManyToOne,
  ManyToMany,
  TreeParent,
  TreeChildren,
  Tree,
  Index,
  Unique,
} from 'typeorm';
import { Tool } from './tool.entity';
import { Organization } from './organization.entity';

@Entity('tool_categories')
@Tree('closure-table')
@Index('IDX_tool_categories_organizationId', ['organizationId'])
@Unique('UQ_tool_categories_org_slug', ['organizationId', 'slug'])
export class ToolCategory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ nullable: true })
  description: string;

  // Unique per organization, not per install — see
  // `@Unique` above. A globally unique slug means the first tenant to
  // take "web" takes it from everyone else.
  @Column()
  slug: string;

  @Column({ type: 'uuid' })
  organizationId: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;

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