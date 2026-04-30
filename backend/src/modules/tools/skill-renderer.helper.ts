import { Injectable } from '@nestjs/common';

import { Tool } from '../../entities/tool.entity';

/**
 * Pure helpers extracted from SkillGeneratorService — GraphQL
 * query templating, kebab-segment dedup, and the SKILL.md rendering
 * pipeline (markdown body + curl/json examples + slug + escape).
 *
 * No DI: callers pass tools in directly.
 */
@Injectable()
export class SkillRendererHelper {
  buildGraphQLQueryTemplate(operation: any): string {
    const opType: 'query' | 'mutation' | 'subscription' =
      operation.type === 'mutation' || operation.type === 'subscription'
        ? operation.type
        : 'query';
    const opName = operation.name || 'op';
    const vars = (operation.parameters?.body?.variables?.properties || {}) as Record<
      string,
      any
    >;
    const required = new Set<string>(
      operation.parameters?.body?.variables?.required || [],
    );

    const declarations: string[] = [];
    const args: string[] = [];
    for (const [name, schema] of Object.entries(vars)) {
      // The GraphQL parser stores the original type signature on
      // `schema.gqlType` ("ID!", "[String!]!", "Int") — use it
      // directly when present so re-rendered queries faithfully
      // match the server's expected variable types. Older imports
      // without that field fall back to the JSON-schema → GraphQL
      // best-effort mapping plus a `required` boolean.
      let decl: string;
      if (typeof schema?.gqlType === 'string' && schema.gqlType.length > 0) {
        decl = schema.gqlType;
      } else {
        const gqlType = this.jsonTypeToGraphQLType(schema?.type);
        const bang = required.has(name) ? '!' : '';
        decl = `${gqlType}${bang}`;
      }
      declarations.push(`$${name}: ${decl}`);
      args.push(`${name}: $${name}`);
    }

    const head = declarations.length
      ? `${opType} ${opName}(${declarations.join(', ')})`
      : `${opType} ${opName}`;
    const argsBlock = args.length ? `(${args.join(', ')})` : '';
    const selection = this.buildGraphQLSelectionSet(operation);
    return `${head} {\n  ${opName}${argsBlock} ${selection}\n}`;
  }

  /**
   * Render a starter selection set for the operation's return type.
   *
   * Reads `operation.responses['200'].schema.properties.data`, which
   * the GraphQL parser populates with the field structure of the
   * operation's return type (one level deep). Includes scalar/enum
   * leaf fields directly. For nested object fields, emits a nested
   * block with `__typename` so the query is still syntactically
   * complete — the agent can flesh it out.
   *
   * Falls back to `{ __typename }` if the parser didn't capture
   * field info (older tools, non-object return types, or imports
   * predating the parser depth-walk change).
   */
  buildGraphQLSelectionSet(operation: any): string {
    const dataSchema = this.unwrapReturnType(
      operation.responses?.['200']?.schema?.properties?.data,
    );
    const props = dataSchema?.properties as Record<string, any> | undefined;
    if (!props || Object.keys(props).length === 0) {
      return `{\n    __typename\n  }`;
    }

    const lines: string[] = [];
    for (const [name, prop] of Object.entries(props)) {
      const inner = this.unwrapReturnType(prop);
      if (!inner) continue;
      if (inner.type === 'object') {
        // Object field — needs its own subselection. Emit a stub
        // with `__typename` so the query parses; the agent can
        // expand it.
        lines.push(`${name} {\n      __typename\n    }`);
      } else if (inner.type === 'array' && (inner.items as any)?.type === 'object') {
        lines.push(`${name} {\n      __typename\n    }`);
      } else {
        // Scalar / enum / array-of-scalars — leaf field, no subselection.
        lines.push(name);
      }
    }
    if (lines.length === 0) {
      return `{\n    __typename\n  }`;
    }
    return `{\n    ${lines.join('\n    ')}\n  }`;
  }

  /** Unwrap a JSON-schema array wrapper to expose the item shape. */
  unwrapReturnType(schema: any): any {
    if (!schema || typeof schema !== 'object') return schema;
    if (schema.type === 'array' && schema.items) {
      return this.unwrapReturnType(schema.items);
    }
    return schema;
  }

  jsonTypeToGraphQLType(t: string | undefined): string {
    switch ((t || '').toLowerCase()) {
      case 'integer':
      case 'int':
        return 'Int';
      case 'number':
      case 'float':
        return 'Float';
      case 'boolean':
      case 'bool':
        return 'Boolean';
      case 'array':
        return '[String]';
      case 'string':
      default:
        return 'String';
    }
  }

  /**
   * Drop kebab segments from the head of `tail` that are already
   * present at the head of `head` (in order). `dedupeSharedSegments
   * ('open-meteo-skills', 'open-meteo-weather-get-v1-forecast')`
   * → `'weather-get-v1-forecast'`. Walks one segment at a time so
   * partial matches don't false-positive.
   */
  dedupeSharedSegments(head: string, tail: string): string {
    const headParts = head.split('-').filter(Boolean);
    const tailParts = tail.split('-').filter(Boolean);
    let i = 0;
    while (
      i < tailParts.length &&
      i < headParts.length &&
      tailParts[i] === headParts[i]
    ) {
      i++;
    }
    return tailParts.slice(i).join('-');
  }


  /**
   * Render a SKILL.md following the Agent Skills open standard.
   * https://agentskills.io/specification
   *
   * @param tool The tool to render
   * @param skillName Optional override for the frontmatter `name` field.
   *   When provided (e.g. `almyty-find-pet-by-id`), ensures name matches
   *   the parent directory per the Agent Skills spec.
   */
  renderToolSkillMd(tool: Tool, skillName?: string, context?: { orgSlug?: string; gatewaySlug?: string }): string {
    const params = tool.parameters as any;
    const properties = params?.properties || {};
    const required = params?.required || [];
    const method = tool.operation?.method || '';
    const endpoint = tool.operation?.endpoint || '';
    const baseUrl = tool.operation?.api?.baseUrl?.replace(/\/$/, '') || '';
    const isApiTool = !!tool.operation && !!method && !!endpoint;

    const lines: string[] = [];

    // YAML frontmatter (Agent Skills standard).
    // metadata.toolId is the canonical identifier the skills CLI's
    // `run` uses to invoke the skill — name-based lookup against
    // the search API doesn't see post-rename gateway-prefixed
    // skill names, but the toolId is stable and unique. Without
    // this, `npx @almyty/skills run <name>` would fail to resolve
    // the underlying tool when the SKILL.md's `name` differs from
    // what the search index returns.
    lines.push('---');
    lines.push(`name: ${skillName || this.slugify(tool.name)}`);
    lines.push(`description: ${this.escapeYaml(this.buildDescription(tool))}`);
    lines.push('metadata:');
    lines.push('  author: almyty');
    lines.push('  generated: "true"');
    if (tool.id) {
      lines.push(`  toolId: "${tool.id}"`);
    }
    if (tool.version) {
      lines.push(`  version: "${tool.version}"`);
    }
    lines.push('---');
    lines.push('');

    // Title
    lines.push(`# ${tool.name}`);
    lines.push('');

    // Description
    if (tool.description) {
      lines.push(tool.description);
      lines.push('');
    }

    // When to use
    lines.push('## When to use');
    lines.push('');
    lines.push(this.generateWhenToUse(tool));
    lines.push('');

    // API endpoint (for API tools with operation data)
    if (isApiTool) {
      const fullUrl = baseUrl
        ? `${baseUrl}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`
        : endpoint;
      lines.push('## HTTP endpoint');
      lines.push('');
      lines.push('```');
      lines.push(`${method} ${fullUrl}`);
      lines.push('```');
      lines.push('');

      // Protocol-specific guidance for non-REST APIs.
      const apiType = (tool.operation?.api as any)?.type;
      const opName = tool.operation?.name;
      if (apiType === 'graphql' && opName) {
        const queryTemplate = this.buildGraphQLQueryTemplate(tool.operation!);
        lines.push('## GraphQL operation');
        lines.push('');
        lines.push(
          'This skill wraps a GraphQL operation. You must pass a' +
            ' `query` argument with the GraphQL document, and one' +
            ' flag per variable (the gateway packages them into the' +
            ' `variables` object server-side). Starting query:',
        );
        lines.push('');
        lines.push('```graphql');
        lines.push(queryTemplate);
        lines.push('```');
        lines.push('');
      } else if (apiType === 'soap' && opName) {
        lines.push('## SOAP operation');
        lines.push('');
        lines.push(
          'This skill wraps a SOAP operation. The almyty gateway' +
            ' currently requires the caller to pass the full SOAP' +
            ' envelope as `--envelope` and the namespaced action as' +
            ' `--action` — this is being improved server-side.' +
            ' See https://github.com/frane/almyty for status.',
        );
        lines.push('');
      }
    }

    // Parameters
    if (Object.keys(properties).length > 0) {
      lines.push('## Parameters');
      lines.push('');
      for (const [pName, schema] of Object.entries(properties)) {
        const paramSchema = schema as any;
        const isRequired = required.includes(pName);
        const typeStr = paramSchema.type || 'string';
        const desc = paramSchema.description || '';
        const reqLabel = isRequired ? ', **required**' : '';
        lines.push(`- \`${pName}\` (${typeStr}${reqLabel}): ${desc}`);
      }
      lines.push('');
    }

    // Example
    lines.push('## Example');
    lines.push('');
    if (isApiTool) {
      lines.push(this.generateCurlExample(tool, properties, required));
    } else {
      lines.push(this.generateJsonExample(tool, properties, required));
    }
    lines.push('');

    // Invocation section (only if context with slugs is provided).
    // Use the skill's own (already-deduped) slug — `skillName` here is
    // the resolved name passed from generateIndividualSkills, which
    // matches the directory and frontmatter `name`. Drop the `@`
    // prefix on the org/gateway/skill ref so the format matches the
    // rest of the almyty CLI family (chat-cli, agents-cli use bare
    // `org/...`).
    if (context?.orgSlug && context?.gatewaySlug && skillName) {
      const requiredFlags = required.map((p) => `--${p} <${p}>`).join(' ');
      const ref = `${context.orgSlug}/${context.gatewaySlug}/${skillName}`;
      const tail = requiredFlags ? ' ' + requiredFlags : '';

      // Suggest a one-time global install for fast invocation, but
      // don't force-run the installer on every call. Some agents
      // run inside sandboxes where `npm i -g` either fails (no
      // write permission) or pollutes a shared environment, and
      // some users prefer to pin specific versions or avoid global
      // installs altogether. Document both paths and let the
      // caller pick.
      lines.push('## Invocation');
      lines.push('');
      lines.push('Recommended (fastest, ~50 ms startup): install the CLI once globally, then call directly.');
      lines.push('');
      lines.push('```bash');
      lines.push('npm i -g @almyty/skills   # one-time, skip if already installed');
      lines.push(`almyty-skills run ${ref}${tail}`);
      lines.push('```');
      lines.push('');
      lines.push('Or invoke with `npx` if a global install isn\'t available — slower (~1 s overhead per call, much more in sandboxes that scope per-session npm caches):');
      lines.push('');
      lines.push('```bash');
      lines.push(`npx -y @almyty/skills run ${ref}${tail}`);
      lines.push('```');
      lines.push('');
    }

    // Skip generic error handling section — adds no value

    return lines.join('\n');
  }

  /**
   * Render a gateway skill bundle (overview + per-tool sections).
   */
  renderGatewaySkill(gateway: any, tools: Tool[]): string {
    const lines: string[] = [];

    // YAML frontmatter
    lines.push('---');
    lines.push(`name: ${this.slugify(gateway.name)}`);
    lines.push(`description: ${this.escapeYaml(`API tools for ${gateway.name}. ${tools.length} tools available. Use when interacting with the ${gateway.name} API.`)}`);
    lines.push('metadata:');
    lines.push('  author: almyty');
    lines.push('  generated: "true"');
    lines.push('---');
    lines.push('');

    // Overview
    lines.push(`# ${gateway.name}`);
    lines.push('');
    lines.push(`This gateway provides ${tools.length} API tools.`);
    lines.push('');

    // Tool index
    lines.push('## Available tools');
    lines.push('');
    for (const tool of tools) {
      lines.push(`- **${tool.name}**: ${tool.description || 'No description'}`);
    }
    lines.push('');

    // Per-tool sections
    for (const tool of tools) {
      const params = tool.parameters as any;
      const properties = params?.properties || {};
      const required = params?.required || [];
      const method = tool.operation?.method || '';
      const endpoint = tool.operation?.endpoint || '';
      const baseUrl = tool.operation?.api?.baseUrl?.replace(/\/$/, '') || '';
      const isApiTool = !!tool.operation && !!method && !!endpoint;

      lines.push('---');
      lines.push('');
      lines.push(`### ${tool.name}`);
      lines.push('');
      if (tool.description) {
        lines.push(tool.description);
        lines.push('');
      }

      if (isApiTool) {
        const fullUrl = baseUrl
          ? `${baseUrl}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`
          : endpoint;
        lines.push('```');
        lines.push(`${method} ${fullUrl}`);
        lines.push('```');
        lines.push('');
      }

      if (Object.keys(properties).length > 0) {
        lines.push('**Parameters:**');
        lines.push('');
        for (const [name, schema] of Object.entries(properties)) {
          const paramSchema = schema as any;
          const isRequired = required.includes(name);
          lines.push(`- \`${name}\` (${paramSchema.type || 'string'}${isRequired ? ', required' : ''}): ${paramSchema.description || ''}`);
        }
        lines.push('');
      }

      if (isApiTool) {
        lines.push(this.generateCurlExample(tool, properties, required));
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  renderEmptyGatewaySkill(gateway: any): string {
    return [
      '---',
      `name: ${this.slugify(gateway.name)}`,
      `description: ${this.escapeYaml(`API tools for ${gateway.name}. Use when interacting with the ${gateway.name} API.`)}`,
      'metadata:',
      '  author: almyty',
      '  generated: "true"',
      '---',
      '',
      `# ${gateway.name}`,
      '',
      'No tools are currently assigned to this gateway.',
      '',
    ].join('\n');
  }

  buildDescription(tool: Tool): string {
    const desc = tool.description || tool.name;
    if (desc.length > 300) return desc.substring(0, 297) + '...';
    return desc;
  }

  generateWhenToUse(tool: Tool): string {
    const desc = tool.description || '';
    const method = tool.operation?.method?.toUpperCase() || '';
    const endpoint = tool.operation?.endpoint || '';

    const lines: string[] = [];
    if (desc) lines.push(`- ${desc}`);
    if (method && endpoint) lines.push(`- ${method} requests to ${endpoint}`);

    return lines.length > 0 ? lines.join('\n') : '- Use this tool when relevant to the user\'s request';
  }

  /**
   * Generate a curl example for API tools.
   */
  generateCurlExample(tool: Tool, properties: Record<string, any>, required: string[]): string {
    const method = tool.operation?.method || 'GET';
    const endpoint = tool.operation?.endpoint || '';
    const baseUrl = tool.operation?.api?.baseUrl?.replace(/\/$/, '') || '';
    let fullUrl = baseUrl
      ? `${baseUrl}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`
      : endpoint;

    const bodyParams: Record<string, any> = {};
    const queryParams: string[] = [];

    for (const [name, schema] of Object.entries(properties)) {
      const paramSchema = schema as any;
      const value = this.getExampleValue(name, paramSchema);

      if (fullUrl.includes(`{${name}}`)) {
        // Path parameter — substitute into URL
        fullUrl = fullUrl.replace(`{${name}}`, String(value));
      } else if (['GET', 'DELETE', 'HEAD'].includes(method)) {
        // Query parameter for GET-like methods
        if (required.includes(name) || Object.keys(properties).length <= 3) {
          queryParams.push(`${name}=${encodeURIComponent(String(value))}`);
        }
      } else {
        // Body parameter for POST/PUT/PATCH
        if (required.includes(name) || Object.keys(properties).length <= 3) {
          bodyParams[name] = value;
        }
      }
    }

    if (queryParams.length > 0) {
      fullUrl += `?${queryParams.join('&')}`;
    }

    const lines: string[] = [];
    lines.push('```bash');

    const hasBody = Object.keys(bodyParams).length > 0;
    if (method === 'GET' && !hasBody) {
      lines.push(`curl "${fullUrl}"`);
    } else {
      const parts: string[] = [`curl -X ${method} "${fullUrl}"`];
      if (hasBody) {
        parts.push(`  -H "Content-Type: application/json"`);
        parts.push(`  -d '${JSON.stringify(bodyParams)}'`);
      }
      lines.push(parts.join(' \\\n'));
    }

    lines.push('```');
    return lines.join('\n');
  }

  /**
   * Generate a JSON parameters example for non-API tools.
   */
  generateJsonExample(tool: Tool, properties: Record<string, any>, required: string[]): string {
    const exampleParams: Record<string, any> = {};
    for (const [name, schema] of Object.entries(properties)) {
      const paramSchema = schema as any;
      if (required.includes(name) || Object.keys(properties).length <= 3) {
        exampleParams[name] = this.getExampleValue(name, paramSchema);
      }
    }

    if (Object.keys(exampleParams).length === 0) {
      return 'No parameters required.';
    }

    return `\`\`\`json\n${JSON.stringify(exampleParams, null, 2)}\n\`\`\``;
  }

  getExampleValue(name: string, schema: any): any {
    if (schema.enum && schema.enum.length > 0) return schema.enum[0];
    if (schema.default !== undefined) return schema.default;

    const type = schema.type || 'string';
    const nameLower = name.toLowerCase();

    switch (type) {
      case 'integer':
      case 'number':
        if (nameLower.includes('id')) return 1;
        if (nameLower.includes('limit')) return 10;
        if (nameLower.includes('page')) return 1;
        return 0;
      case 'boolean':
        return true;
      case 'array':
        return [];
      case 'object':
        return {};
      default:
        if (nameLower.includes('name')) return 'example';
        if (nameLower.includes('email')) return 'user@example.com';
        if (nameLower.includes('status')) return 'active';
        return 'string';
    }
  }

  generateErrorHandling(_tool: Tool): string {
    const lines: string[] = [];
    lines.push('- **400 Bad Request**: Check that all required parameters are provided and valid');
    lines.push('- **401 Unauthorized**: Authentication credentials may be missing or expired');
    lines.push('- **404 Not Found**: The requested resource may not exist');
    lines.push('- **500 Internal Server Error**: Server-side issue, retry after a brief wait');
    return lines.join('\n');
  }

  slugify(name: string): string {
    if (!name) return 'unnamed';
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      || 'unnamed';
  }

  escapeYaml(str: string): string {
    if (str.includes(':') || str.includes('#') || str.includes("'") || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return str;
  }
}
