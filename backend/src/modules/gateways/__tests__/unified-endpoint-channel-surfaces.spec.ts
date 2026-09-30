import { HttpException } from '@nestjs/common';

import { UnifiedEndpointController, channelSurfaceSlug } from '../unified-endpoint.controller';
import { GatewayStatus, GatewayType } from '../../../entities/gateway.entity';
import { fakeRepository } from '../../../test/fake-repository';
import { ClauseModel, ExecutedQuery, RecordingQueryBuilder, matchingRows } from './recording-query-builder';

/**
 * A published channel answers on the URL the dashboard shows for it.
 *
 * Publishing a channel creates a gateway whose endpoint is `/channels/<id>`,
 * and the channel webhook registrar tells Telegram and Twilio to call
 * `<api>/<org>/channels/<id>`. A controller that only looked up
 * `/<resourceSlug>` -- here `/channels` -- would 404 every inbound message
 * to a Slack, WhatsApp or Teams channel, and Meta's callback verification
 * could never succeed.
 */
describe('unified endpoint -- channel surfaces', () => {
  const organization = { id: 'org-1', slug: 'acme', name: 'Acme' };
  const channelGateway = {
    id: 'gw-channel',
    endpoint: '/channels/7f0c',
    type: GatewayType.WHATSAPP_CLOUD,
    status: GatewayStatus.ACTIVE,
    organizationId: 'org-1',
  };

  /**
   * Another organization's agents, one per lookup `resolveAgent` makes:
   * `channels` for the exact-name findOne, `CHANNELS` for the case-insensitive
   * query. With any of their organization predicates gone, the 404 below
   * turns into this tenant being served org-2's agent. The chain that
   * stood here answered null whatever it was asked, so it could not tell.
   */
  const foreignAgents = [
    { id: 'agent-foreign-exact', organizationId: 'org-2', name: 'channels' },
    { id: 'agent-foreign-upper', organizationId: 'org-2', name: 'CHANNELS' },
  ];
  const AGENT_CLAUSES: ClauseModel = {
    'agent.organizationId = :organizationId': (row, p) => row.organizationId === p.organizationId,
    'LOWER(agent.name) = LOWER(:name)': (row, p) => row.name.toLowerCase() === p.name.toLowerCase(),
  };

  const build = (gateways: any[]) => {
    const gatewayRepository = fakeRepository<any>(gateways);
    const agents = fakeRepository<any>(foreignAgents);
    const agentRepository = {
      findOne: agents.findOne,
      find: agents.find,
      createQueryBuilder: jest.fn(
        (alias: string) =>
          new RecordingQueryBuilder(alias, {
            getOne: (query: ExecutedQuery) => matchingRows(query, agents.rows(), AGENT_CLAUSES)[0] ?? null,
          }),
      ),
    };
    const agentHelper = { handleAgentRequest: jest.fn().mockResolvedValue('agent') };
    const delegation = { handleGatewayRequest: jest.fn().mockResolvedValue('delegated') };
    const resolver = { resolveOrganization: jest.fn().mockResolvedValue(organization) };
    const controller = new UnifiedEndpointController(
      {} as any,
      gatewayRepository as any,
      agentRepository as any,
      {} as any,
      resolver as any,
      {} as any,
      {} as any,
      {} as any,
      agentHelper as any,
      delegation as any,
    );
    return { controller, gatewayRepository, delegation, agentHelper };
  };

  const req = (path: string) => ({ method: 'GET', path, headers: {}, query: {} }) as any;

  it('routes /<org>/channels/<id> to the channel gateway', async () => {
    const { controller, delegation } = build([channelGateway]);
    const request = req('/acme/channels/7f0c');
    await controller.handleSubPathRequest('acme', 'channels', request, {} as any, {});
    expect(delegation.handleGatewayRequest).toHaveBeenCalledWith(
      organization,
      channelGateway,
      'acme',
      'channels/7f0c',
      request,
      {},
      {},
    );
  });

  it('answers nothing under /<org>/apps: channels have one address', async () => {
    const { controller, delegation } = build([{ ...channelGateway, endpoint: '/apps/support/whatsapp_cloud' }]);
    await expect(
      controller.handleSubPathRequest('acme', 'apps', req('/acme/apps/support/whatsapp_cloud'), {} as any, {}),
    ).rejects.toBeInstanceOf(HttpException);
    expect(delegation.handleGatewayRequest).not.toHaveBeenCalled();
  });

  it("does not resolve another organization's channel, nor its agent", async () => {
    const { controller, delegation, agentHelper } = build([{ ...channelGateway, organizationId: 'org-2' }]);
    await expect(
      controller.handleSubPathRequest('acme', 'channels', req('/acme/channels/7f0c'), {} as any, {}),
    ).rejects.toBeInstanceOf(HttpException);
    expect(delegation.handleGatewayRequest).not.toHaveBeenCalled();
    expect(agentHelper.handleAgentRequest).not.toHaveBeenCalled();
  });

  it('does not route to a channel that is not active', async () => {
    const { controller, delegation } = build([{ ...channelGateway, status: GatewayStatus.INACTIVE }]);
    await expect(
      controller.handleSubPathRequest('acme', 'channels', req('/acme/channels/7f0c'), {} as any, {}),
    ).rejects.toBeInstanceOf(HttpException);
    expect(delegation.handleGatewayRequest).not.toHaveBeenCalled();
  });

  it('a hand-made gateway sub-path still takes exactly one lookup', async () => {
    const mcp = { ...channelGateway, id: 'gw-mcp', endpoint: '/tools', type: GatewayType.MCP };
    const { controller, gatewayRepository, delegation } = build([mcp]);
    await controller.handleSubPathRequest('acme', 'tools', req('/acme/tools/manifest'), {} as any, {});
    expect(gatewayRepository.findOne).toHaveBeenCalledTimes(1);
    expect(delegation.handleGatewayRequest.mock.calls[0][3]).toBe('tools');
  });

  describe('channelSurfaceSlug', () => {
    it('reads a channel by its id', () => {
      expect(channelSurfaceSlug('/acme/channels/7f0c', 'acme', 'channels')).toBe('channels/7f0c');
      expect(channelSurfaceSlug('/acme/channels/7f0c/events', 'acme', 'channels')).toBe('channels/7f0c');
      expect(channelSurfaceSlug('/acme/channels', 'acme', 'channels')).toBeNull();
    });
    it('ignores anything that is not a channel path', () => {
      expect(channelSurfaceSlug('/acme/apps/support/slack', 'acme', 'apps')).toBeNull();
      expect(channelSurfaceSlug('/acme/tools/x/y', 'acme', 'tools')).toBeNull();
      expect(channelSurfaceSlug('/other/apps/a/b', 'acme', 'apps')).toBeNull();
    });
  });
});
