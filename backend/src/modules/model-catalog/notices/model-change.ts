import type { Model } from '../../../entities/model.entity';

/**
 * What the catalog tells the notices about a connection's models: the ones
 * a sync found for the first time, and the ones that stopped being usable
 * (the vendor stopped listing them, refused the connection's key, or said
 * a model is gone). The catalog knows when; the notices decide who hears.
 */
export interface ModelChange {
  organizationId: string;
  providerId: string;
  appeared: Model[];
  gone: Array<{ card: Model; reason: string }>;
}

export interface ModelChangeListener {
  /** Never throws: a notice is side-band work and must not fail a sync. */
  modelsChanged(change: ModelChange): Promise<void>;
}

/** Injection token; optional wherever it is read, so specs need not wire it. */
export const MODEL_CHANGE_LISTENER = 'MODEL_CHANGE_LISTENER';

/** The reasons a model stops being usable, in the words a notice uses. */
export const GONE_REASONS = {
  notListed: 'The provider no longer lists it.',
  keyRejected: "The provider refused the connection's key.",
  modelNotFound: 'The provider says the model is gone.',
} as const;
