import { BadRequestException } from '@nestjs/common';

import type { LlmProvider } from '../../entities/llm-provider.entity';

/**
 * Which of a connection's models may be used.
 *
 * Every model the key reaches is allowed by default, and the owner unticks
 * models to hide them. One switch per connection, "Allow new models
 * automatically", decides what a model the vendor lists later does:
 *
 *  - on (the default): it is allowed; unticked models are kept in
 *    `hiddenModels` and are the only ones hidden;
 *  - off: only the ticked models in `allowedModels` are allowed, and a new
 *    one stays unticked until someone ticks it. This is how one key is
 *    pinned to one model ("this Hugging Face key serves Llama 70B and
 *    nothing else").
 *
 * Both lists are stored, so flipping the switch loses nothing. Every reader
 * goes through here: the catalog (`allowed` on a card, and so
 * `selectable`), the router's plan, a role naming one model, the default
 * model a call falls back to, and the call itself.
 */

export type ModelAccessFields = Pick<LlmProvider, 'allowNewModels' | 'hiddenModels' | 'allowedModels'>;

/** The most model ids one list can hold. */
export const MAX_MODEL_LIST = 2000;

/** The switch; a row written before it existed (undefined) behaves as on. */
export function allowsNewModels(provider: Partial<ModelAccessFields> | null | undefined): boolean {
  return provider?.allowNewModels !== false;
}

/** The ids a pinned connection (switch off) allows, or null when the switch is on. */
export function allowedModelList(provider: Partial<ModelAccessFields> | null | undefined): string[] | null {
  if (allowsNewModels(provider)) return null;
  return Array.isArray(provider?.allowedModels) ? provider!.allowedModels! : [];
}

/** The ids hidden while the switch is on (empty when it is off: the allow list decides then). */
export function hiddenModelList(provider: Partial<ModelAccessFields> | null | undefined): string[] {
  if (!allowsNewModels(provider)) return [];
  return Array.isArray(provider?.hiddenModels) ? provider!.hiddenModels! : [];
}

/** Whether `model` may be used through this connection. An empty model id is decided by the default-model rule, not here. */
export function providerAllowsModel(provider: Partial<ModelAccessFields> | null | undefined, model: string | null | undefined): boolean {
  if (!model || !provider) return true;
  const allowed = allowedModelList(provider);
  if (allowed) return allowed.includes(model);
  return !hiddenModelList(provider).includes(model);
}

/** What a create or update may carry; each field absent means "no change". */
export interface ModelAccessInput {
  allowNewModels?: boolean;
  hiddenModels?: string[] | null;
  allowedModels?: string[] | null;
}

function normaliseList(input: unknown, field: string): string[] | null | undefined {
  if (input === undefined) return undefined;
  if (input === null) return null;
  if (!Array.isArray(input)) {
    throw new BadRequestException({ code: 'INVALID_MODEL_LIST', message: `${field} must be a list of model ids` });
  }
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') throw new BadRequestException({ code: 'INVALID_MODEL_LIST', message: `${field} must be a list of model ids` });
    const id = raw.trim();
    if (id && !out.includes(id)) out.push(id);
  }
  if (out.length > MAX_MODEL_LIST) {
    throw new BadRequestException({ code: 'INVALID_MODEL_LIST', message: `${field} can hold at most ${MAX_MODEL_LIST} models` });
  }
  return out;
}

/**
 * Apply a request's model access fields to a row (or a new one). A
 * connection may offer no model at all (switch off, nothing ticked): it is
 * paused, and nothing is offered or called through it until a model is
 * ticked again.
 */
export function applyModelAccess(target: Partial<ModelAccessFields>, input: ModelAccessInput): void {
  // Worked out on a copy: a refused change leaves the row as it was.
  const next: Partial<ModelAccessFields> = {};
  if (input.allowNewModels !== undefined) {
    if (typeof input.allowNewModels !== 'boolean') {
      throw new BadRequestException({ code: 'INVALID_MODEL_LIST', message: 'allowNewModels must be true or false' });
    }
    next.allowNewModels = input.allowNewModels;
  }
  const hidden = normaliseList(input.hiddenModels, 'hiddenModels');
  if (hidden !== undefined) next.hiddenModels = hidden && hidden.length > 0 ? hidden : null;
  const allowed = normaliseList(input.allowedModels, 'allowedModels');
  if (allowed !== undefined) next.allowedModels = allowed && allowed.length > 0 ? allowed : null;
  Object.assign(target, next);
}

/**
 * A call named a model this connection hides. A 400: the request is what
 * is wrong, so a routed walk stops here rather than trying the next
 * candidate (a routed plan never contains a hidden model to begin with).
 */
export class ModelNotAllowedError extends BadRequestException {
  readonly code = 'MODEL_NOT_ALLOWED';

  constructor(provider: Pick<LlmProvider, 'id' | 'name'>, readonly model: string) {
    super({
      code: 'MODEL_NOT_ALLOWED',
      message: `The connection "${provider.name ?? provider.id}" does not allow the model "${model}". Tick it on the connection, or choose another model.`,
      providerId: provider.id,
      model,
    });
  }
}

/** Throw ModelNotAllowedError when `model` is hidden on this connection. */
export function assertModelAllowed(provider: Pick<LlmProvider, 'id' | 'name'> & Partial<ModelAccessFields>, model: string | null | undefined): void {
  if (!providerAllowsModel(provider, model)) throw new ModelNotAllowedError(provider, model as string);
}
