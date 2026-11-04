// The shared fake upstream: one small HTTP server that services plug
// routes into. It answers /health, logs every request one line each,
// parses JSON bodies, listens on 127.0.0.1 and ::1 (Node resolves
// localhost to either), and lets a service keep state and expose it under
// /_admin. Nothing here reaches the internet.
import http, { type IncomingHttpHeaders, type Server } from 'node:http'
import { appendFileSync } from 'node:fs'

export interface Req {
  method: string
  /** The decoded path. */
  path: string
  url: URL
  query: URLSearchParams
  headers: IncomingHttpHeaders
  /** The parsed JSON body ({} when empty, { _raw } when not JSON). */
  body: any
  /** The body exactly as sent. */
  raw: string
}

/** What a handler answers: a value is sent as JSON with 200 (201 for POST when created is set). */
export interface Reply { status?: number; json?: unknown; html?: string; text?: string; headers?: Record<string, string>; redirect?: string }
export type Answer = Reply | undefined | void
/** A handler that wrote the response itself (an event stream) returns STREAMED. */
export type Handler = (req: Req, m: RegExpMatchArray, res: http.ServerResponse) => Answer | Promise<Answer>

export interface Route {
  method?: string | string[]
  /** An exact path, or a pattern whose groups the handler gets. */
  path: string | RegExp
  handler: Handler
}

export interface Service {
  name: string
  routes: Route[]
}

export const json = (value: unknown, status = 200, headers?: Record<string, string>): Reply => ({ status, json: value, headers })
export const html = (value: string, status = 200): Reply => ({ status, html: value })
export const notFound = (value: unknown = { error: 'not found' }): Reply => ({ status: 404, json: value })
export const noContent = (): Reply => ({ status: 204, text: '' })

/** A route table entry: route('POST', /^\/tickets$/, handler). */
export const route = (method: string | string[] | undefined, path: string | RegExp, handler: Handler): Route => ({ method, path, handler })
export const get = (path: string | RegExp, handler: Handler) => route('GET', path, handler)
export const post = (path: string | RegExp, handler: Handler) => route('POST', path, handler)
export const patch = (path: string | RegExp, handler: Handler) => route('PATCH', path, handler)
export const any = (path: string | RegExp, handler: Handler) => route(undefined, path, handler)

function matchRoute(r: Route, req: Req): RegExpMatchArray | null {
  if (r.method) {
    const methods = Array.isArray(r.method) ? r.method : [r.method]
    if (!methods.includes(req.method)) return null
  }
  if (typeof r.path === 'string') return r.path === req.path ? Object.assign([req.path], { index: 0, input: req.path }) as RegExpMatchArray : null
  return req.path.match(r.path)
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function send(res: http.ServerResponse, reply: Reply): void {
  if (reply.redirect) { res.writeHead(reply.status ?? 302, { location: reply.redirect, ...reply.headers }); res.end(); return }
  if (reply.html !== undefined) { res.writeHead(reply.status ?? 200, { 'content-type': 'text/html; charset=utf-8', ...reply.headers }); res.end(reply.html); return }
  if (reply.text !== undefined) { res.writeHead(reply.status ?? 200, { 'content-type': 'text/plain; charset=utf-8', ...reply.headers }); res.end(reply.text); return }
  res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers })
  res.end(JSON.stringify(reply.json ?? null))
}

export interface ServeOptions {
  port: number
  /** One line per request, for reading what a run did. */
  log?: string
}

export const STREAMED: Reply = Object.freeze({ status: -1 })

export function serve(services: Service[], opts: ServeOptions): Server[] {
  const routes = services.flatMap((s) => s.routes)
  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://localhost:${opts.port}`)
    let path = url.pathname
    try { path = decodeURIComponent(url.pathname) } catch { /* keep it encoded */ }
    const raw = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '') ? await readBody(req) : ''
    let body: any = {}
    if (raw) { try { body = JSON.parse(raw) } catch { body = { _raw: raw } } }
    const r: Req = { method: req.method ?? 'GET', path, url, query: url.searchParams, headers: req.headers, body, raw }
    if (opts.log) {
      const auth = req.headers.authorization ? `${req.headers.authorization.slice(0, 18)}...` : 'none'
      try { appendFileSync(opts.log, `${new Date().toISOString()} ${r.method} ${url.pathname}${url.search} auth=${auth} ${raw.slice(0, 400)}\n`) } catch { /* no log dir */ }
    }
    try {
      if (path === '/health') return send(res, json({ ok: true }))
      for (const route of routes) {
        const m = matchRoute(route, r)
        if (!m) continue
        const answer = await route.handler(r, m, res)
        if (answer === STREAMED) return
        if (answer) return send(res, answer)
      }
      send(res, notFound({ error: 'not found in the local fake', path }))
    } catch (e) {
      send(res, { status: 500, json: { error: String((e as Error)?.message ?? e) } })
    }
  }
  const v4 = http.createServer(handle)
  v4.listen(opts.port, '127.0.0.1')
  const v6 = http.createServer(handle)
  v6.on('error', () => { /* no IPv6 loopback here */ })
  v6.listen(opts.port, '::1')
  return [v4, v6]
}
