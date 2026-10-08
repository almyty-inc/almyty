import { Injectable, CanActivate, ExecutionContext, ForbiddenException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Gateway } from '../../entities/gateway.entity';
import { Agent } from '../../entities/agent.entity';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { assertManageable } from '../../common/authorization/read-rule';
import { findEffectiveMembership } from '../../common/authorization/membership';
@Injectable()
export class GatewayAuthManagementGuard implements CanActivate {
 constructor(@InjectRepository(Gateway) private readonly gateways: Repository<Gateway>, private readonly policy: AccessPolicyService) {}
 async canActivate(context: ExecutionContext): Promise<boolean> {
  const req = context.switchToHttp().getRequest();
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const organizationId = req.user?.currentOrganizationId;
  if (!organizationId || !req.user?.id) throw new ForbiddenException('Organization required');
  const gateway = await this.gateways.findOne({ where: { id: req.params.gatewayId, organizationId } });
  if (!gateway) throw new NotFoundException('Gateway not found');
  if (gateway.metadata?.agentApiTarget && gateway.agentId) {
   const agent = await this.gateways.manager.getRepository(Agent).findOne({ where: { id: gateway.agentId, organizationId, apiGatewayId: gateway.id } });
   await assertManageable(this.policy, req.user.id, agent, 'Agent', { ownerManages: true });
   return true;
  }
  const membership = findEffectiveMembership<any>(req.user.organizationMemberships, organizationId);
  if (!['admin', 'owner'].includes(membership?.role)) throw new ForbiddenException('Only organization admins can manage gateway authentication');
  return true;
 }
}
