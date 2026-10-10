/**
 * The live preview of the chat widget, as the dashboard shows it.
 *
 * The dashboard frames this page from the API origin (an iframe with a real
 * URL), not as an srcdoc document: an srcdoc document inherits the dashboard's
 * CSP, whose script-src admits neither an inline script nor the API host, so
 * the preview never ran. Served from here, both scripts are this origin's own
 * files and the page carries a policy of its own.
 *
 *   GET /gateways/:id/widget-preview      this page
 *   GET /gateways/:id/widget-preview.js   the preview shim, then widget.js
 *
 * The dashboard passes the look and the unsaved placement in the URL
 * fragment, which never reaches the server. The shim answers the widget's
 * own /widget-config request with it, and widget.js validates every field
 * as it would the real response, so a crafted fragment can only produce a
 * widget the real endpoint could have produced.
 */

/** The page: nothing inline but its style; both scripts are files on this origin. */
export const WIDGET_PREVIEW_PAGE = [
  '<!doctype html>',
  '<html lang="en">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<meta name="robots" content="noindex">',
  '<title>Chat widget preview</title>',
  '<style>html,body{margin:0;height:100%;background:#f4f4f5}</style>',
  '</head>',
  '<body>',
  '<script src="widget-preview.js"></script>',
  '<script src="widget.js"></script>',
  '</body>',
  '</html>',
  '',
].join('\n');

/**
 * Runs before widget.js: reads the config from the fragment, shims only the
 * widget-config fetch, sets the page background for the theme, and opens the
 * panel once the widget has drawn its bubble.
 */
export const WIDGET_PREVIEW_SCRIPT = `(function () {
  'use strict';
  var config = null;
  try {
    var parsed = JSON.parse(decodeURIComponent(window.location.hash.slice(1)));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed;
  } catch (e) { config = null; }
  if (config) {
    var payload = JSON.stringify({ success: true, data: config });
    var orig = window.fetch;
    window.fetch = function (input) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.indexOf('/widget-config') !== -1) {
        return Promise.resolve(new Response(payload, { headers: { 'Content-Type': 'application/json' } }));
      }
      return orig.apply(window, arguments);
    };
    if (config.theme === 'dark') document.documentElement.style.background = '#09090b';
  }
  window.addEventListener('load', function () {
    setTimeout(function () {
      var bubble = document.querySelector('.almyty-widget-bubble');
      if (bubble) bubble.click();
    }, 150);
  });
})();
`;

const ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;

/**
 * The page's own policy. Scripts and requests stay on this origin (widget-
 * config is answered by the shim; messages go to the same API); the inline
 * style the widget injects needs 'unsafe-inline' for styles only. Only the
 * dashboard may frame it: `dashboardOrigins` are the API's trusted browser
 * origins, and anything that is not a bare origin is dropped rather than
 * written into the header.
 */
export function widgetPreviewCsp(dashboardOrigins: Iterable<string>): string {
  const ancestors = [...dashboardOrigins].map((o) => o.trim().replace(/\/$/, '')).filter((o) => ORIGIN.test(o));
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    `frame-ancestors 'self' ${[...new Set(ancestors)].join(' ')}`.trim(),
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}
