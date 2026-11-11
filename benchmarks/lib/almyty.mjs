// The almyty REST and MCP calls the benchmark makes, against a running
// backend: the same endpoints the web app and @almyty/mcp-server use.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const unwrap = (body) => (body && typeof body === 'object' && 'success' in body && 'data' in body ? body.data : body);

/** The generated tool for a task's operation, found by its HTTP method and path. */
export function targetTool(tools, target) {
  return tools.find((t) => {
    const op = t.operation ?? t.metadata?.sourceOperation ?? {};
    return String(op.method ?? '').toUpperCase() === target.method && op.endpoint === target.endpoint;
  });
}

export class Almyty {
  constructor(baseUrl, { pgContainer = 'almyty-bench-pg', database = 'almyty_bench' } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.pgContainer = pgContainer;
    this.database = database;
    this.token = null;
  }

  async request(method, path, body, { form } = {}) {
    const headers = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${this.baseUrl}${path}`, { method, headers, body: payload });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}: ${text.slice(0, 400)}`);
    return unwrap(json);
  }

  sql(statement) {
    return execFileSync('docker', ['exec', this.pgContainer, 'psql', '-U', 'postgres', '-d', this.database, '-tAc', statement], { encoding: 'utf8' }).trim();
  }

  /** A fresh user and organization, verified, signed in with a bearer token. */
  async freshAccount(label) {
    const id = randomBytes(4).toString('hex');
    const email = `bench-${label}-${id}@bench.local`.toLowerCase();
    const password = `Bench-${randomBytes(6).toString('hex')}-9!`;
    await this.request('POST', '/auth/register', { email, password, firstName: 'Bench', lastName: label, organizationName: `Bench ${label} ${id}` });
    this.sql(`UPDATE users SET "isVerified" = true, "verifiedAt" = now() WHERE email = '${email}'`);
    const { accessToken } = await this.request('POST', '/auth/token', { email, password });
    this.token = accessToken;
    const row = this.sql(`SELECT o.id || '|' || o.slug FROM user_organizations uo JOIN users u ON u.id = uo."userId" JOIN organizations o ON o.id = uo."organizationId" WHERE u.email = '${email}' LIMIT 1`);
    const [orgId, orgSlug] = row.split('|');
    this.orgId = orgId;
    return { email, orgId, orgSlug };
  }

  /**
   * Import a description as the web app's "Connect an API" does (multipart
   * upload to POST /apis/import with generateTools), then poll the job until
   * it settles. Returns the wall-clock milliseconds from sending the request
   * to seeing the job completed (tools generated and written).
   */
  async importAndGenerate({ name, fileName, content, baseUrl, type = 'openapi', pollMs = 100, timeoutMs = 20 * 60_000 }) {
    const form = new FormData();
    form.append('schema', new Blob([content]), fileName);
    form.append('type', type);
    form.append('name', name);
    if (baseUrl) form.append('baseUrl', baseUrl);
    form.append('generateTools', 'true');
    const started = performance.now();
    const created = await this.request('POST', '/apis/import', undefined, { form });
    const apiId = created.api.id;
    for (;;) {
      const status = await this.request('GET', `/apis/${apiId}/import-status/${created.jobId}`);
      if (status.status === 'completed') return { apiId, ms: performance.now() - started, result: status.result };
      if (status.status === 'failed') throw new Error(`import of ${name} failed: ${status.error}`);
      if (performance.now() - started > timeoutMs) throw new Error(`import of ${name} timed out`);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  /** Delete an API; its operations and generated tools go with it (foreign-key cascade). */
  async deleteApi(apiId) {
    await this.request('DELETE', `/apis/${apiId}`);
  }

  /** Every tool of an API. */
  async toolsOfApi(apiId) {
    const all = [];
    for (let page = 1; ; page++) {
      const res = await this.request('GET', `/organizations/${this.orgId}/tools?apiId=${apiId}&limit=100&page=${page}`);
      const rows = Array.isArray(res) ? res : res.tools ?? res.items ?? [];
      all.push(...rows);
      if (rows.length < 100) break;
    }
    return all;
  }

  /**
   * An MCP gateway serving the given tools; `exposure` is tools or code.
   * The create call takes at most 500 tool ids; the rest are attached
   * through the bulk endpoint, 500 at a time.
   */
  async createGateway({ name, endpoint, toolIds, exposure = 'tools' }) {
    const created = await this.request('POST', '/gateways', {
      name, type: 'mcp', endpoint, kind: 'tool', visibility: 'org', toolIds: toolIds.slice(0, 500),
      configuration: { transport: 'http', ...(exposure === 'tools' ? {} : { exposure }) },
    });
    const gw = created.gateway ?? created;
    for (let i = 500; i < toolIds.length; i += 500) {
      await this.request('POST', `/gateways/${gw.id}/tools/bulk`, { toolIds: toolIds.slice(i, i + 500) });
    }
    return gw;
  }

  /** One JSON-RPC call to a gateway's MCP endpoint (the earlier protocol, as most clients speak it). */
  async mcp(gatewayPath, method, params = {}) {
    const res = await fetch(`${this.baseUrl}/${gatewayPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { throw new Error(`${method} on ${gatewayPath}: not JSON (${res.status}): ${text.slice(0, 300)}`); }
    if (body.error) throw new Error(`${method} on ${gatewayPath}: ${body.error.message}`);
    return body.result;
  }

  /** The whole tools/list of a gateway, every page. */
  async listAllTools(gatewayPath) {
    const tools = [];
    let cursor;
    do {
      const page = await this.mcp(gatewayPath, 'tools/list', cursor ? { cursor } : {});
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }
}
