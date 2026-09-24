import { BadRequestException, NotFoundException } from '@nestjs/common';

import { GatewayType } from '../../../entities/gateway.entity';
import {
  PRIVATE_CAPABLE_GATEWAY_TYPES,
  assertToolAttachable,
  gatewayServableTo,
  resourceServableThroughGateway,
} from '../private-gateway';
import { UnifiedGatewayDelegation } from '../unified-gateway-delegation.helper';

const OWNER = 'owner-1';
const OTHER = 'other-1';

describe('private gateways', () => {
  const privateGw = { visibility: 'private' as const, ownerUserId: OWNER };
  const orgGw = { visibility: 'org' as const, ownerUserId: OTHER };

  it('serves a private gateway to its owner and nobody else', () => {
    expect(gatewayServableTo(privateGw, OWNER)).toBe(true);
    expect(gatewayServableTo(privateGw, OTHER)).toBe(false);
    expect(gatewayServableTo(privateGw, null)).toBe(false);
    expect(gatewayServableTo({ visibility: 'private', ownerUserId: null }, OWNER)).toBe(false);
    expect(gatewayServableTo(orgGw, null)).toBe(true);
  });

  it('exposes a private tool only through a gateway private to the same owner', () => {
    const tool = { visibility: 'private' as const, createdBy: OWNER };
    expect(resourceServableThroughGateway(privateGw, tool)).toBe(true);
    expect(resourceServableThroughGateway(orgGw, tool)).toBe(false);
    expect(resourceServableThroughGateway({ visibility: 'private', ownerUserId: OTHER }, tool)).toBe(false);
    expect(resourceServableThroughGateway(orgGw, { visibility: 'org', createdBy: OWNER })).toBe(true);
  });

  it('refuses attaching another user\'s private tool as not found, and the caller\'s own to a shared gateway', () => {
    const mine = { visibility: 'private' as const, createdBy: OWNER, name: 'mine' };
    expect(() => assertToolAttachable(privateGw, mine, OTHER)).toThrow(NotFoundException);
    expect(() => assertToolAttachable(orgGw, mine, OWNER)).toThrow(BadRequestException);
    expect(() => assertToolAttachable(privateGw, mine, OWNER)).not.toThrow();
  });

  it('never lets a chat channel be private (nobody reaching it signs in to almyty)', () => {
    for (const channel of UnifiedGatewayDelegation.CHANNEL_TYPES) {
      expect(PRIVATE_CAPABLE_GATEWAY_TYPES.has(channel)).toBe(false);
    }
    for (const surface of [GatewayType.CHAT_WIDGET, GatewayType.HOSTED_CHAT, GatewayType.DISCORD]) {
      expect(PRIVATE_CAPABLE_GATEWAY_TYPES.has(surface)).toBe(false);
    }
    expect(PRIVATE_CAPABLE_GATEWAY_TYPES.has(GatewayType.MCP)).toBe(true);
  });
});
