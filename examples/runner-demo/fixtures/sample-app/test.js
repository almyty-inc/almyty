import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildServer } from './index.js';

test('GET / returns the app metadata', async () => {
  const server = buildServer();
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.name, 'sample-app');
  } finally {
    server.close();
  }
});
