import { pluralized } from '@/lib/utils'

/**
 * Which of a connection's models may be used, the same rule the backend
 * applies (backend/src/modules/llm-providers/allowed-models.ts).
 *
 * Every model the key reaches is allowed by default and unticking hides
 * one. "Allow new models automatically" decides what a model the vendor
 * lists later does: on, it is allowed and the unticked ones are a hidden
 * list; off, only the ticked ones are allowed. Both lists are kept on the
 * connection, so flipping the switch loses nothing.
 */

export interface ModelAccess {
  allowNewModels: boolean
  hiddenModels: string[]
  allowedModels: string[]
}

/** What the API sends on a provider; a missing field reads as "all, new ones too". */
export interface ModelAccessFields {
  allowNewModels?: boolean | null
  hiddenModels?: string[] | null
  allowedModels?: string[] | null
}

export function modelAccessOf(provider: ModelAccessFields | null | undefined): ModelAccess {
  return {
    allowNewModels: provider?.allowNewModels !== false,
    hiddenModels: Array.isArray(provider?.hiddenModels) ? provider!.hiddenModels! : [],
    allowedModels: Array.isArray(provider?.allowedModels) ? provider!.allowedModels! : [],
  }
}

export function allowsModel(access: ModelAccess, model: string): boolean {
  return access.allowNewModels ? !access.hiddenModels.includes(model) : access.allowedModels.includes(model)
}

/** The ids of `all` that are ticked under `access`. */
export function tickedModels(access: ModelAccess, all: string[]): string[] {
  return all.filter((id) => allowsModel(access, id))
}

/**
 * The access that ticks exactly `ticked` of `all`, keeping the switch as
 * it is. With the switch on, the unticked ones become the hidden list;
 * with it off, the ticked ones become the allowed list. The other list is
 * left as it was.
 */
export function withTicked(access: ModelAccess, all: string[], ticked: string[]): ModelAccess {
  const on = new Set(ticked)
  if (access.allowNewModels) {
    // Hidden ids the vendor no longer lists stay hidden: they may come back.
    const unlisted = access.hiddenModels.filter((id) => !all.includes(id))
    return { ...access, hiddenModels: [...unlisted, ...all.filter((id) => !on.has(id))] }
  }
  const unlisted = access.allowedModels.filter((id) => !all.includes(id))
  return { ...access, allowedModels: [...unlisted, ...all.filter((id) => on.has(id))] }
}

/**
 * Flip the switch without changing what is ticked today: the list the new
 * setting reads is rebuilt from the current ticks.
 */
export function withSwitch(access: ModelAccess, all: string[], allowNewModels: boolean): ModelAccess {
  const ticked = tickedModels(access, all)
  return withTicked({ ...access, allowNewModels }, all, ticked)
}

/** The PATCH body for a connection's models. */
export function modelAccessBody(access: ModelAccess): { allowNewModels: boolean; hiddenModels: string[] | null; allowedModels: string[] | null } {
  return {
    allowNewModels: access.allowNewModels,
    hiddenModels: access.hiddenModels.length ? access.hiddenModels : null,
    allowedModels: access.allowedModels.length ? access.allowedModels : null,
  }
}

/** "All 12 models", "3 of 12 models", "Only Llama 3.3 70B" for a summary line. */
export function accessSummary(access: ModelAccess, all: string[], nameOf: (id: string) => string = (id) => id): string {
  const ticked = tickedModels(access, all)
  if (all.length === 0) return access.allowNewModels ? 'Every model it lists' : 'Only the models you tick'
  if (ticked.length === all.length) return access.allowNewModels ? `All ${pluralized(all.length, 'model')}, and new ones` : `All ${pluralized(all.length, 'model')}, not new ones`
  if (ticked.length === 0) return access.allowNewModels ? 'No models now, new ones when they appear' : 'No models: paused'
  if (ticked.length === 1) return `Only ${nameOf(ticked[0])}`
  return `${ticked.length} of ${pluralized(all.length, 'model')}`
}
