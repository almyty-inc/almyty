import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { ChannelWidgetController } from '../channel-widget.controller';
import {
  buildWidgetScript,
  sanitizeWidgetConfig,
  WIDGET_CONFIG_DEFAULTS,
  WIDGET_DEFAULT_AI_DISCLOSURE,
} from '../widget-script';
import { ChannelGatewayService } from '../channel-gateway.service';

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

    it('fetches the runtime widget-config and keeps defaults as the fetch-failure fallback', () => {
      const script = buildWidgetScript(ID_A);
      // Config hook: the script derives the config URL from the gateway
      // id at runtime — the config itself is never templated in.
      expect(script).toContain(`'/widget-config'`);
      expect(script).toContain('fetch(CONFIG_URL)');
      // Fallback: defaults are applied synchronously before the fetch,
      // and the fetch failure path leaves them in place.
      expect(script).toContain('applyConfig(DEFAULTS)');
      expect(script).toContain('/* fetch failed: defaults stay applied */');
      expect(script).toContain(`primaryColor: '#8b5cf6'`);
      // Config-derived text is applied via textContent, not markup.
      expect(script).toContain('header.textContent = c.title');
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

  describe('GET :id/widget-config', () => {
    const GATEWAY_UUID = '3e7f8f3a-4a5b-4c6d-8e9f-0a1b2c3d4e5f';

    it('returns only whitelisted presentation fields with a 60s cache header', async () => {
      channelGatewayService.findWidgetGateway.mockResolvedValueOnce({
        id: GATEWAY_UUID,
        type: 'chat_widget',
        configuration: {
          bot_token: 'super-secret-token',
          aiDisclosure: true,
          widget: {
            primaryColor: '#FF00AA',
            position: 'bottom-left',
            launcherIcon: 'chat',
            greeting: 'Hi! How can we help?',
            title: 'Northwind Support',
            theme: 'dark',
            poweredBy: false,
            apiKey: 'should-never-leak',
            onload: 'alert(1)',
          },
        },
      });

      const out = await controller.widgetConfig(GATEWAY_UUID, res as any);

      expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'public, max-age=60');
      expect(out).toEqual({
        success: true,
        data: {
          primaryColor: '#ff00aa',
          position: 'bottom-left',
          launcherIcon: 'chat',
          greeting: 'Hi! How can we help?',
          title: 'Northwind Support',
          theme: 'dark',
          aiDisclosure: WIDGET_DEFAULT_AI_DISCLOSURE,
          poweredBy: false,
        },
      });
      // Nothing outside the whitelist may leak — not credentials, not
      // unknown widget sub-keys.
      const serialized = JSON.stringify(out);
      expect(serialized).not.toContain('super-secret-token');
      expect(serialized).not.toContain('should-never-leak');
      expect(serialized).not.toContain('alert(1)');
    });

    it('404s when the gateway is not an active chat_widget gateway', async () => {
      channelGatewayService.findWidgetGateway.mockRejectedValueOnce(
        new NotFoundException('Widget gateway not found or inactive'),
      );
      await expect(controller.widgetConfig(GATEWAY_UUID, res as any)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('sanitizeWidgetConfig', () => {
    it('returns pure defaults for missing/empty/non-object configuration', () => {
      expect(sanitizeWidgetConfig(undefined)).toEqual(WIDGET_CONFIG_DEFAULTS);
      expect(sanitizeWidgetConfig(null)).toEqual(WIDGET_CONFIG_DEFAULTS);
      expect(sanitizeWidgetConfig({})).toEqual(WIDGET_CONFIG_DEFAULTS);
      expect(sanitizeWidgetConfig({ widget: 'not-an-object' })).toEqual(WIDGET_CONFIG_DEFAULTS);
      expect(sanitizeWidgetConfig({ widget: ['a'] })).toEqual(WIDGET_CONFIG_DEFAULTS);
    });

    it('defaults primaryColor to violet and falls back on invalid hex', () => {
      expect(WIDGET_CONFIG_DEFAULTS.primaryColor).toBe('#8b5cf6');
      for (const bad of ['red', '#12345g', '#1234', 'javascript:alert(1)', '8b5cf6', '#8b5cf6;x']) {
        expect(sanitizeWidgetConfig({ widget: { primaryColor: bad } }).primaryColor).toBe('#8b5cf6');
      }
    });

    it('accepts 3- and 6-digit hex colors and lowercases them', () => {
      expect(sanitizeWidgetConfig({ widget: { primaryColor: '#ABC' } }).primaryColor).toBe('#abc');
      expect(sanitizeWidgetConfig({ widget: { primaryColor: ' #22D3EE ' } }).primaryColor).toBe('#22d3ee');
    });

    it('falls back to defaults for unknown enum values', () => {
      const out = sanitizeWidgetConfig({
        widget: { position: 'top-center', launcherIcon: 'rocket', theme: 'sepia' },
      });
      expect(out.position).toBe('bottom-right');
      expect(out.launcherIcon).toBe('spark');
      expect(out.theme).toBe('auto');
    });

    it('length-caps title, greeting and disclosure strings', () => {
      const out = sanitizeWidgetConfig({
        aiDisclosure: 'd'.repeat(500),
        widget: { title: 't'.repeat(200), greeting: 'g'.repeat(1000) },
      });
      expect(out.title).toHaveLength(60);
      expect(out.greeting).toHaveLength(300);
      expect(out.aiDisclosure).toHaveLength(200);
    });

    it('drops unknown fields entirely (strict whitelist output shape)', () => {
      const out = sanitizeWidgetConfig({
        widget: { customCss: 'body{}', script: 'x', primaryColor: '#123456' },
      });
      expect(Object.keys(out).sort()).toEqual([
        'aiDisclosure',
        'greeting',
        'launcherIcon',
        'position',
        'poweredBy',
        'primaryColor',
        'theme',
        'title',
      ]);
      expect(out.primaryColor).toBe('#123456');
    });

    it('passes the channel aiDisclosure through: true = default line, string = custom', () => {
      expect(sanitizeWidgetConfig({}).aiDisclosure).toBeNull();
      expect(sanitizeWidgetConfig({ aiDisclosure: false }).aiDisclosure).toBeNull();
      expect(sanitizeWidgetConfig({ aiDisclosure: true }).aiDisclosure).toBe(
        WIDGET_DEFAULT_AI_DISCLOSURE,
      );
      expect(sanitizeWidgetConfig({ aiDisclosure: '  Custom AI note  ' }).aiDisclosure).toBe(
        'Custom AI note',
      );
    });

    it('never drifts from the dispatch-path default disclosure line', () => {
      expect(WIDGET_DEFAULT_AI_DISCLOSURE).toBe(ChannelGatewayService.DEFAULT_AI_DISCLOSURE);
    });

    it('ignores an empty/whitespace title so the default stays', () => {
      expect(sanitizeWidgetConfig({ widget: { title: '   ' } }).title).toBe('Chat with us');
    });
  });
});
