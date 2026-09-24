import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Gateway } from '../../entities/gateway.entity';
import { gatewayServableTo } from './private-gateway';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Another user's private gateway does not exist, on every dashboard route
 * that names a gateway by id (`:gatewayId` or `:id`).
 *
 * Sits after JwtAuthGuard on the gateway controllers. The services behind
 * those routes load gateways by (id, organizationId) in a dozen places --
 * tools, auth configs, API keys, skills, stats, channel events -- and a
 * member of the same organization passes every one of those lookups. One
 * gate in front of all of them is harder to forget than a check in each.
 * Org owners and admins are refused too: "just me" means just me.
 *
 * Answers 404 with the text a missing gateway gets, so a caller probing
 * ids cannot tell "private" from "absent".
 */
@Injectable()
export class PrivateGatewayGuard implements CanActivate {
  constructor(
    @InjectRepository(Gateway)
    private readonly gateways: Repository<Gateway>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const id: unknown = req?.params?.gatewayId ?? req?.params?.id;
    if (typeof id !== 'string' || !UUID.test(id)) return true;

    const row = await this.gateways.findOne({
      where: { id },
      select: { id: true, visibility: true, ownerUserId: true },
    });
    if (row && !gatewayServableTo(row, req?.user?.id)) {
      // The body GatewaysController answers GET /gateways/:id with for an
      // id that does not exist.
      throw new NotFoundException({ success: false, message: 'Gateway not found', error: 'GATEWAY_NOT_FOUND' });
    }
    return true;
  }
}
