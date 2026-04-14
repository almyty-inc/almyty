import { batchAsync, batchAsyncSettled } from './batch-async';

describe('batchAsync', () => {
  it('processes all items', async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await batchAsync(items, 2, async (n) => n * 2);
    expect(results).toEqual([2, 4, 6, 8, 10]);
  });

  it('respects batch size', async () => {
    const concurrency: number[] = [];
    let active = 0;

    const items = Array.from({ length: 10 }, (_, i) => i);
    await batchAsync(items, 3, async () => {
      active++;
      concurrency.push(active);
      await new Promise(r => setTimeout(r, 10));
      active--;
    });

    // Max concurrency should never exceed batch size
    expect(Math.max(...concurrency)).toBeLessThanOrEqual(3);
  });

  it('handles empty array', async () => {
    const results = await batchAsync([], 5, async (n) => n);
    expect(results).toEqual([]);
  });

  it('passes correct index', async () => {
    const items = ['a', 'b', 'c'];
    const indices: number[] = [];
    await batchAsync(items, 2, async (_, i) => { indices.push(i); });
    expect(indices).toEqual([0, 1, 2]);
  });
});

describe('batchAsyncSettled', () => {
  it('returns null for failed items', async () => {
    const items = [1, 2, 3];
    const results = await batchAsyncSettled(items, 2, async (n) => {
      if (n === 2) throw new Error('fail');
      return n * 10;
    });
    expect(results).toEqual([10, null, 30]);
  });

  it('processes all despite failures', async () => {
    const processed: number[] = [];
    await batchAsyncSettled([1, 2, 3, 4], 2, async (n) => {
      processed.push(n);
      if (n % 2 === 0) throw new Error('even');
      return n;
    });
    expect(processed).toEqual([1, 2, 3, 4]);
  });
});
