import { AgentApp, AppAuthMode } from '../../entities/agent-app.entity';
import { DistributionTarget } from '../../entities/agent-app-distribution.entity';
import { splitChannelConfigSecrets } from '../gateways/channels/channel-config.helper';
import { appSlugError, defaultLimitsFor } from './agent-app.rules';
import { CREDENTIAL_ALTERNATIVES, GATEWAY_TYPE_FOR_TARGET, REQUIRED_CREDENTIALS } from './distribution-publish';

/**
 * What a new app is made of. Pure, so the service that creates an app and
 * the migration that wraps a surface no app owned build the same row.
 */
export interface CreateAppDto {
  name: string;
  slug: string;
  description?: string;
  agentIds?: string[];
  branding?: AgentApp['branding'];
  authMode?: AppAuthMode;
  capabilities?: AgentApp['capabilities'];
  limits?: AgentApp['limits'];
  privacy?: AgentApp['privacy'];
}

export type NewAppFields = Pick<
  AgentApp,
  'organizationId' | 'name' | 'slug' | 'description' | 'agentIds' | 'branding' | 'authMode' | 'capabilities' | 'limits' | 'privacy' | 'isActive'
>;

/** The row a new app is saved as. The slug must already have passed appSlugError. */
export function newAppFields(organizationId: string, dto: CreateAppDto): NewAppFields {
  const authMode = dto.authMode ?? AppAuthMode.PUBLIC_LINK;
  return {
    organizationId,
    name: dto.name,
    slug: dto.slug.trim().toLowerCase(),
    description: dto.description ?? null,
    agentIds: dto.agentIds ?? [],
    branding: dto.branding ?? {},
    authMode,
    capabilities: dto.capabilities ?? {},
    // A product open to anyone starts with a ceiling on every axis rather
    // than with empty fields and a publish rule that refuses it. The
    // numbers are meant to be edited, not discovered.
    limits: dto.limits ?? defaultLimitsFor(authMode),
    privacy: dto.privacy ?? null,
    isActive: true,
  };
}

/**
 * A usable app slug from a display name: lowercase letters, digits and
 * single hyphens, 3 to 63 characters, not reserved, and not one `taken`
 * already answers yes to. A clash gets `-2`, `-3`, ... so the result is
 * always free.
 */
export function appSlugFromName(name: string, taken: (slug: string) => boolean): string {
  let base = (name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');
  if (appSlugError(base)) base = base ? `${base}-app` : 'app';
  if (appSlugError(base)) base = 'agent-app';
  if (!taken(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken(candidate)) return candidate;
  }
}

/** The app target a gateway type is the place of, or null for a gateway no app place stands up. */
export function targetForGatewayType(type: string): DistributionTarget | null {
  const entry = Object.entries(GATEWAY_TYPE_FOR_TARGET).find(([, gatewayType]) => gatewayType === type);
  return entry ? (entry[0] as DistributionTarget) : null;
}

/**
 * What a place carries when an existing gateway becomes it: the reference
 * to the connection holding the platform secrets, and the platform's
 * non-secret settings the publish check reads (a phone number, an inbound
 * address). Secret values never land on a distribution. The web chat
 * carries nothing: its address and sign-in rule stay on the gateway.
 */
export function placeConfigurationFrom(
  target: DistributionTarget,
  gatewayConfiguration: Record<string, any> | null | undefined,
): Record<string, any> {
  if (target === DistributionTarget.WEB) return {};
  const { publicConfig } = splitChannelConfigSecrets(gatewayConfiguration);
  const settings = [...(REQUIRED_CREDENTIALS[target] ?? []), ...(CREDENTIAL_ALTERNATIVES[target]?.all ?? [])];
  const place: Record<string, any> = {};
  for (const key of settings) {
    const value = publicConfig[key];
    if (value !== undefined && value !== null && value !== '') place[key] = value;
  }
  if (typeof publicConfig.credentialId === 'string' && publicConfig.credentialId) {
    place.credentialId = publicConfig.credentialId;
    place.credentialKeys = Array.isArray(publicConfig.credentialKeys) ? publicConfig.credentialKeys : [];
  }
  return place;
}
