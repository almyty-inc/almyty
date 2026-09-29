import { GatewayType } from '../../entities/gateway.entity';
import { GATEWAY_TYPE_FOR_TARGET } from '../agent-apps/distribution-publish';

/**
 * The gateways that are an app's places.
 *
 * An app is the one place an agent is put in front of people: its web
 * chat and its messaging channels are each a place on the app, and
 * publishing a place stands up the gateway it answers on and records it
 * on the distribution. So every gateway of these types belongs to an app,
 * and none is made any other way. The list is read off the app's own
 * target table, so a platform an app can ship to is on it by construction.
 */
export const APP_SURFACE_GATEWAY_TYPES: ReadonlySet<GatewayType> = new Set(
  Object.values(GATEWAY_TYPE_FOR_TARGET).filter((type): type is GatewayType => type != null),
);

export function isAppSurfaceGatewayType(type: GatewayType | string | null | undefined): boolean {
  return APP_SURFACE_GATEWAY_TYPES.has(type as GatewayType);
}

/** Why a chat or messaging gateway made outside an app is refused. */
export const APP_SURFACE_NEEDS_APP = Object.freeze({
  code: 'APP_SURFACE_NEEDS_APP',
  message:
    'A web chat or a messaging channel is a place on an app. Add it to an app and publish it there.',
});
