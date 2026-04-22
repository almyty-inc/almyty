/**
 * Integration test: Redis Streams for cross-pod run event distribution.
 *
 * Tests the real XADD/XREAD flow against a running Redis instance.
 * Verifies events written by one "pod" (emitEvent) can be read
 * by another "pod" (subscribeRunEvents) — the core cross-pod contract.
 *
 * Requires: RUN_DB_INTEGRATION=1 and a running Redis (docker-compose).
 */

const SKIP = !process.env.RUN_DB_INTEGRATION;

import Redis from 'ioredis';

(SKIP ? describe.skip : describe)('Redis Streams event distribution (integration)', () => {
  let redis: Redis;
  const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
  const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

  beforeAll(async () => {
    redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
    await redis.ping(); // verify connection
  });

  afterAll(async () => {
    await redis.quit();
  });

  afterEach(async () => {
    const keys = await redis.keys('run:test-*:events');
    if (keys.length) await redis.del(...keys);
  });

  it('should write events to a Redis stream via XADD', async () => {
    const streamKey = 'run:test-write:events';
    const event = { type: 'llm.started', data: { step: 0 }, timestamp: new Date().toISOString() };

    await redis.xadd(streamKey, '*', 'event', JSON.stringify(event));

    // Read it back
    const result = await redis.xrange(streamKey, '-', '+');
    expect(result.length).toBe(1);
    const parsed = JSON.parse(result[0][1][1]); // [id, [key, value]]
    expect(parsed.type).toBe('llm.started');
    expect(parsed.data.step).toBe(0);
  });

  it('should read events in order via XREAD', async () => {
    const streamKey = 'run:test-order:events';

    // Write 3 events
    await redis.xadd(streamKey, '*', 'event', JSON.stringify({ type: 'llm.started', data: { step: 0 } }));
    await redis.xadd(streamKey, '*', 'event', JSON.stringify({ type: 'llm.chunk', data: { content: 'Hello' } }));
    await redis.xadd(streamKey, '*', 'event', JSON.stringify({ type: 'run.completed', data: { output: 'Hello world' } }));

    // Read from beginning
    const results = await (redis as any).xread('COUNT', 100, 'STREAMS', streamKey, '0');
    expect(results).not.toBeNull();

    const messages = results[0][1];
    expect(messages.length).toBe(3);
    expect(JSON.parse(messages[0][1][1]).type).toBe('llm.started');
    expect(JSON.parse(messages[1][1][1]).type).toBe('llm.chunk');
    expect(JSON.parse(messages[2][1][1]).type).toBe('run.completed');
  });

  it('should support blocking reads that wake up on new events', async () => {
    const streamKey = 'run:test-blocking:events';
    const received: any[] = [];

    // Start a blocking reader in the background
    const readerPromise = (async () => {
      const sub = redis.duplicate();
      const results = await (sub as any).xread(
        'BLOCK', 5000, 'COUNT', 100,
        'STREAMS', streamKey, '$', // '$' = only new events
      );
      sub.disconnect();

      if (results) {
        for (const [, messages] of results) {
          for (const [, fields] of messages) {
            received.push(JSON.parse(fields[1]));
          }
        }
      }
    })();

    // Wait a bit, then publish an event
    await new Promise(r => setTimeout(r, 100));
    await redis.xadd(streamKey, '*', 'event', JSON.stringify({ type: 'llm.chunk', data: { content: 'streamed' } }));

    await readerPromise;

    expect(received.length).toBe(1);
    expect(received[0].type).toBe('llm.chunk');
    expect(received[0].data.content).toBe('streamed');
  });

  it('should replay missed events when reader connects late', async () => {
    const streamKey = 'run:test-replay:events';

    // Write events BEFORE reader connects
    await redis.xadd(streamKey, '*', 'event', JSON.stringify({ type: 'llm.started', data: {} }));
    await redis.xadd(streamKey, '*', 'event', JSON.stringify({ type: 'llm.response', data: { content: 'Answer' } }));
    await redis.xadd(streamKey, '*', 'event', JSON.stringify({ type: 'run.completed', data: { output: 'Answer' } }));

    // Reader connects AFTER all events were written — reads from '0'
    const results = await (redis as any).xread('COUNT', 100, 'STREAMS', streamKey, '0');

    const messages = results[0][1];
    expect(messages.length).toBe(3);
    expect(JSON.parse(messages[0][1][1]).type).toBe('llm.started');
    expect(JSON.parse(messages[2][1][1]).type).toBe('run.completed');
  });

  it('should expire stream keys after TTL', async () => {
    const streamKey = 'run:test-ttl:events';
    await redis.xadd(streamKey, '*', 'event', JSON.stringify({ type: 'run.completed', data: {} }));
    await redis.expire(streamKey, 1); // 1 second TTL

    // Key exists now
    const existsBefore = await redis.exists(streamKey);
    expect(existsBefore).toBe(1);

    // Wait for expiry
    await new Promise(r => setTimeout(r, 1500));

    const existsAfter = await redis.exists(streamKey);
    expect(existsAfter).toBe(0);
  });

  it('should handle multiple concurrent run streams independently', async () => {
    const stream1 = 'run:test-multi-1:events';
    const stream2 = 'run:test-multi-2:events';

    await redis.xadd(stream1, '*', 'event', JSON.stringify({ type: 'llm.chunk', data: { content: 'Run 1' } }));
    await redis.xadd(stream2, '*', 'event', JSON.stringify({ type: 'llm.chunk', data: { content: 'Run 2' } }));
    await redis.xadd(stream1, '*', 'event', JSON.stringify({ type: 'run.completed', data: { output: 'Run 1 done' } }));
    await redis.xadd(stream2, '*', 'event', JSON.stringify({ type: 'run.completed', data: { output: 'Run 2 done' } }));

    const result1 = await redis.xrange(stream1, '-', '+');
    const result2 = await redis.xrange(stream2, '-', '+');

    expect(result1.length).toBe(2);
    expect(result2.length).toBe(2);
    expect(JSON.parse(result1[0][1][1]).data.content).toBe('Run 1');
    expect(JSON.parse(result2[0][1][1]).data.content).toBe('Run 2');
  });

  it('should simulate cross-pod publish/subscribe pattern', async () => {
    const streamKey = 'run:test-crosspod:events';
    const received: any[] = [];

    // "Pod B" starts reading (blocking) from '$' for new events
    const readerDone = new Promise<void>(async (resolve) => {
      const sub = redis.duplicate();
      let lastId = '$';

      // Read in a loop until terminal event
      while (true) {
        const results = await (sub as any).xread(
          'BLOCK', 3000, 'COUNT', 100,
          'STREAMS', streamKey, lastId,
        );
        if (!results) break;

        let terminal = false;
        for (const [, messages] of results) {
          for (const [id, fields] of messages) {
            lastId = id;
            const event = JSON.parse(fields[1]);
            received.push(event);
            if (event.type === 'run.completed') terminal = true;
          }
        }
        if (terminal) break;
      }
      sub.disconnect();
      resolve();
    });

    // "Pod A" processes the run and emits events
    await new Promise(r => setTimeout(r, 50));
    await redis.xadd(streamKey, '*', 'event', JSON.stringify({ type: 'llm.started', data: { step: 0 } }));
    await new Promise(r => setTimeout(r, 10));
    await redis.xadd(streamKey, '*', 'event', JSON.stringify({ type: 'llm.chunk', data: { content: 'Hello ' } }));
    await new Promise(r => setTimeout(r, 10));
    await redis.xadd(streamKey, '*', 'event', JSON.stringify({ type: 'llm.chunk', data: { content: 'world' } }));
    await new Promise(r => setTimeout(r, 10));
    await redis.xadd(streamKey, '*', 'event', JSON.stringify({ type: 'tool.started', data: { tool: 'web_search' } }));
    await new Promise(r => setTimeout(r, 10));
    await redis.xadd(streamKey, '*', 'event', JSON.stringify({ type: 'tool.result', data: { tool: 'web_search', success: true } }));
    await new Promise(r => setTimeout(r, 10));
    await redis.xadd(streamKey, '*', 'event', JSON.stringify({ type: 'run.completed', data: { output: 'Hello world' } }));

    await readerDone;

    // Verify all events received in order
    expect(received.length).toBe(6);
    expect(received.map(e => e.type)).toEqual([
      'llm.started',
      'llm.chunk',
      'llm.chunk',
      'tool.started',
      'tool.result',
      'run.completed',
    ]);
    expect(received[1].data.content).toBe('Hello ');
    expect(received[3].data.tool).toBe('web_search');
    expect(received[5].data.output).toBe('Hello world');
  });
});
