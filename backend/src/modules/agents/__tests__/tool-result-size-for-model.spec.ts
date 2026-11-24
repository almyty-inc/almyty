import { AgentRunStatus } from '../../../entities/agent-run.entity';
import { anthropicText, mainModelConfig, runAgent } from './autonomous-harness';
import { MODEL_TOOL_RESULT_CAP, toolResultTextForModel } from '../tool-result-for-model';
import { STEP_PAYLOAD_CAP } from '../persist-cap';

jest.mock('../../llm-providers/providers/safe-request', () => ({
  ...jest.requireActual('../../llm-providers/providers/safe-request'),
  callLlmProviderHttpStream: jest.fn(),
}));

/**
 * What a tool result costs on every later call of a run.
 *
 * Run fedb735b (Founder's associate, staging): the model read fourteen
 * Gmail threads (threads_get, format=full). Each thread holds earlier HTML
 * briefs, so each message is a MIME tree with base64 plain-text and HTML
 * bodies and ~5 KB of transport headers: ~73k characters a thread. The
 * step log kept a shortened copy, but the model got every result whole,
 * and its next two calls took 421,594 and 423,539 input tokens ($2.31 a
 * run against $0.73). The model must get the bodies as text, bounded as
 * the step log bounds them, and still read what the mail says.
 */

const MAIN = { key: 'main', name: 'Main', purpose: 'main', kind: 'model', providerId: 'p-strong', model: 'claude-sonnet-5' } as const;
const single = { strategy: 'single', roles: [MAIN] } as any;
const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

/** A brief the agent mailed earlier, as plain text (~4.6k) and HTML (~10k), as Gmail holds it. */
function brief(n: number) {
  const items = Array.from({ length: 30 }, (_, i) => `Item ${n}.${i}: Priya Raman asked for Q3 cohort retention numbers before the call; Marcus Lee wants 15% off for two years.`);
  const text = `Morning brief ${n}\n\n${items.join('\n')}`;
  const html = `<html><head><style>p{font-family:Manrope;color:#141E30}</style></head><body><div class="brief">${items
    .map((it) => `<p style="margin:0 0 12px 0;line-height:1.5;font-size:15px;color:#141E30"><span>${it}</span></p>`)
    .join('')}</div></body></html>`;
  return { text, html };
}

/** Fifty transport headers of a delivered message, as Gmail returns them. */
const transport = () =>
  Array.from({ length: 12 }, (_, i) => [
    { name: 'Received', value: `by 2002:a17:505:81ca:b0:1f0d:a413:6adb with SMTP id lf10csp${4237708 + i}njc;        Tue, 24 Nov 2026 06:04:41 -0800 (PST)` },
    { name: 'ARC-Seal', value: `i=1; a=rsa-sha256; t=1795529080; cv=none; d=google.com; s=arc-20260327; b=${'UKhHztYwvNxM4+xb/sT24NnrEYkm3pstH8+G70oCotcJTtyaNVXDpI9m'.repeat(4)}` },
    { name: 'X-Received', value: `by 2002:ac8:5f0c:0:b0:55d:3648:a0f9 with SMTP id d75a77b69052e-55d769b8eb7mr${i}.14.1795529080802` },
    { name: 'DKIM-Signature', value: `v=1; a=rsa-sha256; c=relaxed/relaxed; d=offbyte.com; bh=${'m1OThj54Dy24idC3syb8AClyTqpQ4v'.repeat(3)}` },
  ]).flat();

/** A Gmail users.threads.get result (format=full): three messages, each multipart/alternative. */
function thread(id: string) {
  return {
    id,
    historyId: '2015',
    messages: [1, 2, 3].map((n) => {
      const b = brief(n);
      return {
        id: `${id}-${n}`,
        threadId: id,
        labelIds: ['INBOX'],
        snippet: `Morning brief ${n}`,
        payload: {
          partId: '',
          mimeType: 'multipart/alternative',
          filename: '',
          headers: [
            ...transport(),
            { name: 'From', value: 'Founder\'s associate <agent@almyty.app>' },
            { name: 'To', value: 'ava@offbyte.com' },
            { name: 'Subject', value: `Morning brief ${n}` },
            { name: 'Date', value: 'Tue, 24 Nov 2026 11:04:45 +0100' },
          ],
          body: { size: 0 },
          parts: [
            { partId: '0', mimeType: 'text/plain', filename: '', headers: [{ name: 'Content-Type', value: 'text/plain; charset="UTF-8"' }], body: { size: b.text.length, data: b64url(b.text) } },
            { partId: '1', mimeType: 'text/html', filename: '', headers: [{ name: 'Content-Type', value: 'text/html; charset="UTF-8"' }], body: { size: b.html.length, data: b64url(b.html) } },
          ],
        },
      };
    }),
  };
}

/** One model turn that calls threads_get on each of `ids`, in parallel, as the run's third call did. */
function readThreads(model: string, ids: string[], input: number) {
  return [
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { model, usage: { input_tokens: input } } })}\n\n`,
    ...ids.flatMap((id, i) => [
      `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `toolu_${i}`, name: 'gmail_users_threads_get' } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ userId: 'me', id }) } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: i })}\n\n`,
    ]),
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":200}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
}

/** The tool results the model was sent on a call, by the text of each. */
const toolResultsSent = (body: any): string[] =>
  (body.messages as any[])
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((c: any) => c.type === 'tool_result')
    .map((c: any) => (typeof c.content === 'string' ? c.content : JSON.stringify(c.content)));

describe('the size of a tool result the model reads', () => {
  const ids = Array.from({ length: 14 }, (_, i) => `1a20d03d6685${String(7000 + i)}`);

  it('fourteen Gmail threads reach the model as text, bounded, and still say what the mail says', async () => {
    const executeTool = jest.fn(async (_toolId: string, params: any) => ({ success: true, data: thread(params.id), executionTime: 3 }));
    const raw = JSON.stringify(thread(ids[0]));
    const seen = await runAgent({
      models: single,
      modelConfig: mainModelConfig,
      agent: { toolIds: ['tool-gmail'] },
      tools: [{ id: 'tool-gmail', organizationId: 'org-1', visibility: 'org', status: 'active', name: 'gmail_users_threads_get', description: 'Get a thread', parameters: { type: 'object', properties: { userId: { type: 'string' }, id: { type: 'string' } } } }],
      executeTool,
      streams: {
        'claude-sonnet-5': [readThreads('claude-sonnet-5', ids, 8000), anthropicText('claude-sonnet-5', 30000, ['Priya wants the Q3 cohort numbers.'], 20)],
      },
    });
    expect(seen.leftover).toEqual({});
    expect(seen.run.status).toBe(AgentRunStatus.COMPLETED);
    expect(executeTool).toHaveBeenCalledTimes(14);

    const [first, second] = seen.bodies.map((b) => JSON.stringify(b.body.messages).length);
    const results = toolResultsSent(seen.bodies[1].body);
    expect(results).toHaveLength(14);
    const added = second - first;
    // The run's own fourteen threads, counted with the vendor's token
    // counter: 368,724 tokens as Gmail returned them, 27,273 as the model
    // now reads them.

    for (const r of results) {
      // Bounded as the step log bounds it.
      expect(r.length).toBeLessThanOrEqual(MODEL_TOOL_RESULT_CAP);
      // No encoded bodies, no HTML twin, no transport headers.
      expect(r).not.toContain(b64url(brief(1).text).slice(0, 200));
      expect(r).not.toContain('<p style=');
      expect(r).not.toContain('ARC-Seal');
      // What the brief needs: who, what, and every message's words.
      expect(r).toContain('Priya Raman asked for Q3 cohort retention numbers');
      expect(r).toContain('Item 3.29');
      expect(r).toContain('ava@offbyte.com');
      expect(r).toContain('Morning brief 2');
    }
    // A quarter of what the raw results were, for all fourteen.
    expect(added).toBeLessThan((14 * raw.length) / 4);
  });
});

describe('toolResultTextForModel', () => {
  it('gives a small result exactly as it came', () => {
    const small = JSON.stringify({ account: '4411', eta: 'Monday' });
    expect(toolResultTextForModel(small)).toBe(small);
    expect(toolResultTextForModel('plain words')).toBe('plain words');
  });

  it('shortens a large JSON list as the step log does: valid JSON, every item, a note', () => {
    const items = Array.from({ length: 200 }, (_, i) => ({ id: `item-${i}`, title: `Item ${i}`, body: 'the abstract of a paper, '.repeat(80) }));
    const out = toolResultTextForModel(JSON.stringify({ items }));
    expect(out.length).toBeLessThanOrEqual(STEP_PAYLOAD_CAP);
    const parsed = JSON.parse(out);
    expect(parsed._shortened).toMatch(/^\[result shortened/);
    expect(parsed.result.items).toHaveLength(200);
    expect(parsed.result.items[199].id).toBe('item-199');
  });

  it('cuts long text with the truncation marker', () => {
    const out = toolResultTextForModel('word '.repeat(20000));
    expect(out.length).toBeLessThanOrEqual(STEP_PAYLOAD_CAP);
    expect(out).toMatch(/truncated from 100000 characters/);
  });

  it('leaves out a long run of base64 anywhere in a result, with its length', () => {
    const blob = Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 37) % 256)).toString('base64');
    const out = JSON.parse(toolResultTextForModel(JSON.stringify({ name: 'logo.png', content: blob })));
    expect(out).toEqual({ name: 'logo.png', content: '[4,000 characters of encoded data left out]' });
  });

  it('keeps the HTML body, as text, when a message has no plain-text one', () => {
    const msg = { mimeType: 'text/html', headers: [{ name: 'Subject', value: 'Hi' }, { name: 'Received', value: 'by x' }], body: { size: 40, data: b64url('<p>Hello <b>Ava</b> &amp; team</p>') } };
    const out = JSON.parse(toolResultTextForModel(JSON.stringify({ payload: msg })));
    expect(out.payload.body.text).toBe('Hello Ava & team');
    expect(out.payload.headers).toEqual([{ name: 'Subject', value: 'Hi' }]);
  });

  it('reads a message given whole as raw mail (format=raw)', () => {
    const mail = ['From: Priya <priya@halcyon.vc>', 'To: ava@offbyte.com', 'Subject: Q3 numbers', 'Content-Type: text/plain; charset=utf-8', '', 'Could you send the Q3 cohort retention numbers?'].join('\r\n');
    const out = JSON.parse(toolResultTextForModel(JSON.stringify({ id: 'm1', raw: b64url(mail) })));
    expect(out.raw).toBeUndefined();
    expect(out.message).toMatchObject({ from: 'Priya <priya@halcyon.vc>', subject: 'Q3 numbers', text: 'Could you send the Q3 cohort retention numbers?' });
  });

  it('leaves an attachment out with its size', () => {
    const part = { mimeType: 'application/pdf', filename: 'deck.pdf', body: { size: 5000, data: Buffer.alloc(5000).toString('base64url') } };
    const out = JSON.parse(toolResultTextForModel(JSON.stringify(part)));
    expect(out.body.data).toBe('[5,000 bytes of application/pdf left out]');
    expect(out.filename).toBe('deck.pdf');
  });
});
