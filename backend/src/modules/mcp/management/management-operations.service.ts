import { Inject, Injectable, Optional } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';

import { ROLES_KEY, PERMISSIONS_KEY } from '../../auth/guards/roles.guard';
import { RBAC_ACTION_KEY } from '../../../common/authorization/rbac-actions';
import { ENTITLEMENT_KEY } from '../../licensing/decorators/requires-entitlement.decorator';
import { dtoSchema, isDtoClass, JsonSchema } from './dto-schema';
import { ManagementRouteInvoker, OperationError, ResolvedRoute } from './route-invoker.service';
import { OPERATIONS, OperationEffect, OperationEntry, effectOf } from './management-operations';

/** `@ApiOperation({ summary })`, as @nestjs/swagger stores it on the handler. */
const API_OPERATION_KEY = 'swagger/apiOperation';

export interface OperationView {
  name: string;
  summary: string;
  effect: OperationEffect;
  method: string;
  path: string;
}

export interface OperationDetail extends OperationView {
  /** The `call_*_operation` tool that runs it. */
  callWith: string;
  inputSchema: JsonSchema;
  requires: { roles?: string[]; permissions?: string[]; rbacAction?: string; entitlements?: string[] };
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: boolean };
}

/** The `call_*` meta-tool for each effect: its annotations are then true for every operation it runs. */
export const CALL_TOOL_FOR: Record<OperationEffect, string> = {
  read: 'call_read_operation',
  write: 'call_write_operation',
  destructive: 'call_destructive_operation',
};

/** Overrides the operation catalog; specs use it to run fake routes through the real machinery. */
export const MANAGEMENT_OPERATIONS = Symbol('MANAGEMENT_OPERATIONS');

const TOKEN = /[a-z0-9]+/g;

function tokens(text: string): string[] {
  return (text.toLowerCase().match(TOKEN) ?? []).map((t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t));
}

/**
 * The platform's REST operations as management-MCP operations: found with
 * search_operations, described with get_operation, run with
 * call_read_operation / call_write_operation / call_destructive_operation.
 *
 * The catalog (management-operations.ts) names each operation and the
 * route it is; everything else is read from the running route: its
 * summary (@ApiOperation), its method and path, its input schema (the
 * DTOs its ValidationPipe enforces), who may call it (@Roles,
 * @Permissions, @RbacAction, @RequiresEntitlement). Calling one runs the
 * route itself (ManagementRouteInvoker), so there is no second copy of
 * any of it to drift.
 */
@Injectable()
export class ManagementOperationsService {
  private readonly catalog: OperationEntry[];
  private readonly byName: Map<string, OperationEntry>;

  constructor(
    private readonly invoker: ManagementRouteInvoker,
    @Optional() @Inject(MANAGEMENT_OPERATIONS) catalog?: OperationEntry[],
  ) {
    this.catalog = catalog ?? OPERATIONS;
    this.byName = new Map(this.catalog.map((op) => [op.name, op]));
  }

  private route(entry: OperationEntry): ResolvedRoute | null {
    return this.invoker.resolve(entry.route);
  }

  private entry(name: string): { entry: OperationEntry; route: ResolvedRoute } {
    const entry = this.byName.get(String(name));
    if (!entry) {
      throw new OperationError(`Unknown operation: ${name}. Find operations with search_operations.`, 404);
    }
    const route = this.route(entry);
    if (!route) throw new OperationError(`The operation ${name} is not available in this edition.`, 404);
    return { entry, route };
  }

  private summaryOf(entry: OperationEntry, route: ResolvedRoute): string {
    if (entry.summary) return entry.summary;
    const api = Reflect.getMetadata(API_OPERATION_KEY, route.handler);
    return String(api?.summary ?? api?.description ?? `${route.method} ${route.path}`);
  }

  private view(entry: OperationEntry, route: ResolvedRoute): OperationView {
    return {
      name: entry.name,
      summary: this.summaryOf(entry, route),
      effect: effectOf(entry, route.method),
      method: route.method,
      path: route.path,
    };
  }

  /** Every operation this build can run (an EE operation needs the EE modules loaded). */
  available(): OperationView[] {
    const out: OperationView[] = [];
    for (const entry of this.catalog) {
      const route = this.route(entry);
      if (route) out.push(this.view(entry, route));
    }
    return out;
  }

  /**
   * Keyword search over name, summary, path and resource. Every query
   * token that matches scores; a match in the name scores double. With no
   * query, the operations of `resource` (or all) in catalog order.
   */
  search(query: string | undefined, opts: { resource?: string; effect?: OperationEffect; limit?: number } = {}) {
    const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 100);
    let pool = this.available();
    if (opts.resource) pool = pool.filter((op) => op.name.split('.')[0] === opts.resource);
    if (opts.effect) pool = pool.filter((op) => op.effect === opts.effect);
    const q = tokens(query ?? '');
    const scored = q.length
      ? pool
          .map((op) => {
            const name = new Set(tokens(op.name));
            const rest = new Set(tokens(`${op.summary} ${op.path}`));
            const score = q.reduce((s, t) => s + (name.has(t) ? 2 : 0) + (rest.has(t) ? 1 : 0), 0);
            return { op, score };
          })
          .filter((s) => s.score > 0)
          .sort((a, b) => b.score - a.score)
      : pool.map((op) => ({ op, score: 0 }));
    const resources = [...new Set(this.available().map((op) => op.name.split('.')[0]))].sort();
    return {
      total: scored.length,
      operations: scored.slice(0, limit).map(({ op }) => ({ ...op, callWith: CALL_TOOL_FOR[op.effect] })),
      resources,
    };
  }

  /** One operation in full: what it does, who may run it, and the arguments it takes. */
  describe(name: string): OperationDetail {
    const { entry, route } = this.entry(name);
    const view = this.view(entry, route);
    const meta = (key: string) =>
      Reflect.getMetadata(key, route.handler) ?? Reflect.getMetadata(key, route.controller);
    const requires: OperationDetail['requires'] = {};
    if (meta(ROLES_KEY)) requires.roles = meta(ROLES_KEY);
    if (meta(PERMISSIONS_KEY)) requires.permissions = meta(PERMISSIONS_KEY);
    if (meta(RBAC_ACTION_KEY)) requires.rbacAction = meta(RBAC_ACTION_KEY);
    if (meta(ENTITLEMENT_KEY)) requires.entitlements = meta(ENTITLEMENT_KEY);
    return {
      ...view,
      callWith: CALL_TOOL_FOR[view.effect],
      inputSchema: this.inputSchema(route),
      requires,
      annotations: annotationsFor(view.effect, view.method, !!entry.openWorld),
    };
  }

  /**
   * The arguments an operation takes, as one object: the path's `:params`
   * (required strings; never `organizationId`, which is always this
   * organization), the query fields at the top level, and the request
   * body under `body`.
   */
  inputSchema(route: ResolvedRoute): JsonSchema {
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const param of route.pathParams) {
      if (param === 'organizationId') continue;
      properties[param] = { type: 'string', description: `The :${param} in ${route.path}` };
      required.push(param);
    }
    const argsMeta: Record<string, any> =
      Reflect.getMetadata(ROUTE_ARGS_METADATA, route.controller, route.handlerName) ?? {};
    const paramTypes: any[] =
      Reflect.getMetadata('design:paramtypes', route.controller.prototype, route.handlerName) ?? [];
    let body: JsonSchema | undefined;
    const bodyFields: Record<string, JsonSchema> = {};
    for (const [key, meta] of Object.entries(argsMeta)) {
      const paramtype = Number(key.split(':')[0]);
      const metatype = paramTypes[meta.index];
      if (paramtype === RouteParamtypes.QUERY) {
        if (meta.data) {
          properties[meta.data] ??= { type: 'string', description: 'Query parameter' };
        } else if (isDtoClass(metatype)) {
          const schema = dtoSchema(metatype);
          for (const [prop, s] of Object.entries(schema.properties ?? {})) properties[prop] ??= s;
          for (const prop of schema.required ?? []) if (!required.includes(prop)) required.push(prop);
        }
      } else if (paramtype === RouteParamtypes.BODY) {
        if (meta.data) {
          bodyFields[meta.data] = isDtoClass(metatype) ? dtoSchema(metatype) : {};
        } else {
          body = isDtoClass(metatype) ? dtoSchema(metatype) : { type: 'object', additionalProperties: true };
        }
      }
    }
    if (!body && Object.keys(bodyFields).length) body = { type: 'object', properties: bodyFields };
    if (body) {
      properties.body = { ...body, description: 'The request body.' };
      if (body.required?.length) required.push('body');
    }
    return {
      type: 'object',
      properties,
      ...(required.length ? { required } : {}),
    };
  }

  /**
   * Run an operation for the caller through the `call_*` tool named
   * `via`. An operation whose effect is not that tool's is refused, so a
   * client that asks before running destructive tools is asked for every
   * destructive operation.
   */
  async call(
    via: OperationEffect,
    name: string,
    args: Record<string, unknown> | undefined,
    organizationId: string,
    userId: string | undefined,
  ): Promise<unknown> {
    const { entry, route } = this.entry(name);
    const effect = effectOf(entry, route.method);
    if (effect !== via) {
      throw new OperationError(
        `${name} is a ${effect} operation; run it with ${CALL_TOOL_FOR[effect]}.`,
        400,
      );
    }
    const params: Record<string, unknown> = {};
    const query: Record<string, unknown> = {};
    let body: unknown;
    for (const [key, value] of Object.entries(args ?? {})) {
      if (key === 'body') body = value;
      else if (route.pathParams.includes(key)) params[key] = value;
      // Over HTTP every query value arrives as a string; keep that, so a
      // query DTO validates exactly as it does for the dashboard.
      else if (value !== undefined && value !== null) query[key] = Array.isArray(value) ? value.map(String) : typeof value === 'object' ? JSON.stringify(value) : String(value);
    }
    return this.invoker.invoke(entry.route, organizationId, userId, { params, query, body });
  }
}

/** The MCP annotations an operation's effect implies. */
export function annotationsFor(effect: OperationEffect, method: string, openWorld: boolean) {
  if (effect === 'read') return { readOnlyHint: true, openWorldHint: openWorld };
  return {
    readOnlyHint: false,
    destructiveHint: effect === 'destructive',
    idempotentHint: method === 'PUT' || method === 'DELETE',
    openWorldHint: openWorld,
  };
}
