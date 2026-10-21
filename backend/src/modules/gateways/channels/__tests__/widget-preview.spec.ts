import { NotFoundException } from '@nestjs/common';
import { runInNewContext } from 'vm';
import { ChannelWidgetController } from '../channel-widget.controller';
import { WIDGET_PREVIEW_PAGE, WIDGET_PREVIEW_SCRIPT, widgetPreviewCsp } from '../widget-preview';
import { snapshotEnv } from '../../../../test/env';

/**
 * The dashboard's live widget preview. It used to be an srcdoc iframe with
 * an inline shim and widget.js from the API host; an srcdoc document
 * inherits the dashboard's CSP, which allows neither, so in production the
 * preview never ran. It is now a page on the API origin with its own policy.
 */
describe('widget preview', () => {
  const GATEWAY_UUID = '3e7f8f3a-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
  let findWidgetGateway: jest.Mock;
  let controller: ChannelWidgetController;

  const makeRes = () => {
    const headers: Record<string, string> = { 'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': "frame-ancestors 'self'" };
    return {
      headers,
      setHeader: jest.fn((k: string, v: string) => { headers[k] = v; }),
      removeHeader: jest.fn((k: string) => { delete headers[k]; }),
      send: jest.fn(),
    };
  };

  let restoreEnvVars: () => void;

  beforeEach(() => {
    restoreEnvVars = snapshotEnv('FRONTEND_URL', 'CORS_ALLOWED_ORIGINS');
    findWidgetGateway = jest.fn(async () => ({ id: GATEWAY_UUID, type: 'chat_widget' }));
    controller = new ChannelWidgetController({ findWidgetGateway } as any, {} as any);
  });

  afterEach(() => restoreEnvVars());

  describe('GET :id/widget-preview', () => {
    it('serves a page with no inline script that loads the shim, then widget.js, from this origin', async () => {
      const res = makeRes();
      await controller.widgetPreview(GATEWAY_UUID, res as any);

      expect(findWidgetGateway).toHaveBeenCalledWith(GATEWAY_UUID);
      expect(res.headers['Content-Type']).toBe('text/html; charset=utf-8');
      const page: string = res.send.mock.calls[0][0];
      expect(page).toBe(WIDGET_PREVIEW_PAGE);
      const scripts = [...page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
      expect(scripts.map((m) => m[1].trim())).toEqual(['src="widget-preview.js"', 'src="widget.js"']);
      expect(scripts.every((m) => m[2] === '')).toBe(true);
    });

    it('lets the dashboard frame it, and no one else', async () => {
      process.env.FRONTEND_URL = 'https://app.example.org';
      process.env.CORS_ALLOWED_ORIGINS = 'https://admin.example.org/, not an origin';
      const res = makeRes();
      await controller.widgetPreview(GATEWAY_UUID, res as any);

      expect(res.removeHeader).toHaveBeenCalledWith('X-Frame-Options');
      expect(res.headers['X-Frame-Options']).toBeUndefined();
      const csp = res.headers['Content-Security-Policy'];
      const ancestors = csp.split('; ').find((d) => d.startsWith('frame-ancestors '))!.split(' ').slice(1);
      expect(ancestors).toEqual(expect.arrayContaining(["'self'", 'https://app.example.org', 'https://admin.example.org']));
      expect(ancestors).not.toContain('not');
      expect(ancestors).not.toContain('*');
    });

    it('404s unless the gateway is an active chat widget', async () => {
      findWidgetGateway.mockRejectedValueOnce(new NotFoundException('Widget not found'));
      const res = makeRes();
      await expect(controller.widgetPreview(GATEWAY_UUID, res as any)).rejects.toThrow(NotFoundException);
      expect(res.send).not.toHaveBeenCalled();
    });
  });

  describe('GET :id/widget-preview.js', () => {
    it('serves the shim as public javascript the sandboxed frame may load', async () => {
      const res = makeRes();
      await controller.widgetPreviewScript(GATEWAY_UUID, res as any);

      expect(res.headers['Content-Type']).toBe('application/javascript; charset=utf-8');
      expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
      expect(res.headers['Cross-Origin-Resource-Policy']).toBe('cross-origin');
      expect(res.send).toHaveBeenCalledWith(WIDGET_PREVIEW_SCRIPT);
    });

    it('404s unless the gateway is an active chat widget', async () => {
      findWidgetGateway.mockRejectedValueOnce(new NotFoundException('Widget not found'));
      await expect(controller.widgetPreviewScript(GATEWAY_UUID, makeRes() as any)).rejects.toThrow(NotFoundException);
    });
  });

  describe('widgetPreviewCsp', () => {
    const directive = (csp: string, name: string) =>
      csp.split('; ').find((d) => d.startsWith(name + ' '))!.split(' ').slice(1);

    it('runs only scripts and requests of this origin', () => {
      const csp = widgetPreviewCsp([]);
      expect(directive(csp, 'default-src')).toEqual(["'none'"]);
      expect(directive(csp, 'script-src')).toEqual(["'self'"]);
      expect(directive(csp, 'connect-src')).toEqual(["'self'"]);
      expect(directive(csp, 'frame-ancestors')).toEqual(["'self'"]);
    });

    it('writes only bare origins into frame-ancestors', () => {
      const csp = widgetPreviewCsp([
        'https://app.example.org/',
        'http://localhost:3002',
        "https://x.example; script-src 'unsafe-inline'",
        'https://*.example.org',
        'https://app.example.org',
      ]);
      expect(directive(csp, 'frame-ancestors')).toEqual(["'self'", 'https://app.example.org', 'http://localhost:3002']);
      expect(directive(csp, 'script-src')).toEqual(["'self'"]);
    });
  });

  describe('the shim', () => {
    /** Runs the shim in a stub window, the way the page would before widget.js. */
    const run = (hash: string) => {
      const listeners: Record<string, () => void> = {};
      const realFetch = jest.fn(async () => 'network');
      const window: any = {
        location: { hash },
        fetch: realFetch,
        addEventListener: (type: string, fn: () => void) => { listeners[type] = fn; },
      };
      const document = { documentElement: { style: {} as Record<string, string> }, querySelector: jest.fn() };
      class FakeResponse {
        constructor(readonly body: string, readonly init: unknown) {}
      }
      runInNewContext(WIDGET_PREVIEW_SCRIPT, { window, document, Response: FakeResponse, JSON, decodeURIComponent, Promise, setTimeout });
      return { window, document, realFetch };
    };
    const fragment = (config: unknown) => '#' + encodeURIComponent(JSON.stringify(config));

    it('answers the widget-config request with the config from the fragment', async () => {
      const config = { title: 'Northwind', position: 'bottom-left', theme: 'dark' };
      const { window, document, realFetch } = run(fragment(config));

      const answer = await window.fetch(`https://api.test/gateways/${GATEWAY_UUID}/widget-config`);
      expect(JSON.parse(answer.body)).toEqual({ success: true, data: config });
      expect(realFetch).not.toHaveBeenCalled();
      expect(document.documentElement.style.background).toBe('#09090b');

      await expect(window.fetch(`https://api.test/gateways/${GATEWAY_UUID}/widget/messages`)).resolves.toBe('network');
      expect(realFetch).toHaveBeenCalledTimes(1);
    });

    it('leaves fetch alone without a usable config', () => {
      for (const hash of ['', '#not-json', fragment([1, 2]), fragment('text'), fragment(null)]) {
        const { window, realFetch } = run(hash);
        expect(window.fetch).toBe(realFetch);
      }
    });
  });
});
