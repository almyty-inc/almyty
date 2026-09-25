import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Gateway } from '../../entities/gateway.entity';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { GATEWAY_NOT_FOUND, gatewayReadableBy } from './private-gateway';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A gateway the caller may not read does not exist, on every dashboard
 * route that names a gateway by id (`:gatewayId` or `:id`).
 *
 * Sits after JwtAuthGuard on the gateway controllers. The services behind
 * those routes load gateways by (id, organizationId) in a dozen places --
 * tools, auth configs, API keys, skills, CLI and SDK bundles, stats,
 * channel events -- and a member of the same organization passes every
 * one of those lookups. One gate in front of all of them is harder to
 * forget than a check in each. The rule is gatewayReadableBy: another
 * user's private gateway is refused to everyone, org owners and admins
 * included ("just me" means just me); a team gateway to anyone outside
 * the team who is not an org owner or admin.
 *
 * Answers 404 with the text a missing gateway gets, so a caller probing
 * ids cannot tell "not yours" from "absent".
 */
@Injectable()
export class PrivateGatewayGuard implements CanActivate {
  constructor(
    @InjectRepository(Gateway)
    private readonly gateways: Repository<Gateway>,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const id: unknown = req?.params?.gatewayId ?? req?.params?.id;
    if (typeof id !== 'string' || !UUID.test(id)) return true;

    const row = await this.gateways.findOne({
      where: { id },
      select: { id: true, organizationId: true, visibility: true, ownerUserId: true, teamId: true },
    });
    if (row && !(await gatewayReadableBy(this.accessPolicy, row, req?.user?.id))) {
      // The body GatewaysController answers GET /gateways/:id with for an
      // id that does not exist.
      throw new NotFoundException({ success: false, message: GATEWAY_NOT_FOUND, error: 'GATEWAY_NOT_FOUND' });
    }
    return true;
  }
}
