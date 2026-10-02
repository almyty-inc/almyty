/**
 * The discovery meta-tools (docs/design/code-mode.md, part B), the same on
 * every surface: an agent in `discover` mode gets these instead of every
 * tool's full definition, and finds the rest on demand. The array is
 * constant, so a provider-side prefix cache stays intact while the set of
 * usable tools changes.
 */
export interface MetaToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

export const SEARCH_TOOLS = 'search_tools';
export const GET_TOOL = 'get_tool';
export const CALL_TOOL = 'call_tool';

export const META_TOOL_NAMES: ReadonlySet<string> = new Set([SEARCH_TOOLS, GET_TOOL, CALL_TOOL]);

export const META_TOOL_DEFINITIONS: readonly MetaToolDefinition[] = [
  {
    name: SEARCH_TOOLS,
    description:
      'Find the tools that fit what you need to do. Describe the task in a few words ("refund an order", "pets that are sold"). ' +
      'Returns the best matches: each tool\'s name, a one-line summary, and what it does to data (read, write or destructive). ' +
      'Then use get_tool for the details of one, and call_tool to run it.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you need to do, in a few words.' },
        limit: { type: 'integer', minimum: 1, description: 'How many matches to return (default 10).' },
      },
      required: ['query'],
    },
  },
  {
    name: GET_TOOL,
    description:
      'Get one tool\'s details by name: its description, the arguments it takes (JSON Schema), what it returns when known, ' +
      'what it does to data, and an example call.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The tool name, as search_tools returned it.' },
        detail: { type: 'string', enum: ['name', 'description', 'full'], description: 'How much to return (default full).' },
      },
      required: ['name'],
    },
  },
  {
    name: CALL_TOOL,
    description:
      'Run a tool by name with its arguments (shaped as get_tool showed). Returns the tool\'s result. ' +
      'Use the name exactly as search_tools returned it.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The tool name.' },
        arguments: { type: 'object', description: 'The tool\'s arguments.', additionalProperties: true },
      },
      required: ['name'],
    },
  },
];

export const RUN_CODE = 'run_code';

/**
 * run_code (docs/design/code-mode.md, part C): one short script that calls
 * the tools, run in a locked sandbox; only what it logs and returns comes
 * back. The description says what a staged call is (a receipt, not data),
 * as the design's "Staged receipts confuse the model" risk asks.
 */
export const RUN_CODE_DEFINITION: MetaToolDefinition = {
  name: RUN_CODE,
  description:
    'Run a short JavaScript or TypeScript script that calls the tools, when a job needs several calls, a loop or filtering. ' +
    'The script is the body of an async function: use await and return a value. Each API is an object of async functions ' +
    '(get_tool shows a tool\'s `code.namespace` and `code.function`, and its signature), for example ' +
    '`const sold = await petstore.findPetsByStatus({ status: "sold" })`. Also available: tools.search(query), tools.get(name), ' +
    'tools.call(name, args), extract(value, jsonSchema) to turn loose text into data, and log(...). ' +
    'There is no network, no files, no require or import: call the tools instead. A failed call throws a ToolError with `tool` and `message`. ' +
    'Only what you log and the return value come back to you. ' +
    'A call that changes or deletes data may be staged for a person to approve instead of running: it returns ' +
    '{ staged: true, id } and no data, so nothing later in the same script can use its result. When a write\'s result matters, ' +
    'read in one script and write in the next.',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'The script body.' },
      timeoutMs: { type: 'integer', minimum: 1, description: 'How long it may run, in milliseconds (there is a default and a maximum).' },
    },
    required: ['code'],
  },
};
