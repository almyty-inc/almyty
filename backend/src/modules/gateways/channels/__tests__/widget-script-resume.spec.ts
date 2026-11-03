import { buildWidgetScript } from '../widget-script';

/**
 * The embed script, run: where the widget picks up its replies.
 *
 * The widget has no live stream; it polls for the replies stored for its
 * thread. Each poll names the last reply it showed (`afterId`), so the
 * server answers with what came after that one exactly, and only one poll
 * runs at a time, so two in flight never both show the same reply. The
 * server side of the cursor is channel-gateway.service.spec.ts and the
 * real-Postgres visitor-resume integration spec.
 */
const GATEWAY = '3e7f8f3a-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const THREAD = 'w-11111111-2222-4333-8444-555555555555';

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
  click() {
    for (const fn of this.listeners.click ?? []) fn({ preventDefault() {} });
  }
  focus() {}
  get all(): FakeElement[] {
    return [this, ...this.children.flatMap((c) => c.all)];
  }
}

type Reply = { id: string; message: string; createdAt: string };

function runWidget() {
  const polls: string[] = [];
  const pending: Array<(replies: Reply[]) => void> = [];
  const store = new Map<string, string>([[`almyty-widget-${GATEWAY}-thread`, THREAD]]);
  const body = new FakeElement('body');
  let tick: (() => void) | null = null;
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
      tick = fn;
      return 1;
    },
    clearInterval: () => undefined,
  };
  const fetch = jest.fn(async (url: string) => {
    if (url.includes('/widget/messages?')) {
      polls.push(url);
      const replies = await new Promise<Reply[]>((resolve) => pending.push(resolve));
      return { ok: true, json: async () => ({ data: replies }) };
    }
    return { ok: true, json: async () => ({ data: {} }) };
  });
  new Function('window', 'document', 'fetch', 'FormData', buildWidgetScript(GATEWAY))(win, doc, fetch, FormData);
  const shown = () => body.all.filter((e) => e.className === 'almyty-widget-msg almyty-widget-msg-agent').map((e) => e.textContent);
  const bubble = body.all.find((e) => e.className === 'almyty-widget-bubble')!;
  return {
    polls,
    shown,
    open: () => bubble.click(),
    tick: () => tick?.(),
    /** Answer the oldest poll still waiting. */
    answer: async (replies: Reply[]) => {
      pending.shift()!(replies);
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    },
  };
}

const reply = (id: string, message: string): Reply => ({ id, message, createdAt: '2026-10-28T10:00:00.123Z' });

describe('the widget script: picking up replies where it left off', () => {
  it('names the last reply it showed on the next poll, and shows each reply once', async () => {
    const w = runWidget();
    w.open();
    expect(w.polls).toHaveLength(1);
    expect(w.polls[0]).toBe(`https://api.example/gateways/${GATEWAY}/widget/messages?threadId=${THREAD}`);
    await w.answer([reply('3e7f8f3a-0000-4000-8000-000000000001', 'Your order ships Monday.')]);

    w.tick();
    expect(w.polls[1]).toBe(
      `https://api.example/gateways/${GATEWAY}/widget/messages?threadId=${THREAD}&afterId=3e7f8f3a-0000-4000-8000-000000000001`,
    );
    // A timestamp is not the cursor: it comes back rounded to the millisecond.
    expect(w.polls[1]).not.toContain('after=');
    await w.answer([]);

    w.tick();
    await w.answer([reply('3e7f8f3a-0000-4000-8000-000000000002', 'Anything else?')]);
    expect(w.shown()).toEqual(['Your order ships Monday.', 'Anything else?']);
  });

  it('runs one poll at a time: a tick while one is in flight asks nothing, so nothing shows twice', async () => {
    const w = runWidget();
    w.open();
    w.tick();
    w.tick();
    expect(w.polls).toHaveLength(1);
    await w.answer([reply('3e7f8f3a-0000-4000-8000-000000000001', 'Your order ships Monday.')]);
    w.tick();
    expect(w.polls).toHaveLength(2);
    await w.answer([]);
    expect(w.shown()).toEqual(['Your order ships Monday.']);
  });
});
