import { BadRequestException } from '@nestjs/common';
import * as protobuf from 'protobufjs';

import { ToolExecutionMethod } from '../../entities/tool.entity';

/**
 * A GraphQL, SOAP or gRPC tool made on the Create tool page is stored as
 * its protocol's config (`graphqlConfig`, `soapConfig`, `grpcConfig`),
 * which the protocol executor runs. It is never stored as generated
 * JavaScript: the executor dispatches `code` to the sandbox before any
 * config, and the sandbox has none of the clients such code would need,
 * so a tool saved that way could not run. This is the one stored shape,
 * checked on create and on update, so a tool that saves is a tool that
 * can run.
 */

const PROTOCOL_CONFIG: Record<string, 'graphqlConfig' | 'soapConfig' | 'grpcConfig'> = {
  [ToolExecutionMethod.GRAPHQL]: 'graphqlConfig',
  [ToolExecutionMethod.SOAP]: 'soapConfig',
  [ToolExecutionMethod.GRPC]: 'grpcConfig',
};

const LABEL: Record<string, string> = {
  graphqlConfig: 'GraphQL',
  soapConfig: 'SOAP',
  grpcConfig: 'gRPC',
};

export interface ProtocolToolInput {
  executionMethod?: string | null;
  code?: string | null;
  apiId?: string | null;
  graphqlConfig?: any;
  soapConfig?: any;
  grpcConfig?: any;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

function assertEndpoint(label: string, endpoint: unknown, linkedToApi: boolean): void {
  if (endpoint === undefined || endpoint === null || endpoint === '') {
    if (linkedToApi) return;
    throw new BadRequestException(`A ${label} tool needs the service URL (endpoint).`);
  }
  let parsed: URL;
  try {
    parsed = new URL(String(endpoint));
  } catch {
    throw new BadRequestException(`The ${label} endpoint is not a URL: ${String(endpoint)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BadRequestException(
      `The ${label} endpoint must start with https:// (or http:// for a plaintext server).`,
    );
  }
}

/** Every service in a parsed proto, by its simple and its full name. */
function servicesIn(ns: protobuf.NamespaceBase, out: protobuf.Service[] = []): protobuf.Service[] {
  for (const nested of ns.nestedArray) {
    if (nested instanceof protobuf.Service) out.push(nested);
    if (nested instanceof protobuf.Namespace || nested instanceof protobuf.Type || nested instanceof protobuf.Service) {
      servicesIn(nested as protobuf.NamespaceBase, out);
    }
  }
  return out;
}

function assertProtoHasMethod(proto: string, serviceName: string, methodName: string): void {
  let root: protobuf.Root;
  try {
    root = protobuf.parse(proto, { keepCase: true }).root;
  } catch (err: any) {
    throw new BadRequestException(`The proto definition does not parse: ${err.message}`);
  }
  const wanted = serviceName.replace(/^\./, '');
  const services = servicesIn(root);
  const service = services.find(
    (s) => s.name === wanted || s.fullName.replace(/^\./, '') === wanted,
  );
  if (!service) {
    const names = services.map((s) => s.fullName.replace(/^\./, ''));
    throw new BadRequestException(
      `The proto has no service "${serviceName}"` + (names.length ? `. It defines: ${names.join(', ')}.` : ' (it defines none).'),
    );
  }
  if (!service.methods[methodName]) {
    throw new BadRequestException(
      `Service "${serviceName}" has no method "${methodName}". It defines: ${Object.keys(service.methods).join(', ') || 'none'}.`,
    );
  }
}

function assertGraphqlConfig(c: unknown, linkedToApi: boolean): void {
  if (!isPlainObject(c)) throw new BadRequestException('graphqlConfig must be an object.');
  if (!nonEmpty(c.query)) throw new BadRequestException('A GraphQL tool needs a query or mutation.');
  assertEndpoint('GraphQL', c.endpoint, linkedToApi);
  if (c.variables !== undefined && c.variables !== null && !isPlainObject(c.variables)) {
    throw new BadRequestException('GraphQL variables must be a JSON object, e.g. { "id": "{userId}" }.');
  }
}

function assertSoapConfig(c: unknown, linkedToApi: boolean): void {
  if (!isPlainObject(c)) throw new BadRequestException('soapConfig must be an object.');
  if (!nonEmpty(c.operation)) throw new BadRequestException('A SOAP tool needs the operation name.');
  if (c.namespace !== undefined && c.namespace !== null && typeof c.namespace !== 'string') {
    throw new BadRequestException('The SOAP namespace must be a string.');
  }
  assertEndpoint('SOAP', c.endpoint, linkedToApi);
}

function assertGrpcConfig(c: unknown, linkedToApi: boolean): void {
  if (!isPlainObject(c)) throw new BadRequestException('grpcConfig must be an object.');
  if (!nonEmpty(c.serviceName) || !nonEmpty(c.methodName)) {
    throw new BadRequestException('A gRPC tool needs the service and the method.');
  }
  assertEndpoint('gRPC', c.endpoint, linkedToApi);
  if (nonEmpty(c.protoDefinition)) {
    assertProtoHasMethod(c.protoDefinition, c.serviceName, c.methodName);
  } else if (!linkedToApi) {
    throw new BadRequestException(
      'A gRPC tool needs its proto definition: paste or upload the .proto that defines the service.',
    );
  }
}

/**
 * Check the protocol configs a create or update carries, and that a tool
 * whose execution method is GraphQL, SOAP or gRPC is stored as that
 * protocol's config rather than as code. `current` is the stored tool on
 * an update (null on create), so a partial update is judged against what
 * the tool will be once it is applied.
 */
export function assertProtocolToolShape(
  input: ProtocolToolInput,
  current: ProtocolToolInput | null = null,
): void {
  const merged: ProtocolToolInput = { ...(current ?? {}) };
  for (const [k, v] of Object.entries(input)) if (v !== undefined) (merged as any)[k] = v;
  const linkedToApi = !!merged.apiId;

  if (input.graphqlConfig) assertGraphqlConfig(input.graphqlConfig, linkedToApi);
  if (input.soapConfig) assertSoapConfig(input.soapConfig, linkedToApi);
  if (input.grpcConfig) assertGrpcConfig(input.grpcConfig, linkedToApi);

  const configKey = merged.executionMethod ? PROTOCOL_CONFIG[merged.executionMethod] : undefined;
  if (!configKey) return;
  const label = LABEL[configKey];
  if (!merged[configKey]) {
    throw new BadRequestException(`A ${label} tool is stored as ${configKey}; none was sent.`);
  }
  if (nonEmpty(merged.code)) {
    throw new BadRequestException(
      `A ${label} tool is stored as ${configKey}, not as code. Send ${configKey} and leave code out.`,
    );
  }
}

/** The execution method a protocol config implies, when the request named none. */
export function impliedExecutionMethod(input: ProtocolToolInput): ToolExecutionMethod | undefined {
  if (input.graphqlConfig) return ToolExecutionMethod.GRAPHQL;
  if (input.soapConfig) return ToolExecutionMethod.SOAP;
  if (input.grpcConfig) return ToolExecutionMethod.GRPC;
  return undefined;
}
