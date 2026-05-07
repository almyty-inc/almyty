import { createServer } from 'node:http';

export function buildServer() {
  return createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: 'sample-app' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  buildServer().listen(port, () => {
    console.log(`sample-app listening on :${port}`);
  });
}
