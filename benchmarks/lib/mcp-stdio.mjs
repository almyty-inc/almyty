// A minimal MCP client over stdio (newline-delimited JSON-RPC), enough to
// talk to @almyty/mcp-server the way an editor does: initialize, then list
// and call. It speaks the 2025-06-18 protocol, what most clients send today.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class StdioMcpClient {
  constructor(command, args, env) {
    this.child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.pending = new Map();
    this.seq = 0;
    this.stderr = '';
    this.child.stderr.on('data', (d) => { this.stderr += d; });
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
      }
    });
    this.exited = new Promise((resolve) => this.child.on('exit', resolve));
  }

  send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}, timeoutMs = 30_000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out; stderr: ${this.stderr.slice(-500)}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  async initialize() {
    const result = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'almyty-benchmark', version: '1.0.0' },
    });
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return result;
  }

  async close() {
    this.child.stdin.end();
    this.child.kill();
    await this.exited;
  }
}
