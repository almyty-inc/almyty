/**
 * Client-side mirror of the backend surface catalog
 * (backend/src/modules/gateways/surface-catalog.ts).
 *
 * The shapes are declared here but the DATA is never hardcoded: the
 * canvas fetches GET /gateways/surfaces so a surface added, gated or
 * retired on the backend shows up without a frontend change.
 */

export type SurfaceCategory = 'protocol' | 'messaging' | 'human'

export type InboundAuthMechanism =
  | 'signature'
  | 'shared_secret'
  | 'jwt'
  | 'transport'
  | 'none'
  | 'absent'

export interface SurfaceInboundAuth {
  mechanism: InboundAuthMechanism
  requiredConfigKeys: string[]
  unauthenticatedByDesign: boolean
}

export interface SurfaceDescriptor {
  type: string
  label: string
  category: SurfaceCategory
  kind: 'tool' | 'agent'
  available: boolean
  /** One line shown on a greyed node. Null when available. */
  unavailableReason: string | null
  humanFacing: boolean
  inboundAuth: SurfaceInboundAuth
  edition: 'core' | 'ee'
}

export const CATEGORY_LABEL: Record<SurfaceCategory, string> = {
  protocol: 'Protocols',
  messaging: 'Messaging',
  human: 'People',
}

export const CATEGORY_BLURB: Record<SurfaceCategory, string> = {
  protocol: 'Machine clients calling the agent',
  messaging: 'Platforms your users already have open',
  human: 'Chat surfaces you host yourself',
}

/**
 * Whether inbound authentication will actually run for a surface given
 * the configuration in hand. Mirrors inboundAuthStatus() on the backend
 * so a node can warn before publish instead of after the first dropped
 * message. The backend refuses regardless; this is the warning, not the
 * enforcement.
 */
export function inboundAuthStatus(
  surface: SurfaceDescriptor | undefined,
  configuration: Record<string, any> | null | undefined,
): { verified: boolean; reason: string | null } {
  if (!surface) return { verified: false, reason: 'Unknown surface type.' }

  const { mechanism, requiredConfigKeys, unauthenticatedByDesign } = surface.inboundAuth
  if (unauthenticatedByDesign || mechanism === 'none') return { verified: true, reason: null }

  const config = configuration ?? {}
  const missing = requiredConfigKeys.filter((key) => !config[key])
  if (missing.length > 0) {
    return {
      verified: false,
      reason: `Inbound messages are refused until ${missing.join(' and ')} ${
        missing.length > 1 ? 'are' : 'is'
      } set.`,
    }
  }
  return { verified: true, reason: null }
}
