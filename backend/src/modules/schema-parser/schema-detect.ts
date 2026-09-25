/**
 * Work out what an API description is, and what it says about the API,
 * from its content alone.
 *
 * Connecting an API used to start with a form: name, type (six of them),
 * base URL, version, the sign-in scheme and its header, a description.
 * Every one of those is already written in the description the user is
 * about to import -- OpenAPI's `info`, `servers` and `securitySchemes`,
 * Swagger 2's `host`/`basePath`/`securityDefinitions`, a WSDL's
 * `soap:address`, a GraphQL endpoint's own URL. This module reads them,
 * so the one question left is the one only the user can answer: their key.
 *
 * Pure: no I/O, no DI. The caller fetches (through the guarded helper)
 * and hands the text in.
 */
import { buildClientSchema, parse as parseGraphQL, printSchema, Kind } from 'graphql';
import * as protobuf from 'protobufjs';

import { ApiType } from '../../entities/api.entity';

export type DetectedFormat = 'openapi3' | 'swagger2' | 'graphql-sdl' | 'graphql-introspection' | 'wsdl' | 'proto';

export type DetectedAuthType = 'none' | 'api_key' | 'bearer' | 'basic' | 'oauth2';

export interface DetectedOAuth2 {
  flow: 'authorization_code' | 'client_credentials';
  authorizationUrl?: string;
  tokenUrl: string;
  scopes: string[];
}

export interface DetectedAuth {
  type: DetectedAuthType;
  /** api_key: the header or query parameter the key travels in. */
  headerName?: string;
  location?: 'header' | 'query';
  /** oauth2: what the spec declares, so signing in needs only a client id and secret. */
  oauth2?: DetectedOAuth2;
}

export interface DetectedApi {
  type: ApiType;
  format: DetectedFormat;
  /** The text the parser for `type` reads. Introspection JSON comes back as SDL. */
  content: string;
  name: string | null;
  version: string | null;
  description: string | null;
  baseUrl: string | null;
  auth: DetectedAuth;
}

export interface DetectOptions {
  fileName?: string;
  /** Where the text was fetched from: resolves relative server URLs and names an unnamed API. */
  sourceUrl?: string;
  /** Set when the text came from a GraphQL endpoint's introspection: that URL is the API's address. */
  graphqlEndpoint?: string;
}

/** Thrown when the text is none of the formats we read. The message is written for the person who pasted it. */
export class SchemaNotRecognizedError extends Error {
  readonly code = 'SCHEMA_NOT_RECOGNIZED';
  constructor(message = "We couldn't read this as OpenAPI, GraphQL, WSDL or proto.") {
    super(message);
    this.name = 'SchemaNotRecognizedError';
  }
}

/** GraphQL SDL above this is left to the parser's own cap rather than test-parsed here. */
const MAX_SDL_DETECT_BYTES = 5 * 1024 * 1024;

const WSDL_NAMESPACES = ['http://schemas.xmlsoap.org/wsdl/', 'http://www.w3.org/ns/wsdl'];

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function extensionOf(fileName?: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(fileName ?? '');
  return m ? m[1].toLowerCase() : '';
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Read the text and say what it is. Throws SchemaNotRecognizedError when
 * it is not an API description we can import.
 */
export function detectApiSchema(raw: string, opts: DetectOptions = {}): DetectedApi {
  const text = stripBom(typeof raw === 'string' ? raw : String(raw ?? ''));
  const trimmed = text.trim();
  if (!trimmed) throw new SchemaNotRecognizedError('There is nothing to import yet.');

  if (trimmed.startsWith('<')) return detectXml(text, opts);

  const json = tryJson(trimmed);
  if (json !== undefined) return detectJson(json, text, opts);

  if (/^\s*(openapi|swagger)\s*:/m.test(text)) {
    const doc = tryYaml(text);
    if (doc && typeof doc === 'object') return detectJson(doc, text, opts);
  }

  const ext = extensionOf(opts.fileName);
  if (ext === 'proto' || looksLikeProto(text)) {
    const proto = tryProto(text, opts);
    if (proto) return proto;
  }

  const sdl = trySdl(text, opts);
  if (sdl) return sdl;

  throw new SchemaNotRecognizedError();
}

function tryJson(text: string): unknown {
  if (!(text.startsWith('{') || text.startsWith('['))) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function tryYaml(text: string): unknown {
  try {
    // Same loader the OpenAPI parser uses; the parser re-checks the
    // document's shape (alias amplification, depth) before walking it.
    const yaml = require('js-yaml');
    return yaml.load(text);
  } catch {
    return undefined;
  }
}

function detectJson(doc: any, text: string, opts: DetectOptions): DetectedApi {
  if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
    if (typeof doc.openapi === 'string' && doc.openapi.startsWith('3')) return describeOpenApi3(doc, text, opts);
    if (String(doc.swagger ?? '') === '2.0') return describeSwagger2(doc, text, opts);
    const schema = doc.__schema ?? doc.data?.__schema;
    if (schema && typeof schema === 'object') return describeIntrospection({ __schema: schema }, opts);
  }
  throw new SchemaNotRecognizedError();
}

// ---------------------------------------------------------------------------
// OpenAPI 3 / Swagger 2
// ---------------------------------------------------------------------------

function describeOpenApi3(doc: any, text: string, opts: DetectOptions): DetectedApi {
  const info = doc.info ?? {};
  const server = Array.isArray(doc.servers) ? doc.servers.find((s: any) => str(s?.url)) : null;
  return {
    type: ApiType.OPENAPI,
    format: 'openapi3',
    content: text,
    name: str(info.title) ?? fallbackName(opts),
    version: str(info.version) ?? (info.version != null ? String(info.version) : null),
    description: str(info.description),
    baseUrl: server ? resolveServerUrl(server, opts.sourceUrl) : originOf(opts.sourceUrl),
    auth: pickAuth(doc.components?.securitySchemes, doc.security, doc.paths, mapOpenApi3Scheme),
  };
}

function describeSwagger2(doc: any, text: string, opts: DetectOptions): DetectedApi {
  const info = doc.info ?? {};
  return {
    type: ApiType.OPENAPI,
    format: 'swagger2',
    content: text,
    name: str(info.title) ?? fallbackName(opts),
    version: str(info.version) ?? (info.version != null ? String(info.version) : null),
    description: str(info.description),
    baseUrl: swagger2BaseUrl(doc, opts.sourceUrl),
    auth: pickAuth(doc.securityDefinitions, doc.security, doc.paths, mapSwagger2Scheme),
  };
}

/** `https://{region}.example.com` with the variables' defaults filled in; relative URLs against where the spec came from. */
function resolveServerUrl(server: any, sourceUrl?: string): string | null {
  let url = String(server.url).trim();
  const vars = server.variables && typeof server.variables === 'object' ? server.variables : {};
  url = url.replace(/\{([^}]+)\}/g, (whole, name) => {
    const v = vars[name];
    return v && v.default != null ? String(v.default) : whole;
  });
  if (/\{[^}]+\}/.test(url)) return null;
  return absolute(url, sourceUrl);
}

function swagger2BaseUrl(doc: any, sourceUrl?: string): string | null {
  const basePath = str(doc.basePath) ?? '';
  const host = str(doc.host);
  if (host) {
    const schemes: string[] = Array.isArray(doc.schemes) ? doc.schemes : [];
    const scheme = schemes.includes('https') ? 'https' : schemes[0] ?? (sourceUrl?.startsWith('http:') ? 'http' : 'https');
    return trimSlash(`${scheme}://${host}${basePath}`);
  }
  const origin = originOf(sourceUrl);
  return origin ? trimSlash(`${origin}${basePath}`) : null;
}

function absolute(url: string, sourceUrl?: string): string | null {
  if (/^https?:\/\//i.test(url)) return trimSlash(url);
  if (!sourceUrl) return null;
  try {
    return trimSlash(new URL(url, sourceUrl).toString());
  } catch {
    return null;
  }
}

function originOf(sourceUrl?: string): string | null {
  if (!sourceUrl) return null;
  try {
    return new URL(sourceUrl).origin;
  } catch {
    return null;
  }
}

function trimSlash(url: string): string {
  return url.length > 1 && url.endsWith('/') && !/^https?:\/\/$/.test(url) ? url.replace(/\/+$/, '') : url;
}

/**
 * The scheme the API asks for: the first one its top-level `security`
 * names, else the first one any operation names, else the first declared.
 */
function pickAuth(
  schemes: Record<string, any> | undefined,
  security: unknown,
  paths: Record<string, any> | undefined,
  map: (scheme: any) => DetectedAuth | null,
): DetectedAuth {
  if (!schemes || typeof schemes !== 'object') return { type: 'none' };
  const named: string[] = [];
  const collect = (req: unknown) => {
    if (!Array.isArray(req)) return;
    for (const entry of req) {
      if (entry && typeof entry === 'object') named.push(...Object.keys(entry));
    }
  };
  collect(security);
  if (named.length === 0 && paths && typeof paths === 'object') {
    for (const item of Object.values(paths)) {
      if (!item || typeof item !== 'object') continue;
      for (const op of Object.values(item as Record<string, any>)) collect(op?.security);
      if (named.length > 0) break;
    }
  }
  const order = [...named, ...Object.keys(schemes)];
  for (const name of order) {
    const mapped = schemes[name] ? map(schemes[name]) : null;
    if (mapped) return mapped;
  }
  return { type: 'none' };
}

function apiKeyAuth(scheme: any): DetectedAuth | null {
  const name = str(scheme.name);
  if (!name) return null;
  if (scheme.in === 'query') return { type: 'api_key', headerName: name, location: 'query' };
  if (scheme.in === 'header') return { type: 'api_key', headerName: name, location: 'header' };
  return null; // cookie keys are not something a tool call sends
}

function mapOpenApi3Scheme(scheme: any): DetectedAuth | null {
  switch (scheme?.type) {
    case 'apiKey':
      return apiKeyAuth(scheme);
    case 'http': {
      const s = String(scheme.scheme ?? '').toLowerCase();
      if (s === 'bearer') return { type: 'bearer' };
      if (s === 'basic') return { type: 'basic' };
      return null;
    }
    case 'oauth2': {
      const flows = scheme.flows ?? {};
      if (flows.authorizationCode?.authorizationUrl && flows.authorizationCode?.tokenUrl) {
        return { type: 'oauth2', oauth2: { flow: 'authorization_code', authorizationUrl: flows.authorizationCode.authorizationUrl, tokenUrl: flows.authorizationCode.tokenUrl, scopes: Object.keys(flows.authorizationCode.scopes ?? {}) } };
      }
      if (flows.clientCredentials?.tokenUrl) {
        return { type: 'oauth2', oauth2: { flow: 'client_credentials', tokenUrl: flows.clientCredentials.tokenUrl, scopes: Object.keys(flows.clientCredentials.scopes ?? {}) } };
      }
      // Implicit and password flows: the user pastes a token they already have.
      return { type: 'bearer' };
    }
    case 'openIdConnect':
      return { type: 'bearer' };
    default:
      return null;
  }
}

function mapSwagger2Scheme(scheme: any): DetectedAuth | null {
  switch (scheme?.type) {
    case 'apiKey':
      return apiKeyAuth(scheme);
    case 'basic':
      return { type: 'basic' };
    case 'oauth2': {
      const scopes = Object.keys(scheme.scopes ?? {});
      if (scheme.flow === 'accessCode' && scheme.authorizationUrl && scheme.tokenUrl) {
        return { type: 'oauth2', oauth2: { flow: 'authorization_code', authorizationUrl: scheme.authorizationUrl, tokenUrl: scheme.tokenUrl, scopes } };
      }
      if (scheme.flow === 'application' && scheme.tokenUrl) {
        return { type: 'oauth2', oauth2: { flow: 'client_credentials', tokenUrl: scheme.tokenUrl, scopes } };
      }
      return { type: 'bearer' };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------

function describeIntrospection(result: { __schema: any }, opts: DetectOptions): DetectedApi {
  let sdl: string;
  try {
    sdl = printSchema(buildClientSchema(result as any));
  } catch {
    throw new SchemaNotRecognizedError();
  }
  return {
    type: ApiType.GRAPHQL,
    format: 'graphql-introspection',
    content: sdl,
    name: fallbackName(opts),
    version: null,
    description: str(result.__schema?.description),
    baseUrl: opts.graphqlEndpoint ?? null,
    auth: { type: 'none' },
  };
}

function trySdl(text: string, opts: DetectOptions): DetectedApi | null {
  if (text.length > MAX_SDL_DETECT_BYTES) return null;
  let doc;
  try {
    doc = parseGraphQL(text, { noLocation: true });
  } catch {
    return null;
  }
  const typeKinds = new Set<string>([Kind.OBJECT_TYPE_DEFINITION, Kind.SCHEMA_DEFINITION, Kind.OBJECT_TYPE_EXTENSION]);
  if (!doc.definitions.some((d) => typeKinds.has(d.kind))) return null;
  const schemaDef = doc.definitions.find((d) => d.kind === Kind.SCHEMA_DEFINITION) as any;
  const leading = /^\s*"""([\s\S]*?)"""/.exec(text);
  return {
    type: ApiType.GRAPHQL,
    format: 'graphql-sdl',
    content: text,
    name: fallbackName(opts),
    version: null,
    description: str(schemaDef?.description?.value) ?? (leading ? str(leading[1]) : null),
    baseUrl: opts.graphqlEndpoint ?? null,
    auth: { type: 'none' },
  };
}

// ---------------------------------------------------------------------------
// WSDL
// ---------------------------------------------------------------------------

function detectXml(text: string, opts: DetectOptions): DetectedApi {
  const head = text.slice(0, 64 * 1024);
  const isWsdl = /<(?:[\w-]+:)?(definitions|description)\b/.test(head) && WSDL_NAMESPACES.some((ns) => head.includes(ns));
  if (!isWsdl) throw new SchemaNotRecognizedError();
  const defName = /<(?:[\w-]+:)?definitions\b[^>]*\bname\s*=\s*"([^"]+)"/.exec(head)?.[1];
  const serviceName = /<(?:[\w-]+:)?service\b[^>]*\bname\s*=\s*"([^"]+)"/.exec(text)?.[1];
  const doc = /<(?:[\w-]+:)?documentation\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?documentation>/.exec(head)?.[1];
  // SOAP 1.1 or 1.2 address, in the service's port.
  const address = /<(?:[\w-]+:)?address\b[^>]*\blocation\s*=\s*"([^"]+)"/.exec(text)?.[1];
  return {
    type: ApiType.SOAP,
    format: 'wsdl',
    content: text,
    name: str(defName) ?? str(serviceName) ?? fallbackName(opts),
    version: null,
    description: doc ? str(doc.replace(/<[^>]*>/g, '')) : null,
    baseUrl: address ? absolute(address, opts.sourceUrl) : null,
    auth: { type: 'none' },
  };
}

// ---------------------------------------------------------------------------
// Protocol Buffers
// ---------------------------------------------------------------------------

function looksLikeProto(text: string): boolean {
  return /^\s*syntax\s*=\s*["']proto[23]["']/m.test(text) || (/^\s*service\s+\w+\s*\{/m.test(text) && /\brpc\s+\w+\s*\(/.test(text)) || (/^\s*message\s+\w+\s*\{/m.test(text) && /=\s*\d+\s*;/.test(text));
}

function tryProto(text: string, opts: DetectOptions): DetectedApi | null {
  let parsed: protobuf.IParserResult;
  try {
    parsed = protobuf.parse(text, { keepCase: true });
  } catch {
    return null;
  }
  const services: string[] = [];
  const walk = (ns: protobuf.NamespaceBase) => {
    for (const nested of ns.nestedArray) {
      if (nested instanceof protobuf.Service) services.push(nested.name);
      else if (nested instanceof protobuf.Namespace) walk(nested);
    }
  };
  walk(parsed.root);
  const pkg = parsed.package ?? null;
  const version = pkg ? /(?:^|\.)(v\d+(?:(?:alpha|beta)\d*)?)$/.exec(pkg)?.[1] ?? null : null;
  const leading = /^\s*\/\/\s*(.+)$/m.exec(text.split(/^\s*syntax\b/m)[0] ?? '');
  return {
    type: ApiType.GRPC,
    format: 'proto',
    content: text,
    name: services[0] ?? pkg ?? fallbackName(opts),
    version,
    description: leading ? str(leading[1]) : null,
    baseUrl: null,
    auth: { type: 'none' },
  };
}

// ---------------------------------------------------------------------------

/** File names that say nothing about the API; the host it came from says more. */
const GENERIC_FILE_NAMES = new Set(['schema', 'openapi', 'swagger', 'api', 'apis', 'spec', 'service', 'index', 'definition', 'wsdl', 'graphql']);

/** A name when the description has none: the file's name, else the host it came from. */
function fallbackName(opts: DetectOptions): string | null {
  const base = (opts.fileName ?? '').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').trim();
  if (base && !GENERIC_FILE_NAMES.has(base.toLowerCase())) return base;
  const from = opts.graphqlEndpoint ?? opts.sourceUrl;
  if (from) {
    try {
      return new URL(from).hostname;
    } catch {
      /* fall through */
    }
  }
  return null;
}
