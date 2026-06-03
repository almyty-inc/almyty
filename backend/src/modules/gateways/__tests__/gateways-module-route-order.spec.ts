import { Module } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

import { GatewaysModule } from '../gateways.module';
import { GatewayInfoController } from '../gateway-info.controller';
import { GatewaysController } from '../gateways.controller';

/**
 * Route-ordering regression test for the gateways module.
 *
 * GatewaysController has `@Get(':gatewayId')` decorated with
 * ParseUUIDPipe. If that route is registered before
 * GatewayInfoController's literal paths (all-skills, stats/overview,
 * skills/search, resolve/:org/:gateway), any non-UUID path segment
 * lands on `:gatewayId` and the request 400s with 'uuid is expected'
 * — exactly the failure observed in @almyty/skills smoke tests
 * before this fix.
 *
 * The fix is to register GatewayInfoController FIRST in the module's
 * controllers array so its literal paths win the prefix match.
 */
describe('GatewaysModule controller registration order', () => {
  it('lists GatewayInfoController before GatewaysController so literal /gateways/all-skills wins over /gateways/:gatewayId', () => {
    // Reach into the module metadata to assert the registration order
    // explicitly. We could boot a full Nest app and curl the route,
    // but that would slow the suite for a constraint that's a single
    // ordering invariant.
    const controllers: Function[] = Reflect.getMetadata('controllers', GatewaysModule) || [];

    const infoIdx = controllers.indexOf(GatewayInfoController);
    const gatewaysIdx = controllers.indexOf(GatewaysController);

    expect(infoIdx).toBeGreaterThan(-1);
    expect(gatewaysIdx).toBeGreaterThan(-1);
    expect(infoIdx).toBeLessThan(gatewaysIdx);
  });
});
