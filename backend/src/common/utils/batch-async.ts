/**
 * Process an array in batches to avoid exhausting the DB connection pool.
 *
 * Without batching, `Promise.all(items.map(async => dbCall()))` opens N
 * concurrent connections. On a managed Postgres with 25 max connections
 * and a pool of 5 per pod, N > 5 means pool exhaustion.
 *
 * Usage:
 *   const results = await batchAsync(items, 3, async (item) => {
 *     return await someService.process(item);
 *   });
 */
export async function batchAsync<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map((item, j) => fn(item, i + j)),
    );
    results.push(...batchResults);
  }
  return results;
}

/**
 * Same as batchAsync but tolerates failures — failed items return null.
 */
export async function batchAsyncSettled<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<(R | null)[]> {
  const results: (R | null)[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(
      batch.map((item, j) => fn(item, i + j)),
    );
    results.push(
      ...batchResults.map(r => r.status === 'fulfilled' ? r.value : null),
    );
  }
  return results;
}
