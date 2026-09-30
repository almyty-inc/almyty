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
 *   POST /gateways/:id/widget/messages            { message, threadId?, attachmentIds? }
 *   POST /gateways/:id/widget/attachments         multipart: file, threadId (a file to send next)
 *   GET  /gateways/:id/widget/messages?threadId=&after=
 *   GET  /gateways/:id/widget/threads/:threadId/export   the visitor's own copy
 *   DELETE /gateways/:id/widget/threads/:threadId        erase the conversation
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
  /** The agent lets visitors delete their conversation (its privacy setting). */
  visitorCanDelete: boolean;
  /** The agent lets visitors download their conversation. */
  visitorCanExport: boolean;
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
  // The visitor privacy defaults (VISITOR_PRIVACY_DEFAULTS): visitors may
  // delete and download their own conversation unless the agent turns that off.
  visitorCanDelete: true,
  visitorCanExport: true,
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

/** The channel a widget is, as far as its look and visitor rights go (resolved from its agent). */
export interface WidgetOwner {
  name: string;
  /** The channel's AI disclosure switch is off: the widget shows no disclosure line. */
  disclosureOff?: boolean;
  branding?: {
    appName?: string;
    primaryColor?: string;
    greeting?: string;
    theme?: string;
    aiDisclosure?: string | null;
    whiteLabel?: boolean;
  } | null;
  /** The visitor privacy settings; a missing flag is the default (allowed). */
  privacy?: { visitorCanDelete?: boolean; visitorCanExport?: boolean } | null;
}

/**
 * What the public widget-config endpoint answers for a widget.
 *
 * Branding has one home, the agent (overridden per channel): a widget
 * channel takes its colour, name, greeting, theme, AI disclosure line and
 * almyty mark from there, read on every request, and keeps only where it
 * sits on the page and which launcher icon it shows. The disclosure line is
 * always shown on a channel's widget (its own wording, or the default). A
 * widget no channel owns keeps its own block, sanitized the same way.
 *
 * What visitors may do with their conversation is the agent's privacy
 * setting too, so the widget offers "Download" and "Delete" exactly when
 * the endpoints behind them would allow it.
 */
export function widgetConfigFor(
  configuration: Record<string, any> | null | undefined,
  owner: WidgetOwner | null,
): WidgetPublicConfig {
  const own = sanitizeWidgetConfig(configuration);
  if (!owner) return own;
  const branding = owner.branding ?? {};
  const look = sanitizeWidgetConfig({
    widget: {
      primaryColor: branding.primaryColor,
      title: branding.appName || owner.name,
      greeting: branding.greeting,
      theme: branding.theme,
      poweredBy: !branding.whiteLabel,
    },
    aiDisclosure: owner.disclosureOff
      ? false
      : typeof branding.aiDisclosure === 'string' && branding.aiDisclosure.trim()
        ? branding.aiDisclosure
        : true,
  });
  return {
    ...look,
    position: own.position,
    launcherIcon: own.launcherIcon,
    visitorCanDelete: owner.privacy?.visitorCanDelete !== false,
    visitorCanExport: owner.privacy?.visitorCanExport !== false,
  };
}
export function buildWidgetScript(gatewayId: string): string {
  // Defense in depth: the controller already ParseUUIDPipe-validates,
  // but never emit anything that isn't a plain UUID into JS source.
  if (!/^[0-9a-fA-F-]{36}$/.test(gatewayId)) {
    throw new Error('invalid gateway id for widget script');
  }

  const source = `(function () {
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
  var THREADS = base + '/gateways/' + GATEWAY_ID + '/widget/threads';
  var CONFIG_URL = base + '/gateways/' + GATEWAY_ID + '/widget-config';
  var LS_KEY = 'almyty-widget-' + GATEWAY_ID + '-thread';
  var ATTACH = base + '/gateways/' + GATEWAY_ID + '/widget/attachments';

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
    poweredBy: true,
    // Off until the app's config says otherwise, so a failed config fetch
    // never offers a button the server would refuse.
    visitorCanDelete: false,
    visitorCanExport: false
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
    '.almyty-widget-footer{font-size:10px;text-align:center;color:var(--aw-muted);padding:4px 0 6px;background:var(--aw-panel-bg)}',
    '.almyty-widget-privacy{text-align:center;padding:4px 0 0;background:var(--aw-panel-bg)}',
    '.almyty-widget-privacy button{border:none;background:none;color:var(--aw-muted);cursor:pointer;text-decoration:underline;font-size:10px;padding:0 6px}',
    '.almyty-widget-files{flex-wrap:wrap;gap:4px;padding:6px 8px 0;background:var(--aw-panel-bg)}',
    '.almyty-widget-file{font-size:11px;border:1px solid var(--aw-border);border-radius:6px;background:none;color:var(--aw-text)}'
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
  var attach = document.createElement('button');
  attach.className = 'almyty-widget-send';
  attach.type = 'button';
  attach.setAttribute('aria-label', 'Attach files');
  attach.textContent = '+';
  var picker = document.createElement('input');
  picker.type = 'file';
  picker.multiple = true;
  picker.accept = 'image/*,.pdf,.txt,.csv,.md,.json';
  picker.style.display = 'none';
  var filesEl = document.createElement('div');
  filesEl.className = 'almyty-widget-files';
  filesEl.style.display = 'none';
  form.appendChild(attach);
  form.appendChild(picker);
  form.appendChild(input);
  form.appendChild(send);

  var footer = document.createElement('div');
  footer.className = 'almyty-widget-footer';
  footer.textContent = 'powered by almyty';

  var privacy = document.createElement('div');
  privacy.className = 'almyty-widget-privacy';
  privacy.style.display = 'none';
  var download = document.createElement('button');
  download.type = 'button';
  download.textContent = 'Download my chat';
  var erase = document.createElement('button');
  erase.type = 'button';
  erase.textContent = 'Delete my chat';
  privacy.appendChild(download);
  privacy.appendChild(erase);

  panel.appendChild(header);
  panel.appendChild(note);
  panel.appendChild(messages);
  panel.appendChild(filesEl);
  panel.appendChild(form);
  panel.appendChild(privacy);
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
    if (typeof c.visitorCanDelete === 'boolean') m.visitorCanDelete = c.visitorCanDelete;
    if (typeof c.visitorCanExport === 'boolean') m.visitorCanExport = c.visitorCanExport;
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
    updatePrivacy();
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

  // Files the visitor attaches to the next message, uploaded as picked
  // under the thread the message will name: { name, id, state, error },
  // state 'up' (uploading), 'ok' or 'err'. Each shows as a chip; pressing
  // it takes the file back.
  var files = [];

  // A thread of its own before the first message, so an upload has one to
  // be filed under. Random and unguessable, like the ones the server makes.
  function ensureThread() {
    if (!threadId) {
      threadId = 'w-' + window.crypto.randomUUID();
      try { window.localStorage.setItem(LS_KEY, threadId); } catch (e) {}
    }
    return threadId;
  }

  function renderFiles() {
    while (filesEl.firstChild) filesEl.removeChild(filesEl.firstChild);
    files.forEach(function (f) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'almyty-widget-file';
      chip.title = 'Remove';
      chip.textContent = f.name + (f.state === 'up' ? ' \\u2026' : f.state === 'err' ? ': ' + f.error : '') + ' \\u00d7';
      chip.addEventListener('click', function () { files.splice(files.indexOf(f), 1); renderFiles(); });
      filesEl.appendChild(chip);
    });
    filesEl.style.display = files.length ? 'flex' : 'none';
  }

  function upload(file) {
    var f = { name: file.name, state: 'up' };
    files.push(f);
    if (files.filter(function (x) { return x.state !== 'err'; }).length > 5) f.error = 'up to 5 files';
    else if (file.size > 10485760) f.error = 'over 10 MB';
    if (f.error) f.state = 'err';
    renderFiles();
    if (f.error) return;
    var body = new FormData();
    body.append('threadId', ensureThread());
    body.append('file', file);
    fetch(ATTACH, { method: 'POST', body: body }).then(function (r) {
      return r.json().then(function (out) {
        if (!r.ok || !out.data) throw new Error(out.message);
        f.id = out.data.id;
        f.state = 'ok';
      });
    }).catch(function (e) {
      f.state = 'err';
      f.error = (e && e.message) || 'not sent';
    }).then(renderFiles);
  }

  attach.addEventListener('click', function () { picker.click(); });
  picker.addEventListener('change', function () {
    for (var i = 0; i < picker.files.length; i++) upload(picker.files[i]);
    picker.value = '';
  });

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var text = input.value.replace(/^\\s+|\\s+$/g, '');
    // A message can be files alone; it waits for an upload still running.
    if (files.some(function (f) { return f.state === 'up'; })) return;
    var ready = files.filter(function (f) { return f.state === 'ok'; });
    if (!text && !ready.length) return;
    input.value = '';
    addMessage([text].concat(ready.map(function (f) { return '[Attachment: ' + f.name + ']'; })).filter(Boolean).join('\\n'), 'user');
    var ids = ready.map(function (f) { return f.id; });
    files = [];
    renderFiles();
    fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, threadId: threadId || undefined, attachmentIds: ids.length ? ids : undefined })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (out) { return { ok: r.ok, out: out }; });
    }).then(function (res) {
      // A refusal (too many messages, or the chat has reached its limit)
      // is said in the server's own plain words.
      if (!res.ok) {
        var said = res.out && typeof res.out.message === 'string' ? res.out.message : '';
        addMessage(said || 'Message could not be sent. Please try again.', 'agent');
        return;
      }
      var data = res.out && res.out.data;
      if (data && data.threadId && data.threadId !== threadId) {
        threadId = data.threadId;
        try { window.localStorage.setItem(LS_KEY, threadId); } catch (e) {}
      }
      updatePrivacy();
      startPolling();
    }).catch(function () {
      addMessage('Message could not be sent. Please try again.', 'agent');
    });
  });

  // The visitor's own data: download or delete this conversation, when
  // the app allows it. The thread id is the visitor; nothing else is sent.
  function threadUrl() {
    return THREADS + '/' + encodeURIComponent(threadId);
  }

  function updatePrivacy() {
    var any = !!threadId && (cfg.visitorCanDelete || cfg.visitorCanExport);
    privacy.style.display = any ? 'block' : 'none';
    download.style.display = cfg.visitorCanExport ? 'inline' : 'none';
    erase.style.display = cfg.visitorCanDelete ? 'inline' : 'none';
    erase.textContent = 'Delete my chat';
    armed = false;
  }

  download.addEventListener('click', function () {
    if (!threadId) return;
    fetch(threadUrl() + '/export').then(function (r) {
      if (!r.ok) throw new Error('export ' + r.status);
      return r.blob();
    }).then(function (blob) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'my-chat.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }).catch(function () {
      addMessage('Your chat could not be downloaded. Please try again.', 'agent');
    });
  });

  // Two presses, not a dialog: the first says what the second will do.
  var armed = false;
  erase.addEventListener('click', function () {
    if (!threadId) return;
    if (!armed) {
      armed = true;
      erase.textContent = 'Press again to delete this chat for good';
      return;
    }
    fetch(threadUrl(), { method: 'DELETE' }).then(function (r) {
      if (!r.ok) throw new Error('delete ' + r.status);
      threadId = null;
      lastAt = null;
      try { window.localStorage.removeItem(LS_KEY); } catch (e) {}
      while (messages.firstChild) messages.removeChild(messages.firstChild);
      stopPolling();
      addMessage('Your chat was deleted.', 'agent');
      updatePrivacy();
    }).catch(function () {
      addMessage('Your chat could not be deleted. Please try again.', 'agent');
      updatePrivacy();
    });
  });
})();
`;
  // The comments and layout above are for whoever maintains this file, not
  // for every page it is embedded in: whole-line // comments, indentation
  // and blank lines are not shipped, which is what keeps the script inside
  // its budget. No string in it spans a line, so none of this touches one;
  // a // inside a line (a URL, a trailing note) is left alone.
  return source
    .replace(/^[ \t]*\/\/.*\n/gm, '')
    .replace(/^[ \t]+/gm, '')
    .replace(/\n{2,}/g, '\n');
}
