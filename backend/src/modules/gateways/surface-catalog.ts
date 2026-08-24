import { GatewayKind, GatewayType } from '../../entities/gateway.entity';

/**
 * The surface catalog: one source of truth for every place an agent can
 * be reached from.
 *
 * A "surface" is anywhere an agent is addressable — a protocol endpoint
 * (MCP, A2A, UTCP, Agent Skills, the OpenAI-compatible API), a messaging
 * platform, or a human chat UI. The publish canvas renders one node per
 * entry here: live surfaces are draggable, surfaces that are not usable
 * yet render greyed with `unavailableReason` as their one-line
 * explanation, so the UI never has to hardcode that knowledge.
 *
 * Everything else that needs to reason about a surface reads it from
 * here too: which surfaces a human reads (and therefore need an EU AI
 * Act Art. 50 disclosure), and whether inbound platform authentication
 * actually runs given the gateway's current configuration.
 */

export type SurfaceCategory = 'protocol' | 'messaging' | 'human';

/**
 * How inbound requests on this surface are proven to come from the
 * platform they claim to.
 *
 *   signature      HMAC over the raw body (Slack, Meta, Twilio, Svix, ...)
 *   shared_secret  a bearer token the platform echoes back, compared
 *                  in constant time (Google Chat, the IRC bridge)
 *   jwt        signed bearer token verified against the platform's JWKS
 *   transport  no inbound HTTP at all; the connection itself is
 *              authenticated (Discord's gateway socket, Matrix and
 *              Signal client sessions)
 *   none       the surface accepts unauthenticated inbound by design
 *              (the embeddable widget is public)
 *   absent     the platform offers a verification mechanism and we do
 *              not implement it
 */
export type InboundAuthMechanism =
  | 'signature'
  | 'shared_secret'
  | 'jwt'
  | 'transport'
  | 'none'
  | 'absent';

export interface SurfaceInboundAuth {
  mechanism: InboundAuthMechanism;
  /**
   * Config keys that must all be present for verification to run. Empty
   * when the mechanism needs no per-gateway configuration.
   */
  requiredConfigKeys: string[];
  /**
   * True when this surface can carry an agent conversation without any
   * inbound authentication at all. Only the two adapters that declare
   * `inboundIsUnauthenticatedByDesign` set it: discord, whose inbound is
   * an authenticated websocket rather than an HTTP endpoint, and the
   * embeddable widget, which is public on purpose. Every other surface
   * refuses unverified inbound, so a missing key means the surface is
   * unpublishable, not quietly insecure.
   */
  unauthenticatedByDesign: boolean;
}

export interface SurfaceDescriptor {
  type: GatewayType;
  label: string;
  category: SurfaceCategory;
  kind: GatewayKind;
  /** False renders the canvas node greyed out. */
  available: boolean;
  /** One line, shown on a greyed node. Null when `available`. */
  unavailableReason: string | null;
  /** A person reads the agent's replies here, so Art. 50 applies. */
  humanFacing: boolean;
  inboundAuth: SurfaceInboundAuth;
  /** 'ee' surfaces require a commercial entitlement to publish. */
  edition: 'core' | 'ee';
}

const NO_INBOUND_AUTH: SurfaceInboundAuth = {
  mechanism: 'none',
  requiredConfigKeys: [],
  unauthenticatedByDesign: false,
};

/**
 * Protocol surfaces authenticate with almyty's own gateway auth (API
 * key, OAuth, JWT) rather than a third party's signature scheme, so
 * their inbound auth is described as almyty-side.
 */
const GATEWAY_AUTH: SurfaceInboundAuth = {
  mechanism: 'none',
  requiredConfigKeys: [],
  unauthenticatedByDesign: false,
};

export const SURFACE_CATALOG: readonly SurfaceDescriptor[] = Object.freeze([
  // ---------------------------------------------------------------
  // Protocol surfaces
  // ---------------------------------------------------------------
  {
    type: GatewayType.MCP,
    label: 'MCP',
    category: 'protocol',
    kind: GatewayKind.TOOL,
    available: true,
    unavailableReason: null,
    humanFacing: false,
    inboundAuth: GATEWAY_AUTH,
    edition: 'core',
  },
  {
    type: GatewayType.UTCP,
    label: 'UTCP',
    category: 'protocol',
    kind: GatewayKind.TOOL,
    available: true,
    unavailableReason: null,
    humanFacing: false,
    inboundAuth: GATEWAY_AUTH,
    edition: 'core',
  },
  {
    type: GatewayType.SKILLS,
    label: 'Agent Skills',
    category: 'protocol',
    kind: GatewayKind.TOOL,
    available: true,
    unavailableReason: null,
    humanFacing: false,
    inboundAuth: GATEWAY_AUTH,
    edition: 'core',
  },
  {
    type: GatewayType.A2A,
    label: 'A2A',
    category: 'protocol',
    kind: GatewayKind.AGENT,
    available: true,
    unavailableReason: null,
    humanFacing: false,
    inboundAuth: GATEWAY_AUTH,
    edition: 'core',
  },
  {
    type: GatewayType.ACP,
    label: 'ACP',
    category: 'protocol',
    kind: GatewayKind.AGENT,
    available: true,
    unavailableReason: null,
    humanFacing: false,
    inboundAuth: GATEWAY_AUTH,
    edition: 'core',
  },
  {
    type: GatewayType.OPENAI_CHAT,
    label: 'OpenAI-compatible API',
    category: 'protocol',
    kind: GatewayKind.AGENT,
    available: true,
    unavailableReason: null,
    // Reached by a client the operator writes, not by an end user
    // directly; the disclosure obligation sits with that client.
    humanFacing: false,
    inboundAuth: GATEWAY_AUTH,
    edition: 'core',
  },

  // ---------------------------------------------------------------
  // Messaging surfaces
  // ---------------------------------------------------------------
  {
    type: GatewayType.SLACK,
    label: 'Slack',
    category: 'messaging',
    kind: GatewayKind.AGENT,
    available: true,
    unavailableReason: null,
    humanFacing: true,
    inboundAuth: {
      mechanism: 'signature',
      requiredConfigKeys: ['signing_secret'],
      unauthenticatedByDesign: false,
    },
    edition: 'core',
  },
  {
    type: GatewayType.DISCORD,
    label: 'Discord',
    category: 'messaging',
    kind: GatewayKind.AGENT,
    available: true,
    unavailableReason: null,
    humanFacing: true,
    // Inbound arrives over the authenticated gateway websocket
    // (discord-gateway.transport.ts), never as an unsigned webhook.
    inboundAuth: {
      mechanism: 'transport',
      requiredConfigKeys: ['bot_token'],
      unauthenticatedByDesign: true,
    },
    edition: 'core',
  },
  {
    type: GatewayType.TELEGRAM,
    label: 'Telegram',
    category: 'messaging',
    kind: GatewayKind.AGENT,
    available: true,
    unavailableReason: null,
    humanFacing: true,
    // setWebhook mints a per-gateway secret_token which Telegram echoes
    // back in X-Telegram-Bot-Api-Secret-Token on every update.
    inboundAuth: {
      mechanism: 'shared_secret',
      requiredConfigKeys: ['webhook_secret_token'],
      unauthenticatedByDesign: false,
    },
    edition: 'core',
  },
  {
    type: GatewayType.WHATSAPP,
    label: 'WhatsApp (Twilio)',
    category: 'messaging',
    kind: GatewayKind.AGENT,
    available: true,
    unavailableReason: null,
    humanFacing: true,
    // Twilio signs the exact public URL, so verification cannot run
    // until webhook_url is known. The registrar backfills it when
    // PUBLIC_API_URL is set; operators can also enter it by hand.
    inboundAuth: {
      mechanism: 'signature',
      requiredConfigKeys: ['twilio_auth_token', 'webhook_url'],
      unauthenticatedByDesign: false,
    },
    edition: 'core',
  },
  {
    type: GatewayType.WHATSAPP_CLOUD,
    label: 'WhatsApp (Meta Cloud API)',
    category: 'messaging',
    kind: GatewayKind.AGENT,
    available: true,
    unavailableReason: null,
    humanFacing: true,
    inboundAuth: {
      mechanism: 'signature',
      requiredConfigKeys: ['app_secret'],
      unauthenticatedByDesign: false,
    },
    edition: 'core',
  },
  {
    type: GatewayType.SMS,
    label: 'SMS (Twilio)',
    category: 'messaging',
    kind: GatewayKind.AGENT,
    available: true,
    unavailableReason: null,
    humanFacing: true,
    inboundAuth: {
      mechanism: 'signature',
      requiredConfigKeys: ['twilio_auth_token', 'webhook_url'],
      unauthenticatedByDesign: false,
    },
    edition: 'core',
  },
  {
    type: GatewayType.MICROSOFT_TEAMS,
    label: 'Microsoft Teams',
    category: 'messaging',
    kind: GatewayKind.AGENT,
    available: true,
    unavailableReason: null,
    humanFacing: true,
    inboundAuth: {
      mechanism: 'jwt',
      requiredConfigKeys: [],
      unauthenticatedByDesign: false,
    },
    edition: 'core',
  },
  {
    type: GatewayType.GOOGLE_CHAT,
    label: 'Google Chat',
    category: 'messaging',
    kind: GatewayKind.AGENT,
    available: true,
    unavailableReason: null,
    humanFacing: true,
    inboundAuth: {
      mechanism: 'shared_secret',
      requiredConfigKeys: ['verification_token'],
      unauthenticatedByDesign: false,
    },
    edition: 'core',
  },
  {
    type: GatewayType.EMAIL,
    label: 'Email',
    category: 'messaging',
    kind: GatewayKind.AGENT,
    available: true,
    unavailableReason: null,
    humanFacing: true,
    inboundAuth: {
      mechanism: 'signature',
      requiredConfigKeys: ['resend_inbound_signing_secret'],
      unauthenticatedByDesign: false,
    },
    edition: 'core',
  },
  {
    type: GatewayType.SIGNAL,
    label: 'Signal',
    category: 'messaging',
    kind: GatewayKind.AGENT,
    available: true,
    unavailableReason: null,
    humanFacing: true,
    // The signal-cli bridge POSTs envelopes in and must present the
    // gateway's inbound_token as a bearer token.
    inboundAuth: {
      mechanism: 'shared_secret',
      requiredConfigKeys: ['inbound_token'],
      unauthenticatedByDesign: false,
    },
    edition: 'core',
  },
  {
    type: GatewayType.MATRIX,
    label: 'Matrix',
    category: 'messaging',
    kind: GatewayKind.AGENT,
    available: true,
    unavailableReason: null,
    humanFacing: true,
    // Same as Signal: the bridge presents inbound_token as a bearer token.
    inboundAuth: {
      mechanism: 'shared_secret',
      requiredConfigKeys: ['inbound_token'],
      unauthenticatedByDesign: false,
    },
    edition: 'core',
  },
  {
    type: GatewayType.IRC,
    label: 'IRC',
    category: 'messaging',
    kind: GatewayKind.AGENT,
    available: true,
    unavailableReason: null,
    humanFacing: true,
    inboundAuth: {
      mechanism: 'shared_secret',
      requiredConfigKeys: ['inbound_token'],
      unauthenticatedByDesign: false,
    },
    edition: 'core',
  },
  {
    type: GatewayType.WEBHOOK,
    label: 'Inbound webhook',
    category: 'messaging',
    kind: GatewayKind.AGENT,
    available: true,
    unavailableReason: null,
    // A webhook is machine to machine: whatever consumes the callback
    // decides whether a person ever sees the text.
    humanFacing: false,
    inboundAuth: {
      mechanism: 'signature',
      requiredConfigKeys: ['secret'],
      unauthenticatedByDesign: false,
    },
    edition: 'core',
  },

  // ---------------------------------------------------------------
  // Human surfaces
  // ---------------------------------------------------------------
  {
    type: GatewayType.CHAT_WIDGET,
    label: 'Embeddable web widget',
    category: 'human',
    kind: GatewayKind.AGENT,
    available: true,
    unavailableReason: null,
    humanFacing: true,
    inboundAuth: NO_INBOUND_AUTH,
    edition: 'core',
  },
]);

const BY_TYPE: ReadonlyMap<GatewayType, SurfaceDescriptor> = new Map(
  SURFACE_CATALOG.map((s) => [s.type, s]),
);

export function getSurface(type: GatewayType | string): SurfaceDescriptor | undefined {
  return BY_TYPE.get(type as GatewayType);
}

/** Surfaces a person reads directly, and therefore Art. 50 applies to. */
export function humanFacingSurfaces(): SurfaceDescriptor[] {
  return SURFACE_CATALOG.filter((s) => s.humanFacing);
}

export function isHumanFacingSurface(type: GatewayType | string): boolean {
  return getSurface(type)?.humanFacing ?? false;
}

/**
 * Whether inbound platform authentication will actually run for this
 * gateway as configured, and if not, why.
 *
 * Every adapter fails closed, so `verified: false` on a surface that is
 * not `unauthenticatedByDesign` means inbound will be REFUSED, not
 * quietly accepted. The reason is written for an operator to act on and
 * is what the publish gate and the canvas node both display.
 */
export function inboundAuthStatus(
  type: GatewayType | string,
  configuration: Record<string, any> | null | undefined,
): { verified: boolean; reason: string | null } {
  const surface = getSurface(type);
  if (!surface) return { verified: false, reason: 'Unknown surface type.' };

  const { mechanism, requiredConfigKeys, unauthenticatedByDesign } = surface.inboundAuth;

  if (unauthenticatedByDesign) {
    return {
      verified: true,
      reason: null,
    };
  }
  if (mechanism === 'none') {
    // Protocol surfaces authenticate with almyty's own gateway auth
    // (API key, OAuth, JWT) rather than a third party's scheme.
    return { verified: true, reason: null };
  }

  const config = configuration ?? {};
  const missing = requiredConfigKeys.filter((key) => !config[key]);
  if (missing.length > 0) {
    return {
      verified: false,
      reason: `Inbound messages are refused until ${missing.join(' and ')} ${
        missing.length > 1 ? 'are' : 'is'
      } set.`,
    };
  }
  return { verified: true, reason: null };
}

/** Reason code for a surface that cannot be published as configured. */
export const SURFACE_PUBLISH_REFUSED = 'SURFACE_INBOUND_AUTH_UNVERIFIABLE';

export interface SurfacePublishCheck {
  publishable: boolean;
  code: typeof SURFACE_PUBLISH_REFUSED | null;
  reason: string | null;
}

/**
 * Publish gate. A messaging surface whose inbound authentication cannot
 * run is refused rather than published in a degraded state: it would
 * accept nothing anyway, and shipping it live would look like a working
 * channel that silently drops every message.
 */
export function canPublishSurface(
  type: GatewayType | string,
  configuration: Record<string, any> | null | undefined,
): SurfacePublishCheck {
  const status = inboundAuthStatus(type, configuration);
  if (status.verified) return { publishable: true, code: null, reason: null };
  return { publishable: false, code: SURFACE_PUBLISH_REFUSED, reason: status.reason };
}
