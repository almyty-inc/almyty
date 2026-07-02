/**
 * Self-contained embed script served at GET /gateways/:id/widget.js.
 *
 * Design constraints:
 *   - vanilla JS/CSS, zero dependencies, < 15 KB
 *   - everything namespaced almyty-widget-* so it cannot collide with
 *     the host page
 *   - ALL message text rendered via textContent (never innerHTML with
 *     user/agent data) — agent replies and visitor input are untrusted
 *   - the ONLY gateway-derived value injected into the script is the
 *     gateway id, and the route validates it as a UUID before this
 *     builder runs, so template injection is structurally impossible
 *   - the visitor-side threadId is persisted in localStorage on the
 *     CUSTOMER'S site. This is a random, unguessable conversation key
 *     for an anonymous visitor — not an almyty auth token (almyty auth
 *     stays in httpOnly cookies; that rule is unaffected here).
 *
 * The script talks to the existing public widget surface:
 *   POST /gateways/:id/widget/messages          { message, threadId? }
 *   GET  /gateways/:id/widget/messages?threadId=&after=
 */
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
  var LS_KEY = 'almyty-widget-' + GATEWAY_ID + '-thread';

  var threadId = null;
  try { threadId = window.localStorage.getItem(LS_KEY); } catch (e) {}
  var lastAt = null;
  var pollTimer = null;
  var open = false;

  var css = [
    '.almyty-widget-bubble{position:fixed;bottom:20px;right:20px;width:56px;height:56px;border-radius:50%;',
    'background:linear-gradient(135deg,#7C3AED,#0891B2);color:#fff;border:none;cursor:pointer;z-index:2147483000;',
    'box-shadow:0 4px 14px rgba(0,0,0,.25);font-size:24px;line-height:56px;text-align:center;padding:0}',
    '.almyty-widget-panel{position:fixed;bottom:88px;right:20px;width:340px;max-width:calc(100vw - 40px);height:440px;',
    'max-height:calc(100vh - 120px);background:#fff;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.25);',
    'display:none;flex-direction:column;overflow:hidden;z-index:2147483000;font-family:system-ui,-apple-system,sans-serif}',
    '.almyty-widget-panel.almyty-widget-open{display:flex}',
    '.almyty-widget-header{background:#7C3AED;color:#fff;padding:12px 16px;font-size:14px;font-weight:600}',
    '.almyty-widget-messages{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:#fafafa}',
    '.almyty-widget-msg{max-width:85%;padding:8px 12px;border-radius:10px;font-size:13px;line-height:1.45;',
    'white-space:pre-wrap;word-break:break-word}',
    '.almyty-widget-msg-user{align-self:flex-end;background:#7C3AED;color:#fff}',
    '.almyty-widget-msg-agent{align-self:flex-start;background:#ececf1;color:#1a1a1a}',
    '.almyty-widget-form{display:flex;border-top:1px solid #e5e5e5;background:#fff}',
    '.almyty-widget-input{flex:1;border:none;outline:none;padding:12px;font-size:13px;font-family:inherit}',
    '.almyty-widget-send{border:none;background:none;color:#7C3AED;font-weight:600;font-size:13px;cursor:pointer;padding:0 14px}'
  ].join('');

  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  var bubble = document.createElement('button');
  bubble.className = 'almyty-widget-bubble';
  bubble.type = 'button';
  bubble.setAttribute('aria-label', 'Open chat');
  bubble.textContent = '\\u2726';

  var panel = document.createElement('div');
  panel.className = 'almyty-widget-panel';

  var header = document.createElement('div');
  header.className = 'almyty-widget-header';
  header.textContent = 'Chat with us';

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

  panel.appendChild(header);
  panel.appendChild(messages);
  panel.appendChild(form);
  document.body.appendChild(panel);
  document.body.appendChild(bubble);

  function addMessage(text, who) {
    var el = document.createElement('div');
    el.className = 'almyty-widget-msg almyty-widget-msg-' + who;
    el.textContent = text; // textContent only — never inject HTML
    messages.appendChild(el);
    messages.scrollTop = messages.scrollHeight;
  }

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
