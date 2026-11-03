import { buildWidgetScript, compactScript } from '../widget-script';

/**
 * The embed script, run: a widget reply streams in as it is written, over
 * the same resumable stream the hosted chat uses, and the widget polls only
 * when streaming will not work.
 *
 *  - after a message, the widget opens `widget/stream` for the run the
 *    server named, and writes the reply into one bubble as it arrives
 *  - a dropped connection opens again from the last frame shown (`after=`)
 *  - when the reply is done, its stored copy takes the streamed bubble's
 *    place: the reply shows once
 *  - a stream that keeps failing is given up on: the widget polls instead,
 *    and after two such streams in a row it stops trying to stream
 *
 * The server side is channel-widget-stream.spec.ts.
 */
const GATEWAY = '3e7f8f3a-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const THREAD = 'w-11111111-2222-4333-8444-555555555555';
const RUN_1 = '7a7a7a7a-0000-4000-8000-000000000001';
const RUN_2 = '7a7a7a7a-0000-4000-8000-000000000002';

class FakeElement {
  children: FakeElement[] = [];
  style: Record<string, any> = { setProperty: () => undefined };
  attributes: Record<string, string> = {};
  listeners: Record<string, Array<(ev: any) => void>> = {};
  className = '';
  textContent = '';
  value = '';
  [key: string]: any;
  constructor(readonly tag: string) {}
  appendChild(child: FakeElement) {
    this.children.push(child);
    return child;
  }
  removeChild(child: FakeElement) {
    this.children = this.children.filter((c) => c !== child);
    return child;
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  addEventListener(type: string, fn: (ev: any) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  dispatch(type: string) {
    for (const fn of this.listeners[type] ?? []) fn({ preventDefault() {} });
  }
  click() {
    this.dispatch('click');
  }
  focus() {}
  get all(): FakeElement[] {
    return [this, ...this.children.flatMap((c) => c.all)];
  }
}

/** One EventSource the widget opened. */
class FakeSource {
  static opened: FakeSource[] = [];
  listeners: Record<string, Array<(ev: any) => void>> = {};
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeSource.opened.push(this);
  }
  addEventListener(type: string, fn: (ev: any) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: unknown, lastEventId = '') {
    for (const fn of this.listeners[type] ?? []) fn({ data: JSON.stringify(data), lastEventId });
  }
  fail() {
    this.onerror?.();
  }
}

type Reply = { id: string; runId: string | null; message: string; createdAt: string };

function runWidget(opts: { eventSource?: boolean } = {}) {
  FakeSource.opened = [];
  const polls: string[] = [];
  let stored: Reply[] = [];
  const timers: Array<() => void> = [];
  let interval: (() => void) | null = null;
  const store = new Map<string, string>([[`almyty-widget-${GATEWAY}-thread`, THREAD]]);
  const body = new FakeElement('body');
  const doc = {
    head: new FakeElement('head'),
    body,
    currentScript: { src: `https://api.example/gateways/${GATEWAY}/widget.js` },
    createElement: (tag: string) => new FakeElement(tag),
    createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
    createTextNode: (text: string) => Object.assign(new FakeElement('#text'), { textContent: text }),
  };
  const win: any = {
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
    crypto: { randomUUID: () => '11111111-2222-4333-8444-555555555555' },
    matchMedia: () => ({ matches: false }),
    setInterval: (fn: () => void) => {
      interval = fn;
      return 1;
    },
    clearInterval: () => {
      interval = null;
    },
    setTimeout: (fn: () => void) => {
      timers.push(fn);
      return timers.length;
    },
  };
  if (opts.eventSource !== false) win.EventSource = FakeSource;
  let nextRun = [RUN_1, RUN_2];
  const fetch = jest.fn(async (url: string, init?: any) => {
    if (url.includes('/widget/messages?')) {
      polls.push(url);
      const after = /afterId=([^&]+)/.exec(url)?.[1];
      const from = after ? stored.findIndex((r) => r.id === after) + 1 : 0;
      return { ok: true, json: async () => ({ data: stored.slice(from) }) };
    }
    if (url.endsWith('/widget/messages') && init?.method === 'POST') {
      const runId = nextRun[0];
      nextRun = nextRun.slice(1);
      return { ok: true, json: async () => ({ data: { runId, threadId: THREAD } }) };
    }
    return { ok: true, json: async () => ({ data: {} }) };
  });
  new Function('window', 'document', 'fetch', 'FormData', buildWidgetScript(GATEWAY))(win, doc, fetch, FormData);
  const agentBubbles = () => body.all.filter((e) => e.className === 'almyty-widget-msg almyty-widget-msg-agent');
  const bubble = body.all.find((e) => e.className === 'almyty-widget-bubble')!;
  const form = body.all.find((e) => e.className === 'almyty-widget-form')!;
  const input = body.all.find((e) => e.className === 'almyty-widget-input')!;
  const settle = async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
  };
  return {
    polls,
    shown: () => agentBubbles().map((e) => e.textContent),
    open: () => bubble.click(),
    send: async (text: string) => {
      input.value = text;
      form.dispatch('submit');
      await settle();
    },
    /** The server stored a reply for the thread (ChatWidgetAdapter). */
    storeReply: (reply: Reply) => stored.push(reply),
    /** Run the timers the widget set, the ones set meanwhile included. */
    runTimers: async () => {
      while (timers.length) {
        timers.shift()!();
        await settle();
      }
    },
    polling: () => interval !== null,
    settle,
  };
}

const reply = (id: string, runId: string, message: string): Reply => ({ id, runId, message, createdAt: '2026-10-28T10:00:00.123Z' });

describe('the widget script: replies stream as they are written', () => {
  it('opens the run’s stream after a message and writes the reply into one bubble as it arrives', async () => {
    const w = runWidget();
    w.open();
    await w.settle();
    await w.send('Where is my order?');

    expect(FakeSource.opened).toHaveLength(1);
    expect(FakeSource.opened[0].url).toBe(
      `https://api.example/gateways/${GATEWAY}/widget/stream?threadId=${THREAD}&runId=${RUN_1}`,
    );
    // Not polling: the stream is the transport.
    expect(w.polling()).toBe(false);

    const s = FakeSource.opened[0];
    s.emit('token', { content: 'Your order' }, '1-0.0');
    expect(w.shown()).toEqual(['Your order']);
    s.emit('token', { content: ' ships Monday.' }, '2-0.0');
    expect(w.shown()).toEqual(['Your order ships Monday.']);
  });

  it('a dropped connection opens again from the last frame shown, and nothing shows twice', async () => {
    const w = runWidget();
    await w.send('Where is my order?');
    const first = FakeSource.opened[0];
    first.emit('token', { content: 'Your order' }, '5-0.0');
    first.fail();
    expect(first.closed).toBe(true);
    await w.runTimers();

    expect(FakeSource.opened).toHaveLength(2);
    expect(FakeSource.opened[1].url).toContain('&after=5-0.0');
    FakeSource.opened[1].emit('token', { content: ' ships Monday.' }, '6-0.0');
    expect(w.shown()).toEqual(['Your order ships Monday.']);
  });

  it('a reset clears what was streamed; done swaps in the stored reply in the same place', async () => {
    const w = runWidget();
    await w.send('Where is my order?');
    const s = FakeSource.opened[0];
    s.emit('token', { content: 'Let me check' }, '1-0.0');
    s.emit('reset', {}, '2-0.0');
    s.emit('token', { content: 'Your order ships Monday.' }, '3-0.0');
    w.storeReply(reply('3e7f8f3a-0000-4000-8000-000000000001', RUN_1, 'Your order ships Monday.'));
    s.emit('done', { reason: 'run.completed' });
    await w.settle();

    expect(s.closed).toBe(true);
    expect(w.shown()).toEqual(['Your order ships Monday.']);
    // The next poll starts after the stored reply.
    await w.send('Thanks');
    w.storeReply(reply('3e7f8f3a-0000-4000-8000-000000000002', RUN_2, 'You are welcome.'));
    FakeSource.opened[1].emit('done', { reason: 'run.completed' });
    await w.settle();
    expect(w.polls.pop()).toContain('afterId=3e7f8f3a-0000-4000-8000-000000000001');
    expect(w.shown()).toEqual(['Your order ships Monday.', 'You are welcome.']);
  });

  it('a stored reply that is not filed yet when the stream ends is asked for again', async () => {
    const w = runWidget();
    await w.send('Where is my order?');
    const s = FakeSource.opened[0];
    s.emit('token', { content: 'Your order ships Monday.' }, '1-0.0');
    s.emit('done', { reason: 'run.completed' });
    await w.settle();
    expect(w.shown()).toEqual(['Your order ships Monday.']);

    w.storeReply(reply('3e7f8f3a-0000-4000-8000-000000000001', RUN_1, 'Your order ships Monday!'));
    await w.runTimers();
    expect(w.shown()).toEqual(['Your order ships Monday!']);
  });

  it('a stream that keeps failing falls back to polling, and two such in a row stop streaming', async () => {
    const w = runWidget();
    await w.send('Where is my order?');
    // The first try and four retries, all refused.
    for (let i = 0; i < 5; i++) {
      FakeSource.opened[FakeSource.opened.length - 1].fail();
      await w.runTimers();
    }
    expect(FakeSource.opened).toHaveLength(5);
    expect(w.polling()).toBe(true);

    await w.send('Hello?');
    for (let i = 0; i < 5; i++) {
      FakeSource.opened[FakeSource.opened.length - 1].fail();
      await w.runTimers();
    }
    expect(FakeSource.opened).toHaveLength(10);

    // From here on the widget polls and opens no stream.
    await w.send('Anyone there?');
    expect(FakeSource.opened).toHaveLength(10);
    expect(w.polling()).toBe(true);
  });

  it('without EventSource the widget polls, as before', async () => {
    const w = runWidget({ eventSource: false });
    w.open();
    await w.send('Where is my order?');
    expect(FakeSource.opened).toHaveLength(0);
    expect(w.polling()).toBe(true);
  });
});

describe('compactScript: the widget ships without its comments and layout', () => {
  it('drops comments and layout, and leaves strings exactly as written', () => {
    const out = compactScript(
      [
        '// a note for maintainers',
        "var url = base + '/gateways/' + id; // trailing note",
        "var link = 'http://example.test/a // b';",
        'if (a) {',
        '  x = a + +b;',
        '  y = a - -b;',
        '}',
        'else if (c) { z() }',
        'var t = typeof window',
        '(function () {})()',
      ].join('\n'),
    );
    expect(out).toContain("var url=base+'/gateways/'+id;");
    expect(out).toContain("'http://example.test/a // b'");
    expect(out).not.toContain('maintainers');
    expect(out).not.toContain('trailing note');
    expect(out).toContain('a+ +b');
    expect(out).toContain('a- -b');
    expect(out).toContain('else if');
    // A line that did not plainly end keeps its break: `window` then `(` is
    // not read as a call.
    expect(out).toContain('typeof window\n(function');
  });

  it('the shipped script still parses, and stays inside its budget', () => {
    const script = buildWidgetScript(GATEWAY);
    expect(() => new Function(script)).not.toThrow();
    expect(Buffer.byteLength(script, 'utf-8')).toBeLessThan(15 * 1024);
  });
});
