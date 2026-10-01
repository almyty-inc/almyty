import { buildWidgetScript } from '../widget-script';

/**
 * The embed script, run: a visitor attaches a file and sends it.
 *
 * The script is executed as the page would, against a small DOM double
 * that implements what it calls (elements, events, localStorage, crypto)
 * and a fetch that records requests. What is checked is what the backend
 * receives: the upload filed under a thread, and the message naming the
 * upload by id.
 */
class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  style: Record<string, any> = { setProperty: () => undefined };
  attributes: Record<string, string> = {};
  listeners: Record<string, Array<(ev: any) => void>> = {};
  className = '';
  textContent = '';
  value = '';
  files: any[] = [];
  [key: string]: any;
  constructor(readonly tag: string) {}
  appendChild(child: FakeElement) {
    child.parent = this;
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
  dispatch(type: string, ev: any = {}) {
    for (const fn of this.listeners[type] ?? []) fn({ preventDefault() {}, ...ev });
  }
  click() {
    this.dispatch('click');
  }
  focus() {}
  get all(): FakeElement[] {
    return [this, ...this.children.flatMap((c) => c.all)];
  }
}

function runWidget() {
  const requests: Array<{ url: string; init: any }> = [];
  const store = new Map<string, string>();
  const head = new FakeElement('head');
  const body = new FakeElement('body');
  let uploadAnswer: any = { data: { id: 'up-1', name: 'box.png', mimeType: 'image/png', size: 4 } };
  const doc = {
    head,
    body,
    currentScript: { src: 'https://api.example/gateways/3e7f8f3a-4a5b-4c6d-8e9f-0a1b2c3d4e5f/widget.js' },
    createElement: (tag: string) => new FakeElement(tag),
    createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
    createTextNode: (text: string) => Object.assign(new FakeElement('#text'), { textContent: text }),
  };
  const win: any = {
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
    crypto: { randomUUID: () => '11111111-2222-4333-8444-555555555555' },
    matchMedia: () => ({ matches: false }),
    setInterval: () => 1,
    clearInterval: () => undefined,
  };
  const fetch = jest.fn(async (url: string, init?: any) => {
    requests.push({ url, init });
    const json = url.endsWith('/widget/attachments')
      ? uploadAnswer
      : url.endsWith('/widget/messages') && init?.method === 'POST'
        ? { data: { runId: 'run-1', threadId: 'w-11111111-2222-4333-8444-555555555555' } }
        : { data: [] };
    return { ok: !json.message, json: async () => json };
  });
  new Function('window', 'document', 'fetch', 'FormData', buildWidgetScript('3e7f8f3a-4a5b-4c6d-8e9f-0a1b2c3d4e5f'))(win, doc, fetch, FormData);
  const find = (className: string) => body.all.find((e) => e.className === className)!;
  const byLabel = (label: string) => body.all.find((e) => e.attributes['aria-label'] === label)!;
  const picker = body.all.find((e) => e.tag === 'input' && e.type === 'file')!;
  return {
    requests,
    store,
    find,
    byLabel,
    picker,
    form: find('almyty-widget-form'),
    input: find('almyty-widget-input'),
    setUploadAnswer: (a: any) => (uploadAnswer = a),
  };
}

const settle = () => new Promise((r) => setImmediate(r));

describe('the widget script: attaching a file', () => {
  it('uploads a picked file under a thread of its own, then sends the message naming it', async () => {
    const w = runWidget();
    w.picker.files = [new File([new Uint8Array([1, 2, 3, 4])], 'box.png', { type: 'image/png' })];
    w.picker.dispatch('change');
    await settle();
    await settle();

    const upload = w.requests.find((r) => r.url.endsWith('/widget/attachments'))!;
    expect(upload.url).toBe('https://api.example/gateways/3e7f8f3a-4a5b-4c6d-8e9f-0a1b2c3d4e5f/widget/attachments');
    expect(upload.init.method).toBe('POST');
    expect(upload.init.body.get('threadId')).toBe('w-11111111-2222-4333-8444-555555555555');
    expect(upload.init.body.get('file').name).toBe('box.png');
    // The thread is kept, so the message and the upload name the same one.
    expect([...w.store.values()]).toEqual(['w-11111111-2222-4333-8444-555555555555']);
    expect(w.find('almyty-widget-file').textContent).toBe('box.png ×');

    w.input.value = 'Is this damaged?';
    w.form.dispatch('submit');
    const message = w.requests.find((r) => r.url.endsWith('/widget/messages') && r.init?.method === 'POST')!;
    expect(JSON.parse(message.init.body)).toEqual({
      message: 'Is this damaged?',
      threadId: 'w-11111111-2222-4333-8444-555555555555',
      attachmentIds: ['up-1'],
    });
    // Sent: the chip is gone; the turn names the file, as text.
    expect(w.find('almyty-widget-files').children).toHaveLength(0);
    const turn = w.find('almyty-widget-msg almyty-widget-msg-user');
    expect(turn.textContent).toBe('Is this damaged?\n[Attachment: box.png]');
  });

  it('shows why the server refused a file, and does not name it in the message', async () => {
    const w = runWidget();
    w.setUploadAnswer({ message: 'Only images (PNG, JPEG, GIF, WebP), PDFs and text files can be sent.' });
    w.picker.files = [new File(['x'], 'clip.mov', { type: 'video/quicktime' })];
    w.picker.dispatch('change');
    await settle();
    await settle();
    expect(w.find('almyty-widget-file').textContent).toBe('clip.mov: Only images (PNG, JPEG, GIF, WebP), PDFs and text files can be sent. ×');

    w.input.value = 'hi';
    w.form.dispatch('submit');
    const message = w.requests.find((r) => r.url.endsWith('/widget/messages') && r.init?.method === 'POST')!;
    expect(JSON.parse(message.init.body).attachmentIds).toBeUndefined();
  });

  it('refuses a file over 10 MB without uploading it', async () => {
    const w = runWidget();
    w.picker.files = [{ name: 'huge.png', size: 10 * 1024 * 1024 + 1 }];
    w.picker.dispatch('change');
    await settle();
    expect(w.requests.some((r) => r.url.endsWith('/widget/attachments'))).toBe(false);
    expect(w.find('almyty-widget-file').textContent).toBe('huge.png: over 10 MB ×');
  });

  it('ships no comments and still parses', () => {
    const script = buildWidgetScript('3e7f8f3a-4a5b-4c6d-8e9f-0a1b2c3d4e5f');
    expect(script).not.toMatch(/^\s*\/\//m);
    expect(() => new Function(script)).not.toThrow();
  });
});
