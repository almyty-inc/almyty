import {
  Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn, Index, Unique,
} from 'typeorm';

import { Organization } from './organization.entity';

/**
 * An execution shape over role slots.
 *
 * A strategy says how work is done: one call, a cascade from cheap to
 * dear, several candidates and a judge, explore then extract then patch.
 * It says nothing about which model does it, because that is the role's
 * job and mixing the two is what makes an agent impossible to move
 * between models.
 *
 * L5 in docs/design/layers.md. Depends on L4 only.
 *
 * **A strategy must never name a concrete model.** Not as a convention:
 * `strategyModelViolations()` rejects it and a test asserts no seeded row
 * contains one. If a strategy row carries a model id, the layering is
 * broken and every strategy silently becomes vendor-specific.
 */

/** The node kinds a strategy may compile to. All of them already exist in the engine. */
export const STRATEGY_STEP_KINDS = ['call', 'extract_context', 'verify', 'merge', 'parallel'] as const;
export type StrategyStepKind = (typeof STRATEGY_STEP_KINDS)[number];

export interface StrategyStep {
  id: string;
  kind: StrategyStepKind;
  /** Which role slot performs this step. Absent for pure structure (parallel, merge). */
  roleSlot?: string;
  /** Step-kind parameters: merge strategy, candidate count, thresholds. Never a model. */
  params?: Record<string, unknown>;
  /** Step ids this one feeds. */
  next?: string[];
}

export interface StrategyShape {
  entry: string;
  steps: StrategyStep[];
}

@Entity('strategies')
@Index(['organizationId'])
@Unique(['organizationId', 'key'])
export class Strategy {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Null for a built-in seed, which every organization can use and none can edit. */
  @Column({ nullable: true, type: 'uuid' })
  organizationId: string | null;

  @Column({ length: 64 })
  key: string;

  @Column({ length: 128 })
  displayName: string;

  @Column({ type: 'text', default: '' })
  description: string;

  /** The role slots this shape needs filled, by key. */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  roleSlots: string[];

  @Column({ type: 'jsonb' })
  shape: StrategyShape;

  /** Seeded strategies are read-only; an organization copies one to change it. */
  @Column({ default: false })
  builtIn: boolean;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

/**
 * Anything that looks like a concrete model hiding in a strategy.
 *
 * Deliberately broad and a little paranoid: the failure this prevents is
 * silent, and a false positive costs someone a rename while a false
 * negative costs the whole layering. Returns one message per violation,
 * empty when the strategy is clean.
 */
const MODEL_KEYS = ['model', 'modelid', 'modelname', 'vendormodelid', 'providerid', 'provider', 'pinnedmodel', 'deployment'];
const MODEL_SHAPED = /^(gpt|claude|gemini|llama|qwen|mistral|deepseek|kimi|glm|palmyra|solar|grok|command|phi|nemotron|jamba|minimax|doubao|ernie|hunyuan|spark)[-._a-z0-9]*$/i;

export function strategyModelViolations(strategy: Pick<Strategy, 'shape' | 'roleSlots'>): string[] {
  const problems: string[] = [];

  const walk = (value: unknown, path: string): void => {
    if (value == null) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (MODEL_KEYS.includes(k.toLowerCase())) {
          problems.push(`${path}.${k} names a model or provider; a strategy describes shape, and which model fills a slot is the role's job`);
          continue;
        }
        walk(v, `${path}.${k}`);
      }
      return;
    }
    if (typeof value === 'string' && MODEL_SHAPED.test(value.trim())) {
      problems.push(`${path} looks like a model id ("${value}"); use a role slot instead`);
    }
  };

  walk(strategy.shape, 'shape');
  strategy.roleSlots?.forEach((slot, i) => {
    if (MODEL_SHAPED.test(slot)) problems.push(`roleSlots[${i}] looks like a model id ("${slot}"); a slot is a job, not a model`);
  });
  return problems;
}
