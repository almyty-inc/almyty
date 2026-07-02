import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { ChannelWidgetController } from '../channel-widget.controller';
import { buildWidgetScript } from '../widget-script';

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

  describe('GET :id/widget.js', () => {
    const GATEWAY_UUID = '3e7f8f3a-4a5b-4c6d-8e9f-0a1b2c3d4e5f';

    const makeScriptRes = () => ({
      setHeader: jest.fn(),
      send: jest.fn(),
    });

    it('serves the embed script with a javascript content-type and cache headers', async () => {
      const scriptRes = makeScriptRes();
      await controller.widgetScript(GATEWAY_UUID, scriptRes as any);

      expect(channelGatewayService.findWidgetGateway).toHaveBeenCalledWith(GATEWAY_UUID);
      expect(scriptRes.setHeader).toHaveBeenCalledWith(
        'Content-Type',
        'application/javascript; charset=utf-8',
      );
      expect(scriptRes.setHeader).toHaveBeenCalledWith('Cache-Control', 'public, max-age=300');
      const script = scriptRes.send.mock.calls[0][0];
      expect(script).toContain(GATEWAY_UUID);
      expect(script).toContain('almyty-widget-bubble');
    });

    it('404s when the gateway is not an active chat_widget gateway', async () => {
      channelGatewayService.findWidgetGateway.mockRejectedValueOnce(
        new NotFoundException('Widget gateway not found or inactive'),
      );
      const scriptRes = makeScriptRes();
      await expect(controller.widgetScript(GATEWAY_UUID, scriptRes as any)).rejects.toThrow(
        NotFoundException,
      );
      expect(scriptRes.send).not.toHaveBeenCalled();
    });
  });

  describe('buildWidgetScript', () => {
    const ID_A = '3e7f8f3a-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
    const ID_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    it('injects the gateway id and nothing else (no template injection surface)', () => {
      // If the id is the ONLY dynamic content, swapping it must yield
      // exactly the script built for the other id.
      const a = buildWidgetScript(ID_A);
      const b = buildWidgetScript(ID_B);
      expect(a.split(ID_A).join(ID_B)).toBe(b);
    });

    it('rejects a non-UUID id (defense in depth behind the ParseUUIDPipe)', () => {
      expect(() => buildWidgetScript('</script><script>alert(1)</script>')).toThrow(
        /invalid gateway id/,
      );
    });

    it('persists the visitor thread id in a namespaced localStorage key', () => {
      const script = buildWidgetScript(ID_A);
      expect(script).toContain(`'almyty-widget-' + GATEWAY_ID + '-thread'`);
    });

    it('renders message text via textContent only (XSS-safe)', () => {
      const script = buildWidgetScript(ID_A);
      expect(script).toContain('el.textContent = text');
      expect(script).not.toContain('innerHTML');
    });

    it('stays comfortably under the 15KB embed budget', () => {
      expect(Buffer.byteLength(buildWidgetScript(ID_A), 'utf-8')).toBeLessThan(15 * 1024);
    });
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
