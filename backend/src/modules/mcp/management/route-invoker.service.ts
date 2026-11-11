import {
  CanActivate,
  HttpException,
  Injectable,
  Logger,
  PipeTransform,
  Type,
  ValidationPipe,
} from '@nestjs/common';
import {
  CUSTOM_ROUTE_ARGS_METADATA,
  GUARDS_METADATA,
  INTERCEPTORS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  PIPES_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common/enums/request-method.enum';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { ModuleRef, ModulesContainer } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { InjectRepository } from '@nestjs/typeorm';
import { isObservable, lastValueFrom } from 'rxjs';
import { EntityNotFoundError, QueryFailedError, Repository } from 'typeorm';

import { User } from '../../../entities/user.entity';
import { isConnectionClassDatabaseError } from '../../../common/filters/global-exception.filter';
import { effectiveMemberships, hasEffectiveMembership } from '../../../common/authorization/membership';
import { GLOBAL_VALIDATION_OPTIONS } from '../../../common/validation-options';
import { versionContext } from '../../../common/version-context';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import { curatedControllerClass } from './curated-controllers';
import { isOptionalUploadInterceptor } from '../../files/temp-upload';

/**
 * Runs one dashboard route on behalf of a management-MCP caller.
 *
 * The management MCP (`/:org/almyty`) exposes the platform's REST
 * operations as MCP operations (management-operations.ts). An operation
 * does not get its own copy of the route's logic: it calls the route's own
 * controller handler, the same way Nest's router does, so validation,
 * authorization, service calls, audit entries and the response are the
 * route's. What this class reproduces from the HTTP pipeline:
 *
 *  - the caller: the user row with its memberships, as JwtStrategy loads
 *    it, with the organization fixed to the gateway's own. A caller who is
 *    not an effective member of that organization is refused before any
 *    guard runs. A path `:organizationId` is always the gateway's org, never
 *    an argument.
 *  - the guards the route declares (class and method `@UseGuards`):
 *    RolesGuard with its `@Roles`/`@Permissions`/`@RbacAction` and the EE
 *    advanced-RBAC hook, EntitlementGuard and `@RequiresEntitlement`, the
 *    private-resource guards, GatewayAuthManagementGuard. JwtAuthGuard is
 *    the one guard not run: the MCP layer has already authenticated the
 *    caller, and what it attaches (`req.user`) is built here instead.
 *  - the pipes: the global ValidationPipe with the options main.ts uses,
 *    `@UsePipes`, and per-parameter pipes (ParseUUIDPipe and friends).
 *  - the global VersionContextInterceptor's store, so versioned writes
 *    are attributed to the caller.
 *
 * What it refuses: a route that is not behind JwtAuthGuard (a public
 * route), a route guarded by anything that authenticates a non-user
 * (runner credentials, SCIM tokens, password login), and a route with an
 * interceptor other than the optional upload one. Those are excluded from
 * the catalog anyway; refusing here keeps a mis-mapped one from running.
 * The upload interceptor (TempFileInterceptor) is skipped: the routes that
 * carry it take the same input as JSON when no file is sent, and an MCP
 * call never sends one.
 */

/** The guard that authenticates a dashboard user; the MCP layer already did, so it is not re-run. */
const AUTHENTICATING_GUARDS = new Set(['JwtAuthGuard']);
/** Guards that authenticate something other than a signed-in user: a route behind one is never an MCP operation. */
const NON_USER_GUARDS = new Set([
  'RunnerCredentialGuard',
  'ScimAuthGuard',
  'LocalAuthGuard',
  'AccountThrottleGuard',
]);

export interface ResolvedRoute {
  controller: Type<any>;
  instance: any;
  handlerName: string;
  handler: (...args: any[]) => any;
  method: string;
  /** Full path pattern, e.g. `/agents/:id/versions`. */
  path: string;
  /** The `:name` segments of the path, in order. */
  pathParams: string[];
}

export interface RouteCall {
  /** Values for the path's `:params` (an `organizationId` is ignored). */
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  /**
   * Authorizing a curated tool: a path parameter its arguments do not
   * carry is left blank rather than refused. The role and entitlement
   * checks do not read it, and the private-resource guards pass a value
   * that is not an id to the handler, which here is the tool's own code.
   */
  lenient?: boolean;
}

/** A refusal or failure, in words an MCP client can act on. */
export class OperationError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/** The path without leading or trailing slashes (a linear scan, not a regex). */
function trimSlashes(path: string): string {
  let start = 0;
  let end = path.length;
  while (start < end && path[start] === '/') start++;
  while (end > start && path[end - 1] === '/') end--;
  return path.slice(start, end);
}

function joinPath(prefix: string | string[] | undefined, sub: string | string[] | undefined): string {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
  const parts = [first(prefix), first(sub)].map(trimSlashes).filter(Boolean);
  return '/' + parts.join('/');
}

const logger = new Logger('ManagementRouteInvoker');

/**
 * What the caller is told when the route fails: what GlobalExceptionFilter
 * would have sent over HTTP. An HttpException's message (with the field
 * list a ValidationPipe refusal holds) is the caller's to read; a database
 * error or an unexpected throw is not, and reads as the same generic
 * sentence the REST route answers with. The detail goes to the log.
 */
export function describeHttpError(err: unknown): OperationError {
  if (err instanceof OperationError) return err;
  if (err instanceof HttpException) {
    const response: any = err.getResponse();
    const message = Array.isArray(response?.message)
      ? response.message.join('; ')
      : typeof response === 'string'
        ? response
        : response?.message ?? err.message;
    return new OperationError(String(message), err.getStatus());
  }
  if (err instanceof QueryFailedError) {
    const connectionClass = isConnectionClassDatabaseError(err);
    logger.error(`Database error in a management operation: ${(err as any).code ?? 'no-code'} ${err.message}`);
    return new OperationError(connectionClass ? 'Service temporarily unavailable' : 'Database operation failed', connectionClass ? 503 : 400);
  }
  if (err instanceof EntityNotFoundError) return new OperationError('Resource not found', 404);
  logger.error(`Unhandled error in a management operation: ${err instanceof Error ? err.message : String(err)}`);
  return new OperationError('Internal server error', 500);
}

@Injectable()
export class ManagementRouteInvoker {
  private routes?: Map<string, { controller: Type<any>; instance: any }>;
  private readonly guardCache = new Map<any, CanActivate>();
  private readonly pipeCache = new Map<any, PipeTransform>();
  private readonly globalPipe = new ValidationPipe(GLOBAL_VALIDATION_OPTIONS);

  constructor(
    private readonly modules: ModulesContainer,
    private readonly moduleRef: ModuleRef,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  /** The controller class named `name`, from the running application, or null when this build has none. */
  private controllerNamed(name: string): { controller: Type<any>; instance: any } | null {
    if (!this.routes) {
      this.routes = new Map();
      for (const mod of this.modules.values()) {
        for (const wrapper of mod.controllers.values()) {
          const metatype = wrapper.metatype as Type<any> | null;
          if (metatype?.name && wrapper.instance && !this.routes.has(metatype.name)) {
            this.routes.set(metatype.name, { controller: metatype, instance: wrapper.instance });
          }
        }
      }
    }
    return this.routes.get(name) ?? null;
  }

  /**
   * `ControllerClass.handler` as the running application has it, or null
   * when the controller is not loaded (an EE controller in a community
   * build) or has no such handler.
   */
  resolve(ref: string): ResolvedRoute | null {
    const [controllerName, handlerName] = ref.split('.');
    // A curated tool's twin is named directly (curated-controllers.ts):
    // authorizing it needs the class's metadata, not a registered instance.
    const curated = curatedControllerClass(controllerName);
    const found = this.controllerNamed(controllerName) ?? (curated ? { controller: curated, instance: null } : null);
    if (!found) return null;
    const handler = found.controller.prototype?.[handlerName];
    if (typeof handler !== 'function') return null;
    const methodValue = Reflect.getMetadata(METHOD_METADATA, handler);
    const path = joinPath(
      Reflect.getMetadata(PATH_METADATA, found.controller),
      Reflect.getMetadata(PATH_METADATA, handler),
    );
    return {
      controller: found.controller,
      instance: found.instance,
      handlerName,
      handler,
      method: typeof methodValue === 'number' ? RequestMethod[methodValue] : 'GET',
      path,
      pathParams: (path.match(/:(\w+)/g) ?? []).map((p) => p.slice(1)),
    };
  }

  /**
   * The caller as JwtStrategy would attach it, scoped to `organizationId`.
   * Refused when the user is unknown or inactive, or is not an effective
   * member of the organization the MCP endpoint belongs to.
   */
  async principal(organizationId: string, userId: string | undefined): Promise<any> {
    if (!userId) throw new OperationError('This operation needs a signed-in user; the request carried none.', 401);
    const user: any = await this.users.findOne({
      where: { id: userId },
      relations: { organizationMemberships: { organization: true } },
    });
    if (!user || !user.isActive) throw new OperationError('User not found or inactive.', 401);
    if (!hasEffectiveMembership(user.organizationMemberships, organizationId)) {
      throw new OperationError('You are not a member of this organization.', 403);
    }
    user.organizations = effectiveMemberships(user.organizationMemberships).map((m: any) => ({
      id: m.organizationId || m.organization?.id,
      name: m.organization?.name,
      role: m.role,
    }));
    user.currentOrganizationId = organizationId;
    return user;
  }

  private request(route: ResolvedRoute, user: any, organizationId: string, call: RouteCall): any {
    const params: Record<string, string> = {};
    for (const name of route.pathParams) {
      const value = name === 'organizationId' ? organizationId : call.params?.[name];
      if (value === undefined || value === null || value === '') {
        if (call.lenient) {
          params[name] = '-';
          continue;
        }
        throw new OperationError(`Missing argument: ${name}`, 400);
      }
      params[name] = String(value);
    }
    const url = route.path.replace(/:(\w+)/g, (_, name) => encodeURIComponent(params[name]));
    const headers: Record<string, string> = {
      'user-agent': 'almyty-mcp',
      'x-organization-id': organizationId,
    };
    return {
      method: route.method,
      url,
      originalUrl: url,
      path: url,
      route: { path: route.path },
      params,
      query: { ...(call.query ?? {}) },
      body: call.body ?? {},
      headers,
      cookies: {},
      user,
      ip: undefined,
      socket: {},
      get: (name: string) => headers[name.toLowerCase()],
      header: (name: string) => headers[name.toLowerCase()],
    };
  }

  private async instanceOf<T>(token: any, cache: Map<any, T>): Promise<T> {
    if (typeof token !== 'function') return token as T;
    const cached = cache.get(token);
    if (cached) return cached;
    let instance: T | undefined;
    for (const mod of this.modules.values()) {
      const wrapper = mod.injectables.get(token) ?? mod.providers.get(token);
      if (wrapper?.instance) {
        instance = wrapper.instance as T;
        break;
      }
    }
    instance ??= await this.moduleRef.create(token);
    cache.set(token, instance!);
    return instance!;
  }

  private guardsOf(route: ResolvedRoute): any[] {
    return [
      ...(Reflect.getMetadata(GUARDS_METADATA, route.controller) ?? []),
      ...(Reflect.getMetadata(GUARDS_METADATA, route.handler) ?? []),
    ];
  }

  private assertServable(route: ResolvedRoute): void {
    const interceptors = [
      ...(Reflect.getMetadata(INTERCEPTORS_METADATA, route.controller) ?? []),
      ...(Reflect.getMetadata(INTERCEPTORS_METADATA, route.handler) ?? []),
    ];
    const nameOf = (token: any): string => (typeof token === 'function' ? token.name : token?.constructor?.name);
    if (interceptors.some((i) => !isOptionalUploadInterceptor(i))) {
      throw new OperationError('This operation needs request handling an MCP call cannot reproduce (an interceptor such as a required upload).', 400);
    }
    const guards = this.guardsOf(route).map(nameOf);
    // @Public() turns JwtAuthGuard off for the route: it is not a signed-in user's either.
    const isPublic = Reflect.getMetadata(IS_PUBLIC_KEY, route.handler) ?? Reflect.getMetadata(IS_PUBLIC_KEY, route.controller);
    if (isPublic || guards.some((name) => NON_USER_GUARDS.has(name)) || !guards.some((name) => AUTHENTICATING_GUARDS.has(name))) {
      throw new OperationError('This operation is not for a signed-in user, so it is not available over MCP.', 403);
    }
  }

  /** Run the route's own guards against the caller. Throws the guard's refusal. */
  async authorize(ref: string, organizationId: string, userId: string | undefined, call: RouteCall = {}): Promise<void> {
    const route = this.resolve(ref);
    if (!route) throw new OperationError('This operation is not available in this edition.', 404);
    const user = await this.principal(organizationId, userId);
    const req = this.request(route, user, organizationId, call);
    await this.runGuards(route, req);
  }

  private context(route: ResolvedRoute, req: any, res: any): ExecutionContextHost {
    const ctx = new ExecutionContextHost([req, res, () => undefined], route.controller, route.handler);
    ctx.setType('http');
    return ctx;
  }

  private async runGuards(route: ResolvedRoute, req: any): Promise<void> {
    this.assertServable(route);
    const ctx = this.context(route, req, {});
    for (const token of this.guardsOf(route)) {
      const name = typeof token === 'function' ? token.name : token?.constructor?.name;
      if (AUTHENTICATING_GUARDS.has(name)) continue;
      const guard = await this.instanceOf<CanActivate>(token, this.guardCache);
      let allowed: boolean;
      try {
        const result = guard.canActivate(ctx);
        allowed = isObservable(result) ? await lastValueFrom(result) : await result;
      } catch (err) {
        throw describeHttpError(err);
      }
      if (!allowed) throw new OperationError('Forbidden resource', 403);
    }
  }

  /** The pipes a parameter goes through, in Nest's order: global, controller, method, parameter. */
  private pipesFor(route: ResolvedRoute, paramPipes: any[]): any[] {
    return [
      this.globalPipe,
      ...(Reflect.getMetadata(PIPES_METADATA, route.controller) ?? []),
      ...(Reflect.getMetadata(PIPES_METADATA, route.handler) ?? []),
      ...(paramPipes ?? []),
    ];
  }

  /**
   * Call the route for the caller: authorize, build the handler's
   * arguments, validate them, run the handler. Returns what the route
   * would have sent as its JSON body.
   */
  async invoke(ref: string, organizationId: string, userId: string | undefined, call: RouteCall = {}): Promise<unknown> {
    const route = this.resolve(ref);
    if (!route?.instance) throw new OperationError('This operation is not available in this edition.', 404);
    const user = await this.principal(organizationId, userId);
    const req = this.request(route, user, organizationId, call);
    await this.runGuards(route, req);

    const captured: { body?: unknown; sent: boolean; status?: number } = { sent: false };
    const res: any = {
      statusCode: 200,
      locals: {},
      status(code: number) { captured.status = code; this.statusCode = code; return this; },
      setHeader() { return this; },
      header() { return this; },
      set() { return this; },
      cookie() { return this; },
      clearCookie() { return this; },
      json(body: unknown) { captured.body = body; captured.sent = true; return this; },
      send(body: unknown) { captured.body = body; captured.sent = true; return this; },
      end(body?: unknown) { if (body !== undefined) captured.body = body; captured.sent = true; return this; },
      redirect() { throw new OperationError('This operation answers with a browser redirect, which an MCP call cannot follow.', 400); },
      write() { throw new OperationError('This operation streams its answer, which this MCP operation cannot relay.', 400); },
      pipe() { throw new OperationError('This operation streams its answer, which this MCP operation cannot relay.', 400); },
    };
    const ctx = this.context(route, req, res);

    const argsMeta: Record<string, any> = Reflect.getMetadata(ROUTE_ARGS_METADATA, route.controller, route.handlerName) ?? {};
    const paramTypes: any[] = Reflect.getMetadata('design:paramtypes', route.controller.prototype, route.handlerName) ?? [];
    const args: unknown[] = [];
    try {
      for (const [key, meta] of Object.entries(argsMeta)) {
        const index: number = meta.index;
        const metatype = paramTypes[index];
        let value: unknown;
        let type: 'body' | 'query' | 'param' | 'custom' | undefined;
        if (key.includes(CUSTOM_ROUTE_ARGS_METADATA)) {
          value = meta.factory(meta.data, ctx);
          type = 'custom';
        } else {
          const paramtype = Number(key.split(':')[0]) as RouteParamtypes;
          const pick = (source: any) => (meta.data ? source?.[meta.data] : source);
          switch (paramtype) {
            case RouteParamtypes.REQUEST: value = req; break;
            case RouteParamtypes.RESPONSE: value = res; break;
            case RouteParamtypes.NEXT: value = () => undefined; break;
            case RouteParamtypes.BODY: value = pick(req.body); type = 'body'; break;
            case RouteParamtypes.QUERY: value = pick(req.query); type = 'query'; break;
            case RouteParamtypes.PARAM: value = pick(req.params); type = 'param'; break;
            case RouteParamtypes.HEADERS: value = meta.data ? req.headers[String(meta.data).toLowerCase()] : req.headers; break;
            case RouteParamtypes.IP: value = req.ip; break;
            // No upload ever rides an MCP call; the route's JSON form applies.
            case RouteParamtypes.FILE: value = undefined; break;
            case RouteParamtypes.FILES: value = undefined; break;
            case RouteParamtypes.HOST: value = undefined; break;
            default:
              throw new OperationError('This operation needs something an MCP call cannot carry.', 400);
          }
        }
        if (type) {
          for (const pipe of this.pipesFor(route, meta.pipes)) {
            const instance = await this.instanceOf<PipeTransform>(pipe, this.pipeCache);
            value = await instance.transform(value, { type, metatype, data: meta.data });
          }
        }
        args[index] = value;
      }
    } catch (err) {
      throw describeHttpError(err);
    }

    try {
      const store = { userId: user.id, userEmail: user.email };
      let result: any = await versionContext.run(store, () => route.handler.apply(route.instance, args));
      if (isObservable(result)) result = await lastValueFrom(result);
      const usesRawResponse = Object.entries(argsMeta).some(
        ([key, meta]) => Number(key.split(':')[0]) === RouteParamtypes.RESPONSE && !meta.data?.passthrough,
      );
      if (usesRawResponse || (captured.sent && result === undefined)) {
        if (captured.status && captured.status >= 400) {
          throw new OperationError(typeof captured.body === 'string' ? captured.body : JSON.stringify(captured.body), captured.status);
        }
        return captured.body ?? null;
      }
      return result ?? null;
    } catch (err) {
      throw describeHttpError(err);
    }
  }
}
