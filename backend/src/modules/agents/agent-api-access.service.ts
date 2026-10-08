import { getBaseUrl } from '../../common/config/base-url';
import { ConfigService } from '@nestjs/config';
import { Organization } from '../../entities/organization.entity';
import { assertManageable } from '../../common/authorization/read-rule';
import { Injectable, NotFoundException, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApiKey } from '../../entities/api-key.entity';
import { GatewayAuthService } from '../gateways/gateway-auth.service';
import { gatewayPrincipal } from '../../common/authorization/execution-access.service';
import { Agent } from '../../entities/agent.entity';
import { Gateway, GatewayKind, GatewayType, GatewayStatus } from '../../entities/gateway.entity';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { normalizeGatewayAccess, type AccessScope } from '../gateways/gateway-access';
import { resourceServableThroughGateway } from '../gateways/private-gateway';
@Injectable()
export class AgentApiAccessService {
 constructor(@InjectRepository(Agent) private readonly agents: Repository<Agent>, @InjectRepository(Gateway) private readonly gateways: Repository<Gateway>, private readonly policy: AccessPolicyService, private readonly gatewayAuth: GatewayAuthService) {}
 async authenticateTarget(model: unknown, req: any): Promise<ApiKey | null> {
  const ref = typeof model === 'string' ? model.replace(/^agent:/, '') : req?.headers?.['x-almyty-agent-id'];
  if (typeof ref !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) return null;
  const agent = await this.agents.findOne({ where: { id: ref } });
  if (!agent?.apiGatewayId) return null;
  const gateway = await this.gateways.findOne({ where: { id: agent.apiGatewayId, organizationId: agent.organizationId, agentId: agent.id, status: GatewayStatus.ACTIVE }, relations: { authConfigs: true } });
  if (!gateway) throw new UnauthorizedException('Agent API access unavailable');
  const configs = gateway.authConfigs.map(c => Object.assign(c, { gateway }));
  const auth = await this.gatewayAuth.authenticateRequest(gateway.id, req?.headers ?? {}, req?.query ?? {}, req?.body, req?.ip, configs, req);
  if (!auth.isValid) throw new UnauthorizedException(auth.error || 'Authentication required');
  return { id: gateway.id, organizationId: agent.organizationId, userId: auth.userId ?? null, agentId: agent.id, gatewayId: gateway.id, endpointAgent: agent, endpointPrincipal: gatewayPrincipal(gateway, auth.userId) } as unknown as ApiKey;
 }
 private async agent(id: string, organizationId: string, userId: string) {
  const agent = await this.agents.findOne({ where: { id, organizationId } });
  if (!agent || !(await this.policy.canAccess({ id: userId }, agent, 'read')).allowed) throw new NotFoundException('Agent not found');
  return agent;
 }
 private async view(agent: Agent, gateway?: Gateway) {
  const org = await this.agents.manager.getRepository(Organization).findOne({ where: { id: agent.organizationId } });
  const base = getBaseUrl(new ConfigService(process.env));
  const slug = agent.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return { gatewayId: gateway?.id ?? null, accessScope: gateway?.accessScope ?? agent.visibility ?? 'org', accessTeamId: gateway ? (gateway.accessScope === 'team' ? gateway.accessTeamId : null) : (agent.visibility === 'team' ? agent.teamId : null), endpoint: `${base}/${org?.slug ?? agent.organizationId}/${slug || agent.id}` };
 }
 async get(id: string, organizationId: string, userId: string) {
  const agent = await this.agent(id, organizationId, userId);
  if (!agent.apiGatewayId) return this.view(agent);
  const target = await this.gateways.findOne({ where: { id: agent.apiGatewayId, organizationId, agentId: id } });
  return this.view(agent, target ?? undefined);
 }
 async set(id: string, organizationId: string, userId: string, body: { accessScope?: AccessScope; accessTeamId?: string | null }) {
  const agent = await this.agent(id, organizationId, userId);
  await assertManageable(this.policy, userId, agent, 'Agent', { ownerManages: true });
  const scope = normalizeGatewayAccess(body.accessScope, body.accessTeamId);
  await this.policy.assertCanScopeToTeam(userId, organizationId, scope.accessScope === 'team' ? 'team' : 'org', scope.accessTeamId);
  const definition = { organizationId, visibility: agent.visibility, teamId: agent.teamId, ownerUserId: agent.createdBy, ...scope };
  if (!resourceServableThroughGateway(definition, agent)) throw new BadRequestException('The agent must be published to the people this API endpoint admits');
  return this.agents.manager.transaction(async tx => {
   await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['agent-api-access:' + id]);
   const current = await tx.getRepository(Agent).findOne({ where: { id, organizationId } });
   if (!current) throw new NotFoundException('Agent not found');
   let target = current.apiGatewayId ? await tx.getRepository(Gateway).findOne({ where: { id: current.apiGatewayId, organizationId, agentId: id } }) : null;
   if (!target) target = tx.getRepository(Gateway).create({ ...definition, kind: GatewayKind.AGENT, type: GatewayType.A2A, agentId: id, name: `${agent.name} API access`, endpoint: '/_agent_api_' + id, status: GatewayStatus.ACTIVE, configuration: {}, metadata: { agentApiTarget: true } });
   Object.assign(target, scope);
   target = await tx.getRepository(Gateway).save(target);
   await tx.getRepository(Agent).update({ id, organizationId }, { apiGatewayId: target.id, apiAccessScope: scope.accessScope, apiAccessTeamId: scope.accessTeamId });
   return this.view(agent, target);
  });
 }
}
