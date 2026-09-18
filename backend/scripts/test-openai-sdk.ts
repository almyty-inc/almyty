/**
 * Drive an almyty agent with the real OpenAI Node.js SDK.
 *
 * Usage:
 *   npx ts-node scripts/test-openai-sdk.ts --url https://api.staging.almyty.com --api-key <key> --agent-name new-agent
 *
 * The point of this script is to prove the claim "any OpenAI SDK can target an
 * almyty agent", so it has to exercise the parts of that claim a happy-path
 * call does not reach.
 *
 * A single-message completion cannot see whether the conversation survives the
 * trip: /v1/chat/completions is stateless, so an endpoint that reads only the
 * last user line answers a one-shot request perfectly and is amnesiac on every
 * real chat loop. Hence a multi-turn case whose answer is only possible if the
 * earlier turns arrived. Likewise the finish_reason, the usage disclosure, the
 * refusals, a real stream, and the 401/404/400 shapes an SDK raises on -- an
 * error path that is never taken is an error path nobody has checked.
 *
 * Anything red exits non-zero.
 */
import OpenAI from 'openai';

const args = process.argv.slice(2);
const flag = (name: string, fallback = '') => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const url = flag('url', 'https://api.staging.almyty.com');
const apiKey = flag('api-key');
const agentName = flag('agent-name', 'new-agent');
const skipStream = args.includes('--no-stream');

const base = `${url}/v1`;
const model = `agent:${agentName}`;
const client = new OpenAI({ baseURL: base, apiKey });

const FINISH_REASONS = ['stop', 'length', 'tool_calls', 'content_filter', 'function_call'];

const failures: string[] = [];

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

/** Run `fn` and hand back the APIError it raised, or null if it did not raise. */
async function expectStatus(name: string, status: number, fn: () => Promise<unknown>): Promise<any> {
  try {
    await fn();
    check(name, false, `the call succeeded; a ${status} was expected`);
    return null;
  } catch (err: any) {
    check(name, err?.status === status, `got status ${err?.status}: ${err?.message}`);
    return err;
  }
}

async function main() {
  // ── 1. models.list ─────────────────────────────────────────────────────
  section('Models list');
  const models = await client.models.list();
  const ids = models.data.map((m) => m.id);
  console.log(`  ${ids.length} model(s): ${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ' …' : ''}`);
  check('models.list returns a list', Array.isArray(ids));

  // ── 2. single-turn completion ──────────────────────────────────────────
  section('Chat completion (single turn)');
  const response = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: 'Say hello in 3 words' }],
  });
  const choice = response.choices[0];
  console.log(`  Response: ${choice.message.content}`);
  check('an answer came back', Boolean(choice.message.content));
  check(
    `finish_reason "${choice.finish_reason}" is a real OpenAI value`,
    FINISH_REASONS.includes(choice.finish_reason as string),
    `got ${JSON.stringify(choice.finish_reason)}, expected one of ${FINISH_REASONS.join(', ')}`,
  );
  check('usage.total_tokens is present', response.usage?.total_tokens != null);
  check('one choice for n=1', response.choices.length === 1);

  // ── 3. multi-turn — the whole point of a stateless chat API ────────────
  section('Chat completion (multi-turn memory)');
  // /v1/chat/completions keeps no state: the messages array IS the
  // conversation, and every SDK chat loop resends it whole. If only the last
  // user line reaches the agent, this answer cannot contain the name.
  const multi = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: 'You are terse. Answer with one word where you can.' },
      { role: 'user', content: 'My name is Gwendolyn.' },
      { role: 'assistant', content: 'Noted.' },
      { role: 'user', content: 'What is my name?' },
    ],
  });
  const answer = multi.choices[0].message.content ?? '';
  console.log(`  Response: ${answer}`);
  check(
    'the agent could see the earlier turns',
    answer.toLowerCase().includes('gwendolyn'),
    'the answer does not contain the name given two turns earlier, so the conversation did not reach the model',
  );

  // ── 4. sampling ────────────────────────────────────────────────────────
  section('Sampling parameters are accepted');
  const sampled = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: 'Name one colour.' }],
    temperature: 0,
    max_tokens: 32,
  });
  check('temperature=0 and max_tokens are accepted', Boolean(sampled.choices[0].message.content));

  // ── 5. usage disclosure ────────────────────────────────────────────────
  section('Usage reporting is honest about what it measured');
  const raw = await client.chat.completions
    .create({ model, messages: [{ role: 'user', content: 'hello' }] })
    .withResponse();
  const split = raw.response.headers.get('x-almyty-usage-split');
  const usage = raw.data.usage;
  console.log(`  x-almyty-usage-split: ${split}`);
  console.log(`  usage: ${JSON.stringify(usage)}`);
  if (split === 'unavailable') {
    check(
      'the prompt/completion split is not invented when it is not measured',
      usage?.prompt_tokens === 0 && usage?.completion_tokens === 0,
      'the header says the split is unavailable but the fields carry numbers',
    );
  } else {
    check(
      'prompt + completion adds up to total',
      (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0) === usage?.total_tokens,
    );
  }

  // ── 6. refusals ────────────────────────────────────────────────────────
  section('Unsupported fields are refused, by name');
  const toolsErr = await expectStatus('client-declared tools are refused with a 400', 400, () =>
    client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'what is the weather' }],
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', parameters: { type: 'object', properties: {} } },
        },
      ],
    }),
  );
  if (toolsErr) {
    console.log(`  400: ${toolsErr.error?.message ?? toolsErr.message}`);
    check('the refusal names the field', toolsErr.error?.param === 'tools', `param was ${toolsErr.error?.param}`);
  }

  await expectStatus('response_format json_object is refused', 400, () =>
    client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'give me json' }],
      response_format: { type: 'json_object' },
    }),
  );

  // ── 7. error paths ─────────────────────────────────────────────────────
  section('Error paths raise the right SDK exception');
  await expectStatus('a bad key is a 401', 401, () =>
    new OpenAI({ baseURL: base, apiKey: 'sk-definitely-not-a-real-key' }).models.list(),
  );
  await expectStatus('an unknown agent is a 404', 404, () =>
    client.chat.completions.create({
      model: 'agent:this-agent-does-not-exist-9f3c',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  );
  await expectStatus('an empty messages array is a 400', 400, () =>
    client.chat.completions.create({ model, messages: [] }),
  );

  // ── 8. streaming ───────────────────────────────────────────────────────
  if (!skipStream) {
    section('Streaming');
    const stream = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'Count 1 to 5' }],
      stream: true,
      stream_options: { include_usage: true },
    });

    let full = '';
    const reasons: string[] = [];
    let usageChunk: unknown = null;
    for await (const chunk of stream) {
      if ((chunk as any).usage) usageChunk = (chunk as any).usage;
      for (const c of chunk.choices ?? []) {
        if (c.delta?.content) full += c.delta.content;
        if (c.finish_reason) reasons.push(c.finish_reason);
      }
    }
    console.log(`  Full: ${full}`);
    check('the stream produced content', full.length > 0);
    check(
      `every streamed finish_reason is a real OpenAI value (${reasons.join(', ') || 'none'})`,
      reasons.every((r) => FINISH_REASONS.includes(r)),
    );
    check(
      'stream_options.include_usage produced a usage-bearing chunk',
      usageChunk !== null,
      'the spec requires a final chunk carrying usage before [DONE]',
    );

    await expectStatus('a streaming request for an unknown agent is a 404', 404, async () => {
      const bad = await client.chat.completions.create({
        model: 'agent:this-agent-does-not-exist-9f3c',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      });
      for await (const _ of bad) {
        // drain
      }
    });
  }

  console.log();
  if (failures.length) {
    console.log(`=== ${failures.length} CHECK(S) FAILED ===`);
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exitCode = 1;
    return;
  }
  console.log('=== ALL CHECKS PASSED ===');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
