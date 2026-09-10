import { Strategy, StrategyShape } from '../../../entities/strategy.entity';

/**
 * The built-in execution shapes.
 *
 * Every one of these is expressed purely in role slots. Read them as the
 * answer to "how is the work done", never "by whom": swapping the model
 * behind `principal` changes nothing here, which is the entire point of
 * separating L5 from L4.
 *
 * See docs/design/layers.md, L5.
 */
export type StrategySeed = Pick<Strategy, 'key' | 'displayName' | 'description' | 'roleSlots' | 'shape'> & {
  /** Offered without a claim that it pays off. See strategies.md. */
  experimental?: boolean;
};

const single: StrategyShape = {
  entry: 'answer',
  steps: [{ id: 'answer', kind: 'call', roleSlot: 'principal' }],
};

/**
 * Try the cheap slot first and only escalate when a verifier is not
 * satisfied. The saving comes from the cases that stop at the first step.
 */
const cascade: StrategyShape = {
  entry: 'draft',
  steps: [
    { id: 'draft', kind: 'call', roleSlot: 'drafter', next: ['check'] },
    { id: 'check', kind: 'verify', roleSlot: 'verifier', next: ['escalate'] },
    // Reached only when the check fails; the compiler wires the pass path
    // straight to the end.
    { id: 'escalate', kind: 'call', roleSlot: 'principal' },
  ],
};

/** N independent attempts, then one judge picks. */
const bestOfN: StrategyShape = {
  entry: 'fan',
  steps: [
    { id: 'fan', kind: 'parallel', params: { n: 3 }, next: ['candidate'] },
    { id: 'candidate', kind: 'call', roleSlot: 'principal', next: ['judge'] },
    { id: 'judge', kind: 'merge', roleSlot: 'verifier', params: { strategy: 'best_of_n' } },
  ],
};

/** Several different slots answer, and the disagreement is the signal. */
const panel: StrategyShape = {
  entry: 'fan',
  steps: [
    { id: 'fan', kind: 'parallel', next: ['a', 'b', 'c'] },
    { id: 'a', kind: 'call', roleSlot: 'panelist_one', next: ['consensus'] },
    { id: 'b', kind: 'call', roleSlot: 'panelist_two', next: ['consensus'] },
    { id: 'c', kind: 'call', roleSlot: 'panelist_three', next: ['consensus'] },
    { id: 'consensus', kind: 'merge', params: { strategy: 'consensus', consensusThreshold: 0.5 } },
  ],
};

/**
 * Explore broadly with a cheap slot, compress what was learned into a
 * brief, then let the expensive slot act on the brief rather than the
 * whole transcript.
 *
 * EXPERIMENTAL, and deliberately not claimed to save money. The
 * arithmetic only works if the cheap model is roughly an order of
 * magnitude cheaper AND the frontier call stays a single generation over
 * a prepared brief. If the price ratio is small, or the brief balloons
 * the input, or the frontier model runs its own loop anyway, you have
 * paid for the rollouts and saved nothing. The product here is the
 * machinery and the measurement, not a promise: run it against your own
 * traffic and read the routing headroom.
 */
const exploreExtractPatch: StrategyShape = {
  entry: 'explore',
  steps: [
    { id: 'explore', kind: 'parallel', params: { n: 3 }, next: ['rollout'] },
    { id: 'rollout', kind: 'call', roleSlot: 'explorer', next: ['extract'] },
    { id: 'extract', kind: 'extract_context', roleSlot: 'summariser', next: ['patch'] },
    { id: 'patch', kind: 'call', roleSlot: 'principal', next: ['check'] },
    { id: 'check', kind: 'verify', roleSlot: 'verifier' },
  ],
};

export const STRATEGY_SEEDS: StrategySeed[] = [
  {
    key: 'single',
    displayName: 'Single call',
    description: 'One call on one role. The default, and the thing every other shape is measured against.',
    roleSlots: ['principal'],
    shape: single,
  },
  {
    key: 'cascade',
    displayName: 'Cascade',
    description: 'A cheaper role drafts, a verifier checks, and only a failed check escalates to the principal role.',
    roleSlots: ['drafter', 'verifier', 'principal'],
    shape: cascade,
  },
  {
    key: 'best_of_n',
    displayName: 'Best of N',
    description: 'Several independent attempts on the same role, and a verifier picks the best.',
    roleSlots: ['principal', 'verifier'],
    shape: bestOfN,
  },
  {
    key: 'panel',
    displayName: 'Panel',
    description: 'Three different roles answer and the shape looks for consensus. Disagreement is the signal.',
    roleSlots: ['panelist_one', 'panelist_two', 'panelist_three'],
    shape: panel,
  },
  {
    key: 'explore_extract_patch',
    displayName: 'Explore, extract, patch',
    description:
      'A cheap role explores in parallel, a summariser compresses what was found into a brief, and the principal role acts on the brief rather than the whole transcript. Experimental: whether it saves anything depends on your workload.',
    experimental: true,
    roleSlots: ['explorer', 'summariser', 'principal', 'verifier'],
    shape: exploreExtractPatch,
  },
];
