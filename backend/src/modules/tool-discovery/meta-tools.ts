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
