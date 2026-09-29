import { BadRequestException } from '@nestjs/common';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

import { unlimitedQuotaManager } from '../../../test/tool-quota.fake';
import { GatewaysService } from '../gateways.service';
import { CHANNEL_GATEWAY_TYPES, CHANNEL_GATEWAY_NEEDS_AGENT, isChannelGatewayType } from '../channel-surface';
import { GatewayType } from '../../../entities/gateway.entity';

/**
 * A web chat, a website widget, a messaging channel or an A2A endpoint is
 * a channel on an agent: publishing it on the agent's Channels tab stands
 * up its gateway and records it on the channel. So no such gateway is made
 * any other way -- not through POST /gateways, not through the platform's
 * own MCP tools, not through the CLI -- and the service refuses one that
 * names no channel.
 */
describe('every channel gateway belongs to an agent channel', () => {
  it('names the web chat, the website widget, A2A and every messaging platform a channel can be, and nothing else', () => {
    expect([...CHANNEL_GATEWAY_TYPES].sort()).toEqual(
      [
        GatewayType.HOSTED_CHAT,
        GatewayType.CHAT_WIDGET,
        GatewayType.A2A,
        GatewayType.SLACK,
        GatewayType.DISCORD,
        GatewayType.TELEGRAM,
        GatewayType.WHATSAPP,
        GatewayType.WHATSAPP_CLOUD,
        GatewayType.SMS,
        GatewayType.EMAIL,
        GatewayType.WEBHOOK,
        GatewayType.GOOGLE_CHAT,
        GatewayType.MICROSOFT_TEAMS,
        GatewayType.SIGNAL,
        GatewayType.MATRIX,
        GatewayType.IRC,
      ].sort(),
    );
    for (const type of [GatewayType.TOOLS, GatewayType.MCP, GatewayType.UTCP, GatewayType.SKILLS, GatewayType.ACP, GatewayType.OPENAI_CHAT]) {
      expect(isChannelGatewayType(type)).toBe(false);
    }
  });

  describe('GatewaysService.createGateway', () => {
    let gatewayRepository: any;
    let organizations: any;

    const service = () =>
      new GatewaysService(
        gatewayRepository,
        {} as any,
        {} as any,
        { findOne: jest.fn().mockResolvedValue({ hasPermissionInOrganization: () => true }) } as any,
        organizations,
        {} as any,
        { logCreate: jest.fn() } as any,
        {} as any,
        { validateGatewayConfiguration: jest.fn(), createDefaultAuth: jest.fn().mockResolvedValue(undefined) } as any,
        { assertCanScopeToTeam: jest.fn().mockResolvedValue(undefined) } as any,
      );

    const dto = (type: GatewayType) => ({
      name: `${type} surface`,
      type,
      agentId: 'agent-1',
      endpoint: `/${type}-surface`,
      configuration: type === GatewayType.HOSTED_CHAT ? { hostedChat: { slug: 'acme' } } : {},
    });

    beforeEach(() => {
      gatewayRepository = {
        get manager() {
          return unlimitedQuotaManager(this);
        },
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn((row: any) => ({ ...row })),
        save: jest.fn(async (row: any) => ({ ...row, id: 'gw-1' })),
        createQueryBuilder: jest.fn(() => {
          const qb: any = { where: () => qb, andWhere: () => qb, getOne: async () => null };
          return qb;
        }),
      };
      organizations = { findOne: jest.fn().mockResolvedValue({ id: 'org-1' }) };
    });

    it.each([...CHANNEL_GATEWAY_TYPES].sort())('refuses a %s gateway that names no channel, before reading or writing anything', async (type) => {
      const attempt = service().createGateway(dto(type) as any, 'org-1', 'user-1');

      await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
      await expect(attempt).rejects.toMatchObject({ response: CHANNEL_GATEWAY_NEEDS_AGENT });
      expect(organizations.findOne).not.toHaveBeenCalled();
      expect(gatewayRepository.save).not.toHaveBeenCalled();
    });

    it('makes one for the channel that publishes it', async () => {
      const gateway = await service().createGateway(dto(GatewayType.SLACK) as any, 'org-1', 'user-1', {
        forChannel: { channelId: 'channel-1' },
      });
      expect(gateway.id).toBe('gw-1');
      expect(gatewayRepository.save).toHaveBeenCalledTimes(1);
    });

    it('still makes a shared-tools gateway, which no channel owns', async () => {
      const gateway = await service().createGateway(
        { name: 'Shared', type: GatewayType.TOOLS, endpoint: '/shared', configuration: {} } as any,
        'org-1',
        'user-1',
      );
      expect(gateway.id).toBe('gw-1');
    });

    it('publishing a channel makes its gateway for that channel', async () => {
      const svc = service();
      const create = jest.spyOn(svc, 'createGateway');
      await svc.upsertForChannel(dto(GatewayType.TELEGRAM) as any, 'org-1', 'user-1', { channelId: 'channel-7', activate: false });
      expect(create).toHaveBeenCalledWith(expect.anything(), 'org-1', 'user-1', {
        initialStatus: 'inactive',
        forChannel: { channelId: 'channel-7' },
      });
      expect(gatewayRepository.save).toHaveBeenCalledTimes(1);
    });
  });

  // Held at the source: the one production caller that may say a gateway
  // is a channel's is the publish path. Anything else passing `forChannel`
  // would be a second way to make a chat surface outside an agent.
  it('passes forChannel from upsertForChannel only', () => {
    const src = join(__dirname, '..', '..', '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== 'node_modules' && name !== '__tests__' && name !== 'test') walk(path);
        } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) {
          files.push(path);
        }
      }
    };
    walk(src);
    walk(join(src, '..', 'ee'));

    const passing = files.filter((f) => /\bforChannel\s*:\s*\{/.test(readFileSync(f, 'utf8')));
    expect(passing.map((f) => relative(src, f))).toEqual(['modules/gateways/gateways.service.ts']);

    const service = readFileSync(join(src, 'modules/gateways/gateways.service.ts'), 'utf8');
    const upsert = service.slice(service.indexOf('async upsertForChannel('));
    expect(service.match(/\bforChannel\s*:\s*\{/g)).toHaveLength(1);
    expect(upsert).toMatch(/forChannel:\s*\{\s*channelId:\s*options\.channelId\s*\}/);
  });
});
