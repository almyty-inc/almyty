import { BadRequestException, HttpException } from '@nestjs/common';
import { ChannelWidgetController } from '../channel-widget.controller';

/**
 * Unit coverage for the public chat-widget surface. The controller is
 * deliberately thin — gateway resolution, run handling and message
 * persistence live in ChannelGatewayService — so these tests focus on
 * input validation, rate limiting, and delegation.
 */
describe('ChannelWidgetController', () => {
  let channelGatewayService: {
    findWidgetGateway: jest.Mock;
    handleWidgetMessage: jest.Mock;
    listWidgetMessages: jest.Mock;
  };
  let gatewayRateLimit: { check: jest.Mock };
  let controller: ChannelWidgetController;
  let res: { setHeader: jest.Mock };

  const gateway = { id: 'gw-1', type: 'chat_widget' };

  beforeEach(() => {
    channelGatewayService = {
      findWidgetGateway: jest.fn(async () => gateway),
      handleWidgetMessage: jest.fn(async () => ({ runId: 'run-1', threadId: 'thread-1' })),
      listWidgetMessages: jest.fn(async () => [
        { id: 'e1', runId: 'run-1', message: 'hello', attachments: null, createdAt: new Date() },
      ]),
    };
    gatewayRateLimit = { check: jest.fn(async () => ({ limited: false })) };
    controller = new ChannelWidgetController(
      channelGatewayService as any,
      gatewayRateLimit as any,
    );
    res = { setHeader: jest.fn() };
  });

  describe('POST :id/widget/messages', () => {
    it('resolves the gateway, delegates, and returns runId + threadId', async () => {
      const out = await controller.postMessage(
        'gw-1',
        { message: '  hi there  ', threadId: 'thread-1' },
        res as any,
      );
      expect(channelGatewayService.findWidgetGateway).toHaveBeenCalledWith('gw-1');
      expect(channelGatewayService.handleWidgetMessage).toHaveBeenCalledWith(gateway, {
        message: 'hi there',
        sessionId: undefined,
        threadId: 'thread-1',
      });
      expect(out).toEqual({ success: true, data: { runId: 'run-1', threadId: 'thread-1' } });
    });

    it('rejects an empty or missing message', async () => {
      await expect(controller.postMessage('gw-1', {}, res as any)).rejects.toThrow(BadRequestException);
      await expect(controller.postMessage('gw-1', { message: '   ' }, res as any)).rejects.toThrow(
        BadRequestException,
      );
      expect(channelGatewayService.handleWidgetMessage).not.toHaveBeenCalled();
    });

    it('rejects an oversized message', async () => {
      await expect(
        controller.postMessage('gw-1', { message: 'x'.repeat(4001) }, res as any),
      ).rejects.toThrow(/too long/);
    });

    it('enforces per-gateway rate limits with Retry-After', async () => {
      gatewayRateLimit.check.mockResolvedValueOnce({
        limited: true,
        retryAfterSeconds: 30,
        message: 'Gateway rate limit exceeded',
      });
      await expect(controller.postMessage('gw-1', { message: 'hi' }, res as any)).rejects.toThrow(
        HttpException,
      );
      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '30');
      expect(channelGatewayService.handleWidgetMessage).not.toHaveBeenCalled();
    });
  });

  describe('GET :id/widget/messages', () => {
    it('requires threadId', async () => {
      await expect(controller.listMessages('gw-1', undefined, undefined)).rejects.toThrow(
        /threadId is required/,
      );
    });

    it('rejects an unparseable `after` timestamp', async () => {
      await expect(controller.listMessages('gw-1', 't1', 'not-a-date')).rejects.toThrow(
        /ISO-8601/,
      );
    });

    it('returns the persisted messages for a thread', async () => {
      const out = await controller.listMessages('gw-1', 't1', undefined);
      expect(channelGatewayService.findWidgetGateway).toHaveBeenCalledWith('gw-1');
      expect(channelGatewayService.listWidgetMessages).toHaveBeenCalledWith('gw-1', 't1', undefined);
      expect(out.success).toBe(true);
      expect(out.data).toHaveLength(1);
      expect(out.data[0].message).toBe('hello');
    });

    it('passes a parsed `after` date through for incremental polls', async () => {
      await controller.listMessages('gw-1', 't1', '2026-07-01T10:00:00Z');
      const after = channelGatewayService.listWidgetMessages.mock.calls[0][2];
      expect(after).toBeInstanceOf(Date);
      expect(after.toISOString()).toBe('2026-07-01T10:00:00.000Z');
    });
  });
});
