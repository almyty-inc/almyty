/**
 * Self-contained embed script served at GET /gateways/:id/widget.js,
 * plus the strict whitelist sanitizer behind the public
 * GET /gateways/:id/widget-config endpoint.
 *
 * Design constraints:
 *   - vanilla JS/CSS, zero dependencies, < 15 KB
 *   - everything namespaced almyty-widget-* so it cannot collide with
 *     the host page
 *   - ALL message and config text rendered via textContent (never
 *     innerHTML with user/agent/config data) — agent replies, visitor
 *     input AND the widget configuration are untrusted
 *   - the ONLY gateway-derived value injected into the script is the
 *     gateway id, and the route validates it as a UUID before this
 *     builder runs, so template injection is structurally impossible.
 *     Presentation config (colors, title, greeting, theme, ...) is
 *     fetched at runtime from the widget-config endpoint and
 *     re-validated client-side before use; if that fetch fails the
 *     widget falls back to the built-in defaults and stays functional.
 *   - the visitor-side threadId is persisted in localStorage on the
 *     CUSTOMER'S site. This is a random, unguessable conversation key
 *     for an anonymous visitor — not an almyty auth token (almyty auth
 *     stays in httpOnly cookies; that rule is unaffected here).
 *
 * The script talks to the existing public widget surface:
 *   GET  /gateways/:id/widget-config              sanitized presentation config
 *   POST /gateways/:id/widget/messages            { message, threadId? }
 *   GET  /gateways/:id/widget/messages?threadId=&after=
 */

export type WidgetPosition = 'bottom-right' | 'bottom-left';
export type WidgetLauncherIcon = 'chat' | 'help' | 'spark';
export type WidgetTheme = 'dark' | 'light' | 'auto';

/** Everything the public widget-config endpoint is allowed to return. */
export interface WidgetPublicConfig {
  primaryColor: string;
  position: WidgetPosition;
  launcherIcon: WidgetLauncherIcon;
  greeting: string;
  title: string;
  theme: WidgetTheme;
  aiDisclosure: string | null;
  poweredBy: boolean;
}

export const WIDGET_TITLE_MAX = 60;
export const WIDGET_GREETING_MAX = 300;
export const WIDGET_DISCLOSURE_MAX = 200;

/**
 * Mirrors ChannelGatewayService.DEFAULT_AI_DISCLOSURE — kept as a local
 * constant so this module stays dependency-free; a unit test asserts the
 * two never drift apart.
 */
export const WIDGET_DEFAULT_AI_DISCLOSURE = 'You are chatting with an AI assistant.';

export const WIDGET_CONFIG_DEFAULTS: WidgetPublicConfig = Object.freeze({
  primaryColor: '#8b5cf6',
  position: 'bottom-right' as WidgetPosition,
  launcherIcon: 'spark' as WidgetLauncherIcon,
  greeting: '',
  title: 'Chat with us',
  theme: 'auto' as WidgetTheme,
  aiDisclosure: null,
  poweredBy: true,
});

const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const POSITIONS: readonly WidgetPosition[] = ['bottom-right', 'bottom-left'];
const ICONS: readonly WidgetLauncherIcon[] = ['chat', 'help', 'spark'];
const THEMES: readonly WidgetTheme[] = ['dark', 'light', 'auto'];

/**
 * Strict whitelist over `gateway.configuration.widget`.
 *
 * The gateways update DTO deliberately accepts free-form `configuration`
 * jsonb (channel adapters store arbitrary credential keys in it), so the
 * public whitelist is enforced HERE, on the read path: only these eight
 * known-safe presentation fields can ever leave the server. Everything
 * else in configuration (bot tokens, secrets, webhook URLs, unknown
 * widget sub-keys) is dropped. Invalid values fall back to the defaults
 * rather than erroring — the widget must always render.
 */
export function sanitizeWidgetConfig(
  configuration: Record<string, any> | null | undefined,
): WidgetPublicConfig {
  const out: WidgetPublicConfig = { ...WIDGET_CONFIG_DEFAULTS };
  const cfg = configuration && typeof configuration === 'object' ? configuration : {};
  const raw = (cfg as any).widget;

  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (typeof raw.primaryColor === 'string' && HEX_COLOR.test(raw.primaryColor.trim())) {
      out.primaryColor = raw.primaryColor.trim().toLowerCase();
    }
    if (POSITIONS.includes(raw.position)) out.position = raw.position;
    if (ICONS.includes(raw.launcherIcon)) out.launcherIcon = raw.launcherIcon;
    if (typeof raw.greeting === 'string') {
      out.greeting = raw.greeting.trim().slice(0, WIDGET_GREETING_MAX);
    }
    if (typeof raw.title === 'string' && raw.title.trim()) {
      out.title = raw.title.trim().slice(0, WIDGET_TITLE_MAX);
    }
    if (THEMES.includes(raw.theme)) out.theme = raw.theme;
    if (typeof raw.poweredBy === 'boolean') out.poweredBy = raw.poweredBy;
  }

  // aiDisclosure passthrough: the channel-level EU AI Act setting
  // (configuration.aiDisclosure) is surfaced so the widget can show the
  // disclosure line in its UI. Same semantics as
  // ChannelGatewayService.applyAiDisclosure: true = default line,
  // non-empty string = custom override.
  const disclosure = (cfg as any).aiDisclosure;
  if (disclosure === true) {
    out.aiDisclosure = WIDGET_DEFAULT_AI_DISCLOSURE;
  } else if (typeof disclosure === 'string' && disclosure.trim()) {
    out.aiDisclosure = disclosure.trim().slice(0, WIDGET_DISCLOSURE_MAX);
  }

  return out;
}

export function buildWidgetScript(gatewayId: string): string {
  // Defense in depth: the controller already ParseUUIDPipe-validates,
  // but never emit anything that isn't a plain UUID into JS source.
  if (!/^[0-9a-fA-F-]{36}$/.test(gatewayId)) {
    throw new Error('invalid gateway id for widget script');
  }

  return `(function () {
  'use strict';
  if (window.__almytyWidgetLoaded) return;
  window.__almytyWidgetLoaded = true;

  var GATEWAY_ID = ${JSON.stringify(gatewayId)};
  var script = document.currentScript;
  var base = '';
  try {
    var src = (script && script.src) || '';
    base = src.split('/gateways/')[0];
  } catch (e) { base = ''; }
  var API = base + '/gateways/' + GATEWAY_ID + '/widget/messages';
  var CONFIG_URL = base + '/gateways/' + GATEWAY_ID + '/widget-config';
  var LS_KEY = 'almyty-widget-' + GATEWAY_ID + '-thread';

  var threadId = null;
  try { threadId = window.localStorage.getItem(LS_KEY); } catch (e) {}
  var lastAt = null;
  var pollTimer = null;
  var open = false;
  var greeted = false;

  // Built-in defaults; the widget-config fetch below only overrides
  // values that pass client-side validation, so a failed or malformed
  // fetch leaves a fully working widget.
  var DEFAULTS = {
    primaryColor: '#8b5cf6',
    position: 'bottom-right',
    launcherIcon: 'spark',
    greeting: '',
    title: 'Chat with us',
    theme: 'auto',
    aiDisclosure: null,
    poweredBy: true
  };
  var cfg = DEFAULTS;

  var css = [
    '.almyty-widget-root{--aw-primary:#8b5cf6;--aw-panel-bg:#fff;--aw-msgs-bg:#fafafa;--aw-agent-bg:#ececf1;',
    '--aw-agent-fg:#1a1a1a;--aw-border:#e5e5e5;--aw-text:#1a1a1a;--aw-muted:#8a8a93}',
    '.almyty-widget-root.almyty-widget-dark{--aw-panel-bg:#18181b;--aw-msgs-bg:#101012;--aw-agent-bg:#27272a;',
    '--aw-agent-fg:#e4e4e7;--aw-border:#27272a;--aw-text:#e4e4e7}',
    '.almyty-widget-bubble{position:fixed;bottom:20px;right:20px;width:56px;height:56px;border-radius:50%;',
    'background:linear-gradient(135deg,var(--aw-primary),#0891B2);color:#fff;border:none;cursor:pointer;z-index:2147483000;',
    'box-shadow:0 4px 14px rgba(0,0,0,.25);font-size:24px;line-height:56px;text-align:center;padding:0}',
    '.almyty-widget-root.almyty-widget-left .almyty-widget-bubble{right:auto;left:20px}',
    '.almyty-widget-bubble svg{vertical-align:middle}',
    '.almyty-widget-panel{position:fixed;bottom:88px;right:20px;width:340px;max-width:calc(100vw - 40px);height:440px;',
    'max-height:calc(100vh - 120px);background:var(--aw-panel-bg);border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.25);',
    'display:none;flex-direction:column;overflow:hidden;z-index:2147483000;font-family:system-ui,-apple-system,sans-serif}',
    '.almyty-widget-root.almyty-widget-left .almyty-widget-panel{right:auto;left:20px}',
    '.almyty-widget-panel.almyty-widget-open{display:flex}',
    '.almyty-widget-header{background:var(--aw-primary);color:#fff;padding:12px 16px;font-size:14px;font-weight:600}',
    '.almyty-widget-note{font-size:11px;color:var(--aw-muted);padding:6px 12px 0;background:var(--aw-msgs-bg)}',
    '.almyty-widget-messages{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:var(--aw-msgs-bg)}',
    '.almyty-widget-msg{max-width:85%;padding:8px 12px;border-radius:10px;font-size:13px;line-height:1.45;',
    'white-space:pre-wrap;word-break:break-word}',
    '.almyty-widget-msg-user{align-self:flex-end;background:var(--aw-primary);color:#fff}',
    '.almyty-widget-msg-agent{align-self:flex-start;background:var(--aw-agent-bg);color:var(--aw-agent-fg)}',
    '.almyty-widget-form{display:flex;border-top:1px solid var(--aw-border);background:var(--aw-panel-bg)}',
    '.almyty-widget-input{flex:1;border:none;outline:none;padding:12px;font-size:13px;font-family:inherit;background:transparent;color:var(--aw-text)}',
    '.almyty-widget-send{border:none;background:none;color:var(--aw-primary);font-weight:600;font-size:13px;cursor:pointer;padding:0 14px}',
    '.almyty-widget-footer{font-size:10px;text-align:center;color:var(--aw-muted);padding:4px 0 6px;background:var(--aw-panel-bg)}'
  ].join('');

  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  var root = document.createElement('div');
  root.className = 'almyty-widget-root';

  var bubble = document.createElement('button');
  bubble.className = 'almyty-widget-bubble';
  bubble.type = 'button';
  bubble.setAttribute('aria-label', 'Open chat');

  var panel = document.createElement('div');
  panel.className = 'almyty-widget-panel';

  var header = document.createElement('div');
  header.className = 'almyty-widget-header';

  var note = document.createElement('div');
  note.className = 'almyty-widget-note';
  note.style.display = 'none';

  var messages = document.createElement('div');
  messages.className = 'almyty-widget-messages';

  var form = document.createElement('form');
  form.className = 'almyty-widget-form';
  var input = document.createElement('input');
  input.className = 'almyty-widget-input';
  input.type = 'text';
  input.maxLength = 4000;
  input.placeholder = 'Type a message\\u2026';
  var send = document.createElement('button');
  send.className = 'almyty-widget-send';
  send.type = 'submit';
  send.textContent = 'Send';
  form.appendChild(input);
  form.appendChild(send);

  var footer = document.createElement('div');
  footer.className = 'almyty-widget-footer';
  footer.textContent = 'powered by almyty';

  panel.appendChild(header);
  panel.appendChild(note);
  panel.appendChild(messages);
  panel.appendChild(form);
  panel.appendChild(footer);
  root.appendChild(panel);
  root.appendChild(bubble);
  document.body.appendChild(root);

  function addMessage(text, who) {
    var el = document.createElement('div');
    el.className = 'almyty-widget-msg almyty-widget-msg-' + who;
    el.textContent = text; // textContent only — never inject HTML
    messages.appendChild(el);
    messages.scrollTop = messages.scrollHeight;
  }

  function setIcon(kind) {
    while (bubble.firstChild) bubble.removeChild(bubble.firstChild);
    if (kind === 'help') { bubble.appendChild(document.createTextNode('?')); return; }
    if (kind === 'chat') {
      var NS = 'http://www.w3.org/2000/svg';
      var svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', '26');
      svg.setAttribute('height', '26');
      svg.setAttribute('fill', 'currentColor');
      svg.setAttribute('aria-hidden', 'true');
      var path = document.createElementNS(NS, 'path');
      path.setAttribute('d', 'M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 5V5a2 2 0 0 1 2-2z');
      svg.appendChild(path);
      bubble.appendChild(svg);
      return;
    }
    bubble.appendChild(document.createTextNode('\\u2726'));
  }

  function isDark(theme) {
    if (theme === 'dark') return true;
    if (theme === 'light') return false;
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch (e) { return false; }
  }

  // Client-side re-validation of the fetched config. The server
  // whitelists already; the widget still never trusts its input.
  function pickConfig(c) {
    var m = {};
    for (var k in DEFAULTS) m[k] = DEFAULTS[k];
    if (!c || typeof c !== 'object') return m;
    if (typeof c.primaryColor === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c.primaryColor)) m.primaryColor = c.primaryColor;
    if (c.position === 'bottom-left' || c.position === 'bottom-right') m.position = c.position;
    if (c.launcherIcon === 'chat' || c.launcherIcon === 'help' || c.launcherIcon === 'spark') m.launcherIcon = c.launcherIcon;
    if (typeof c.greeting === 'string') m.greeting = c.greeting.slice(0, 300);
    if (typeof c.title === 'string' && c.title) m.title = c.title.slice(0, 60);
    if (c.theme === 'dark' || c.theme === 'light' || c.theme === 'auto') m.theme = c.theme;
    if (typeof c.aiDisclosure === 'string' && c.aiDisclosure) m.aiDisclosure = c.aiDisclosure.slice(0, 200);
    if (typeof c.poweredBy === 'boolean') m.poweredBy = c.poweredBy;
    return m;
  }

  function applyConfig(c) {
    cfg = c;
    root.style.setProperty('--aw-primary', c.primaryColor);
    root.className = 'almyty-widget-root' +
      (c.position === 'bottom-left' ? ' almyty-widget-left' : '') +
      (isDark(c.theme) ? ' almyty-widget-dark' : '');
    header.textContent = c.title;
    setIcon(c.launcherIcon);
    note.textContent = c.aiDisclosure || '';
    note.style.display = c.aiDisclosure ? 'block' : 'none';
    footer.style.display = c.poweredBy ? 'block' : 'none';
    if (c.greeting && !greeted) {
      greeted = true;
      addMessage(c.greeting, 'agent');
    }
  }

  applyConfig(DEFAULTS);

  fetch(CONFIG_URL).then(function (r) {
    if (!r.ok) throw new Error('widget-config ' + r.status);
    return r.json();
  }).then(function (out) {
    applyConfig(pickConfig(out && out.data));
  }).catch(function () { /* fetch failed: defaults stay applied */ });

  function poll() {
    if (!threadId) return;
    var url = API + '?threadId=' + encodeURIComponent(threadId);
    if (lastAt) url += '&after=' + encodeURIComponent(lastAt);
    fetch(url).then(function (r) { return r.json(); }).then(function (out) {
      var items = (out && out.data) || [];
      for (var i = 0; i < items.length; i++) {
        addMessage(String(items[i].message || ''), 'agent');
        lastAt = items[i].createdAt;
      }
    }).catch(function () {});
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = window.setInterval(poll, 2500);
  }
  function stopPolling() {
    if (pollTimer) { window.clearInterval(pollTimer); pollTimer = null; }
  }

  bubble.addEventListener('click', function () {
    open = !open;
    panel.className = 'almyty-widget-panel' + (open ? ' almyty-widget-open' : '');
    bubble.setAttribute('aria-label', open ? 'Close chat' : 'Open chat');
    if (open) { input.focus(); poll(); startPolling(); } else { stopPolling(); }
  });

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var text = input.value.replace(/^\\s+|\\s+$/g, '');
    if (!text) return;
    input.value = '';
    addMessage(text, 'user');
    fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, threadId: threadId || undefined })
    }).then(function (r) { return r.json(); }).then(function (out) {
      var data = out && out.data;
      if (data && data.threadId && data.threadId !== threadId) {
        threadId = data.threadId;
        try { window.localStorage.setItem(LS_KEY, threadId); } catch (e) {}
      }
      startPolling();
    }).catch(function () {
      addMessage('Message could not be sent. Please try again.', 'agent');
    });
  });
})();
`;
}